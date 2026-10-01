// mcp-protocol-shim.mjs
//
// Loaded before index.js via:  node --import ./mcp-protocol-shim.mjs index.js
//
// Bridges Claude's 2026-07-28 connector to a server pinned on
// @modelcontextprotocol/sdk v1.31.0:
//
//   1. Protocol version — Claude sends 2026-07-28; the SDK accepts nothing
//      past 2025-11-25. Rewrite it.
//   2. Authorization — Claude's connector UI strips the space after "Bearer",
//      so the header arrives as "Bearer<token>". Put the space back.
//   3. Session id — the old protocol issues an Mcp-Session-Id at initialize and
//      demands it on every later call. The 2026-07-28 spec removed sessions, so
//      Claude never sends one. Remember the id the server issues and supply it
//      on later requests that arrive without one.
//   4. Logging — request, response status, and on any non-2xx the first part of
//      the server's error body. Credentials appear only as a length and a
//      SHA-256 prefix, never in the clear.

import http from 'node:http';
import { createHash } from 'node:crypto';

const ACCEPTED = '2025-11-25';
const PROTO = 'mcp-protocol-version';
const SESSION = 'mcp-session-id';

const fp = (s) =>
  s === undefined || s === null
    ? 'absent'
    : `len=${s.length} sha=${createHash('sha256').update(s).digest('hex').slice(0, 8)}`;

const envToken = process.env.LGL_MCP_TOKEN;
let knownSession = null;

console.log('[shim] v5 active — protocol, authorization and session bridging');
console.log(`[shim] env LGL_MCP_TOKEN: ${fp(envToken)}`);

const originalEmit = http.Server.prototype.emit;

http.Server.prototype.emit = function patchedEmit(event, ...args) {
  if (event === 'request') {
    const req = args[0];
    const res = args[1];
    try {
      // --- protocol version ---
      const incoming = req.headers?.[PROTO];
      let protoNote = incoming || 'none';
      if (incoming && incoming !== ACCEPTED) {
        req.headers[PROTO] = ACCEPTED;
        protoNote = `${incoming}->${ACCEPTED}`;
      }

      // --- authorization repair ---
      let authNote = 'no-auth';
      const raw = req.headers?.authorization;
      if (typeof raw === 'string') {
        let fixed = raw;
        if (/^Bearer[^\s]/i.test(fixed)) fixed = `${fixed.slice(0, 6)} ${fixed.slice(6)}`;
        else if (!/^Bearer\s/i.test(fixed) && envToken && fixed.trim() === envToken)
          fixed = `Bearer ${fixed.trim()}`;
        req.headers.authorization = fixed;
        const token = fixed.replace(/^Bearer\s+/i, '');
        authNote = `auth[matches=${envToken !== undefined && token === envToken}]`;
      }

      // --- session bridging ---
      let sessionNote = 'no-session';
      if (req.headers?.[SESSION]) {
        sessionNote = 'session-sent';
      } else if (knownSession) {
        req.headers[SESSION] = knownSession;
        sessionNote = 'session-injected';
      }

      // Capture the session id the server hands back.
      const origSetHeader = res.setHeader.bind(res);
      res.setHeader = function (name, value) {
        if (String(name).toLowerCase() === SESSION && value) {
          knownSession = String(value);
          console.log(`[shim] captured session id (${fp(knownSession)})`);
        }
        return origSetHeader(name, value);
      };

      // Capture a short slice of the response body, for error diagnosis only.
      let body = '';
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      res.write = function (chunk, ...rest) {
        if (chunk && body.length < 400) body += String(chunk).slice(0, 400);
        return origWrite(chunk, ...rest);
      };
      res.end = function (chunk, ...rest) {
        if (chunk && body.length < 400) body += String(chunk).slice(0, 400);
        return origEnd(chunk, ...rest);
      };

      const started = Date.now();
      const line = `${req.method} ${req.url} | ${authNote} | ${sessionNote} | proto ${protoNote}`;
      res.once('finish', () => {
        const ms = Date.now() - started;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[shim] ${line} | => ${res.statusCode} (${ms}ms)`);
        } else {
          console.log(
            `[shim] ${line} | => ${res.statusCode} (${ms}ms) | body: ${body.replace(/\s+/g, ' ').slice(0, 300)}`
          );
        }
      });
    } catch (err) {
      console.log(`[shim] instrumentation skipped: ${err?.message}`);
    }
  }
  return originalEmit.call(this, event, ...args);
};
