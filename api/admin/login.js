// POST /api/admin/login
// Body: { password: "..." }
// Returns: 200 { ok: true } on match, 401 on mismatch.
// The client stores the password in sessionStorage and sends it as a Bearer
// token on every subsequent request. This endpoint just tells the UI whether
// the password is correct without performing any real work.

const { applyCors, timingSafeEqualStr } = require('./_auth');

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });

  const body = req.body || {};
  const supplied = typeof body.password === 'string' ? body.password : '';

  if (!timingSafeEqualStr(supplied, expected)) {
    // Deliberate small delay to slow down brute-force attempts further
    await new Promise(r => setTimeout(r, 400));
    return res.status(401).json({ error: 'Invalid password' });
  }

  return res.status(200).json({ ok: true });
};
