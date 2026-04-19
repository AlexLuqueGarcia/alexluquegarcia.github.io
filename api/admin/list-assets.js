// GET /api/admin/list-assets?folder=2025-bold
// Returns lists of photos and thumbnails currently stored in Bunny for this
// project, plus the current video URL parsed from info.txt. Used by the
// admin UI to render media previews in the edit view.

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

// List the contents of a Bunny Storage folder (non-recursive).
// Returns [] if the folder doesn't exist yet, rather than erroring, so the
// UI handles empty projects cleanly.
async function bunnyList(folderPath) {
  const zone = process.env.BUNNY_STORAGE_ZONE;
  const pass = process.env.BUNNY_STORAGE_PASSWORD;
  const url = `https://storage.bunnycdn.com/${zone}/${folderPath}/`;
  const res = await fetch(url, {
    headers: { AccessKey: pass, Accept: 'application/json' },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Bunny Storage list ${folderPath} → ${res.status}`);
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAuth(req, res)) return;

  const url = new URL(req.url, 'http://localhost');
  const folder = url.searchParams.get('folder');
  if (!folder || !/^[a-z0-9][a-z0-9-_]{0,80}$/.test(folder)) {
    return res.status(400).json({ error: 'Invalid folder' });
  }

  try {
    // 1. Fetch project-folder contents (images) and thumbnail subfolder contents
    // in parallel.
    const [rootItems, thumbItems, infoFile] = await Promise.all([
      bunnyList(folder),
      bunnyList(`${folder}/thumbnail`),
      ghGet(`projects/${folder}/info.txt`),
    ]);

    // 2. Parse info.txt to get the video URL and any explicit images list
    let videoUrl = '';
    let infoImages = '';
    if (infoFile && infoFile.content) {
      const txt = Buffer.from(infoFile.content, 'base64').toString('utf-8');
      const mv = txt.match(/^video:\s*(.*)$/m);
      const mi = txt.match(/^images:\s*(.*)$/m);
      if (mv) videoUrl = mv[1].trim();
      if (mi) infoImages = mi[1].trim();
    }

    // 3. Photos = image files in the project root (not in thumbnail/).
    // Filter out non-image files + any folders that happen to be there.
    const imageExt = /\.(jpe?g|png|webp|gif)$/i;
    const photos = rootItems
      .filter(it => !it.IsDirectory && imageExt.test(it.ObjectName))
      .map(it => ({
        name: it.ObjectName,
        size: it.Length,
        url: `${process.env.BUNNY_PULL_ZONE_URL}/${folder}/${it.ObjectName}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    // 4. Thumbnail frames
    const thumbs = thumbItems
      .filter(it => !it.IsDirectory && /^video_\d{3}\.jpg$/.test(it.ObjectName))
      .map(it => ({
        name: it.ObjectName,
        size: it.Length,
        url: `${process.env.BUNNY_PULL_ZONE_URL}/${folder}/thumbnail/${it.ObjectName}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    // 5. Extract Stream video GUID from video URL (if it's a Bunny Stream URL).
    // URL format: https://vz-xxx.b-cdn.net/{guid}/playlist.m3u8
    let videoGuid = null;
    const guidMatch = videoUrl.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
    if (guidMatch) videoGuid = guidMatch[1];

    return res.status(200).json({
      folder,
      videoUrl,
      videoGuid,
      photos,
      thumbs,
      infoImages,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
