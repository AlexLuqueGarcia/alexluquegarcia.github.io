// Session token utility for admin auth.
//
// Tokens are signed with HMAC-SHA256 using ADMIN_SESSION_SECRET env var.
// Format: <payload_base64url>.<signature_base64url>
// Payload: JSON { iat: <issuedAt>, exp: <expiresAt> } — both in Unix seconds.
//
// Tokens expire after SESSION_LIFETIME_HOURS (12h default). On expiry, the
// admin has to re-authenticate with password + TOTP.
//
// This is a simplified JWT-like format, no external library dependency.

const crypto = require('crypto');

const SESSION_LIFETIME_HOURS = 12;

function base64urlEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLength), 'base64');
}

function getSigningSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('ADMIN_SESSION_SECRET env var missing or too short (need at least 16 chars)');
  }
  return secret;
}

// Create a new session token. Returns the token string.
function createSession() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + SESSION_LIFETIME_HOURS * 3600,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadEncoded = base64urlEncode(Buffer.from(payloadJson, 'utf8'));

  const signature = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadEncoded)
    .digest();
  const signatureEncoded = base64urlEncode(signature);

  return `${payloadEncoded}.${signatureEncoded}`;
}

// Verify a session token. Returns the decoded payload if valid, or null.
// Valid = signature matches AND exp is in the future.
function verifySession(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadEncoded, signatureEncoded] = parts;

  let secret;
  try {
    secret = getSigningSecret();
  } catch {
    return null;
  }

  // Verify signature first (timing-safe)
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payloadEncoded)
    .digest();
  let suppliedSignature;
  try {
    suppliedSignature = base64urlDecode(signatureEncoded);
  } catch {
    return null;
  }
  if (expectedSignature.length !== suppliedSignature.length) return null;
  if (!crypto.timingSafeEqual(expectedSignature, suppliedSignature)) return null;

  // Decode + validate payload
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadEncoded).toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;

  return payload;
}

module.exports = { createSession, verifySession, SESSION_LIFETIME_HOURS };
