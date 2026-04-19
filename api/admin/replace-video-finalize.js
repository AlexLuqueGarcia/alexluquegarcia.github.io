// POST /api/admin/replace-video-finalize
// Body: { folder, newVideoUrl, newFrames (comma-separated string), oldVideoGuid? }
// Used after the browser has: (1) uploaded the new video to Bunny Stream,
// (2) deleted the old thumbnail files, (3) extracted + uploaded new thumbs.
// This endpoint commits the info.txt changes to GitHub and best-effort
// deletes the old Bunny Stream video.

const { requireAuth, applyCors } = require('./_auth');

const GH_API = 'https://api.github.com';

async function ghGet(path) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'portfolio-admin',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}`);
  return res.json();
}

async function ghPut(path, content, message, sha) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const body = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'portfolio-admin',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`GitHub PUT ${path} → ${res.status} ${errTxt}`);
  }
  return res.json();
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const { folder, newVideoUrl, newFrames, oldVideoGuid } = req.body || {};
  if (!folder || !/^[a-z0-9][a-z0-9-_]{0,80}$/.test(folder)) {
    return res.status(400).json({ error: 'Invalid folder' });
  }
  if (!newVideoUrl || !newFrames) {
    return res.status(400).json({ error: 'newVideoUrl and newFrames are required' });
  }

  const warnings = [];

  try {
    // 1. Fetch current info.txt, rewrite video: and frames: lines
    const infoPath = `projects/${folder}/info.txt`;
    const existing = await ghGet(infoPath);
    if (!existing) return res.status(404).json({ error: `${infoPath} not found` });

    const currentTxt = Buffer.from(existing.content, 'base64').toString('utf-8');
    const newTxt = replaceOrAppendField(
      replaceOrAppendField(currentTxt, 'video', newVideoUrl),
      'frames',
      newFrames
    );

    await ghPut(infoPath, newTxt, `Replace video for ${folder}`, existing.sha);

    // 2. Best-effort: delete the old Bunny Stream video so abandoned videos
    // don't accumulate. Failure here doesn't fail the whole operation.
    if (oldVideoGuid) {
      try {
        const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
        const apiKey = process.env.BUNNY_STREAM_API_KEY;
        const delRes = await fetch(
          `https://video.bunnycdn.com/library/${libraryId}/videos/${oldVideoGuid}`,
          { method: 'DELETE', headers: { AccessKey: apiKey } }
        );
        if (!delRes.ok && delRes.status !== 404) {
          warnings.push(`Old Stream video not deleted: ${delRes.status}`);
        }
      } catch (e) {
        warnings.push(`Old Stream video delete failed: ${e.message}`);
      }
    }

    return res.status(200).json({
      ok: true,
      folder,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, warnings });
  }
};

// Replace an existing `key: ...` line in info.txt, or append if it doesn't
// exist. Preserves the rest of the file exactly.
function replaceOrAppendField(txt, key, value) {
  const re = new RegExp(`^${key}:\\s*.*$`, 'm');
  const line = `${key}: ${String(value).trim()}`;
  if (re.test(txt)) {
    return txt.replace(re, line);
  }
  // Append with a newline separator if the file doesn't end with one.
  const sep = txt.endsWith('\n') ? '' : '\n';
  return txt + sep + line + '\n';
}
