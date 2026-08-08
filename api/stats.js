// /api/stats.js — Blacklight landing page telemetry
// Durable counters stored in a GitHub Gist. No npm dependencies.
// Env vars required: GH_TOKEN (gist scope), GIST_ID, GH_REPO

const GIST_FILE = 'stats.json';
const GH_API = 'https://api.github.com';

function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + process.env.GH_TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'peachtree-landing-stats',
    'Content-Type': 'application/json'
  };
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

// ---- Gist read ----
async function readStats() {
  const r = await fetch(GH_API + '/gists/' + process.env.GIST_ID, {
    headers: ghHeaders(),
    cache: 'no-store'
  });
  if (!r.ok) throw new Error('gist read failed: ' + r.status);
  const gist = await r.json();
  const file = gist.files && gist.files[GIST_FILE];
  if (!file) throw new Error('gist file ' + GIST_FILE + ' not found');

  let raw = file.content;
  // Very large gists come back truncated; fall back to raw_url.
  if (file.truncated && file.raw_url) {
    raw = await (await fetch(file.raw_url, { cache: 'no-store' })).text();
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { visits_total: 0, daily: {}, countries: {} };
  }
}

// ---- Gist write ----
async function writeStats(data) {
  const body = JSON.stringify({
    files: { [GIST_FILE]: { content: JSON.stringify(data) } }
  });
  const r = await fetch(GH_API + '/gists/' + process.env.GIST_ID, {
    method: 'PATCH',
    headers: ghHeaders(),
    body: body
  });
  if (!r.ok) throw new Error('gist write failed: ' + r.status);
}

// ---- GitHub Releases download total ----
async function readDownloads() {
  const r = await fetch(
    GH_API + '/repos/' + process.env.GH_REPO + '/releases?per_page=100',
    { headers: ghHeaders(), cache: 'no-store' }
  );
  if (!r.ok) throw new Error('releases failed: ' + r.status);
  const releases = await r.json();
  let total = 0;
  for (const rel of releases) {
    for (const a of (rel.assets || [])) {
      total += (a.download_count || 0);
    }
  }
  return total;
}

// ---- Prune daily map so the gist never grows without bound ----
function pruneDaily(daily) {
  const keys = Object.keys(daily).sort();
  while (keys.length > 90) {
    delete daily[keys.shift()];
  }
  return daily;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json');

  // Fail loudly (in the payload) if config is missing — no more silent rot.
  const missing = ['GH_TOKEN', 'GIST_ID', 'GH_REPO'].filter((k) => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({
      ok: false,
      error: 'Missing env vars: ' + missing.join(', ')
    });
  }

  const isNewSession = req.query.new === '1';
  const cc = (req.query.cc || '').toUpperCase().slice(0, 2);
  const today = todayKey();

  const out = { ok: true, today: today, errors: [] };

  // --- Downloads (independent: a failure here must not kill visits) ---
  try {
    out.downloads = await readDownloads();
  } catch (e) {
    out.downloads = null;
    out.errors.push('downloads: ' + e.message);
  }

  // --- Visit + country counters ---
  try {
    const data = await readStats();
    data.visits_total = data.visits_total || 0;
    data.daily = data.daily || {};
    data.countries = data.countries || {};

    if (isNewSession) {
      data.visits_total += 1;
      data.daily[today] = (data.daily[today] || 0) + 1;
      if (/^[A-Z]{2}$/.test(cc)) {
        data.countries[cc] = (data.countries[cc] || 0) + 1;
      }
      data.daily = pruneDaily(data.daily);
      await writeStats(data);
    }

    out.visits_total = data.visits_total;
    out.visits_today = data.daily[today] || 0;
    out.countries = data.countries;
  } catch (e) {
    out.ok = false;
    out.visits_total = null;
    out.visits_today = null;
    out.countries = {};
    out.errors.push('visits: ' + e.message);
  }

  return res.status(200).json(out);
}
