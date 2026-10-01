// mcp-protocol-shim.mjs
//
// Loaded before index.js via:  node --import ./mcp-protocol-shim.mjs index.js
//
// Three jobs:
//   1. Rewrite `MCP-Protocol-Version` to a value the pinned SDK v1 accepts.
//      Claude sends 2026-07-28; SDK v1.31.0 rejects anything past 2025-11-25.
//   2. Repair the Authorization header. Claude's connector UI strips the space
//      after "Bearer", so the header arrives as "Bearer<token>" and no server
//      can parse it. This puts the space back.
//   3. Log each request and its response status, with safe fingerprints
//      (character counts and SHA-256 prefixes, never the secret itself).

import http from 'node:http';
import { createHash } from 'node:crypto';

const ACCEPTED = '2025-11-25';
const HEADER = 'mcp-protocol-version';

const fp = (s) =>
  s === undefined || s === null
    ? 'absent'
    : `len=${s.length} sha=${createHash('sha256').update(s).digest('hex').slice(0, 8)}`;

const envToken = process.env.LGL_MCP_TOKEN;
console.log(`[shim] v4 active — protocol rewrite + Authorization repair`);
console.log(`[shim] env LGL_MCP_TOKEN: ${fp(envToken)}`);

const originalEmit = http.Server.prototype.emit;

http.Server.prototype.emit = function patchedEmit(event, ...args) {
  if (event === 'request') {
    const req = args[0];
    const res = args[1];
    try {
      // --- 1. protocol version ---
      const incoming = req?.headers?.[HEADER];
      let protocolNote = incoming || 'none';
      if (incoming && incoming !== ACCEPTED) {
        req.headers[HEADER] = ACCEPTED;
        protocolNote = `${incoming}->${ACCEPTED}`;
      }

      // --- 2. authorization repair ---
      let authNote = 'no-auth';
      const raw = req?.headers?.authorization;
      if (typeof raw === 'string') {
        let fixed = raw;
        let repaired = false;

        // "Bearer<token>" with no separator -> "Bearer <token>"
        if (/^Bearer[^\s]/i.test(fixed)) {
          fixed = `${fixed.slice(0, 6)} ${fixed.slice(6)}`;
          repaired = true;
        }

        // Bare token with no scheme at all -> add one.
        if (!/^Bearer\s/i.test(fixed) && envToken && fixed.trim() === envToken) {
          fixed = `Bearer ${fixed.trim()}`;
          repaired = true;
        }

        if (repaired) req.headers.authorization = fixed;

        const token = fixed.replace(/^Bearer\s+/i, '');
        authNote = `auth[repaired=${repaired} token:${fp(token)} matches=${envToken !== undefined && token === envToken}]`;
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
