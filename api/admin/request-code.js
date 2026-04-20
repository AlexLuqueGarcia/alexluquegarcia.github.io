// POST /api/admin/request-code
// Body: { password: "..." }
// Returns: 200 { ok: true, challenge: "..." } on match, 401 on mismatch.
//
// Flow step 1 of 2:
//   - Validates the admin password
//   - Generates a random 6-digit code
//   - Sends the code via Telegram to the admin's chat
//   - Returns a signed challenge token that the client sends back on /login
//
// If the password is wrong, no Telegram message is sent (prevents spam of
// codes to the admin's chat from password-guessing attackers).

const { applyCors, timingSafeEqualStr } = require('./_auth');
const { createChallenge } = require('./_challenge');
const { sendTelegramMessage } = require('./_telegram');

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expectedPassword = process.env.ADMIN_PASSWORD;
  if (!expectedPassword) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
  if (!process.env.ADMIN_SESSION_SECRET) {
    return res.status(500).json({ error: 'ADMIN_SESSION_SECRET not configured' });
  }
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_CHAT_ID) {
    return res.status(500).json({ error: 'Telegram bot not configured' });
  }

  const body = req.body || {};
  const supplied = typeof body.password === 'string' ? body.password : '';

  if (!timingSafeEqualStr(supplied, expectedPassword)) {
    // Slow down brute-force. Same delay regardless of outcome.
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ error: 'Invalid password' });
  }

  // Password is correct — generate code + challenge
  let code, challenge;
  try {
    const result = createChallenge();
    code = result.code;
    challenge = result.challenge;
  } catch (e) {
    return res.status(500).json({ error: 'Challenge generation failed: ' + e.message });
  }

  // Send code via Telegram
  try {
    const message =
      '🔐 *Admin login code*\n\n' +
      '`' + code + '`\n\n' +
      '_Valid for 2 minutes. Ignore if you did not request this._';
    await sendTelegramMessage(message);
  } catch (e) {
    return res.status(500).json({ error: 'Could not send code to Telegram: ' + e.message });
  }

  return res.status(200).json({ ok: true, challenge });
};
