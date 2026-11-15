// Werkstatt-Erweiterungen: GitHub, Tagebuch, Server-Ressourcen, ESPHome, Teilelager, Repo-Liste.
import { S, h, icon, api, apiStream, toast, modal, ago, emit } from './core.js';

const sub = (t) => h('div', { class: 'hud-h', style: { padding: '14px 0 6px', border: 0 } }, t);
const running = (st) => ['RUNNING', 'IDLE'].includes(String(st).toUpperCase());

// ---------- Kleines Markdown für READMEs (sicher) ----------
export function mdRender(src, mdFn) {
  return h('div', { class: 'md', html: mdFn(src) });
}

const runIcon = (r) => (r.status !== 'completed' ? ['progress-clock', '#ffb547'] : r.conclusion === 'success' ? ['check-circle', '#3ddc97'] : r.conclusion === 'cancelled' || r.conclusion === 'skipped' ? ['minus-circle', '#8193a8'] : ['close-circle', '#ff5d6c']);

/** Kurzinfo zum Repo für die Übersicht (letzter Commit, Build). */
export function repoSummary(p) {
  const box = h('div', { class: 'readouts' }, h('div', { class: 'ai-empty' }, 'GitHub …'));
  api(`/github/repo/${p.repo}`).then((d) => {
    const run = d.runs[0];
    const [ic, col] = run ? runIcon(run) : ['minus', '#8193a8'];
    box.replaceChildren(
      readout('Letzter Commit', d.commits[0] ? ago(Date.parse(d.commits[0].date)) : '–', d.commits[0]?.message),
      readout('Build', run ? h('span', { style: { color: col } }, icon(ic), ' ', run.conclusion || run.status) : '–', run?.name),
      readout('Offen', `${d.issues.filter((i) => !i.pr).length} Issues · ${d.issues.filter((i) => i.pr).length} PRs`),
      readout('Release', d.release?.tag || '–', d.release ? ago(Date.parse(d.release.date)) : ''));
  }).catch((e) => box.replaceChildren(h('div', { class: 'ai-empty' }, e.message)));
  return [sub('GitHub · ' + p.repo), box];
}

function readout(k, v, title) {
  return h('div', { class: 'readout', title: title || '' }, h('div', { class: 'k' }, k), h('div', { class: 'v', style: { fontSize: '16px' } }, v));
}

