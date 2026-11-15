// Server-Reiter: Unraid (System, Array, VMs, Container) + Dienst-Status.
import { S, h, icon, api, toast, ago } from './core.js';

const gb = (bytes) => (bytes / 1024 ** 3).toFixed(bytes > 100 * 1024 ** 3 ? 0 : 1);
const tb = (kb) => (Number(kb) / 1024 ** 3).toFixed(1);
const running = (st) => ['RUNNING', 'IDLE'].includes(String(st).toUpperCase());
const STATE_DE = { RUNNING: 'läuft', EXITED: 'gestoppt', PAUSED: 'pausiert', SHUTOFF: 'aus', SHUTDOWN: 'fährt herunter', CRASHED: 'abgestürzt', IDLE: 'läuft', PMSUSPENDED: 'Ruhezustand', NOSTATE: '–' };

export function projectsFor(kind, name) {
  return S.projects.filter((p) => (p.resources || []).some((r) => r.type === kind && r.name.toLowerCase() === String(name).toLowerCase()));
}

export async function act(kind, item, action, confirmText) {
  if (confirmText && !confirm(confirmText)) return false;
  try {
    await api(`/unraid/${kind}/${encodeURIComponent(item.id)}/${action}`, { body: {} });
    toast(`${item.name}: ${({ start: 'gestartet', stop: 'gestoppt', restart: 'neu gestartet', reboot: 'neu gestartet', updateContainer: 'Update läuft' })[action] || action}`);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

function bar(pct, warn = 80, bad = 92) {
  const c = pct >= bad ? 'var(--bad)' : pct >= warn ? 'var(--warn)' : 'var(--accent)';
  return h('div', { class: 'bar-mini' }, h('div', { style: { width: Math.min(100, pct) + '%', background: c } }));
}

const tempColor = (t) => (t == null ? 'var(--muted)' : t >= 50 ? 'var(--bad)' : t >= 42 ? 'var(--warn)' : 'var(--ok)');

export function renderServer(view, actions) {
  let timer, data, services = {};
  const root = h('div', { class: 'server' });
  view.append(root);
  actions.prepend(h('button', { class: 'btn icon', title: 'Aktualisieren', onclick: () => load(true) }, icon('refresh')));

  async function load(force) {
    if (!S.settings.unraidUrl) return drawSetup();
    try {
      [data, services] = await Promise.all([api('/unraid' + (force ? '?force=1' : '')), api('/services').catch(() => ({}))]);
      draw();
    } catch (e) {
      root.replaceChildren(h('div', { class: 'card' }, h('h3', {}, icon('alert-outline'), 'Unraid nicht erreichbar'), h('div', { class: 'note-text' }, e.message)));
    }
  }

  function drawSetup() {
    root.replaceChildren(h('div', { class: 'card', style: { maxWidth: '640px' } }, h('h3', {}, icon('server'), 'Unraid verbinden'),
      h('div', { class: 'note-text' },
        '1. In Unraid: Settings → Management Access → API Keys → „Create“.\n' +
        '2. Name z. B. „smart-home“, Rolle ADMIN (oder Rechte für Docker, VMs, Array, Info, Notifications).\n' +
        '3. In den Einstellungen dieses Dashboards unter „Unraid“ die Adresse (z. B. http://192.168.188.175) und den Schlüssel eintragen.'),
      h('a', { class: 'btn primary', href: '#settings', style: { marginTop: '12px' } }, icon('cog-outline'), 'Zu den Einstellungen')));
  }

  function draw() {
    const d = data;
    const arr = d.array;
    const capPct = arr?.capacity ? (Number(arr.capacity.used) / Number(arr.capacity.total)) * 100 : 0;
    const upSince = d.uptime && Date.parse(d.uptime);
    const cards = h('div', { class: 'server-cards' },
      h('div', { class: 'card stat' }, h('div', { class: 'k' }, icon('server'), d.hostname || 'Unraid'), h('div', { class: 'v' }, d.release ? `Unraid ${d.release}` : ''),
        h('div', { class: 'tile-sub' }, [d.cpuModel, upSince ? `läuft seit ${ago(upSince).replace('vor ', '')}` : null].filter(Boolean).join(' · '))),
      h('div', { class: 'card stat' }, h('div', { class: 'k' }, icon('cpu-64-bit'), 'CPU'), h('div', { class: 'v' }, d.cpu != null ? `${d.cpu.toFixed(0)} %` : '–'), bar(d.cpu || 0, 70, 90)),
      h('div', { class: 'card stat' }, h('div', { class: 'k' }, icon('memory'), 'RAM'), h('div', { class: 'v' }, d.mem ? `${gb(d.mem.used)} / ${gb(d.mem.total)} GB` : '–'), bar(d.mem?.pct || 0)),
      h('div', { class: 'card stat' }, h('div', { class: 'k' }, icon('harddisk'), 'Array'), h('div', { class: 'v' }, arr?.capacity ? `${tb(arr.capacity.used)} / ${tb(arr.capacity.total)} TB` : '–'), bar(capPct),
        h('div', { class: 'tile-sub' }, [arr?.state === 'STARTED' ? 'gestartet' : arr?.state, arr?.parity?.running ? `Parity-Check ${arr.parity.progress} %` : arr?.parity?.status ? `Parity: ${arr.parity.status.toLowerCase()}${arr.parity.errors ? `, ${arr.parity.errors} Fehler` : ''}` : null].filter(Boolean).join(' · '))),
    );

    const disks = h('div', { class: 'card' }, h('h3', {}, icon('harddisk'), 'Platten'),
      h('div', { class: 'list' }, (arr?.disks || []).map((x) => h('div', { class: 'list-item' },
        icon(x.type === 'PARITY' ? 'shield-check-outline' : x.type === 'CACHE' ? 'flash' : 'harddisk'),
        h('span', { style: { width: '70px' } }, x.name),
        x.total ? h('div', { style: { flex: 1 } }, bar((x.used / x.total) * 100)) : h('span', { class: 'grow tile-sub' }, x.type === 'PARITY' ? 'Parität' : ''),
        h('span', { class: 'val', style: { width: '70px', textAlign: 'right' } }, x.total ? `${(x.used / 1024 ** 4).toFixed(1)}/${(x.total / 1024 ** 4).toFixed(1)} T` : `${(x.size / 1024 ** 4).toFixed(1)} T`),
        h('span', { class: 'val', style: { width: '52px', textAlign: 'right', color: tempColor(x.temp) } }, x.temp != null ? `${x.temp} °C` : x.spinning === false ? 'schläft' : '–'),
      ))));

    const vms = h('div', { class: 'card' }, h('h3', {}, icon('monitor'), 'Virtuelle Maschinen', h('span', { class: 'spacer' }), h('span', { class: 'chip' }, `${d.vms.filter((v) => running(v.state)).length}/${d.vms.length} an`)),
      d.vms.length ? h('div', { class: 'res-grid' }, d.vms.map((v) => resCard('vm', v))) : h('div', { class: 'empty' }, d.errors?.vms ? 'VMs: ' + d.errors.vms : 'Keine VMs'));

    const updates = d.containers.filter((c) => c.update);
    const containers = h('div', { class: 'card' }, h('h3', {}, icon('docker'), 'Docker-Container', h('span', { class: 'spacer' }),
      updates.length ? h('span', { class: 'chip warn' }, h('span', { class: 'dot' }), `${updates.length} Updates`) : null,
      h('span', { class: 'chip' }, `${d.containers.filter((c) => running(c.state)).length}/${d.containers.length} an`)),
      h('div', { class: 'res-grid' }, d.containers.map((c) => resCard('container', c))));

    const svcEntries = Object.entries(services);
    const svc = svcEntries.length ? h('div', { class: 'card' }, h('h3', {}, icon('lan-check'), 'Dienste'),
      h('div', { class: 'list' }, svcEntries.map(([url, s]) => h('div', { class: 'list-item' },
        h('span', { class: 'fresh', style: { background: s.ok ? 'var(--ok)' : s.ts ? 'var(--bad)' : 'var(--muted)' } }),
        h('a', { class: 'grow', href: url, target: '_blank', style: { color: 'inherit' } }, url.replace(/^https?:\/\//, '')),
        h('span', { class: 'val' }, s.ok ? `${s.ms} ms` : s.error || (s.status ? 'HTTP ' + s.status : '…')),
        h('span', { class: 'val', style: { width: '60px', textAlign: 'right' } }, s.uptime24h != null ? `${s.uptime24h} %` : ''))))) : null;

    root.replaceChildren(cards, h('div', { class: 'server-cols' }, h('div', {}, vms, containers), h('div', {}, disks, svc)));
  }

  function resCard(kind, item) {
    const on = running(item.state);
    const projs = projectsFor(kind, item.name);
    const port = item.ports?.[0];
    const webUi = item.webUi?.replace('[IP]', location.hostname).replace(/\[PORT:(\d+)\]/, (_, p) => p) || (port && `http://${location.hostname}:${port}`);
    const btn = (ic, title, action, confirmText) => h('button', { class: 'btn icon sm', title, onclick: async () => { if (await act(kind, item, action, confirmText)) setTimeout(() => load(true), 1500); } }, icon(ic));
    return h('div', { class: 'res-card' + (on ? ' on' : '') },
      h('div', { class: 'res-top' },
        item.icon ? h('img', { src: item.icon, alt: '', class: 'res-icon', onerror: (e) => e.target.replaceWith(icon(kind === 'vm' ? 'monitor' : 'docker')) }) : h('div', { class: 'res-icon' }, icon(kind === 'vm' ? 'monitor' : 'docker')),
        h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'tile-name' }, item.name), h('div', { class: 'tile-sub' }, STATE_DE[String(item.state).toUpperCase()] || item.state)),
        h('span', { class: 'fresh', style: { background: on ? 'var(--ok)' : 'var(--muted)' } })),
      projs.length ? h('div', { class: 'tagline', style: { marginTop: '6px' } }, projs.map((p) => h('a', { class: 'tag', href: `#workshop/${p.id}` }, icon('hammer-wrench'), p.name))) : null,
      h('div', { class: 'res-actions' },
        on ? btn('stop', 'Stoppen', 'stop', `${item.name} wirklich stoppen?`) : btn('play', 'Starten', 'start'),
        on ? btn('restart', 'Neu starten', kind === 'vm' ? 'reboot' : 'restart', `${item.name} neu starten?`) : null,
        kind === 'container' && item.update ? h('button', { class: 'btn sm active', title: 'Update installieren', onclick: async () => { if (await act(kind, item, 'updateContainer', `${item.name} aktualisieren? Der Container startet dabei neu.`)) setTimeout(() => load(true), 5000); } }, icon('download'), 'Update') : null,
        webUi && on ? h('a', { class: 'btn icon sm', href: webUi, target: '_blank', title: 'Öffnen' }, icon('open-in-new')) : null));
  }

  load();
  timer = setInterval(() => load(), 15000);
  return () => clearInterval(timer);
}
