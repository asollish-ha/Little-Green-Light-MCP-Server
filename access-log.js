import ExcelJS from "exceljs";
import fs from "node:fs/promises";

const SHEET_NAME = "Access Log";
const EXCEL_HEADERS = ["Timestamp", "Tool", "Constituent ID", "Constituent Name"];
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadOrCreateWorkbook(logPath) {
  const workbook = new ExcelJS.Workbook();
  const exists = await fs
    .access(logPath)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    await workbook.xlsx.readFile(logPath);
  }
  let sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    sheet = workbook.addWorksheet(SHEET_NAME);
    sheet.addRow(EXCEL_HEADERS);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }
  return { workbook, sheet };
}

// Appends one row (timestamp, tool, constituent ID, constituent name) to the
// .xlsx file at logPath, creating the file with a header row if it doesn't
// exist yet. Best-effort: never throws. If the file is locked (e.g. open in
// Excel) or the write otherwise fails, retries a few times before giving up
// and warning to stderr — the caller's read must never fail because of this.
// NOTE: Multiple concurrent calls targeting the same logPath can race on the
// read-modify-write of the .xlsx file (no locking or serialization), and one
// write can silently overwrite another's row. This is an accepted trade-off for
// a best-effort audit log — the log is not a source of truth, and truly
// simultaneous overlapping accesses are expected to be rare in practice.
export async function writeExcelAccessRow(constituentId, constituentName, toolName, logPath) {
  if (!logPath) {
    console.error("[access-audit] No log path configured; skipping Excel access log entry.");
    return;
  }
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { workbook, sheet } = await loadOrCreateWorkbook(logPath);
      sheet.addRow([new Date().toISOString(), toolName, constituentId, constituentName]);
      await workbook.xlsx.writeFile(logPath);
      return;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error(
          `[access-audit] Failed to write Excel access log entry for constituent ${constituentId} after ${MAX_RETRIES} attempts: ${err.message}`
        );
        return;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// Writes a note directly to the LGL API (not the Integration Queue — this
// needs to fire unattended, not wait on human approval). Best-effort: a
// logging failure never fails the read that triggered it. lglRequest and
// resolveDefaultNoteTypeId are injected by the caller (index.js) rather than
// imported here, so this module has no dependency on the LGL HTTP client.
export async function writeLglAccessNote(constituentId, toolName, { lglRequest, resolveDefaultNoteTypeId }) {
  try {
    const now = new Date();
    const noteDate = now.toISOString().slice(0, 10);
    const timestamp = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const noteTypeId = await resolveDefaultNoteTypeId();
    const body = {
      text: `[AI Access Log] Record accessed via LGL MCP Server (${toolName}) on ${timestamp}.`,
      note_date: noteDate,
    };
    if (noteTypeId !== null) body.note_type_id = noteTypeId;
    await lglRequest("POST", `/constituents/${constituentId}/notes`, body);
  } catch (err) {
    console.error(`[access-audit] Failed to log note for constituent ${constituentId}: ${err.message}`);
  }
}

// Dispatches to writeLglAccessNote or writeExcelAccessRow based on
// deps.destination ("lgl_note", the default, or "excel"). The lgl_note
// destination is gated by read-only/assisted mode, since it's a real write
// to LGL and strict read-only means leaving zero footprint there. The excel
// destination is not gated — it never touches LGL, so it logs in every mode.
export async function logAccessEntry(constituentId, constituentName, toolName, deps) {
  const { lglRequest, resolveDefaultNoteTypeId, readOnlyMode, assistedMode, destination, logPath } = deps;
  const resolvedDestination = destination === "excel" ? "excel" : "lgl_note";
  if (destination && destination !== resolvedDestination) {
    console.error(
      `[access-audit] Unrecognized LGL_ACCESS_LOG_DESTINATION "${destination}"; falling back to "lgl_note".`
    );
  }
  if (resolvedDestination === "excel") {
    await writeExcelAccessRow(constituentId, constituentName, toolName, logPath);
    return;
  }
  if (readOnlyMode && !assistedMode) return;
  await writeLglAccessNote(constituentId, toolName, { lglRequest, resolveDefaultNoteTypeId });
}