// ---------- GitHub-Reiter ----------
export function githubTab(p, add, mdFn, save, redraw) {
  if (!p.repo) {
    const input = h('input', { class: 'hud-input', placeholder: 'Blauerbarsch/mein-repo' });
    add(h('div', { class: 'ai-empty' }, 'Noch kein Repo verknüpft.'), h('div', { style: { display: 'flex', gap: '6px' } }, input,
      h('button', { class: 'hud-btn', onclick: () => { p.repo = input.value.trim().replace(/^https:\/\/github\.com\//, ''); save(); redraw(); } }, 'Verknüpfen')));
    return;
  }
  const box = h('div', {}, h('div', { class: 'ai-empty' }, 'Lade ' + p.repo + ' …'));
  add(box);
  api(`/github/repo/${p.repo}`).then((d) => {
    box.replaceChildren(h('div', {},
      h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
        h('a', { class: 'hud-btn', href: d.url, target: '_blank' }, icon('github'), d.full_name),
        d.private ? h('span', { class: 'hud-btn' }, icon('lock-outline'), 'privat') : null,
        d.language ? h('span', { class: 'hud-btn' }, d.language) : null,
        h('span', { class: 'hud-btn' }, icon('star-outline'), d.stars),
        h('a', { class: 'hud-btn', href: d.url + '/issues/new', target: '_blank' }, icon('plus'), 'Issue')),
      d.description ? h('div', { class: 'pdesc', style: { margin: '10px 0 0' } }, d.description) : null,
      d.runs.length ? [sub('Builds'), d.runs.map((r) => {
        const [ic, col] = runIcon(r);
        return h('a', { class: 'task', href: r.url, target: '_blank', style: { color: 'inherit', textDecoration: 'none' } },
          h('span', { style: { color: col } }, icon(ic)), h('span', { class: 't' }, `${r.name} · ${r.title || r.branch}`), h('span', { class: 'gh-meta' }, ago(Date.parse(r.date))));
      })] : null,
      d.release ? [sub('Release ' + d.release.tag), h('div', {}, d.release.assets.map((a) => h('a', { class: 'task', href: a.url, target: '_blank', style: { color: 'inherit', textDecoration: 'none' } },
        icon('download'), h('span', { class: 't' }, a.name), h('span', { class: 'gh-meta' }, `${a.downloads} ×`))), !d.release.assets.length ? h('a', { href: d.release.url, target: '_blank' }, d.release.name || d.release.tag) : null)] : null,
      d.issues.length ? [sub('Offene Issues & PRs'), d.issues.map((i) => h('div', { class: 'task' },
        icon(i.pr ? 'source-pull' : 'record-circle-outline'),
        h('a', { class: 't', href: i.url, target: '_blank', style: { color: 'inherit' } }, `#${i.number} ${i.title}`),
        !i.pr ? h('button', { class: 'hud-btn icon', title: 'Als Aufgabe übernehmen', onclick: () => { p.tasks.push({ id: Math.random().toString(36).slice(2, 9), text: `#${i.number} ${i.title}`, done: false }); save(); toast('Als Aufgabe übernommen'); } }, icon('playlist-plus')) : null))] : null,
      sub('Letzte Commits'), d.commits.map((c) => h('a', { class: 'task', href: c.url, target: '_blank', style: { color: 'inherit', textDecoration: 'none' } },
        h('code', { class: 'gh-sha' }, c.sha), h('span', { class: 't' }, c.message), h('span', { class: 'gh-meta' }, ago(Date.parse(c.date))))),
      d.readme ? [sub('README'), mdRender(d.readme.replace(/!\[[^\]]*\]\([^)]*\)/g, ''), mdFn)] : null));
  }).catch((e) => box.replaceChildren(h('div', { class: 'ai-empty' }, e.message)));
}

// ---------- Tagebuch ----------
export function diaryTab(p, add) {
  const list = h('div', { class: 'diary' });
  const text = h('textarea', { class: 'hud-input', rows: 2, style: { minHeight: '60px' }, placeholder: 'Was hast du heute gemacht? Foto dazu?' });
  let image = null;
  const preview = h('div', { class: 'diary-preview' });
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' }, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const blob = await shrink(f);
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
    const j = await res.json();
    if (!res.ok) return toast(j.error, true);
    image = j.url;
    preview.replaceChildren(h('img', { src: image }), h('button', { class: 'hud-btn icon', onclick: () => { image = null; preview.replaceChildren(); } }, icon('close')));
  } });
  const load = () => api(`/projects/${p.id}/log`).then((rows) => list.replaceChildren(...(rows.length ? rows.map(entry) : [h('div', { class: 'ai-empty' }, 'Noch keine Einträge')])));
  const entry = (r) => h('div', { class: 'diary-entry' },
    h('div', { class: 'diary-date' }, new Date(r.ts).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }),
      h('button', { class: 'x', onclick: async () => { if (!confirm('Eintrag löschen?')) return; await api(`/projects/${p.id}/log/${r.id}`, { method: 'DELETE' }); load(); } }, '×')),
    r.text ? h('div', { class: 'diary-text' }, r.text) : null,
    r.image ? h('img', { class: 'diary-img', src: r.image, loading: 'lazy', onclick: () => modal('Foto', h('img', { src: r.image, style: { width: '100%', borderRadius: '12px' } }), { wide: true }) }) : null);
  add(h('div', { class: 'diary-new' }, text, preview, h('div', { style: { display: 'flex', gap: '6px' } },
    h('button', { class: 'hud-btn', onclick: () => file.click() }, icon('camera'), 'Foto'), file,
    h('button', { class: 'hud-btn', onclick: async () => {
      if (!text.value.trim() && !image) return;
      await api(`/projects/${p.id}/log`, { body: { text: text.value.trim(), image } });
      text.value = ''; image = null; preview.replaceChildren(); load();
    } }, icon('content-save'), 'Eintragen'))), list);
  load();
}

/** Bilder vor dem Hochladen verkleinern (max. 1600 px), spart Platz. */
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  } catch { return file; }
}

