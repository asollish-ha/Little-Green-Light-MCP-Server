// mcp-protocol-shim.mjs
//
// Loaded before index.js via:  node --import ./mcp-protocol-shim.mjs index.js
//
// WHY THIS EXISTS
// Claude's connector now sends `MCP-Protocol-Version: 2026-07-28`. The pinned
// @modelcontextprotocol/sdk v1.x validates that header against a hardcoded list
// that stops at 2025-11-25, and answers anything newer with HTTP 400. Claude
// surfaces that 400 as "Couldn't connect to the server."
//
// This rewrites the header to a version the SDK accepts, before the request
// reaches any application code. It also logs every request, which this host
// does not otherwise record.
//
// Remove this shim once the server moves to SDK v2, which speaks 2026-07-28
// natively.

import http from 'node:http';

const ACCEPTED = '2025-11-25';
const HEADER = 'mcp-protocol-version';

const originalEmit = http.Server.prototype.emit;

http.Server.prototype.emit = function patchedEmit(event, ...args) {
  if (event === 'request') {
    const req = args[0];
    try {
      const incoming = req?.headers?.[HEADER];
      const auth = req?.headers?.authorization ? 'with auth' : 'no auth';

      if (incoming && incoming !== ACCEPTED) {
        req.headers[HEADER] = ACCEPTED;
        console.log(
          `[shim] ${req.method} ${req.url} | ${auth} | protocol ${incoming} -> ${ACCEPTED}`
        );
      } else {
        console.log(
          `[shim] ${req.method} ${req.url} | ${auth} | protocol ${incoming || 'none'}`
        );
      }
    } catch (err) {
      // Never let logging or header rewriting take the server down.
      console.log(`[shim] header rewrite skipped: ${err?.message}`);
    }
  }
  return originalEmit.call(this, event, ...args);
};

console.log(`[shim] active — rewriting ${HEADER} to ${ACCEPTED}, logging all requests`);
