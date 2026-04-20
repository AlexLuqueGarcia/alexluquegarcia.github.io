// Stateless challenge token for code-delivery 2FA.
//
// Flow:
//   1. /request-code: server generates a 6-digit code, delivers via Telegram.
//      Server creates a signed challenge token containing a HASH of the code
//      and returns it. Client holds the token in memory.
//   2. /login: client sends back { challenge, code }. Server verifies the
//      challenge signature, extracts the expiry + code hash, recomputes
//      the hash from the supplied code, and compares.
//
// Why hash-not-plaintext: if the challenge token were ever exposed (network
// intercept, XSS from a compromised extension, etc.), the code can't be
// extracted — only brute-forced. For a 6-digit code that's 10^6 possible
// values, which is small, but the challenge also expires in 2 minutes, so
// the attacker has a very narrow window AND still has to race the legit
// admin typing the code from Telegram first.
//
// Storage is stateless — no KV or DB needed. The server secret
// (ADMIN_SESSION_SECRET) is the only thing needed to verify.

const crypto = require('crypto');

const CHALLENGE_LIFETIME_SECONDS = 120; // 2 minutes

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

function getSecret() {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('ADMIN_SESSION_SECRET env var missing or too short');
  }
  return s;
}

// Cryptographically random 6-digit code.
function generateCode() {
  // crypto.randomInt(min, max) is inclusive-exclusive
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

// Creates a new challenge. Returns { code, challenge }.
// The code should be delivered to the user out-of-band (e.g. Telegram).
// The challenge token is signed and safe to return to the client.
function createChallenge() {
  const code = generateCode();
  const exp = Math.floor(Date.now() / 1000) + CHALLENGE_LIFETIME_SECONDS;
  const secret = getSecret();

  // Hash the code — the challenge token doesn't carry the code plaintext
  const codeHash = crypto.createHmac('sha256', secret)
    .update(code + ':' + exp)
    .digest('hex');

  const payload = { exp, codeHash };
  const payloadEncoded = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = crypto.createHmac('sha256', secret)
    .update(payloadEncoded)
    .digest();
  const signatureEncoded = base64urlEncode(signature);

  return {
    code,
    challenge: `${payloadEncoded}.${signatureEncoded}`,
  };
}

// Verify that the supplied code matches the challenge.
// Returns true on valid + non-expired + matching code, false otherwise.
function verifyChallenge(challenge, code) {
  if (typeof challenge !== 'string' || !challenge) return false;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;

  const parts = challenge.split('.');
  if (parts.length !== 2) return false;
  const [payloadEncoded, signatureEncoded] = parts;

  let secret;
  try { secret = getSecret(); } catch { return false; }

  // 1. Verify signature (timing-safe)
  const expectedSignature = crypto.createHmac('sha256', secret)
    .update(payloadEncoded).digest();
  let suppliedSignature;
  try { suppliedSignature = base64urlDecode(signatureEncoded); } catch { return false; }
  if (expectedSignature.length !== suppliedSignature.length) return false;
  if (!crypto.timingSafeEqual(expectedSignature, suppliedSignature)) return false;

  // 2. Decode and validate payload
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadEncoded).toString('utf8'));
  } catch { return false; }

  // 3. Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return false;
  if (typeof payload.codeHash !== 'string') return false;

  // 4. Verify code by hashing supplied code and comparing (timing-safe)
  const computedHash = crypto.createHmac('sha256', secret)
    .update(code + ':' + payload.exp)
    .digest('hex');
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(payload.codeHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { createChallenge, verifyChallenge, CHALLENGE_LIFETIME_SECONDS };
