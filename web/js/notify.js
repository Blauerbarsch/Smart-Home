// Glocke (HA-Benachrichtigungen, Alarme, Unraid), Browser-Benachrichtigungen, Update-Hinweis.
import { S, h, icon, api, on, toast, modal, ago } from './core.js';

export function bellButton() {
  const count = () => (S.haNotifications?.length || 0) + (S.activeAlerts?.length || 0);
  const badge = h('span', { class: 'badge' });
  const btn = h('button', { class: 'btn icon bell', title: 'Benachrichtigungen', onclick: openPanel }, icon('bell-outline'), badge);
  const draw = () => {
    const n = count();
    badge.textContent = n > 9 ? '9+' : n || '';
    badge.style.display = n ? '' : 'none';
    btn.classList.toggle('ring', n > 0);
  };
  draw();
  on('notifications-changed', draw);
  return btn;
}

async function openPanel() {
  const box = h('div', { class: 'notif-list' }, h('div', { class: 'empty' }, 'Lade …'));
  modal([icon('bell-outline'), 'Benachrichtigungen'], box, {
    actions: () => [
      'Notification' in window && Notification.permission !== 'granted'
        ? h('button', { class: 'btn', onclick: () => Notification.requestPermission().then((p) => toast(p === 'granted' ? 'Browser-Benachrichtigungen aktiv' : 'Nicht erlaubt')) }, icon('bell-ring-outline'), 'Im Browser erlauben')
        : null,
      h('a', { class: 'btn', href: '#settings', onclick: () => document.querySelector('.modal-back')?.remove() }, icon('cog-outline'), 'Alarm-Regeln'),
    ],
  });
  const [alerts, unraidN] = await Promise.all([api('/alerts').catch(() => ({ history: [] })), S.settings.unraidUrl ? api('/unraid/notifications').catch(() => []) : []]);
  const items = [];
  for (const n of S.haNotifications || []) {
    items.push(h('div', { class: 'notif' }, icon('home-assistant'), h('div', { class: 'grow' }, h('b', {}, n.title || 'Home Assistant'), h('div', { class: 'md-lite' }, n.message), h('small', {}, ago(Date.parse(n.created_at)))),
      h('button', { class: 'btn icon sm', title: 'Erledigt', onclick: async (e) => { await api(`/ha/notifications/${encodeURIComponent(n.notification_id)}/dismiss`, { body: {} }); e.target.closest('.notif').remove(); } }, icon('check'))));
  }
  for (const n of unraidN) {
    items.push(h('div', { class: 'notif' }, icon('server'), h('div', { class: 'grow' }, h('b', {}, n.subject || n.title), h('div', {}, n.description), h('small', {}, n.timestamp ? ago(Date.parse(n.timestamp)) : ''))));
  }
  for (const a of alerts.history.slice(0, 40)) {
    items.push(h('div', { class: 'notif ' + a.level }, icon(a.level === 'ok' ? 'check-circle-outline' : 'alert-outline'), h('div', { class: 'grow' }, h('b', {}, a.title), h('div', {}, a.text), h('small', {}, ago(a.ts)))));
  }
  box.replaceChildren(...(items.length ? items : [h('div', { class: 'empty' }, 'Alles ruhig.')]));
}

/** Alarm vom Server: Toast + (falls erlaubt) Browser-Benachrichtigung. */
export function showAlert(a) {
  toast(`${a.title}`, a.level !== 'ok');
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(a.title, { body: a.text, icon: '/icons/icon-192.png', tag: a.rule || a.title }); } catch {}
  }
}

export function updateButton() {
  const btn = h('button', { class: 'btn sm update-btn', style: { display: 'none' }, onclick: () => updateDialog() }, icon('download'), 'Update');
  const draw = () => { btn.style.display = S.update?.available ? '' : 'none'; };
  draw();
  on('app-update', draw);
  return btn;
}

export function updateDialog() {
  const u = S.update || {};
  modal([icon('download'), 'Dashboard aktualisieren'], h('div', {},
    h('p', {}, u.available ? 'Auf GitHub liegt eine neuere Version.' : 'Du hast die neueste Version.'),
    h('div', { class: 'list' },
      h('div', { class: 'list-item' }, h('span', { class: 'grow' }, 'Installiert'), h('span', { class: 'val' }, (u.current || 'dev').slice(0, 7))),
      h('div', { class: 'list-item' }, h('span', { class: 'grow' }, 'Neueste'), h('span', { class: 'val' }, u.latest || '–')),
      u.message ? h('div', { class: 'list-item' }, h('span', { class: 'grow' }, u.message), h('span', { class: 'val' }, u.date ? ago(Date.parse(u.date)) : '')) : null),
    h('p', { class: 'hint', style: { color: 'var(--muted)', fontSize: '13px' } },
      S.settings.unraidUrl ? 'Das Update läuft über die Unraid-API: neues Image laden, Container neu starten. Die Seite lädt danach von selbst neu.'
        : 'Für das Update per Knopf die Unraid-API in den Einstellungen eintragen. Alternativ in Unraid: Docker → smart-home → „Apply Update“.')), {
    actions: (close) => [
      h('button', { class: 'btn', onclick: async () => { S.update = await api('/update?check=1'); close(); updateDialog(); } }, icon('refresh'), 'Prüfen'),
      S.settings.unraidUrl ? h('button', { class: 'btn primary', onclick: async () => {
        try {
          await api('/update', { body: {} });
          close();
          toast('Update läuft – die Seite lädt gleich neu');
          waitForRestart();
        } catch (e) { toast(e.message, true); }
      } }, icon('download'), 'Jetzt aktualisieren') : null,
    ],
  });
}

function waitForRestart() {
  let seenDown = false;
  const iv = setInterval(async () => {
    try {
      const r = await fetch('/healthz', { cache: 'no-store' });
      if (r.ok && seenDown) { clearInterval(iv); location.reload(); }
    } catch { seenDown = true; }
  }, 2000);
  setTimeout(() => { clearInterval(iv); location.reload(); }, 180000);
}
