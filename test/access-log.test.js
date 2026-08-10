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
