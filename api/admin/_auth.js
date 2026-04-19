// Shared auth helper for all /api/admin/* endpoints.
// Expects the admin password in the Authorization header: `Bearer <password>`.
// Uses a constant-time compare to avoid timing-based brute force attacks.

const crypto = require('crypto');

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
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    res.status(500).json({ error: 'ADMIN_PASSWORD env var not configured' });
    return false;
  }
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const supplied = match ? match[1] : '';
  if (!timingSafeEqualStr(supplied, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Small helper — apply permissive CORS headers so the admin panel can call
// these endpoints even during local preview or if served from a different
// origin than the API. Since every endpoint requires the admin password in
// the Authorization header anyway, CORS being permissive is not a risk.
function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = { requireAuth, applyCors, timingSafeEqualStr };
