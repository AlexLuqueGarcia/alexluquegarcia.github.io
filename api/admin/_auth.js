// Shared auth helper for all /api/admin/* endpoints.
//
// After the 2FA login, the client sends a session TOKEN in the
// Authorization header: `Bearer <token>`. This token is validated
// against its HMAC signature and expiry (see _session.js).
//
// The raw ADMIN_PASSWORD is no longer accepted as a bearer token —
// password+TOTP is required to obtain a fresh session token via
// /api/admin/login.

const crypto = require('crypto');
const { verifySession } = require('./_session');

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Returns true if request is authenticated, false otherwise.
// Sends a 401 response and returns false if not — callers should return early.
function requireAuth(req, res) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const supplied = match ? match[1].trim() : '';

  if (!supplied) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  // Validate as session token (password+TOTP flow).
  const payload = verifySession(supplied);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized — session expired or invalid' });
    return false;
  }

  // Expose the session payload on the request for endpoints that want it
  req.session = payload;
  return true;
}

// Small helper — apply permissive CORS headers so the admin panel can call
// these endpoints even during local preview or if served from a different
// origin than the API.
function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = { requireAuth, applyCors, timingSafeEqualStr };
