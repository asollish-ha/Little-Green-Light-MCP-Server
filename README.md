# Little Green Light (LGL) MCP Server

A direct, secure, and high-fidelity Model Context Protocol (MCP) Server for the Little Green Light CRM database. This server allows AI coding assistants and chat applications (like Claude Desktop, LibreChat, or Open WebUI) to securely interact with your donor database to search constituents, log gifts, categorize taxonomic groups, and generate reports locally without any third-party middleware (like Zapier).

---

## Features

- **Constituents & Core Management:** Search, retrieve, create, update, and delete constituent records. `create_constituent` rejects a fully blank identity (needs `organization_name`, or at least one of `first_name`/`last_name`) rather than silently creating an empty record. Bulk name-resolution helpers (used to label aggregate reports like `top_donors`) distinguish a genuine "constituent doesn't exist" from any other lookup failure (rate limit, network, auth) instead of masking both as the same fallback.
- **Advanced Server-Side Search:** `search_constituents_advanced` filters constituents directly through LGL's own query engine — custom attributes (contains/equals/starts-with/blank/not-blank), keyword, location, membership status/level, groups, lists, and updated date — all AND'd together and referenced by friendly display name rather than internal LGL IDs. Attribute values are only included in results when explicitly requested (`include_custom_attrs`), keeping ordinary filtered lookups lightweight. `constituents_never_touched_attribute` finds records that have never had a given custom attribute set at all — a state LGL's own blank/not-blank operators can't distinguish from "set but empty." `constituents_missing_info` walks the full constituent list (not just the first page) to find records missing an email, phone, or address, and returns `count` separately from the `limit`-sliced results, flagging `truncated` if the account is large enough to hit the underlying scan's page cap.
- **Fundraising & Gifts:** Record new gifts, list transactions (with date-range filters), search payments, and view campaigns, funds, appeals, and events. Gift/donor-lookup tools surface each record's gift type and pledge/installment linkage, and giving-total reports exclude pledges from cash totals to avoid double-counting — see [Gift Types & Pledge Linkage](#gift-types--pledge-linkage) below.
- **Contact Sub-Resources:** Fully manage street addresses, phone numbers, email addresses, and web addresses for constituents.
- **Activities & Notes:** Log notes, write contact reports, and track volunteer hours.
- **Groups & Memberships:** Organize constituents into customizable groups and membership levels.
- **One-Shot Donor Lookup:** `get_donor_context` returns profile + recent gifts + group memberships + recent notes in a single call (resolves by name or ID).
- **Full Profile Export:** `export_constituent_profile` mirrors LGL's own "Export Profile" button — full record, complete gift history, relationships, class/school affiliations, memberships, volunteer time, contact reports, appeal requests, event invitations, group memberships, and notes, fetched in parallel in one call.
- **Document Links:** `log_document_link` records a note pointing at a file hosted elsewhere (OneDrive/SharePoint/etc.) — LGL's API has no file-upload endpoint, so this is a reference, not a real attachment. See [API Gaps & Workarounds](#api-gaps--workarounds) below.
- **Groups as Saved Lists:** `create_group_with_members` creates a group and adds constituents to it in one call — the closest API-native substitute for LGL's UI-only dynamic Lists, which have no create/edit endpoint. Membership writes are batched (20 at a time) rather than fired all at once, so a large constituent list doesn't blast the API with unbounded concurrent requests. See [API Gaps & Workarounds](#api-gaps--workarounds) below.
- **Three Permission Levels:** strictly read-only, assisted (read-only plus notes and human-reviewed webhook writes), and full. See [Permission Levels](#permission-levels) below.
- **Access Audit Trail:** `get_constituent`, `get_donor_context`, and `export_constituent_profile` automatically log when they're used — as an `[AI Access Log]` note on the constituent's LGL record, or as a row in a local Excel file, depending on `LGL_ACCESS_LOG_DESTINATION`. See [Access Audit Logging](#access-audit-logging) below.
- **Human-Reviewed Writes:** Five `submit_*_for_review` tools post to LGL's own Integration Queue webhook instead of the API, so a person approves every write in LGL before it takes effect. Available in full mode and assisted mode. See [Human-Reviewed Writes](#human-reviewed-writes-integration-queue) below.
- **Zero-Middleware Architecture:** Data transits directly between the local AI client and the LGL API, reducing security risks and third-party fees.

---

## Installation & Setup

### 1. Prerequisites
- **Node.js** (v18 or higher recommended)
- A **Little Green Light API Key** (Generate one in your LGL account under *Settings > Integration > API Keys*)

### 2. Install Dependencies
Clone this repository to your local machine, open a terminal in the folder, and run:
```bash
npm install
```

### 3. Configure Environment Variables
Copy the `.env.example` template to create your local `.env` configuration file:
```bash
cp .env.example .env
```
Open `.env` in a text editor and replace the placeholder with your actual LGL API key and configuration:
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

#### Permission Levels
Two env vars combine to give three permission levels:

| Level | `LGL_READ_ONLY` | `LGL_ASSISTED_MODE` | What's allowed |
|---|---|---|---|
| **Strictly read-only** | `true` | unset/`false` | Reads only. Zero writes of any kind — no direct mutations, no notes (including the automatic access-audit note when `LGL_ACCESS_LOG_DESTINATION=lgl_note`), no Integration Queue submissions. The Excel access-audit destination (`LGL_ACCESS_LOG_DESTINATION=excel`) still logs in this mode, since it never touches LGL. |
| **Assisted** | `true` | `true` | Everything read-only allows, plus low-risk, easily-reviewed writes: the automatic access-audit notes, explicit `create_note`/`update_note`/`log_document_link`, and the `submit_*_for_review` Integration Queue tools. Direct mutations to constituents/gifts/groups/etc. (including `create_group_with_members`) stay blocked. |
| **Full** | unset/`false` | *(ignored)* | Unrestricted — every tool, including direct `create_*`/`update_*`/`delete_*` mutations. |

```env
# Strictly read-only
LGL_READ_ONLY=true

# Assisted: read-only plus notes and human-reviewed webhook writes
LGL_READ_ONLY=true
LGL_ASSISTED_MODE=true
```

In both read-only and assisted mode, disallowed tools are hidden from `tools/list` (not just rejected on call) so the AI assistant doesn't try to use them. `LGL_ASSISTED_MODE` has no effect unless `LGL_READ_ONLY=true` is also set — in full mode everything it unlocks is already available. Recommended whenever you point the server at a live donor database: use strictly read-only for pure exploratory sessions, assisted when you also want the access-audit trail and human-reviewed writes to work.

All tools also publish MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can warn before destructive calls without depending on the server-side guard.

---

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

---

## Human-Reviewed Writes (Integration Queue)

Separate from the direct LGL API, LGL also has a **custom integration webhook** feature (LGL Settings → Integrations → Custom Integrations) that accepts flat key/value submissions and drops them into an **Integration Queue** for a human to approve before anything is actually written to a constituent's record. This server exposes that path as five tools, distinct from the `create_*`/`update_*` API tools:

| Tool | Covers |
|---|---|
| `submit_constituent_for_review` | Identity/name fields, up to 3 phone numbers, up to 3 emails, up to 2 mailing addresses, a website, constituent category fields, and a relationship |
| `submit_gift_for_review` | Gift, pledge, and goal fields, plus tribute (honor/memorial) details. `gift_type` is constrained to LGL's actual gift types (see [Gift Types & Pledge Linkage](#gift-types--pledge-linkage)) |
| `submit_note_for_review` | Notes |
| `submit_event_registration_for_review` | Event registrations/invitations |
| `submit_appeal_request_for_review` | Appeal requests |

None of these five write to LGL directly — every submission lands in **Settings → Integration Queue → Unsaved** in LGL, where someone reviews and either saves or rejects it. Because of that, they only need [**assisted mode**](#permission-levels) rather than full write access: `LGL_READ_ONLY=true` with `LGL_ASSISTED_MODE=true` is enough to use them, since they can't change data without a human clicking Save in LGL first. Strictly read-only mode (no `LGL_ASSISTED_MODE`) still blocks them, since they are real writes to a shared queue.

**Setup:**
1. In LGL, go to *Settings → Integrations* and create (or reuse) a Custom Integration. Copy its listener URL.
2. Set `LGL_INTEGRATION_LISTENER_URL` to that URL in your environment.
3. In that integration's *field mapping* screen, map the field names your submissions will use (e.g. `first_name`, `phone`, `email_2`, `gift_amount`, `note_text`) to the corresponding LGL fields. **The mapping lives entirely in LGL's UI, not in this server** — a field that isn't mapped is silently ignored by LGL rather than causing an error, so an unmapped submission may look successful (HTTP 200) while carrying no usable data. Repeating fields (phone/email/address) use LGL's "Record Type / #" grouping: slot 1 is the bare field name (`phone`, `email`), slots 2–3 use a numeric suffix (`phone_2`, `email_3`).
4. Because there's no LGL account whose mapping is identical out of the box, treat the field names above as a starting point and confirm against your own mapping screen before relying on a given tool.

**Matching an existing constituent:** all five tools accept an optional `record_id` field carrying the LGL constituent ID. This is the preferred match key, but it only works if the integration's *record-matching preference* (in that integration's settings, alongside its field mapping) is set to ID-based matching — with the default email/name-based preference, an "LGL constituent ID" field mapping does not persist matches. If `record_id` is omitted, or your integration is still on email/name-based matching, LGL falls back to matching on `first_name` + `last_name` + `email`.

---

## Schema Value Constraints

Several `submit_*_for_review` fields represent a fixed, closed set of values defined by LGL itself, so their tool schemas use a real JSON Schema `enum` rather than a free-text field with a prose description — an AI client is constrained to a valid value instead of guessing: `constituent_type`, `deceased`, `gives_anonymously` (`submit_constituent_for_review`); `payment_interval`, `gift_is_anonymous`, `auto_generate_installments`, and `gift_type` (`submit_gift_for_review`, see [Gift Types & Pledge Linkage](#gift-types--pledge-linkage) below); `attended`, `rsvp_status`, `is_guest` (`submit_event_registration_for_review`); `appeal_status` (`submit_appeal_request_for_review`).

By contrast, `address_type`, `phone_type`, `email_type`, `web_address_type`, `contact_type`, and `relationship_type` are genuinely **account-customizable** value lists in LGL, not fixed platform enums — confirmed live against this account, whose actual values (e.g. contact types of `Call`/`Meeting`/`Mailing`/`Proposal`/`Tour`) don't match generic examples. These stay free-text, but their descriptions point at `list_type_values` (with the matching `type` key: `street_address_types`, `phone_number_types`, `email_address_types`, `web_address_types`, `contact_report_types`) or `list_relationship_types` to discover the real values for your account before submitting.

---

## Pagination & Truncation Signals

Several tools that list or search an unbounded set of records now signal when a result might be incomplete instead of silently returning a partial page as if it were everything:

- **Account-wide lists** — `list_campaigns`, `list_funds`, `list_events`, `list_appeals`, `list_groups`, `list_categories` — walk the full dataset (up to a 5,000-record cap) instead of a single hardcoded `limit=200` call. The response is a plain array as before, unless the cap was hit, in which case it becomes `{ count, <items>, truncated: true }` so an incomplete result is never mistaken for a complete one. The same underlying fix applies to internal name-based lookups (resolving a group, custom attribute, list, membership level, or keyword by name) that used to falsely report "does not exist" for a real value past the old 200-record cap.
- **`search_contact_reports`, `search_volunteer_times`, and the unscoped (no `constituent_id`) mode of `list_notes`/`list_contact_reports`/`list_volunteer_times`** — accept a `limit` param and flag it when a page comes back exactly full (a heuristic, not a guarantee, since the true count could coincidentally match the limit): the response becomes `{ count, results, note }` prompting you to raise `limit` or narrow the query.

**Separately:** `search_contact_reports` and `search_volunteer_times` previously 400'd on every call regardless of query — a pre-existing bug unrelated to the above, discovered while testing it. Same root cause as the `/constituents/search` quirk already covered below: LGL rejects a bare `q=value` and requires `q[]=field=value`. Fixed using that format (fields `text`/`description`, matching what `create_contact_report`/`create_volunteer_time` already write) — confirmed live for contact reports; volunteer time search no longer errors, though this account has no volunteer time records to fully confirm the field name against.

---

## Gift Types & Pledge Linkage

In LGL, pledges, matching gifts, and installment payments are not separate object types — they're all `Gift` records distinguished by a `gift_type_name`/`gift_category_name` pair, with payments linked back to what they pay against via `parent_gift_id`. Left as raw API output, this is easy to misread (an installment payment looks like an unrelated small gift unless you know it has a `parent_gift_id` pointing at a pledge). This server surfaces that distinction explicitly:

- **`list_gifts`**, **`get_gift`**, **`get_donor_context`**, and **`export_constituent_profile`** all include a `type` field (from `gift_type_name`), plus `gift_category_name` and `parent_gift_id` when LGL provides them. `get_gift` also hoists `type` to the top of the response instead of leaving it buried among dozens of fields.
- LGL's nested `/constituents/{id}/gifts` list endpoint omits these fields for some records; when that happens, these tools backfill them with a per-record follow-up call (capped at 50 records per request).
- **`submit_gift_for_review`**'s `gift_type` field is constrained to LGL's actual gift types: `Gift`, `In Kind`, `Pledge`, `Other Income`, `In Honor of`, `In Memory of`, `Soft Credit`, `Matching`, `Installment` (from `list_gift_types`). An installment's payments should reference the pledge's gift ID so LGL links them together correctly.
- **`record_gift`/`update_gift`** (the direct-write API tools, distinct from the Integration Queue path above) also accept `gift_type` (same enum) and `parent_gift_id`. Previously these had no `gift_type` field at all, so every gift written through them silently became a plain `Gift` — there was no way to record a Pledge or link an Installment payment back to it, which would have reintroduced the double-counting problem above from the write side.
- **Pledge double-counting:** a Pledge record carries the full ask amount, and its Installment payments carry their own amounts on top — summing both counts the same money twice. `recent_donors`, `top_donors`, and `lapsed_donors` exclude `Pledge` and `Soft Credit` records from their giving totals for this reason (verified live: a $500,000 pledge plus its five $100,000 installments would otherwise inflate a donor's reported total toward $1,000,000+). `list_gifts`/`get_gift`/`get_donor_context`/`export_constituent_profile` still return Pledge records themselves — the exclusion is scoped to the three aggregate reporting tools.

---

## API Gaps & Workarounds

Some things LGL's own web UI supports have **no equivalent anywhere in LGL's API** — not the REST API, and not the Integration Queue webhook (which only accepts constituent/gift/note/event-registration/appeal-request fields). Confirmed absent as of this writing:

| UI Feature | API endpoint? | Webhook field mapping? | This server's approach |
|---|---|---|---|
| Tasks / to-dos / reminders assigned to team members | No | No | None. There's no way to reach LGL's Tasks feature (including its reminder emails) programmatically — an actual feature request to LGL Support is the only path forward. |
| File/document attachments on a constituent record | No | No | `log_document_link` logs a note containing a link to a file hosted elsewhere (OneDrive, SharePoint, Google Drive, etc.) plus a description. This is a reference, not a real attachment — LGL cannot accept an uploaded file via API at all; even its own web forms only accept a hosted URL, never raw file bytes. |
| Saved Lists (dynamic, re-runnable queries) | No (read-only at best) | No | `create_group_with_members` creates an LGL **group** (a static set of constituents) and adds members to it in one call. Groups are fully API-writable and serve a similar purpose — "a set of people to come back to" — but are static membership, not a live query. Add/remove members afterward with `add_constituent_to_group` / `remove_constituent_from_group`. |

---

## Transport Selection

This server supports two communication transport standards:
- **Stdio Transport (Default):** The standard input/output process channel. Ideal for local programs like Claude Desktop or local command configurations.
- **Streamable HTTP Transport (SSE):** Runs a native HTTP server providing modern, stateful Server-Sent Events (SSE) over HTTP. Required for **GitHub Copilot**, Cursor's SSE mode, cloud containers, and systems that don't natively execute local Node.js processes.

### Running in Streamable HTTP Mode
To launch the server in Streamable HTTP mode, use the `--http` (or `--sse`) flag:
```bash
node index.js --http --port 3000
```
- **Port Selection:** Custom ports can be specified using `--port <number>` or the `PORT` environment variable (defaults to `3000`).
- **Secure Token Protection:** If you set `LGL_MCP_TOKEN` in your `.env` file, Bearer Token Authentication is strictly enforced. All client requests must include the header `Authorization: Bearer <your_token>`, or they will be rejected with `401 Unauthorized`. **If you don't set it, the server starts anyway with no authentication at all** — it logs a hard-to-miss warning on startup, but accepts requests from anyone who can reach the port. Only run without a token if it's bound to localhost or otherwise unreachable from outside the machine.

---

## Integrating with AI Clients

This server can be integrated into any AI client, editor, or chat interface that supports the Model Context Protocol (MCP).

### 1. Claude Desktop
To utilize this server in the official Claude Desktop application, add the configuration to your `claude_desktop_config.json` file.

**File Location:**
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

**Configuration:**
```json
{
  "mcpServers": {
    "lgl-crm": {
      "command": "node",
      "args": ["C:\\path\\to\\your\\workspace\\folder\\index.js"],
      "env": {
        "LGL_API_KEY": "your_lgl_api_key_here"
      }
    }
  }
}
```

### 2. Cursor IDE (AI Code Editor)
Cursor supports custom MCP servers directly in its graphical user interface. You can connect using either Stdio (command) or Streamable HTTP (SSE):

**Option A: Local Stdio (Command)**
1. Open Cursor and navigate to **Settings** > **Features** > **MCP**.
2. Click **+ Add New MCP Server**.
3. Configure the fields in the popup:
   - **Name:** `lgl-crm`
   - **Type:** `command`
   - **Command:** `node C:\path\to\your\workspace\folder\index.js`
4. Click **Save**. Note: You must ensure that the `LGL_API_KEY` is set in your operating system environment variables or shell configuration so Cursor can inherit it.

**Option B: Streamable HTTP (SSE Mode)**
1. Start the LGL MCP server in HTTP mode: `node index.js --http --port 3000`
2. Navigate to **Settings** > **Features** > **MCP**.
3. Click **+ Add New MCP Server**.
4. Configure the fields in the popup:
   - **Name:** `lgl-crm-sse`
   - **Type:** `sse`
   - **URL:** `http://localhost:3000/mcp`
5. Click **Save**. Note: If `LGL_MCP_TOKEN` is enabled, ensure your editor includes the Bearer authorization header or connection config.

### 3. Windsurf IDE (AI Code Editor)
Windsurf supports native MCP configurations via its global config file.

**File Location:**
- **Windows:** `%USERPROFILE%\.codeium\windsurf\mcp_config.json`
- **macOS/Linux:** `~/.codeium/windsurf/mcp_config.json`

**Configuration:**
```json
{
  "mcpServers": {
    "lgl-crm": {
      "command": "node",
      "args": ["C:\\path\\to\\your\\workspace\\folder\\index.js"],
      "env": {
        "LGL_API_KEY": "your_lgl_api_key_here"
      }
    }
  }
}
```

### 4. LibreChat (Open-Source Chat UI)
LibreChat allows you to integrate MCP servers directly through its centralized config file `librechat.yaml`.

**Configuration in `librechat.yaml`:**
```yaml
mcpServers:
  lgl-crm:
    type: "stdio"
    command: "node"
    args: ["C:\\path\\to\\your\\workspace\\folder\\index.js"]
    env:
      LGL_API_KEY: "your_lgl_api_key_here"
```

### 5. Open WebUI (Local/Self-Hosted AI UI)
To add this to Open WebUI (commonly used with local Ollama instances):
1. Navigate to **Admin Settings** > **Connections** > **MCP**.
2. Click **Add Connection**.
3. Name the connection `lgl-crm`.
4. Enter the command configuration:
   - **Command:** `node C:\path\to\your\workspace\folder\index.js`
5. Click **Submit**. (Make sure the environment variable `LGL_API_KEY` is loaded on your host machine or docker run statement running the Open WebUI instance).

---

## Security & Data Privacy

Unlike other MCP integrations that route sensitive donor information through third-party services (like Zapier or Make), this server operates on a **direct local pipeline**:
- **Zero Third-Party Storage:** All constituent data, physical addresses, emails, phone numbers, and financial donations are sent directly from your computer to the official LGL API over secure, encrypted HTTPS.
- **Principle of Least Privilege:** You can easily restrict access to database modifications (e.g. deleting records) by commenting out or removing the corresponding tools in the `index.js` file before deployment.

---

## License

This project is open-source and free to adapt for non-profit organizations under the MIT License.
