// POST /api/admin/create-project
// Body: { title, folder }
// 1. Creates a new video entry in Bunny Stream (returns GUID)
// 2. Generates an HMAC-SHA256 signature for TUS resumable upload
// 3. Returns all the info the browser needs to upload directly to Bunny
//
// The Stream API key never reaches the browser — only the short-lived signed
// signature for THIS specific video upload.

const crypto = require('crypto');
const { requireAuth, applyCors } = require('./_auth');

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const { title, folder } = req.body || {};
  if (!title || !folder) {
    return res.status(400).json({ error: 'title and folder are required' });
  }

  // Sanity-check the folder name — disallow path traversal, whitespace, etc.
  // Matches the convention used in projects/ folder names (e.g. "2025-bold").
  if (!/^[a-z0-9][a-z0-9-_]{0,80}$/.test(folder)) {
    return res.status(400).json({
      error: 'folder must be lowercase letters, digits, hyphens, or underscores only'
    });
  }

  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const apiKey    = process.env.BUNNY_STREAM_API_KEY;
  if (!libraryId || !apiKey) {
    return res.status(500).json({ error: 'Bunny Stream credentials not configured' });
  }

  try {
    // 1. Create video entry in Bunny Stream
    const createRes = await fetch(
      `https://video.bunnycdn.com/library/${libraryId}/videos`,
      {
        method: 'POST',
        headers: {
          'AccessKey': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ title }),
      }
    );

    if (!createRes.ok) {
      const errTxt = await createRes.text().catch(() => '');
      return res.status(502).json({
        error: `Bunny Stream create-video failed: ${createRes.status} ${errTxt}`,
      });
    }

    const video = await createRes.json();
    const videoId = video.guid;
    if (!videoId) {
      return res.status(502).json({ error: 'Bunny Stream did not return a video GUID' });
    }

    // 2. Generate TUS signature for direct browser upload
    // Signature format (from Bunny docs):
    //   sha256(library_id + api_key + expiration_time + video_id)
    // Expiration is a Unix timestamp (seconds). Give the client an hour to
    // finish uploading — more than enough for a 100 MB video on typical
    // connections, but short enough to limit exposure if the page is
    // compromised.
    const expire = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const signature = crypto
      .createHash('sha256')
      .update(`${libraryId}${apiKey}${expire}${videoId}`)
      .digest('hex');

    // 3. Return everything the client needs.
    // The streamUrl is the public HLS playlist URL that will eventually
    // serve the video once encoding completes — we store this in info.txt
    // so the portfolio site knows where to fetch the video.
    const pullZoneHost = video.hostname || `vz-${libraryId}.b-cdn.net`;
    const streamUrl = `https://${pullZoneHost}/${videoId}/playlist.m3u8`;

    return res.status(200).json({
      videoId,
      libraryId,
      folder,
      streamUrl,
      tusEndpoint: 'https://video.bunnycdn.com/tusupload',
      authorizationSignature: signature,
      authorizationExpire: expire,
      expiresAt: expire,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