// ---------- Server-Ressourcen (Container/VMs/Rechner) ----------
export function resourceStatus(r) {
  const list = r.type === 'vm' ? S.unraid?.vms : r.type === 'container' ? S.unraid?.containers : null;
  return list?.find((x) => x.name.toLowerCase() === r.name.toLowerCase());
}

export function resourcesTab(p, add, save, redraw) {
  p.resources ||= [];
  const rows = p.resources.map((r, i) => {
    const item = resourceStatus(r);
    const on = item && running(item.state);
    return h('div', { class: 'task' },
      icon(r.type === 'vm' ? 'monitor' : r.type === 'container' ? 'docker' : 'desktop-tower'),
      h('span', { class: 't' }, `${r.name}`, h('span', { class: 'gh-meta' }, ` · ${r.type === 'vm' ? 'VM' : r.type === 'container' ? 'Container' : 'Rechner'}${item ? ' · ' + (on ? 'läuft' : 'aus') : r.type === 'host' ? '' : ' · unbekannt'}`)),
      item ? h('button', { class: 'hud-btn', onclick: async () => {
        const { act } = await import('./server.js');
        if (await act(r.type, item, on ? 'stop' : 'start', on ? `${item.name} stoppen?` : null)) setTimeout(() => emit('unraid-refresh'), 1500);
      } }, icon(on ? 'stop' : 'play'), on ? 'Stopp' : 'Start') : null,
      h('button', { class: 'x', onclick: () => { p.resources.splice(i, 1); save(); redraw(); } }, '×'));
  });
  const kind = h('select', { class: 'hud-input', style: { width: 'auto' } }, h('option', { value: 'container' }, 'Container'), h('option', { value: 'vm' }, 'VM'), h('option', { value: 'host' }, 'Rechner'));
  const name = h('select', { class: 'hud-input' });
  const fill = () => {
    const list = kind.value === 'vm' ? S.unraid?.vms : kind.value === 'container' ? S.unraid?.containers : null;
    name.replaceChildren(...(list ? list.map((x) => h('option', { value: x.name }, x.name)) : [h('option', { value: '' }, kind.value === 'host' ? '– Name unten eintippen –' : 'Unraid nicht verbunden')]));
  };
  kind.onchange = fill;
  fill();
  const hostName = h('input', { class: 'hud-input', placeholder: 'z. B. Bazzite-PC' });
  add(rows.length ? rows : h('div', { class: 'ai-empty' }, 'Verknüpfe Container, VMs oder Rechner, auf denen dieses Projekt läuft – dann kannst du sie hier starten und stoppen.'),
    sub('Hinzufügen'), h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, kind, name, hostName,
      h('button', { class: 'hud-btn', onclick: () => {
        const n = kind.value === 'host' ? hostName.value.trim() : name.value;
        if (!n) return;
        p.resources.push({ type: kind.value, name: n });
        save(); redraw();
      } }, icon('plus'))));
}

// ---------- ESPHome ----------
export function esphomeTab(p, add, save, redraw) {
  p.esphome ||= [];
  if (!S.settings.esphomeUrl) return add(h('div', { class: 'ai-empty' }, 'ESPHome-Adresse in den Einstellungen eintragen.'));
  const box = h('div', {}, h('div', { class: 'ai-empty' }, 'Lade Geräte …'));
  add(box);
  api('/esphome/devices').then((d) => {
    const all = d.configured || [];
    const mine = all.filter((x) => p.esphome.includes(x.configuration));
    const others = all.filter((x) => !p.esphome.includes(x.configuration));
    const pick = h('select', { class: 'hud-input' }, h('option', { value: '' }, '– Gerät zuordnen –'), others.map((x) => h('option', { value: x.configuration }, x.friendly)));
    box.replaceChildren(
      ...(mine.length ? mine.map((x) => espDevice(x, p, save, redraw)) : [h('div', { class: 'ai-empty' }, 'Noch kein ESPHome-Gerät zugeordnet.')]),
      sub('Zuordnen'), h('div', { style: { display: 'flex', gap: '6px' } }, pick,
        h('button', { class: 'hud-btn', onclick: () => { if (!pick.value) return; p.esphome.push(pick.value); save(); redraw(); } }, icon('plus'))));
  }).catch((e) => box.replaceChildren(h('div', { class: 'ai-empty' }, e.message)));
}

