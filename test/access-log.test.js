import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { writeExcelAccessRow, writeLglAccessNote, logAccessEntry } from "../access-log.js";

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
