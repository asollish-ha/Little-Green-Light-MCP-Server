# Configurable Access-Audit Log Destination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the access-audit trail (currently a `[AI Access Log]` note written directly to LGL) log instead to a local `.xlsx` file, selectable per deployment via a new `LGL_ACCESS_LOG_DESTINATION` env var, because deactivating the LGL note type does not hide existing notes from a constituent's activity view and the clutter problem persists.

**Architecture:** Extract the audit-logging logic out of `index.js` into a new, independently testable module `access-log.js` that exports `writeLglAccessNote`, `writeExcelAccessRow`, and a `logAccessEntry` dispatcher. `index.js` keeps owning `lglRequest`/`resolveDefaultNoteTypeId` and passes them into `logAccessEntry` as injected dependencies at each of the three call sites, along with the resolved destination/path/mode config.

**Tech Stack:** Node.js (ESM), `exceljs` (new dependency) for `.xlsx` read/write, Node's built-in `node:test` + `node:assert/strict` for unit tests (no test framework currently exists in this repo — this introduces the first one, matching what's already available in Node 18+ per `package.json`'s stated minimum).

---

## Important note for whoever executes this plan

`index.js` in this repo has a memory-hook attached to the `Read` tool that truncates its content to just line 1 on every `Read` call ("This file has prior observations..."). **Do not rely on `Read` for this file.** Use `Grep` (with `output_mode: "content"`) or a shell `sed -n '<start>,<end>p' index.js` to view exact line ranges instead — both bypass the hook and return real content. `Edit` still works normally on `index.js` despite this (the hook only affects `Read`'s display).

All file paths below are relative to the repo root: `C:\Users\willi\OneDrive - Nebraska Philanthropic Trust\Documents\NPTLGL`.

---

### Task 1: Add the `exceljs` dependency and a test script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install exceljs**

Run:
```bash
npm install exceljs
```
Expected: `package.json` now has `"exceljs": "^4.x.x"` under `dependencies`, and `package-lock.json` is updated.

- [ ] **Step 2: Add a `test` script**

Modify the `"scripts"` block in `package.json` from:
```json
  "scripts": {
    "start": "node index.js"
  },
```
to:
```json
  "scripts": {
    "start": "node index.js",
    "test": "node --test"
  },
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add exceljs dependency and test script"
```

---

### Task 2: Create `access-log.js` with `writeExcelAccessRow` (TDD)

**Files:**
- Create: `access-log.js`
- Create: `test/access-log.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/access-log.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { writeExcelAccessRow } from "../access-log.js";

async function tempPath() {
  return path.join(os.tmpdir(), `access-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
}

async function readRows(logPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(logPath);
  const sheet = wb.getWorksheet("Access Log");
  const rows = [];
  sheet.eachRow((row) => rows.push(row.values.slice(1)));
  return rows;
}

test("writeExcelAccessRow creates the file with a header row when missing", async () => {
  const logPath = await tempPath();
  await writeExcelAccessRow(101, "Jane Donor", "get_constituent", logPath);
  const rows = await readRows(logPath);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ["Timestamp", "Tool", "Constituent ID", "Constituent Name"]);
  assert.equal(rows[1][1], "get_constituent");
  assert.equal(rows[1][2], 101);
  assert.equal(rows[1][3], "Jane Donor");
  await fs.rm(logPath, { force: true });
});

test("writeExcelAccessRow appends to an existing file without duplicating the header", async () => {
  const logPath = await tempPath();
  await writeExcelAccessRow(101, "Jane Donor", "get_constituent", logPath);
  await writeExcelAccessRow(202, "John Donor", "get_donor_context", logPath);
  const rows = await readRows(logPath);
  assert.equal(rows.length, 3);
  assert.equal(rows[2][2], 202);
  assert.equal(rows[2][3], "John Donor");
  await fs.rm(logPath, { force: true });
});

test("writeExcelAccessRow does nothing and does not throw when no path is given", async () => {
  await assert.doesNotReject(writeExcelAccessRow(101, "Jane Donor", "get_constituent", undefined));
});

