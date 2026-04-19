// GET /api/admin/list-projects
// Returns the full project catalog with parsed metadata, pulled from GitHub.
// Used by the admin UI to render the project list.

const { requireAuth, applyCors } = require('./_auth');

const GH_API = 'https://api.github.com';

async function ghFetch(path) {
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
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`GitHub ${path} → ${res.status}`);
  }
  return res.json();
}

// Decode base64 content from the GitHub contents API response
function ghDecode(obj) {
  if (!obj || !obj.content) return '';
  return Buffer.from(obj.content, 'base64').toString('utf-8');
}

// Parse info.txt into an object. Matches the format the main site's
// parseInfo() function uses: `key: value` pairs, with continuation lines
// (non-key lines) appended to the previous key separated by newlines.
function parseInfo(txt) {
  const data = {};
  let key = null;
  (txt || '').split('\n').forEach(line => {
    const m = line.match(/^(\w+):\s*(.*)/);
    if (m) { key = m[1]; data[key] = m[2]; }
    else if (key && line.trim()) { data[key] += '\n' + line.trim(); }
  });
  return data;
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAuth(req, res)) return;

  try {
    // 1. Fetch projects.json
    const manifestFile = await ghFetch('projects/projects.json');
    if (!manifestFile) return res.status(200).json({ projects: [] });

    let manifest;
    try { manifest = JSON.parse(ghDecode(manifestFile)); }
    catch (e) { return res.status(500).json({ error: 'projects.json is not valid JSON' }); }

    if (!Array.isArray(manifest)) {
      return res.status(500).json({ error: 'projects.json must be an array' });
    }

    // 2. Normalize entries and fetch each project's info.txt in parallel
    const normalized = manifest.map(entry => {
      if (typeof entry === 'string') return { folder: entry, pinned: false };
      return { folder: entry.folder, pinned: !!entry.pinned };
    });

    const projects = await Promise.all(normalized.map(async (entry) => {
      try {
        const infoFile = await ghFetch(`projects/${entry.folder}/info.txt`);
        const info = infoFile ? parseInfo(ghDecode(infoFile)) : {};
        return {
          folder:   entry.folder,
          pinned:   entry.pinned,
          name:     info.name || entry.folder,
          client:   info.client || '',
          studio:   info.studio || '',
          type:     info.type || '',
          year:     info.year || (entry.folder.match(/^(\d{4})/) || [])[1] || '',
          duration: info.duration || '',
          color:    info.color || '',
          about:    info.about || '',
          team:     info.team || '',
          credits:  info.credits || '',
          video:    info.video || '',
          frames:   info.frames || '',
          infoSha:  infoFile ? infoFile.sha : null,
        };
      } catch (e) {
        return {
          folder: entry.folder,
          pinned: entry.pinned,
          name: entry.folder,
          error: e.message,
        };
      }
    }));

    return res.status(200).json({
      projects,
      manifestSha: manifestFile.sha,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
