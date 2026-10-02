# Fork notes — The Torah Center of Atlanta

This fork differs from upstream in ways that are **load-bearing**. Read this before
changing `index.js`, before deleting `mcp-protocol-shim.mjs`, and before syncing
from upstream.

Deployed at: `https://little-green-light-mcp-server.onrender.com/mcp` (Render, Oregon,
$7/month Starter). Connected to claude.ai as a custom connector.

Last verified working: **2026-10-01**, commit `8c9cd05`.

---

## The three changes to `index.js`

Upstream builds one `Server` and one `StreamableHTTPServerTransport` at module load
and reuses them. That cannot work with claude.ai's connector. This fork builds both
**per request**.

1. **`buildServer()` factory** replaces the module-level `const server = new Server(...)`.
   Registers `ListToolsRequestSchema` and `CallToolRequestSchema` handlers and returns
   a fresh instance.
2. **The module-level transport is gone.** No `new StreamableHTTPServerTransport(...)`
   and no `await server.connect(transport)` at startup.
3. **The POST handler constructs both per request**, with
   `sessionIdGenerator: undefined` and `enableJsonResponse: true`, and closes both on
   `res.on("close")`. GET returns 405 — stateless mode keeps no long-lived stream for a
   GET to attach to.

If you sync from upstream, these three edits must be reapplied. Check with:

```bash
node --check index.js
grep -n "buildServer" index.js        # should appear twice
grep -n "sessionIdGenerator" index.js # should be: undefined
```

## The auth hardening in `index.js` (fork-specific)

Upstream's auth gate read:

```js
const expectedToken = process.env.LGL_MCP_TOKEN;
if (expectedToken) {          // ← unset token = check skipped entirely
  if (token !== expectedToken) { 401 }
}
```

That **fails open**. With `LGL_MCP_TOKEN` unset or empty, `/mcp` served every
request unauthenticated — verified by test: an unpatched server with no token
returned HTTP 200 and the full tool list to a request carrying no `Authorization`
header at all. On a public URL with a live `LGL_API_KEY`, that is the donor
database readable by anyone who knows the address.

This fork fails **closed**: no token means HTTP 503 and nothing served. It also
compares with `timingSafeEqual` (guarded on length, since that function throws on
mismatched buffers) instead of `!==`.

If you sync from upstream, this edit must be reapplied. Check with:

```bash
grep -n "if (!expectedToken)" index.js   # must be present
grep -n "timingSafeEqual" index.js       # must appear twice: import + compare
```

Regression test, which must return 503 and not 200:

