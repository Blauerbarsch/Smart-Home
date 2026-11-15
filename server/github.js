// GitHub: Repos abgleichen, neue Repos automatisch als Projekt anlegen,
// Details je Repo (Commits, Issues, Releases, Actions, README), Update-Prüfung des Dashboards.
import { EventEmitter } from 'node:events';
import { settings, projects, readJson, writeJson, id } from './store.js';

export const APP_REPO = process.env.APP_REPO || 'Blauerbarsch/Smart-Home';
export const APP_COMMIT = process.env.APP_COMMIT || 'dev';

// Bekannte Zuordnungen aus unseren Gesprächen: welches Repo läuft wo?
const KNOWN_RESOURCES = {
  'smart-home': [{ type: 'container', name: 'smart-home' }],
  minecraft: [{ type: 'vm', name: 'Linux' }],
  'local-ai': [{ type: 'host', name: 'Bazzite-PC' }],
  'video-player': [{ type: 'container', name: 'video-player' }],
};

// Namen/Beschreibungen, wo die README nichts Passendes hergibt
const KNOWN_INFO = {
  minecraft: { description: 'Plugins für den Minecraft-Server (WebConsole, OpWatch, ServerStats, WochenChallenge, GraveRestore …) – läuft in der Linux-VM auf Unraid.' },
  'pr-f-app': { name: 'Prüf-App', description: '' },
};

class GitHub extends EventEmitter {
  constructor() {
    super();
    const saved = readJson('github.json', { repos: [], ignored: [], synced: 0 });
    this.repos = saved.repos;
    this.ignored = new Set(saved.ignored);
    this.synced = saved.synced;
    this.cache = new Map();
    this.update = { latest: null, current: APP_COMMIT, available: false, checked: 0 };
    this.error = '';
  }

  save() {
    writeJson('github.json', { repos: this.repos, ignored: [...this.ignored], synced: this.synced });
  }

