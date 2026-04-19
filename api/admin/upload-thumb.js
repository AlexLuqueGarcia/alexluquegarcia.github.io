// POST /api/admin/upload-thumb
// Receives a single thumbnail JPG and forwards it to Bunny Storage at
// /{folder}/thumbnail/{filename}. Each request is small (~50 KB) so even
// on Vercel Hobby's 4.5 MB body limit we're fine. The browser sends these
// in parallel (e.g. 10 at a time) to upload the full set quickly.
//
// Request: multipart/form-data OR raw body with query params
//   - folder (query string): destination folder, validated
//   - filename (query string): must match video_NNN.jpg
//   - body (octet-stream): raw JPG bytes
//
// Using raw binary body + query string rather than multipart keeps the
// Vercel function simple and avoids the need for a multipart parser.

const { requireAuth, applyCors } = require('./_auth');

// Disable Vercel's default body parser so we get the raw request stream
module.exports.config = {
  api: {
    bodyParser: false,
    // Hobby allows up to 4.5 MB request body. Thumbs are nowhere near that
    // but set an explicit cap so a malicious upload can't waste memory.
    sizeLimit: '2mb',
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
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

  // Validate folder and filename — folder matches the create-project rule,
  // filename must be video_NNN.jpg (3-digit zero-padded, zero-indexed).
  if (!folder || !/^[a-z0-9][a-z0-9-_]{0,80}$/.test(folder)) {
    return res.status(400).json({ error: 'Invalid folder' });
  }
  if (!filename || !/^video_\d{3}\.jpg$/.test(filename)) {
    return res.status(400).json({ error: 'filename must match video_NNN.jpg' });
  }

  const zone     = process.env.BUNNY_STORAGE_ZONE;
  const password = process.env.BUNNY_STORAGE_PASSWORD;
  if (!zone || !password) {
    return res.status(500).json({ error: 'Bunny Storage credentials not configured' });
  }

  let body;
  try {
    body = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Failed to read request body' });
  }
  if (!body || body.length === 0) {
    return res.status(400).json({ error: 'Empty body' });
  }
  if (body.length > 2 * 1024 * 1024) {
    return res.status(413).json({ error: 'Thumbnail too large (max 2 MB)' });
  }

  try {
    const putUrl = `https://storage.bunnycdn.com/${zone}/${folder}/thumbnail/${filename}`;
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'AccessKey': password,
        'Content-Type': 'image/jpeg',
      },
      body,
    });
    if (!putRes.ok) {
      const errTxt = await putRes.text().catch(() => '');
      return res.status(502).json({
        error: `Bunny Storage upload failed: ${putRes.status} ${errTxt}`,
      });
    }
    return res.status(200).json({ ok: true, filename });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