```bash
env -u LGL_MCP_TOKEN LGL_API_KEY=dummy \
  node --import ./mcp-protocol-shim.mjs index.js --http --port 3400 &
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3400/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## The contact-fields fix in `index.js` (fork-specific)

LGL has two sources for a constituent, and they do not return the same thing:

| Endpoint | Embeds `email_addresses` / `phone_numbers` / `street_addresses`? |
|---|---|
| `GET /constituents/{id}` | **Yes** |
| `GET /constituents/search` | **No** |
| `GET /constituents` (list) | **No** |

There is no `expand` or `include` parameter on the search endpoint — checked
against the OpenAPI spec and the endpoint reference. Contact data for a search
result can only come from a second, per-record request.

Upstream's `summaryConstituent()` read those arrays unconditionally and was
applied to search results, which caused two bugs:

1. **Every search and list result reported `email: null, phone: null,
   city: null, state: null`** regardless of what was on the record. Verified
   live: Ellen Malka (950409) and Dean Kirkel (947144) both show `null` in
   search while both have an email plainly on file. The output looked like an
   answer, with no signal that nothing had been fetched.

2. **`constituents_missing_info` was 100% wrong.** It tested the same absent
   arrays, so it reported *every* constituent as missing *every* field —
   `count: 1230` out of 1,230 for "missing email". Worse than useless: it was
   a confident, plausible-looking, entirely false cleanup list.

The fix:

- `summaryConstituent()` is now documented as single-record-only and is used
  solely by `get_constituent`, `get_donor_context`,
  `export_constituent_profile` and the fixed `constituents_missing_info`.
- `summaryConstituentBasic()` returns `{id, name}` for every search- and
  list-derived path. The contact keys are **absent, not null** — an absent key
  can't be misread as "no email on file."
- `constituents_missing_info` now fetches each record via
  `fetchConstituentsFull()` (bounded concurrency 8, cap 2,000) and reports
  `scanned`, plus notes for truncation and for fetch failures. Failed lookups
  are **excluded**, never counted as missing — that conflation of "not
  retrieved" with "no data" is the original bug.

**This makes `constituents_missing_info` slow by nature** — one HTTP request
per constituent. That is inherent to LGL's API, not a defect. Expect a minute
or more on a 1,000+ record account.

If you sync from upstream, reapply. Check with:

```bash
grep -n "summaryConstituentBasic" index.js   # several call sites
grep -n "fetchConstituentsFull" index.js     # definition + missing_info
```

Correctness check after deploy — a search result must have NO email key, and
`constituents_missing_info` must return far fewer than your total constituents.

## `mcp-protocol-shim.mjs` — do not delete

Loaded by the Render start command:

```
node --import ./mcp-protocol-shim.mjs index.js --http --port $PORT
```

It does four things, all necessary:

1. **Rewrites `MCP-Protocol-Version`.** claude.ai sends `2026-07-28`. The SDK validates
   that header against a hardcoded allowlist ending at `2025-11-25` and returns HTTP 400
   for anything newer. claude.ai renders that 400 as a sign-in prompt, which is why this
   failure looks like an auth problem and is not one.

   **It patches both `req.headers` and `req.rawHeaders`.** The SDK reads `rawHeaders`.
   Patching only `req.headers` changes nothing and looks like it worked. This cost hours.

2. **Repairs `Bearer<token>` → `Bearer <token>`.** claude.ai's connector UI strips the
   space out of header values. Typing it back in does not survive the save.

3. **Bridges session IDs.** Vestigial now that the transport is stateless, but harmless
   and cheap insurance if the transport is ever made stateful again.

4. **Logs one line per request.** Credentials appear only as a length and a SHA-256
   prefix — never in the clear. Safe to read, safe to paste into a chat.

### Why not just upgrade the SDK?

We tried. 1.29.0 → 1.31.0 bought about eight hours before claude.ai's protocol version
moved past 1.31.0's ceiling too. The shim is version-proof; an SDK pin is not.

---

## Reading the logs

A healthy handshake, in Render → Logs:

```
POST /mcp | auth[matches=true] | no-session | proto 2026-07-28->2025-11-25 | => 200
POST /mcp | auth[matches=true] | no-session | proto none                  | => 200
POST /mcp | auth[matches=true] | no-session | proto 2025-11-25            | => 202
POST /mcp | auth[matches=true] | no-session | proto 2025-11-25            | => 200
```

| What you see | What it means |
|---|---|
| `matches=false` | Token mismatch. Compare the `sha=` prefix on the startup line against the request line. |
| No `->` on an incoming `2026-07-28` | Shim is not loaded. Check the Render start command. |
| `=> 400` | Protocol version rejected. The shim isn't reaching `rawHeaders`. |
| `200` then `500`s | Transport lifecycle — the per-request construction has been reverted. |
| `=> 401` | Auth rejected before the transport. Expected for unauthenticated probes. |
| No `[shim]` lines at all | Process didn't start, or you're reading a drained instance. |

Startup lines that must be present:

```
[shim] v5 active — protocol, authorization and session bridging
[shim] env LGL_MCP_TOKEN: len=48 sha=…
LGL MCP server running over Streamable HTTP on http://localhost:10000/mcp
Secure Bearer Token Authentication is ENABLED.
```

---

## Two deployment traps

**Render's build cache defeats dependency changes.** Deleting `package-lock.json` alone
does nothing — Render restores `node_modules` from cache and logs
`up to date, audited 187 packages`. A real reinstall logs `added 188 packages`. Any
dependency change needs **Manual Deploy → Clear build cache**. That log line tells you
which one you got.

**Wait a full minute past "Your service is live."** Instance handover is gradual. A
connector attempt during the overlap can land on the drained instance and look like the
fix failed. This produced one false failure and a search for a sixth bug that did not
exist.

---

## Testing before you deploy

Do not deploy a change and infer the result from the connector's error message. The
feedback loop is too slow and too lossy. Run it locally:

```bash
npm install
LGL_API_KEY=... LGL_MCP_TOKEN=test-token \
  node --import ./mcp-protocol-shim.mjs index.js --http --port 3000
```

Then POST to `http://localhost:3000/mcp` with `MCP-Protocol-Version: 2026-07-28` and
`Authorization: Bearer test-token`. The seven cases that matter: initialize, tools/list,
tools/list again (catches the single-use transport), tools/call, a no-space Bearer header,
no auth header (expect 401), wrong token (expect 401).

The second `tools/list` is the important one. A single-use transport passes the first and
500s on the second.

---

## Environment variables

Set in Render, not in this repo. `LGL_READ_ONLY=true` and `LGL_ASSISTED_MODE=true`
together give Assisted mode: reads plus notes, and writes that land in LGL's Integration
Queue for human approval rather than going straight into the database. Keep it that way.
