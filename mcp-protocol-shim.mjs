// mcp-protocol-shim.mjs
//
// Loaded before index.js via:  node --import ./mcp-protocol-shim.mjs index.js
//
// Does two things:
//   1. Rewrites `MCP-Protocol-Version` to a value the pinned SDK v1 accepts.
//   2. Logs each request, the status it got, and a SAFE fingerprint of the
//      credential comparison so a 401 can be diagnosed without revealing
//      any secret.
//
// The fingerprints are the first 8 hex characters of a SHA-256 digest plus a
// character count. A digest prefix cannot be reversed into the token.

import http from 'node:http';
import { createHash } from 'node:crypto';

const ACCEPTED = '2025-11-25';
const HEADER = 'mcp-protocol-version';

const fp = (s) =>
  s === undefined || s === null
    ? 'absent'
    : `len=${s.length} sha=${createHash('sha256').update(s).digest('hex').slice(0, 8)}`;

// Snapshot what the server was started with.
const envToken = process.env.LGL_MCP_TOKEN;
console.log(`[shim] v3 active — protocol rewrite to ${ACCEPTED}`);
console.log(`[shim] env LGL_MCP_TOKEN: ${fp(envToken)}`);
if (typeof envToken === 'string' && envToken !== envToken.trim()) {
  console.log('[shim] WARNING: env LGL_MCP_TOKEN has leading or trailing whitespace');
}

const originalEmit = http.Server.prototype.emit;

http.Server.prototype.emit = function patchedEmit(event, ...args) {
  if (event === 'request') {
    const req = args[0];
    const res = args[1];
    try {
      const incoming = req?.headers?.[HEADER];
      let protocolNote = incoming || 'none';
      if (incoming && incoming !== ACCEPTED) {
        req.headers[HEADER] = ACCEPTED;
        protocolNote = `${incoming}->${ACCEPTED}`;
      }

      const raw = req?.headers?.authorization;
      let authNote = 'no-auth';
      if (typeof raw === 'string') {
        const hasBearer = /^Bearer\s/i.test(raw);
        const stripped = raw.replace(/^Bearer\s+/i, '');
        const matchRaw = envToken !== undefined && raw === envToken;
        const matchStripped = envToken !== undefined && stripped === envToken;
        authNote =
          `auth[bearer=${hasBearer} raw:${fp(raw)} stripped:${fp(stripped)} ` +
          `matchRaw=${matchRaw} matchStripped=${matchStripped}]`;
      }

      const started = Date.now();
      const line = `${req.method} ${req.url} | ${authNote} | proto ${protocolNote}`;

      res?.once?.('finish', () => {
        console.log(`[shim] ${line} | => ${res.statusCode} (${Date.now() - started}ms)`);
      });
    } catch (err) {
      console.log(`[shim] instrumentation skipped: ${err?.message}`);
    }
  }
  return originalEmit.call(this, event, ...args);
};
