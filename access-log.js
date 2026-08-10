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
export async function writeExcelAccessRow(constituentId, constituentName, toolName, logPath) {
  if (!logPath) {
    console.error("[access-audit] LGL_ACCESS_LOG_PATH is not set; skipping Excel access log entry.");
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