function espDevice(x, p, save, redraw) {
  const consoleBox = h('pre', { class: 'esp-console', style: { display: 'none' } });
  let ctrl = null;
  const run = async (action) => {
    ctrl?.abort();
    ctrl = new AbortController();
    consoleBox.style.display = '';
    consoleBox.textContent = `> ${action} ${x.configuration}\n`;
    try {
      await apiStream('/esphome/run', { configuration: x.configuration, action }, (ev, data) => {
        if (ev === 'line') { consoleBox.textContent += data.line + (data.line.endsWith('\n') ? '' : '\n'); consoleBox.scrollTop = consoleBox.scrollHeight; }
        if (ev === 'exit') consoleBox.textContent += data.code === 0 ? '\n✓ fertig\n' : `\n✗ beendet mit Code ${data.code}\n`;
        if (ev === 'error') consoleBox.textContent += '\n✗ ' + data.message + '\n';
      }, ctrl.signal);
    } catch (e) { if (e.name !== 'AbortError') consoleBox.textContent += '\n✗ ' + e.message; }
  };
  const editor = h('div', { style: { display: 'none' } });
  const openEditor = async () => {
    if (editor.style.display === '') { editor.style.display = 'none'; return; }
    editor.style.display = '';
    editor.replaceChildren(h('div', { class: 'ai-empty' }, 'Lade YAML …'));
    try {
      const yaml = await fetch('/api/esphome/config?configuration=' + encodeURIComponent(x.configuration)).then((r) => { if (!r.ok) throw new Error('Laden fehlgeschlagen'); return r.text(); });
      const ta = h('textarea', { class: 'hud-input esp-yaml', spellcheck: false }, yaml);
      editor.replaceChildren(ta, h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
        h('button', { class: 'hud-btn', onclick: async () => {
          const r = await fetch('/api/esphome/config?configuration=' + encodeURIComponent(x.configuration), { method: 'PUT', body: ta.value });
          toast(r.ok ? 'Gespeichert' : 'Speichern fehlgeschlagen', !r.ok);
        } }, icon('content-save'), 'Speichern'),
        h('button', { class: 'hud-btn', onclick: () => run('validate') }, icon('check-decagram-outline'), 'Prüfen')));
    } catch (e) { editor.replaceChildren(h('div', { class: 'ai-empty' }, e.message)); }
  };
  return h('div', { class: 'esp-dev' },
    h('div', { class: 'task' }, h('span', { class: 'dot-live', style: { background: x.online ? '#3ddc97' : x.online === false ? '#ff5d6c' : '#8193a8' } }),
      h('span', { class: 't' }, x.friendly, h('span', { class: 'gh-meta' }, ` · ${x.configuration}${x.platform ? ' · ' + x.platform : ''}`)),
      x.outdated ? h('span', { class: 'hud-btn', title: `installiert ${x.deployed}, ESPHome ${x.current}` }, icon('alert-outline'), 'veraltet') : h('span', { class: 'gh-meta' }, x.deployed || ''),
      h('button', { class: 'x', title: 'Zuordnung lösen', onclick: () => { p.esphome = p.esphome.filter((c) => c !== x.configuration); save(); redraw(); } }, '×')),
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '6px 0' } },
      h('button', { class: 'hud-btn', onclick: openEditor }, icon('code-braces'), 'YAML'),
      h('button', { class: 'hud-btn', onclick: () => run('compile') }, icon('hammer'), 'Kompilieren'),
      h('button', { class: 'hud-btn', onclick: () => { if (confirm(`${x.friendly} per OTA flashen?`)) run('upload'); } }, icon('upload-network'), 'OTA-Update'),
      h('button', { class: 'hud-btn', onclick: () => run('logs') }, icon('text-box-outline'), 'Logs'),
      h('button', { class: 'hud-btn icon', title: 'Stopp', onclick: () => ctrl?.abort() }, icon('stop'))),
    editor, consoleBox);
}

