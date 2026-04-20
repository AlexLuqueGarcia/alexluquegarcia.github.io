// POST /api/admin/login
// Body: { challenge: "...", code: "123456" }
// Returns: 200 { ok: true, token: "..." } on match, 401 on mismatch.
//
// Flow step 2 of 2:
//   - Takes the challenge token from /request-code
//   - Takes the 6-digit code the admin received via Telegram
//   - Verifies the challenge signature and code hash
//   - On success, issues a 12-hour session token
//
// Password was already verified in /request-code — this endpoint only
// validates the 2FA code. The challenge token proves a valid password was
// supplied because only /request-code can mint a valid signed challenge.

const { applyCors } = require('./_auth');
const { verifyChallenge } = require('./_challenge');
const { createSession } = require('./_session');

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ADMIN_SESSION_SECRET) {
    return res.status(500).json({ error: 'ADMIN_SESSION_SECRET not configured' });
  }

  const body = req.body || {};
  const challenge = typeof body.challenge === 'string' ? body.challenge : '';
  const code      = typeof body.code === 'string' ? body.code.trim() : '';

  if (!challenge || !code) {
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  if (!verifyChallenge(challenge, code)) {
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  // Code verified — issue session token (12h lifetime)
  let token;
  try {
    token = createSession();
  } catch (e) {
    return res.status(500).json({ error: 'Session creation failed: ' + e.message });
  }

  return res.status(200).json({ ok: true, token });
};
