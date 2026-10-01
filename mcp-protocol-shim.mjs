// mcp-protocol-shim.mjs
//
// Loaded before index.js via:  node --import ./mcp-protocol-shim.mjs index.js
//
// WHY THIS EXISTS
// Claude's connector sends `MCP-Protocol-Version: 2026-07-28`. The pinned
// @modelcontextprotocol/sdk v1.x validates that header against a hardcoded list
// that stops at 2025-11-25 and answers anything newer with HTTP 400.
//
// This rewrites the header to a version the SDK accepts, before the request
// reaches any application code, and logs both the request and the status the
// server answered with — which this host does not otherwise record.
//
// Remove once the server moves to SDK v2, which speaks 2026-07-28 natively.

import http from 'node:http';

const ACCEPTED = '2025-11-25';
const HEADER = 'mcp-protocol-version';

const originalEmit = http.Server.prototype.emit;

http.Server.prototype.emit = function patchedEmit(event, ...args) {
  if (event === 'request') {
    const req = args[0];
    const res = args[1];
    try {
      const incoming = req?.headers?.[HEADER];
      const auth = req?.headers?.authorization ? 'auth' : 'no-auth';
      const accept = req?.headers?.accept || '-';
      const session = req?.headers?.['mcp-session-id'] ? 'session' : 'no-session';

      let protocolNote = incoming || 'none';
      if (incoming && incoming !== ACCEPTED) {
        req.headers[HEADER] = ACCEPTED;
        protocolNote = `${incoming}->${ACCEPTED}`;
      }

      const started = Date.now();
      const line = `${req.method} ${req.url} | ${auth} | ${session} | proto ${protocolNote} | accept ${accept}`;

      res?.once?.('finish', () => {
        console.log(`[shim] ${line} | => ${res.statusCode} (${Date.now() - started}ms)`);
      });
      res?.once?.('close', () => {
        if (!res.writableEnded) {
          console.log(`[shim] ${line} | => CLOSED without response (${Date.now() - started}ms)`);
        }
      });
    } catch (err) {
      console.log(`[shim] instrumentation skipped: ${err?.message}`);
    }
  }
  return originalEmit.call(this, event, ...args);
};

console.log(`[shim] v2 active — rewriting ${HEADER} to ${ACCEPTED}, logging requests and response codes`);