  async api(path, { raw = false } = {}) {
    const { githubToken } = settings();
    const res = await fetch((process.env.GITHUB_API || 'https://api.github.com') + path, {
      headers: {
        accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        'user-agent': 'smart-home-dashboard',
        'x-github-api-version': '2022-11-28',
        ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 150)}`);
    return raw ? res.text() : res.json();
  }

  start() {
    const run = () => this.sync().catch((e) => { this.error = e.message; console.error('GitHub-Abgleich:', e.message); });
    setTimeout(run, 3000);
    setInterval(run, 30 * 60e3).unref();
    const upd = () => this.checkUpdate().catch(() => {});
    setTimeout(upd, 5000);
    setInterval(upd, 30 * 60e3).unref();
  }

  async sync() {
    const s = settings();
    if (!s.githubUser && !s.githubToken) return;
    const list = s.githubToken
      ? await this.api('/user/repos?per_page=100&affiliation=owner&sort=pushed')
      : await this.api(`/users/${encodeURIComponent(s.githubUser)}/repos?per_page=100&sort=pushed`);
    this.repos = (list || []).map((r) => ({
      full_name: r.full_name, name: r.name, description: r.description, private: r.private, fork: r.fork, archived: r.archived,
      language: r.language, topics: r.topics || [], stars: r.stargazers_count, open_issues: r.open_issues_count,
      pushed_at: r.pushed_at, html_url: r.html_url, default_branch: r.default_branch, homepage: r.homepage, size: r.size,
    }));
    this.synced = Date.now();
    this.error = '';
    let created = 0;
    if (s.githubAutoProjects !== false) {
      for (const r of this.repos) {
        if (r.fork) continue;
        if (await this.ensureProject(r)) created++;
      }
    }
    this.save();
    this.emit('synced', { repos: this.repos.length, created });
    return { repos: this.repos.length, created };
  }

  projectFor(fullName) {
    const fn = fullName.toLowerCase();
    return projects.list.find((p) => p.repo?.toLowerCase() === fn) ||
      projects.list.find((p) => (p.links || []).some((l) => l.url?.toLowerCase().replace(/\/$/, '') === `https://github.com/${fn}`));
  }

  /** Projekt zu einem Repo sicherstellen. true, wenn neu angelegt. */
  async ensureProject(r) {
    const existing = this.projectFor(r.full_name);
    if (existing) {
      if (!existing.repo) projects.update(existing.id, { repo: r.full_name, resources: existing.resources?.length ? existing.resources : KNOWN_RESOURCES[r.name.toLowerCase()] || [] });
      return false;
    }
    if (this.ignored.has(r.full_name.toLowerCase())) return false;
    let readme = '';
    try { readme = (await this.api(`/repos/${r.full_name}/readme`, { raw: true })) || ''; } catch {}
    const { title, intro } = parseReadme(readme);
    const pushedDays = (Date.now() - Date.parse(r.pushed_at)) / 86400e3;
    const known = KNOWN_INFO[r.name.toLowerCase()] || {};
    projects.create({
      name: known.name || title || r.name.replace(/[-_]/g, ' '),
      description: r.description || known.description || intro || '',
      status: r.archived ? 'done' : pushedDays < 30 ? 'active' : 'paused',
      repo: r.full_name,
      tags: [r.language, ...(r.topics || [])].filter(Boolean),
      links: [{ label: 'GitHub', url: r.html_url }, ...(r.homepage ? [{ label: 'Webseite', url: r.homepage }] : [])],
      resources: KNOWN_RESOURCES[r.name.toLowerCase()] || [],
      color: pickColor(r.name),
      progress: 0,
      autoCreated: true,
    });
    return true;
  }

  ignore(fullName) {
    if (fullName) this.ignored.add(fullName.toLowerCase());
    this.save();
  }

  /** Details eines Repos, 5 Minuten gecached. */
  async details(fullName) {
    const c = this.cache.get(fullName);
    if (c && Date.now() - c.t < 5 * 60e3) return c.data;
    const [repo, commits, issues, release, runs, readme] = await Promise.all([
      this.api(`/repos/${fullName}`),
      this.api(`/repos/${fullName}/commits?per_page=8`).catch(() => []),
      this.api(`/repos/${fullName}/issues?state=open&per_page=15`).catch(() => []),
      this.api(`/repos/${fullName}/releases/latest`).catch(() => null),
      this.api(`/repos/${fullName}/actions/runs?per_page=5`).catch(() => null),
      this.api(`/repos/${fullName}/readme`, { raw: true }).catch(() => ''),
    ]);
    if (!repo) throw new Error('Repo nicht gefunden (privat? Token in den Einstellungen eintragen)');
    const data = {
      full_name: repo.full_name, url: repo.html_url, description: repo.description, private: repo.private, stars: repo.stargazers_count,
      forks: repo.forks_count, language: repo.language, default_branch: repo.default_branch, pushed_at: repo.pushed_at, size: repo.size,
      commits: (commits || []).map((x) => ({ sha: x.sha.slice(0, 7), message: x.commit.message.split('\n')[0], date: x.commit.author?.date, author: x.commit.author?.name, url: x.html_url })),
      issues: (issues || []).map((i) => ({ number: i.number, title: i.title, pr: Boolean(i.pull_request), url: i.html_url, created: i.created_at, labels: i.labels.map((l) => l.name) })),
      release: release && { tag: release.tag_name, name: release.name, date: release.published_at, url: release.html_url, assets: (release.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, downloads: a.download_count })) },
      runs: (runs?.workflow_runs || []).map((w) => ({ name: w.name, status: w.status, conclusion: w.conclusion, branch: w.head_branch, date: w.created_at, url: w.html_url, title: w.display_title })),
      readme: String(readme || '').slice(0, 20000),
    };
    this.cache.set(fullName, { t: Date.now(), data });
    return data;
  }

  /** Neuere Dashboard-Version auf GitHub? Vergleicht den eingebauten Commit mit main. */
  async checkUpdate() {
    const c = await this.api(`/repos/${APP_REPO}/commits/main`);
    if (!c) return this.update;
    const latest = c.sha;
    this.update = {
      current: APP_COMMIT,
      latest: latest.slice(0, 7),
      message: c.commit.message.split('\n')[0],
      date: c.commit.author?.date,
      available: APP_COMMIT !== 'dev' && !latest.startsWith(APP_COMMIT),
      checked: Date.now(),
    };
    this.emit('update', this.update);
    return this.update;
  }
}

function parseReadme(md) {
  const lines = String(md).split('\n');
  const h1 = lines.find((l) => /^#\s+/.test(l));
  const title = h1 ? h1.replace(/^#\s+/, '').replace(/\s*\(.*?\)\s*$/, '').trim() : '';
  const paras = String(md).replace(/^#.*$/gm, '').split(/\n\s*\n/).map((p) => p.trim())
    .filter((p) => p && !/^(\[!\[|!\[|<|```|\||-{3})/.test(p));
  const intro = (paras[0] || '').replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').slice(0, 300);
  return { title, intro };
}

const COLORS = ['#00d8ff', '#3ddc97', '#ffb547', '#ff6b9a', '#a78bfa', '#5eead4', '#f97316', '#84cc16'];
function pickColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export const github = new GitHub();
export { id };
