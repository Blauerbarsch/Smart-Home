// Einstellungen: Verbindungen, KI, Mesh, Reiter, Sicherung.
import { S, h, icon, api, toast, field, setAccent, saveLayout, emit, uid } from './core.js';

export function renderSettings(view, rerender) {
  const draft = {};
  const locked = (k) => S.envLocked.includes(k);
  const inp = (key, opts = {}) => h('input', {
    class: 'input', value: S.settings[key] ?? '', type: opts.type || 'text', placeholder: opts.placeholder || '',
    disabled: locked(key), oninput: (e) => (draft[key] = opts.type === 'number' ? Number(e.target.value) : e.target.value),
  });
  const lockHint = (key, hint) => (locked(key) ? 'Wird über eine Umgebungsvariable gesetzt (Unraid-Template).' : hint);
  const f = (label, key, opts = {}, hint) => field(label, inp(key, opts), lockHint(key, hint));
  const sel = (label, key, options) => field(label, h('select', { class: 'input', onchange: (e) => (draft[key] = e.target.value === 'true' ? true : e.target.value === 'false' ? false : e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: String(S.settings[key]) === String(v) }, l))));

  const save = async () => {
    try {
      const { settings } = await api('/settings', { method: 'PUT', body: draft });
      S.settings = settings;
      setAccent(S.settings.accent);
      document.getElementById('brand-title').textContent = S.settings.title;
      for (const k of Object.keys(draft)) delete draft[k];
      toast('Gespeichert');
    } catch (e) { toast(e.message, true); }
  };

  const card = (ic, title, ...children) => h('div', { class: 'card' }, h('h3', {}, icon(ic), title), ...children);

  // Reiter-Verwaltung
  const tabsBox = h('div', {});
  const drawTabs = () => {
    tabsBox.replaceChildren(...S.tabs.map((t, i) => h('div', { class: 'tab-row' },
      h('button', { class: 'btn icon sm', title: 'Nach oben', disabled: i === 0, onclick: () => { S.tabs.splice(i - 1, 0, S.tabs.splice(i, 1)[0]); commit(); } }, icon('chevron-up')),
      h('input', { class: 'input', value: t.icon || '', style: { flex: '0 0 130px' }, title: 'Icon (mdi-Name)', oninput: (e) => { t.icon = e.target.value; saveLayout(); } }),
      h('input', { class: 'input', value: t.name, oninput: (e) => { t.name = e.target.value; saveLayout(); } }),
      h('button', { class: 'btn icon sm', title: t.hidden ? 'Einblenden' : 'Ausblenden', onclick: () => { t.hidden = !t.hidden; commit(); } }, icon(t.hidden ? 'eye-off-outline' : 'eye-outline')),
      (t.type || 'grid') === 'grid'
        ? h('button', { class: 'btn icon sm danger', title: 'Löschen', onclick: () => { if (confirm(`Reiter „${t.name}“ mit allen Kacheln löschen?`)) { S.tabs.splice(i, 1); commit(); } } }, icon('delete-outline'))
        : h('span', { class: 'chip', style: { width: '80px', justifyContent: 'center' } }, t.type === 'map' ? 'Karte' : 'Werkstatt'))));
  };
  const commit = () => { saveLayout(); drawTabs(); rerender(); };
  drawTabs();

  const fileIn = h('input', { type: 'file', accept: 'application/json', style: { display: 'none' }, onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await api('/import', { body: JSON.parse(await file.text()) });
      toast('Importiert');
      emit('reload');
    } catch (er) { toast(er.message, true); }
  } });

  const haChip = h('span', { class: 'chip ' + (S.ha.status === 'connected' ? 'ok' : 'bad') }, h('span', { class: 'dot' }), ({ connected: 'verbunden', connecting: 'verbinde …', disconnected: 'getrennt', error: 'Fehler', unconfigured: 'nicht eingerichtet', offline: 'Server nicht erreichbar' }[S.ha.status] || S.ha.status) + (S.ha.error ? ' – ' + S.ha.error : ''));
  const meshChip = h('span', { class: 'chip ' + (S.mesh.status?.connected ? 'ok' : 'bad') }, h('span', { class: 'dot' }), S.mesh.status?.connected ? 'verbunden' : S.mesh.status?.error || 'getrennt');

  view.append(h('div', { class: 'settings' },
    card('palette-outline', 'Allgemein',
      h('div', { class: 'row' }, f('Titel', 'title'),
        field('Akzentfarbe', h('input', { class: 'input', type: 'color', value: S.settings.accent, style: { height: '42px', padding: '4px' }, oninput: (e) => { draft.accent = e.target.value; setAccent(e.target.value); } })))),
    card('home-assistant', 'Home Assistant', h('div', { style: { marginBottom: '12px' } }, haChip),
      f('Adresse', 'haUrl', { placeholder: 'http://192.168.1.10:8123' }),
      f('Long-Lived Access Token', 'haToken', { type: 'password' }, 'In Home Assistant: Profil → Sicherheit → Langlebige Zugangstokens. Für Raumzuordnung ein Admin-Benutzer.'),
      f('ESPHome-Dashboard', 'esphomeUrl', { placeholder: 'http://192.168.1.10:6052' }, 'Für die ESPHome-Kachel (Geräteliste).')),
    card('brain', 'KI',
      h('div', { class: 'row' }, sel('Standard-KI', 'defaultAi', [['claude', 'Claude'], ['kopf', 'Kopf (lokal)']]),
        sel('KI darf Smart Home steuern', 'aiHomeControl', [['true', 'Ja (nur Claude)'], ['false', 'Nein']])),
      h('div', { class: 'row' }, f('Anthropic-API-Key', 'anthropicKey', { type: 'password' }, 'console.anthropic.com → API Keys'), f('Claude-Modell', 'claudeModel', {}, 'z. B. claude-sonnet-5-5, claude-opus-5-5, claude-haiku-5-5')),
      f('Kopf: head-brain', 'kopfUrl', { placeholder: 'http://192.168.1.20:8100' }, 'OpenAI-kompatible API deines Kopfs. Der Port muss vom Unraid-Server aus erreichbar sein (siehe README).'),
      h('div', { class: 'row' }, f('Kopf: head-output (Sprache)', 'kopfOutputUrl', { placeholder: 'http://192.168.1.20:8600' }), f('Kopf: head-vision (Kamera)', 'kopfVisionUrl', { placeholder: 'http://192.168.1.20:8400' })),
      f('Kopf-Modellname', 'kopfModel')),
    card('radio-tower', 'Meshtastic (MQTT)', h('div', { style: { marginBottom: '12px' } }, meshChip),
      f('MQTT-Broker', 'mqttUrl', { placeholder: 'mqtt://192.168.1.10:1883' }, 'Im Node: MQTT-Modul aktivieren, „JSON output“ einschalten, Uplink im Kanal aktivieren.'),
      h('div', { class: 'row' }, f('Benutzer', 'mqttUser'), f('Passwort', 'mqttPassword', { type: 'password' })),
      f('Topics', 'meshTopic', {}, 'Kommagetrennt, Standard: msh/#'),
      h('div', { class: 'row' }, f('Gateway-Node (zum Senden)', 'meshGatewayId', { placeholder: '!a1b2c3d4' }), f('Kanal-Index', 'meshChannel', { type: 'number' })),
      f('Sende-Topic (optional)', 'meshSendTopic', { placeholder: 'msh/EU_868/2/json/mqtt/' }, 'Leer = wird aus empfangenen Topics abgeleitet. Downlink im Kanal muss aktiv sein.')),
    h('div', { class: 'modal-actions', style: { justifyContent: 'flex-start', marginTop: 0 } }, h('button', { class: 'btn primary', onclick: save }, icon('content-save'), 'Speichern')),
    card('tab', 'Reiter', tabsBox, h('div', { class: 'row', style: { marginTop: '12px' } },
      h('button', { class: 'btn', onclick: () => { S.tabs.push({ id: uid(), name: 'Neuer Reiter', icon: 'view-dashboard-outline', type: 'grid', tiles: [] }); commit(); } }, icon('plus'), 'Kachel-Reiter'),
      h('button', { class: 'btn', onclick: () => { S.tabs.push({ id: uid(), name: 'Karte', icon: 'map', type: 'map' }); commit(); } }, icon('plus'), 'Karten-Reiter'))),
    card('cellphone-link', 'App installieren', h('div', { class: 'note-text' },
      'Handy (Android/iOS): Seite im Browser öffnen → Menü → „Zum Startbildschirm hinzufügen“.\n' +
      'Linux-Desktop: In Chromium/Chrome/Brave über das Installieren-Symbol in der Adressleiste, oder das Skript desktop/install-linux.sh aus dem Repo nutzen.\n' +
      'Für die Installation als App und für den Standort braucht der Browser HTTPS (z. B. über Nginx Proxy Manager oder Tailscale).')),
    card('backup-restore', 'Sicherung', h('div', { class: 'row' },
      h('a', { class: 'btn', href: '/api/export', download: 'smart-home-backup.json' }, icon('download'), 'Exportieren'),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, icon('upload'), 'Importieren'), fileIn),
      h('div', { class: 'hint', style: { marginTop: '8px', fontSize: '12px', color: 'var(--muted)' } }, 'Export enthält Reiter, Kacheln, Standorte und Projekte – ohne Passwörter und Keys.')),
    S.authRequired ? h('button', { class: 'btn', onclick: async () => { await api('/logout', { body: {} }); location.reload(); } }, icon('logout'), 'Abmelden') : null,
  ));
  return null;
}
