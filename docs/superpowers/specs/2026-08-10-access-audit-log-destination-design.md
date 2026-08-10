# Access Audit Log Destination — Design

## Problem

The MCP server's access-audit mechanism (`logAccessNote` in `index.js`) writes a `[AI Access Log]` note directly to a constituent's LGL record every time `get_constituent`, `get_donor_context`, or `export_constituent_profile` opens that record. In practice this clutters the constituent's notes/activity timeline, pushing real staff notes further down the list.

Deactivating the note type in LGL (Settings → Menu Items → Note Types) was tested as a possible fix: it does **not** hide existing notes of that type from the constituent's activity view, and (confirmed live) the API can still write notes using a deactivated type's ID. So deactivation only keeps the type out of the manual "new note" dropdown for staff — it does not solve the clutter problem.

## Goal

Give the server a second logging destination — a local `.xlsx` file synced via OneDrive/SharePoint — and make the destination configurable per deployment, rather than removing the LGL-note option outright (other deployments of this open-source server may rely on the existing behavior).

## Design

### Config

Two new environment variables:

- `LGL_ACCESS_LOG_DESTINATION` — `"lgl_note"` (default) or `"excel"`. Controls which mechanism `logAccessEntry` uses. An unrecognized value falls back to `"lgl_note"` with a stderr warning.
- `LGL_ACCESS_LOG_PATH` — absolute path to the `.xlsx` file. Only consulted when destination is `"excel"`. If unset in that mode, logging is skipped with a stderr warning (no fallback path is guessed, since this server is intended for reuse across multiple LGL accounts/deployments and a wrong guessed path is worse than no logging).

### Dispatcher

Replace `logAccessNote(constituentId, toolName)` with `logAccessEntry(constituentId, constituentName, toolName)`. It dispatches on `LGL_ACCESS_LOG_DESTINATION`:

- `"lgl_note"` → `writeLglAccessNote(constituentId, toolName)` — today's existing implementation, unchanged, moved into its own function. Still gated by `READ_ONLY_MODE`/`ASSISTED_MODE` (skipped under strict read-only) because it is a real write to LGL.
- `"excel"` → `writeExcelAccessRow(constituentId, constituentName, toolName)` — new. **Not** gated by read-only mode, since it never touches LGL — it fires in every mode, including strict read-only.

Both branches remain best-effort: a failure in either never fails the read that triggered it, and is reported to stderr only.

### `writeExcelAccessRow`

Uses the `exceljs` npm package.

1. If `LGL_ACCESS_LOG_PATH` is unset, warn to stderr and return.
2. If the file exists, open the workbook with `exceljs`. If it does not exist, create a new workbook with a header row (`Timestamp`, `Tool`, `Constituent ID`, `Constituent Name`), bold and frozen.
3. Append a row: ISO 8601 timestamp, tool name, constituent ID, constituent name.
4. Save the workbook to disk.
5. If the save fails due to a lock/write error (e.g. the file is open in Excel), retry up to 3 times with a ~300ms delay between attempts. If still failing after retries, warn to stderr and skip — the triggering read still succeeds.
6. If the existing file fails to parse (corrupt), warn to stderr and skip rather than crashing the read.

### Fields logged

Timestamp, tool name, constituent ID, constituent name. No "reason"/"why" field — none of the three triggering tools accept a reason argument today, and adding one was explicitly decided against (out of scope for this change).

### Call site changes

`get_constituent`, `get_donor_context`, and `export_constituent_profile` all currently call the access-log function. To avoid an extra lookup for the constituent's name inside the log function:

- `get_constituent`: already fetches the constituent sequentially before logging — pass `summaryConstituent(constituent).name`.
- `get_donor_context` / `export_constituent_profile`: currently include the log call as one of several parallel `Promise.all` entries. Move the log call to *after* the `Promise.all` resolves, using the constituent object it already fetched, and pass `summaryConstituent(constituent).name`. This was parallelized originally to avoid delaying the response on an LGL API round trip; since the Excel path is local file I/O (no network call), parallelizing the log call no longer matters for latency, and sequencing it after keeps the name available without a second lookup. The `lgl_note` branch still involves a real network call to LGL, but moving it out of the `Promise.all` does not change its correctness — it simply runs slightly later, still without blocking on anything but its own write.

### File organization

Single file, growing indefinitely (`LGL_ACCESS_LOG_PATH` points directly at one `.xlsx` file, not a directory). No automatic rotation/archiving; if the file grows unwieldy over time that's a manual cleanup decision for whoever maintains it.

## Out of scope

- Migrating/backfilling historical `[AI Access Log]` notes already written to LGL into the Excel file.
- A "reason"/"why" field or new tool parameters to supply one.
- Automatic file rotation (per-month/per-year splitting).
- A queue-based fallback for the Excel path when the file is locked (retry-then-skip was chosen instead, matching the existing best-effort philosophy).
- Removing the `lgl_note` destination or changing its default — it remains the default for backward compatibility with existing deployments of this server.

## Testing

Manual verification for both destinations:

- **`lgl_note`**: confirm behavior is unchanged from today (note written to a test constituent, skipped under strict read-only).
- **`excel`**: set `LGL_ACCESS_LOG_PATH` to a scratch file; call each of the three tools and confirm rows appear with correct data; hold the file open in Excel during a call to confirm retry-then-skip; confirm logging still fires under strict `LGL_READ_ONLY=true` with no `LGL_ASSISTED_MODE`; unset `LGL_ACCESS_LOG_PATH` and confirm a clean skip with no read failure; set an unrecognized `LGL_ACCESS_LOG_DESTINATION` value and confirm fallback to `lgl_note` with a stderr warning.

## Docs

Update README: document `LGL_ACCESS_LOG_DESTINATION` and `LGL_ACCESS_LOG_PATH` next to the existing env vars (`LGL_READ_ONLY`, `LGL_ASSISTED_MODE`, `LGL_INTEGRATION_LISTENER_URL`). Rewrite the "Access Audit Logging" section to describe both destinations: keep the existing `lgl_note`-specific caveats (note type resolution, single-record-only scope, Integration Queue bypass rationale) under that branch, and add the `excel` caveats (lock retry behavior, no read-only gating, single growing file with no rotation).