// ---------- Teilelager ----------
export function partsStock(p, rowsBox, save, redraw) {
  const pks = p.parts.map((x) => x.inventree).filter(Boolean);
  if (!S.settings.inventreeUrl) return;
  if (pks.length) api('/inventree/parts?ids=' + pks.join(',')).then((stock) => {
    rowsBox.querySelectorAll('[data-pk]').forEach((el) => {
      const s = stock[el.dataset.pk];
      if (!s) return;
      const part = p.parts.find((x) => String(x.inventree) === el.dataset.pk);
      const enough = s.stock >= (part?.qty || 1);
      el.textContent = `Lager: ${s.stock}${s.units ? ' ' + s.units : ''}`;
      el.style.color = enough ? '#3ddc97' : '#ff5d6c';
      if (part && part.have !== enough) { part.have = enough; save(); }
    });
  }).catch(() => {});
}

export function linkPart(part, save, redraw) {
  const q = h('input', { class: 'input', value: part.name, placeholder: 'Suchen …' });
  const list = h('div', { class: 'picker-list' });
  const search = () => api('/inventree/search?q=' + encodeURIComponent(q.value)).then((rows) => list.replaceChildren(...(rows.length ? rows.map((r) =>
    h('button', { class: 'picker-item', onclick: () => { part.inventree = r.pk; part.name = part.name || r.name; save(); close(); redraw(); } },
      r.image ? h('img', { src: r.image, style: { width: '32px', height: '32px', borderRadius: '6px', objectFit: 'cover' } }) : icon('package-variant'),
      h('div', { class: 'grow' }, r.name, h('small', {}, [r.ipn, r.description].filter(Boolean).join(' · '))), h('span', { class: 'val' }, `${r.stock} ${r.units || 'Stk'}`)))
    : [h('div', { class: 'empty' }, 'Nichts gefunden')]))).catch((e) => list.replaceChildren(h('div', { class: 'empty' }, e.message)));
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(search, 300); };
  const close = modal([icon('package-variant-closed'), 'Im Teilelager suchen'], h('div', {}, q, list), {
    actions: (c) => part.inventree ? [h('button', { class: 'btn', onclick: () => { delete part.inventree; save(); c(); redraw(); } }, 'Verknüpfung lösen')] : null,
  });
  search();
}

// ---------- Repo-Liste (linke Spalte) ----------
export function reposPanel(onOpen) {
  const body = h('div', { class: 'hud-body' }, h('div', { class: 'ai-empty' }, 'Lade Repos …'));
  const draw = ({ repos, error, synced }) => {
    if (!repos.length) return body.replaceChildren(h('div', { class: 'ai-empty' }, error || 'GitHub-Benutzer in den Einstellungen eintragen.'));
    body.replaceChildren(h('div', { class: 'gh-meta', style: { padding: '0 2px 8px' } }, synced ? `abgeglichen ${ago(synced)}` : ''),
      ...repos.map((r) => {
        const proj = S.projects.find((x) => x.repo?.toLowerCase() === r.full_name.toLowerCase());
        return h('div', { class: 'proj', style: { '--pc': proj ? undefined : '129, 147, 168' }, onclick: () => (proj ? onOpen(proj) : window.open(r.html_url, '_blank')) },
          h('div', { class: 'nm', style: { fontSize: '14px' } }, icon(r.private ? 'lock-outline' : 'source-repository'), ' ', r.name),
          h('div', { class: 'st' }, h('span', {}, [r.language, r.open_issues ? `${r.open_issues} offen` : null].filter(Boolean).join(' · ') || '–'), h('span', {}, ago(Date.parse(r.pushed_at)))),
          proj ? null : h('div', { class: 'gh-meta' }, 'kein Projekt'));
      }));
  };
  api('/github/repos').then(draw).catch((e) => body.replaceChildren(h('div', { class: 'ai-empty' }, e.message)));
  const syncBtn = h('button', { class: 'hud-btn icon', title: 'Mit GitHub abgleichen', onclick: async () => {
    syncBtn.classList.add('on');
    try {
      const r = await api('/github/sync', { body: {} });
      S.projects = r.projects;
      emit('projects');
      toast(`${r.repos} Repos · ${r.created} neue Projekte`);
      draw(await api('/github/repos'));
    } catch (e) { toast(e.message, true); }
    syncBtn.classList.remove('on');
  } }, icon('sync'));
  return { body, syncBtn };
}
