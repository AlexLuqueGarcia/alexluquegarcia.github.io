// POST /api/admin/upload-photo?folder=X&filename=Y
// Raw JPG body. Uploads to {folder}/{filename} on Bunny Storage (NOT inside
// /thumbnail/). Filename must be the standard NN.jpg / NN.png / NN.webp
// format the main site expects — e.g. 01.jpg, 02.jpg.

const { requireAuth, applyCors } = require('./_auth');

module.exports.config = {
  api: {
    bodyParser: false,
    sizeLimit: '4mb',
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const url = new URL(req.url, 'http://localhost');
  const folder = url.searchParams.get('folder');
  const filename = url.searchParams.get('filename');

  if (!folder || !/^[a-z0-9][a-z0-9-_]{0,80}$/.test(folder)) {
    return res.status(400).json({ error: 'Invalid folder' });
  }
  // Enforce the "NN.ext" naming convention the main site expects.
  // Photo slot max = 99 so 2-digit padding is enough.
  if (!filename || !/^\d{2}\.(jpe?g|png|webp)$/i.test(filename)) {
    return res.status(400).json({ error: 'filename must match NN.jpg|png|webp (e.g. 01.jpg)' });
  }

  const zone = process.env.BUNNY_STORAGE_ZONE;
  const pass = process.env.BUNNY_STORAGE_PASSWORD;
  if (!zone || !pass) return res.status(500).json({ error: 'Bunny Storage not configured' });

  let body;
  try { body = await readRawBody(req); }
  catch { return res.status(400).json({ error: 'Failed to read body' }); }
  if (!body?.length) return res.status(400).json({ error: 'Empty body' });
  if (body.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'Photo too large (max 4 MB)' });

  // Derive content-type from extension
  const ext = filename.split('.').pop().toLowerCase();
  const contentType = ext === 'png' ? 'image/png'
                    : ext === 'webp' ? 'image/webp'
                    : 'image/jpeg';

  try {
    const putUrl = `https://storage.bunnycdn.com/${zone}/${folder}/${filename}`;
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: { AccessKey: pass, 'Content-Type': contentType },
      body,
    });
    if (!putRes.ok) {
      const errTxt = await putRes.text().catch(() => '');
      return res.status(502).json({ error: `Bunny Storage upload failed: ${putRes.status} ${errTxt}` });
    }
    return res.status(200).json({ ok: true, filename });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