test("writeExcelAccessRow retries then gives up without throwing when the path is unwritable", async () => {
  const dirAsFilePath = await fs.mkdtemp(path.join(os.tmpdir(), "access-log-test-dir-"));
  await assert.doesNotReject(writeExcelAccessRow(101, "Jane Donor", "get_constituent", dirAsFilePath));
  await fs.rm(dirAsFilePath, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:
```bash
npm test
```
Expected: FAIL — `Cannot find module '../access-log.js'` (the module doesn't exist yet).

- [ ] **Step 3: Implement `writeExcelAccessRow`**

Create `access-log.js`:
```js
import ExcelJS from "exceljs";

const SHEET_NAME = "Access Log";
const EXCEL_HEADERS = ["Timestamp", "Tool", "Constituent ID", "Constituent Name"];
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadOrCreateWorkbook(logPath) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(logPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run:
```bash
npm test
```
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add access-log.js test/access-log.test.js
git commit -m "feat: add writeExcelAccessRow for Excel-based access-audit logging"
```

---

### Task 3: Add `writeLglAccessNote` and the `logAccessEntry` dispatcher (TDD)

**Files:**
- Modify: `access-log.js`
- Modify: `test/access-log.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/access-log.test.js` (add this import alongside the existing ones at the top):
```js
import { writeLglAccessNote, logAccessEntry } from "../access-log.js";
```

Add these tests to the bottom of the file:
```js
function makeLglRequestStub(calls) {
  return async (method, requestPath, body) => {
    calls.push({ method, path: requestPath, body });
    return { id: 999 };
  };
}

test("writeLglAccessNote posts a note with the expected text and note_type_id", async () => {
  const calls = [];
  const lglRequest = makeLglRequestStub(calls);
  const resolveDefaultNoteTypeId = async () => 42;
  await writeLglAccessNote(101, "get_constituent", { lglRequest, resolveDefaultNoteTypeId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/constituents/101/notes");
  assert.match(calls[0].body.text, /\[AI Access Log\] Record accessed via LGL MCP Server \(get_constituent\)/);
  assert.equal(calls[0].body.note_type_id, 42);
});

test("writeLglAccessNote never throws even if lglRequest fails", async () => {
  const lglRequest = async () => {
    throw new Error("network down");
  };
  const resolveDefaultNoteTypeId = async () => 42;
  await assert.doesNotReject(writeLglAccessNote(101, "get_constituent", { lglRequest, resolveDefaultNoteTypeId }));
});

test("logAccessEntry with destination lgl_note skips under strict read-only", async () => {
  const calls = [];
  const lglRequest = makeLglRequestStub(calls);
  const resolveDefaultNoteTypeId = async () => 42;
  await logAccessEntry(101, "Jane Donor", "get_constituent", {
    lglRequest,
    resolveDefaultNoteTypeId,
    readOnlyMode: true,
    assistedMode: false,
    destination: "lgl_note",
    logPath: undefined,
  });
  assert.equal(calls.length, 0);
});

test("logAccessEntry with destination lgl_note writes the note in full mode", async () => {
  const calls = [];
  const lglRequest = makeLglRequestStub(calls);
  const resolveDefaultNoteTypeId = async () => 42;
  await logAccessEntry(101, "Jane Donor", "get_constituent", {
    lglRequest,
    resolveDefaultNoteTypeId,
    readOnlyMode: false,
    assistedMode: false,
    destination: "lgl_note",
    logPath: undefined,
  });
  assert.equal(calls.length, 1);
});

test("logAccessEntry with destination excel logs even under strict read-only", async () => {
  const logPath = await tempPath();
  const lglRequest = makeLglRequestStub([]);
  const resolveDefaultNoteTypeId = async () => 42;
  await logAccessEntry(101, "Jane Donor", "get_constituent", {
    lglRequest,
    resolveDefaultNoteTypeId,
    readOnlyMode: true,
    assistedMode: false,
    destination: "excel",
    logPath,
  });
  const rows = await readRows(logPath);
  assert.equal(rows.length, 2);
  await fs.rm(logPath, { force: true });
});

test("logAccessEntry falls back to lgl_note for an unrecognized destination", async () => {
  const calls = [];
  const lglRequest = makeLglRequestStub(calls);
  const resolveDefaultNoteTypeId = async () => 42;
  await logAccessEntry(101, "Jane Donor", "get_constituent", {
    lglRequest,
    resolveDefaultNoteTypeId,
    readOnlyMode: false,
    assistedMode: false,
    destination: "bogus",
    logPath: undefined,
  });
  assert.equal(calls.length, 1);
});
```

Note: `tempPath` and `readRows` are helper functions already defined near the top of `test/access-log.test.js` from Task 2 — reuse them, don't redefine.

- [ ] **Step 2: Run the tests and confirm they fail**

Run:
```bash
npm test
```
Expected: FAIL — `writeLglAccessNote` and `logAccessEntry` are not exported by `access-log.js` yet.

- [ ] **Step 3: Implement `writeLglAccessNote` and `logAccessEntry`**

Append to `access-log.js`:
```js
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run:
```bash
npm test
```
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add access-log.js test/access-log.test.js
git commit -m "feat: add writeLglAccessNote and logAccessEntry dispatcher to access-log.js"
```

---

### Task 4: Wire `access-log.js` into `index.js`

**Files:**
- Modify: `index.js:2-7` (imports)
- Modify: `index.js:132-165` (remove old `logAccessNote`)
- Modify: `index.js:806` (tool description)
- Modify: `index.js:2002` (tool description)
- Modify: `index.js:2015` (tool description)
- Modify: `index.js:2272-2276` (`get_constituent` call site)
- Modify: `index.js:3211-3227` (`get_donor_context` call site)
- Modify: `index.js:3241-3273` (`export_constituent_profile` call site)

Use `sed -n '<start>,<end>p' index.js` to re-verify exact current content before each edit below, in case line numbers have shifted from earlier edits in this task.

- [ ] **Step 1: Add the import**

Find:
```js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
```
Replace with:
```js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { logAccessEntry } from "./access-log.js";
```

- [ ] **Step 2: Remove the old `logAccessNote` function**

Find this exact block (currently lines 132-165):
```js
// ─── Access Audit Logging ────────────────────────────────────────────────────
// Writes a note directly to the LGL API (not the Integration Queue — this
// needs to fire unattended, not wait on human approval) whenever a tool opens
// a single constituent's file. This is itself a write, so it's gated the same
// way as any other assisted-tier write: it fires in full mode and in assisted
// mode (LGL_READ_ONLY=true + LGL_ASSISTED_MODE=true), and is silently skipped
// under strict read-only, where the whole point is to leave zero footprint.
// Scoped to single-record detail views only (get_constituent,
// get_donor_context, export_constituent_profile) — bulk list_*/search_* calls
// do not log, since noting every row of a 50-record list would flood
// constituents' note history. Best-effort: a logging failure never fails the
// read that triggered it.
async function logAccessNote(constituentId, toolName) {
  if (READ_ONLY_MODE && !ASSISTED_MODE) return;
  try {
    const now = new Date();
    const noteDate = now.toISOString().slice(0, 10);
    const timestamp = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const noteTypeId = await resolveDefaultNoteTypeId();
    const body = {
      // The "[AI Access Log]" text prefix is what actually makes these notes
      // identifiable/filterable — note_type_id just points at whatever
      // generic type this account has (e.g. "General"), since LGL doesn't
      // auto-create a new named type from a direct API write the way the
      // Integration Queue's field mapping does.
      text: `[AI Access Log] Record accessed via LGL MCP Server (${toolName}) on ${timestamp}.`,
      note_date: noteDate,
    };
    if (noteTypeId !== null) body.note_type_id = noteTypeId;
    await lglRequest("POST", `/constituents/${constituentId}/notes`, body);
  } catch (err) {
    console.error(`[access-audit] Failed to log note for constituent ${constituentId}: ${err.message}`);
  }
}
```
Replace with:
```js
// ─── Access Audit Logging ────────────────────────────────────────────────────
// See access-log.js for the writeLglAccessNote/writeExcelAccessRow/
// logAccessEntry implementation. LGL_ACCESS_LOG_DESTINATION selects which
// mechanism runs (see README "Access Audit Logging" for details); the three
// call sites below build the deps object logAccessEntry needs and pass it in.
```

- [ ] **Step 3: Update the `get_constituent` tool description**

Find (currently line 806):
```js
    description: "Get full details for a single constituent by ID. Writes an 'AI Access Log' note directly to that constituent's record noting when and by which tool it was accessed — this happens automatically in full and assisted (LGL_ASSISTED_MODE=true) modes, and is silently skipped under strict LGL_READ_ONLY.",
```
Replace with:
```js
    description: "Get full details for a single constituent by ID. Logs this access for audit purposes — either as an '[AI Access Log]' note on the constituent's LGL record, or as a row in a local Excel file, depending on LGL_ACCESS_LOG_DESTINATION. The LGL-note destination only fires in full and assisted (LGL_ASSISTED_MODE=true) modes and is silently skipped under strict LGL_READ_ONLY; the Excel destination fires in every mode.",
```

- [ ] **Step 4: Update the `get_donor_context` tool description**

Find (currently line 2002):
```js
    description: "One-shot lookup that returns a constituent's profile plus their recent giving history, group memberships, and recent notes. Saves 4-5 round trips compared to calling get_constituent + list_gifts + list_group_memberships + list_notes separately for the common 'tell me about <donor>' workflow. Accepts either constituent_id (preferred) or name (resolved via search; errors with candidates if multiple constituents match). Writes an 'AI Access Log' note directly to that constituent's record noting when and by which tool it was accessed — this happens automatically in full and assisted (LGL_ASSISTED_MODE=true) modes, and is silently skipped under strict LGL_READ_ONLY.",
```
Replace with:
```js
    description: "One-shot lookup that returns a constituent's profile plus their recent giving history, group memberships, and recent notes. Saves 4-5 round trips compared to calling get_constituent + list_gifts + list_group_memberships + list_notes separately for the common 'tell me about <donor>' workflow. Accepts either constituent_id (preferred) or name (resolved via search; errors with candidates if multiple constituents match). Logs this access for audit purposes — either as an '[AI Access Log]' note on the constituent's LGL record, or as a row in a local Excel file, depending on LGL_ACCESS_LOG_DESTINATION. The LGL-note destination only fires in full and assisted (LGL_ASSISTED_MODE=true) modes and is silently skipped under strict LGL_READ_ONLY; the Excel destination fires in every mode.",
```

- [ ] **Step 5: Update the `export_constituent_profile` tool description**

Find (currently line 2015):
```js
    description: "Comprehensive one-shot export of everything LGL has on a constituent, mirroring LGL's own 'Export Profile' button: full record (contact info embedded), full gift history, relationships, class/school affiliations, memberships, volunteer time, contact reports, appeal requests, event invitations, group memberships, and notes — fetched in parallel in a single call. Slower and heavier than get_donor_context; prefer that for a quick 'tell me about <donor>' lookup and use this when you actually need everything. Accepts either constituent_id (preferred) or name (resolved via search; errors with candidates if multiple match). Writes an 'AI Access Log' note directly to the constituent's record — this happens automatically in full and assisted (LGL_ASSISTED_MODE=true) modes, and is silently skipped under strict LGL_READ_ONLY.",
```
Replace with:
```js
    description: "Comprehensive one-shot export of everything LGL has on a constituent, mirroring LGL's own 'Export Profile' button: full record (contact info embedded), full gift history, relationships, class/school affiliations, memberships, volunteer time, contact reports, appeal requests, event invitations, group memberships, and notes — fetched in parallel in a single call. Slower and heavier than get_donor_context; prefer that for a quick 'tell me about <donor>' lookup and use this when you actually need everything. Accepts either constituent_id (preferred) or name (resolved via search; errors with candidates if multiple match). Logs this access for audit purposes — either as an '[AI Access Log]' note on the constituent's LGL record, or as a row in a local Excel file, depending on LGL_ACCESS_LOG_DESTINATION. The LGL-note destination only fires in full and assisted (LGL_ASSISTED_MODE=true) modes and is silently skipped under strict LGL_READ_ONLY; the Excel destination fires in every mode.",
```

- [ ] **Step 6: Update the `get_constituent` call site**

Find (currently lines 2272-2276):
```js
    case "get_constituent": {
      const constituent = await lglRequest("GET", `/constituents/${args.id}`);
      await logAccessNote(args.id, "get_constituent");
      return toText(constituent);
    }
```
Replace with:
```js
    case "get_constituent": {
      const constituent = await lglRequest("GET", `/constituents/${args.id}`);
      await logAccessEntry(args.id, summaryConstituent(constituent).name, "get_constituent", {
        lglRequest,
        resolveDefaultNoteTypeId,
        readOnlyMode: READ_ONLY_MODE,
        assistedMode: ASSISTED_MODE,
        destination: process.env.LGL_ACCESS_LOG_DESTINATION,
        logPath: process.env.LGL_ACCESS_LOG_PATH,
      });
      return toText(constituent);
    }
```

- [ ] **Step 7: Update the `get_donor_context` call site**

Find (currently lines 3211-3227):
```js
    case "get_donor_context": {
      const id = await resolveConstituentId(args);
      const giftLimit = args.gift_limit ?? 10;
      const noteLimit = args.note_limit ?? 5;

      // Fan out the dependent reads. Group memberships and notes are optional
      // (not every account exposes them on every constituent), so swallow
      // 404s on those rather than failing the whole context call. The audit
      // note runs alongside these rather than blocking on them.
      const [constituent, giftsData, groupsData, notesData] = await Promise.all([
        lglRequest("GET", `/constituents/${id}`),
        lglRequest("GET", `/constituents/${id}/gifts?limit=${giftLimit}`).catch((e) => ({ _error: e.message })),
        lglRequest("GET", `/constituents/${id}/group_memberships`).catch((e) => ({ _error: e.message })),
        lglRequest("GET", `/constituents/${id}/notes?limit=${noteLimit}`).catch((e) => ({ _error: e.message })),
        logAccessNote(id, "get_donor_context"),
      ]);
```
Replace with:
```js
    case "get_donor_context": {
      const id = await resolveConstituentId(args);
      const giftLimit = args.gift_limit ?? 10;
      const noteLimit = args.note_limit ?? 5;

      // Fan out the dependent reads. Group memberships and notes are optional
      // (not every account exposes them on every constituent), so swallow
      // 404s on those rather than failing the whole context call. The access
      // log runs after these resolve (not alongside) so it can use the
      // already-fetched constituent's name without a second lookup.
      const [constituent, giftsData, groupsData, notesData] = await Promise.all([
        lglRequest("GET", `/constituents/${id}`),
        lglRequest("GET", `/constituents/${id}/gifts?limit=${giftLimit}`).catch((e) => ({ _error: e.message })),
        lglRequest("GET", `/constituents/${id}/group_memberships`).catch((e) => ({ _error: e.message })),
        lglRequest("GET", `/constituents/${id}/notes?limit=${noteLimit}`).catch((e) => ({ _error: e.message })),
      ]);
      await logAccessEntry(id, summaryConstituent(constituent).name, "get_donor_context", {
        lglRequest,
        resolveDefaultNoteTypeId,
        readOnlyMode: READ_ONLY_MODE,
        assistedMode: ASSISTED_MODE,
        destination: process.env.LGL_ACCESS_LOG_DESTINATION,
        logPath: process.env.LGL_ACCESS_LOG_PATH,
      });
```

- [ ] **Step 8: Update the `export_constituent_profile` call site**

Find (currently lines 3241-3273):
```js
    case "export_constituent_profile": {
      const id = await resolveConstituentId(args);
      const giftLimit = args.gift_limit ?? 200;
      const noteLimit = args.note_limit ?? 100;

      // Every sub-resource beyond the core constituent record is optional —
      // not every account has relationships/class affiliations/memberships/
      // volunteer time/contact reports/appeal requests/invitations enabled,
      // or data in them for this particular person — so each is fetched
      // independently and a 404/error on one doesn't fail the whole export.
      const fetchOptional = (path) => lglRequest("GET", path).catch((e) => ({ _error: e.message }));
      const unwrap = (data) => (data?._error ? { error: data._error } : (data.items ?? data));

      const [
        constituent, giftsData, groupsData, notesData,
        relationshipsData, classAffiliationsData, membershipsData,
        volunteerTimesData, contactReportsData, appealRequestsData,
        invitationsData, categoriesData,
      ] = await Promise.all([
        lglRequest("GET", `/constituents/${id}`),
        fetchOptional(`/constituents/${id}/gifts?limit=${giftLimit}`),
        fetchOptional(`/constituents/${id}/group_memberships`),
        fetchOptional(`/constituents/${id}/notes?limit=${noteLimit}`),
        fetchOptional(`/constituents/${id}/constituent_relationships`),
        fetchOptional(`/constituents/${id}/class_affiliations`),
        fetchOptional(`/constituents/${id}/memberships`),
        fetchOptional(`/constituents/${id}/volunteer_times`),
        fetchOptional(`/constituents/${id}/contact_reports`),
        fetchOptional(`/constituents/${id}/appeal_requests`),
        fetchOptional(`/constituents/${id}/invitations`),
        fetchOptional(`/constituents/${id}/categories`),
        logAccessNote(id, "export_constituent_profile"),
      ]);
```
Replace with:
```js
    case "export_constituent_profile": {
      const id = await resolveConstituentId(args);
      const giftLimit = args.gift_limit ?? 200;
      const noteLimit = args.note_limit ?? 100;

      // Every sub-resource beyond the core constituent record is optional —
      // not every account has relationships/class affiliations/memberships/
      // volunteer time/contact reports/appeal requests/invitations enabled,
      // or data in them for this particular person — so each is fetched
      // independently and a 404/error on one doesn't fail the whole export.
      const fetchOptional = (path) => lglRequest("GET", path).catch((e) => ({ _error: e.message }));
      const unwrap = (data) => (data?._error ? { error: data._error } : (data.items ?? data));

      const [
        constituent, giftsData, groupsData, notesData,
        relationshipsData, classAffiliationsData, membershipsData,
        volunteerTimesData, contactReportsData, appealRequestsData,
        invitationsData, categoriesData,
      ] = await Promise.all([
        lglRequest("GET", `/constituents/${id}`),
        fetchOptional(`/constituents/${id}/gifts?limit=${giftLimit}`),
        fetchOptional(`/constituents/${id}/group_memberships`),
        fetchOptional(`/constituents/${id}/notes?limit=${noteLimit}`),
        fetchOptional(`/constituents/${id}/constituent_relationships`),
        fetchOptional(`/constituents/${id}/class_affiliations`),
        fetchOptional(`/constituents/${id}/memberships`),
        fetchOptional(`/constituents/${id}/volunteer_times`),
        fetchOptional(`/constituents/${id}/contact_reports`),
        fetchOptional(`/constituents/${id}/appeal_requests`),
        fetchOptional(`/constituents/${id}/invitations`),
        fetchOptional(`/constituents/${id}/categories`),
      ]);
      await logAccessEntry(id, summaryConstituent(constituent).name, "export_constituent_profile", {
        lglRequest,
        resolveDefaultNoteTypeId,
        readOnlyMode: READ_ONLY_MODE,
        assistedMode: ASSISTED_MODE,
        destination: process.env.LGL_ACCESS_LOG_DESTINATION,
        logPath: process.env.LGL_ACCESS_LOG_PATH,
      });
```

- [ ] **Step 9: Confirm the server still starts**

Run:
```bash
node --check index.js
```
Expected: no output (syntax is valid). This only checks syntax, not runtime behavior — Task 6 covers manual runtime verification.

- [ ] **Step 10: Run the unit tests again to confirm nothing in access-log.js broke**

Run:
```bash
npm test
```
Expected: PASS — same 10 tests green (this task doesn't touch access-log.js, but confirms the working tree is still consistent).

- [ ] **Step 11: Commit**

```bash
git add index.js
git commit -m "refactor: wire access-log.js into index.js, replacing inline logAccessNote"
```

---

### Task 5: Update `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add the new env vars**

Current content:
```env
LGL_API_KEY=your_lgl_api_key_here
LGL_READ_ONLY=false
LGL_ASSISTED_MODE=false
LGL_INTEGRATION_LISTENER_URL=https://your-account.littlegreenlight.com/integrations/your-integration-id/listener
PORT=3000
```
Replace with:
```env
LGL_API_KEY=your_lgl_api_key_here
LGL_READ_ONLY=false
LGL_ASSISTED_MODE=false
LGL_INTEGRATION_LISTENER_URL=https://your-account.littlegreenlight.com/integrations/your-integration-id/listener

# Optional: choose where the automatic access-audit trail is logged —
# "lgl_note" (default) writes a note directly to LGL, "excel" appends a row
# to a local spreadsheet instead. See README "Access Audit Logging".
LGL_ACCESS_LOG_DESTINATION=lgl_note

# Required only when LGL_ACCESS_LOG_DESTINATION=excel — absolute path to the
# .xlsx file to append access-log rows to.
LGL_ACCESS_LOG_PATH=C:\path\to\AI_Access_Log.xlsx

PORT=3000
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: document LGL_ACCESS_LOG_DESTINATION and LGL_ACCESS_LOG_PATH in .env.example"
```

---

### Task 6: Update `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the Features bullet**

Find (currently line 20):
```md
- **Access Audit Trail:** `get_constituent`, `get_donor_context`, and `export_constituent_profile` automatically write an `[AI Access Log]` note directly to the constituent's record noting when it was viewed, in full and assisted modes. See [Access Audit Logging](#access-audit-logging) below.
```
Replace with:
```md
- **Access Audit Trail:** `get_constituent`, `get_donor_context`, and `export_constituent_profile` automatically log when they're used — as an `[AI Access Log]` note on the constituent's LGL record, or as a row in a local Excel file, depending on `LGL_ACCESS_LOG_DESTINATION`. See [Access Audit Logging](#access-audit-logging) below.
```

- [ ] **Step 2: Add the new env vars to the config example block**

Find (currently lines 44-53):
```md
```env
LGL_API_KEY=your_lgl_api_key_here
PORT=3000

# Optional: Secure your Streamable HTTP endpoint with Bearer Token Authentication
LGL_MCP_TOKEN=your_secure_bearer_token_here

# Optional: enables the submit_*_for_review tools — see "Human-Reviewed Writes" below
LGL_INTEGRATION_LISTENER_URL=https://your-account.littlegreenlight.com/integrations/your-integration-id/listener
```
```
Replace with:
```md
```env
LGL_API_KEY=your_lgl_api_key_here
PORT=3000

# Optional: Secure your Streamable HTTP endpoint with Bearer Token Authentication
LGL_MCP_TOKEN=your_secure_bearer_token_here

# Optional: enables the submit_*_for_review tools — see "Human-Reviewed Writes" below
LGL_INTEGRATION_LISTENER_URL=https://your-account.littlegreenlight.com/integrations/your-integration-id/listener

# Optional: choose where the automatic access-audit trail is logged —
# "lgl_note" (default) writes a note directly to LGL, "excel" appends a row
# to a local spreadsheet instead. See "Access Audit Logging" below.
LGL_ACCESS_LOG_DESTINATION=lgl_note

# Required only when LGL_ACCESS_LOG_DESTINATION=excel — absolute path to the
# .xlsx file to append access-log rows to.
LGL_ACCESS_LOG_PATH=C:\path\to\AI_Access_Log.xlsx
```
```

- [ ] **Step 3: Update the Permission Levels table's strictly-read-only row**

Find (currently line 60):
```md
| **Strictly read-only** | `true` | unset/`false` | Reads only. Zero writes of any kind — no direct mutations, no notes (including the automatic access-audit note), no Integration Queue submissions. |
```
Replace with:
```md
| **Strictly read-only** | `true` | unset/`false` | Reads only. Zero writes of any kind — no direct mutations, no notes (including the automatic access-audit note when `LGL_ACCESS_LOG_DESTINATION=lgl_note`), no Integration Queue submissions. The Excel access-audit destination (`LGL_ACCESS_LOG_DESTINATION=excel`) still logs in this mode, since it never touches LGL. |
```

- [ ] **Step 4: Rewrite the "Access Audit Logging" section**

Find (currently lines 79-89):
```md
## Access Audit Logging

Whenever `get_constituent`, `get_donor_context`, or `export_constituent_profile` is called in full or assisted mode, the server writes a note directly to that constituent's record in LGL — e.g. `[AI Access Log] Record accessed via LGL MCP Server (get_constituent) on 2026-07-13 17:24 UTC.` It's not a config option of its own — it rides along with whichever [permission level](#permission-levels) is active, and is silently skipped under strictly read-only, where the whole point is to leave zero footprint.

A few things worth knowing:
- **Scope is single-record detail views only.** Bulk `list_*`/`search_*` calls do *not* log — noting every row of a 50-record list would flood constituents' note history with little audit value. Only tools that open one specific donor's file do.
- **The note writes directly via the API**, not through the Integration Queue — an audit trail that needed human approval to appear defeats the purpose.
- **Best-effort:** if writing the note fails for any reason, the read that triggered it still succeeds; the failure is logged to stderr, not surfaced as a tool error.
- **Note type:** LGL's write API needs an existing `note_type_id` (a number), not a type name — passing a name is silently ignored by LGL rather than applied. The server resolves this at runtime (preferring a type literally named "General", falling back to whatever type exists first) rather than hardcoding an ID, since type IDs are account-specific. This same fix applies to `create_note`/`update_note`, which previously accepted a `note_type` string that never actually applied — invalid type names now raise a clear error instead of silently creating an untyped note.
```
Replace with:
```md
## Access Audit Logging

Whenever `get_constituent`, `get_donor_context`, or `export_constituent_profile` is called, the server logs the access for audit purposes. Where that log goes is controlled by `LGL_ACCESS_LOG_DESTINATION`:

- **`lgl_note` (default):** writes a note directly to that constituent's record in LGL — e.g. `[AI Access Log] Record accessed via LGL MCP Server (get_constituent) on 2026-07-13 17:24 UTC.` It rides along with whichever [permission level](#permission-levels) is active, and is silently skipped under strictly read-only, where the whole point is to leave zero footprint on LGL.
- **`excel`:** appends a row (timestamp, tool, constituent ID, constituent name) to the `.xlsx` file at `LGL_ACCESS_LOG_PATH` instead. Fires in every mode, including strictly read-only, since it never writes to LGL at all.

Deactivating a note type in LGL's UI (Settings → Menu Items → Note Types) does **not** hide existing notes of that type from a constituent's activity view, and the API can still write new notes using a deactivated type's ID — so deactivating the note type used for `lgl_note` logging doesn't reduce clutter, it only keeps that type out of the manual "new note" dropdown for staff. If note clutter on constituent records is the concern, switch to `excel` instead.

A few things worth knowing:
- **Scope is single-record detail views only.** Bulk `list_*`/`search_*` calls do *not* log — noting every row of a 50-record list would flood the log with little audit value. Only tools that open one specific donor's file do.
- **Best-effort, either destination:** if writing the log entry fails for any reason, the read that triggered it still succeeds; the failure is logged to stderr, not surfaced as a tool error. For `excel`, a locked file (e.g. open in Excel) is retried a few times before giving up.
- **`lgl_note` writes directly via the API**, not through the Integration Queue — an audit trail that needed human approval to appear defeats the purpose. It also needs an existing `note_type_id` (a number), not a type name — passing a name is silently ignored by LGL rather than applied. The server resolves this at runtime (preferring a type literally named "General", falling back to whatever type exists first) rather than hardcoding an ID, since type IDs are account-specific. This same fix applies to `create_note`/`update_note`, which previously accepted a `note_type` string that never actually applied — invalid type names now raise a clear error instead of silently creating an untyped note.
- **`excel` creates the file if it doesn't exist**, with a bold, frozen header row (`Timestamp`, `Tool`, `Constituent ID`, `Constituent Name`), and keeps growing indefinitely — there's no automatic rotation or archiving.
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document configurable access-audit log destination"
```

---

### Task 7: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Verify the `excel` destination end-to-end**

Set environment variables (adjust the path to a scratch file first, not the real log, to avoid mixing test rows into it):
```bash
export LGL_ACCESS_LOG_DESTINATION=excel
export LGL_ACCESS_LOG_PATH="/tmp/AI_Access_Log_scratch.xlsx"
export LGL_READ_ONLY=true
```
Start the server (`npm start`) and, from an MCP client (or `call_lgl_api`-style manual test), call `get_constituent` on a real constituent ID.

Expected: the tool call succeeds and returns the constituent; opening `/tmp/AI_Access_Log_scratch.xlsx` in Excel shows a header row plus one data row with today's timestamp, `get_constituent`, the constituent's ID, and their name. No `[AI Access Log]` note appears on the constituent's LGL record.

- [ ] **Step 2: Verify strict read-only still logs to Excel**

With `LGL_READ_ONLY=true` and no `LGL_ASSISTED_MODE` set (as in Step 1), confirm the row from Step 1 was still written — this is the point of removing the read-only gate for the `excel` destination.

- [ ] **Step 3: Verify the `lgl_note` destination is unchanged**

```bash
export LGL_ACCESS_LOG_DESTINATION=lgl_note
unset LGL_ACCESS_LOG_PATH
export LGL_READ_ONLY=true
export LGL_ASSISTED_MODE=true
```
Call `get_constituent` on a test constituent record you're comfortable writing to.

Expected: a `[AI Access Log]` note is written to that constituent's LGL record, matching today's behavior. Then set `LGL_ASSISTED_MODE=false` (strict read-only) and call it again — expect no new note.

- [ ] **Step 4: Verify lock-retry behavior**

Repeat Step 1's setup, open `/tmp/AI_Access_Log_scratch.xlsx` in Excel (keeping it open so the file is locked), then call `get_constituent` again.

Expected: the tool call still succeeds immediately (the retry/skip happens in the background and never blocks the response); after ~1 second a `[access-audit]` warning appears in the server's stderr output; no new row appears until the file is closed in Excel and the tool is called again.

- [ ] **Step 5: Clean up the scratch file**

```bash
rm -f /tmp/AI_Access_Log_scratch.xlsx
```
