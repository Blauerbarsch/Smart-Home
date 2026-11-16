// Einstellungen: Verbindungen, KI, Mesh, Reiter, Sicherung.
import { S, h, icon, api, toast, field, setAccent, saveLayout, emit, uid, ago, friendly } from './core.js';
import { PROFILES, autoProfile, currentProfile, setProfile, kioskConfig, saveKiosk, showSaver } from './kiosk.js';
import { updateDialog } from './notify.js';
import { pickEntity } from './editor.js';
import { nodeName } from './tiles.js';

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
      h('select', { class: 'input', style: { flex: '0 0 120px' }, title: 'Auf welchen Geräten?', onchange: (e) => { t.profiles = e.target.value ? [e.target.value] : []; commit(); } },
        h('option', { value: '' }, 'Alle Geräte'), Object.entries(PROFILES).map(([k, l]) => h('option', { value: k, selected: t.profiles?.[0] === k }, 'Nur ' + l))),
      h('button', { class: 'btn icon sm', title: t.hidden ? 'Einblenden' : 'Ausblenden', onclick: () => { t.hidden = !t.hidden; commit(); } }, icon(t.hidden ? 'eye-off-outline' : 'eye-outline')),
      ['grid', 'floorplan'].includes(t.type || 'grid')
        ? h('button', { class: 'btn icon sm danger', title: 'Löschen', onclick: () => { if (confirm(`Reiter „${t.name}“ mit allen Kacheln löschen?`)) { S.tabs.splice(i, 1); commit(); } } }, icon('delete-outline'))
        : h('span', { class: 'chip', style: { width: '80px', justifyContent: 'center' } }, ({ map: 'Karte', workshop: 'Werkstatt', server: 'Server', floorplan: 'Grundriss', chronik: 'Chronik', automations: 'Automationen' })[t.type] || t.type))));
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
      f('Kopf: head-body (Bewegungen)', 'kopfBodyUrl', { placeholder: 'http://192.168.1.20:8300' }, 'Für den Bewegungs-Editor in der Werkstatt und Abläufe wie „Nicken“.'),
      h('div', { class: 'row' }, f('Kopf-Modellname', 'kopfModel'), sel('Kopf bekommt Werkzeuge', 'kopfTools', [['true', 'Ja (Haus, Server, Mesh, Projekte)'], ['false', 'Nein, nur Gespräch']])),
      kopfVoiceBox()),
    card('radio-tower', 'Meshtastic (MQTT)', h('div', { style: { marginBottom: '12px' } }, meshChip),
      f('MQTT-Broker', 'mqttUrl', { placeholder: 'mqtt://192.168.1.10:1883' }, 'Im Gateway-Node: MQTT-Modul aktivieren und im Kanal Uplink einschalten. Verschlüsselte Pakete werden direkt gelesen; „JSON output“ ist nur zum Senden nötig.'),
      h('div', { class: 'row' }, f('Benutzer', 'mqttUser'), f('Passwort', 'mqttPassword', { type: 'password' })),
      f('Topics', 'meshTopic', {}, 'Kommagetrennt, Standard: msh/#'),
      h('div', { class: 'row' }, f('Gateway-Node (zum Senden)', 'meshGatewayId', { placeholder: '!a1b2c3d4' }), f('Kanal-Index', 'meshChannel', { type: 'number' })),
      f('Sende-Topic (optional)', 'meshSendTopic', { placeholder: 'msh/EU_868/2/json/mqtt/' }, 'Leer = wird aus empfangenen Topics abgeleitet. Downlink im Kanal muss aktiv sein.'),
      sel('Alarme ins Mesh senden', 'meshAlerts', [['offline', 'Nur wenn das Internet ausfällt (Notfallkanal)'], ['always', 'Immer zusätzlich'], ['never', 'Nie']]),
      h('div', { class: 'row' }, f('Alarme an', 'meshAlertTarget', { placeholder: 'all oder !a1b2c3d4' }, '„all“ = Kanal, sonst Node-ID für Direktnachricht'),
        f('Befehle erlaubt von', 'meshCommandNodes', { placeholder: '!a1b2c3d4, !e5f6a7b8' }, 'Diese Nodes dürfen per Mesh-Nachricht steuern: !status !an … !aus … !wert … !alarme')),
      f('Kanal-Schlüssel (für verschlüsselte Kanäle)', 'meshKeys', { type: 'password', placeholder: 'Privat=base64schluessel; Familie=AQ==' }, 'Der Standardkanal LongFast wird automatisch entschlüsselt. Eigene Kanäle: Name=PSK (Base64, wie in der App unter Kanäle).')),
    h('div', { class: 'modal-actions', style: { justifyContent: 'flex-start', marginTop: 0 } }, h('button', { class: 'btn primary', onclick: save }, icon('content-save'), 'Speichern')),
    card('server', 'Unraid', f('Adresse des Unraid-Servers', 'unraidUrl', { placeholder: 'http://192.168.188.175' }),
      f('API-Schlüssel', 'unraidApiKey', { type: 'password' }, 'Unraid: Settings → Management Access → API Keys → Create (Rolle ADMIN). Damit: Container, VMs, Array, Update-Knopf.')),
    card('github', 'GitHub', h('div', { class: 'row' }, f('Benutzer', 'githubUser'), f('Token (für private Repos)', 'githubToken', { type: 'password' }, 'github.com → Settings → Developer settings → Fine-grained token, nur Lesen: Contents, Metadata, Issues, Actions.')),
      sel('Neue Repos automatisch als Projekt anlegen', 'githubAutoProjects', [['true', 'Ja'], ['false', 'Nein']]),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => {
        try { const r = await api('/github/sync', { body: {} }); S.projects = r.projects; emit('projects'); toast(`${r.repos} Repos, ${r.created} neue Projekte`); } catch (e) { toast(e.message, true); }
      } }, icon('sync'), 'Jetzt abgleichen'))),
    card('bell-ring-outline', 'Benachrichtigungen',
      f('Home-Assistant-Dienst', 'notifyHaService', { placeholder: 'notify.mobile_app_dein_handy' }, 'Push über die Home-Assistant-App. Name findest du in HA unter Entwicklerwerkzeuge → Aktionen → „notify.“'),
      h('div', { class: 'row' }, f('ntfy-Adresse (optional)', 'ntfyUrl', { placeholder: 'https://ntfy.sh/mein-geheimes-thema' }), f('ntfy-Token', 'ntfyToken', { type: 'password' })),
      sel('Kopf spricht Alarme aus', 'notifyKopf', [['false', 'Nein'], ['true', 'Ja']]),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await save(); await api('/alerts/test', { body: { channels: ['browser', 'ha', 'ntfy', 'kopf'] } }).then(() => toast('Test gesendet')).catch((e) => toast(e.message, true)); } }, icon('send'), 'Test senden'))),
    rulesCard(),
    guardCard(),
    card('package-variant-closed', 'Teilelager (InvenTree)', h('div', { class: 'row' }, f('Adresse', 'inventreeUrl', { placeholder: 'http://192.168.188.175:1337' }), f('API-Token', 'inventreeToken', { type: 'password' }, 'InvenTree → Einstellungen → API-Token'))),
    h('div', { class: 'modal-actions', style: { justifyContent: 'flex-start', marginTop: 0 } }, h('button', { class: 'btn primary', onclick: save }, icon('content-save'), 'Speichern')),
    deviceCard(),
    card('information-outline', 'Version', h('div', { class: 'list' },
      h('div', { class: 'list-item' }, h('span', { class: 'grow' }, 'Dashboard'), h('span', { class: 'val' }, `${S.version} · ${(S.commit || 'dev').slice(0, 7)}`)),
      h('div', { class: 'list-item' }, h('span', { class: 'grow' }, 'Neueste auf GitHub'), h('span', { class: 'val' }, S.update?.latest || '–'))),
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: updateDialog }, icon('download'), S.update?.available ? 'Update verfügbar' : 'Nach Updates suchen'))),

    card('tab', 'Reiter', tabsBox, h('div', { class: 'row', style: { marginTop: '12px' } },
      h('button', { class: 'btn', onclick: () => { S.tabs.push({ id: uid(), name: 'Neuer Reiter', icon: 'view-dashboard-outline', type: 'grid', tiles: [] }); commit(); } }, icon('plus'), 'Kachel-Reiter'),
      h('button', { class: 'btn', onclick: () => { S.tabs.push({ id: uid(), name: 'Grundriss', icon: 'floor-plan', type: 'floorplan', markers: [] }); commit(); } }, icon('plus'), 'Grundriss'),
      h('button', { class: 'btn', onclick: () => { S.tabs.push({ id: uid(), name: 'Karte', icon: 'map', type: 'map' }); commit(); } }, icon('plus'), 'Karte'),
      ...[['chronik', 'Chronik', 'timeline-text-outline'], ['automations', 'Automationen', 'robot']].filter(([ty]) => !S.tabs.some((t) => t.type === ty)).map(([ty, n, ic]) =>
        h('button', { class: 'btn', onclick: () => { S.tabs.push({ id: uid(), name: n, icon: ic, type: ty }); commit(); } }, icon('plus'), n)),
      !S.tabs.some((t) => t.type === 'server') ? h('button', { class: 'btn', onclick: () => { S.tabs.push({ id: uid(), name: 'Server', icon: 'server', type: 'server' }); commit(); } }, icon('plus'), 'Server') : null)),
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


// ---------- Alarm-Regeln ----------
function rulesCard() {
  const box = h('div', {}, h('div', { class: 'empty' }, 'Lade …'));
  let rules = [], types = {};
  const save = () => api('/alerts/rules', { method: 'PUT', body: { rules } }).then(() => toast('Regeln gespeichert')).catch((e) => toast(e.message, true));
  const METRICS = [['battery', 'Akku %'], ['temperature', 'Temperatur'], ['humidity', 'Feuchte'], ['voltage', 'Spannung'], ['chUtil', 'Kanalauslastung'], ['pressure', 'Luftdruck']];
  const nodeSel = (r) => h('select', { class: 'input', onchange: (e) => (r.node = e.target.value) }, h('option', { value: '*' }, 'alle Nodes'),
    [...S.mesh.nodes.values()].map((n) => h('option', { value: n.id, selected: r.node === n.id }, nodeName(n))));
  const opSel = (r) => h('select', { class: 'input', style: { flex: '0 0 70px' }, onchange: (e) => (r.op = e.target.value) }, ['<', '>', '<=', '>=', '=', '!='].map((o) => h('option', { value: o, selected: (r.op || '<') === o }, o)));
  const num = (r, k, ph) => h('input', { class: 'input', value: r[k] ?? '', placeholder: ph, style: { flex: '0 0 90px' }, oninput: (e) => (r[k] = e.target.value) });
  function row(r, i) {
    const params = h('div', { class: 'row', style: { flexWrap: 'wrap' } });
    const drawParams = () => {
      params.replaceChildren();
      if (r.type === 'mesh_offline') params.append(nodeSel(r), num(r, 'minutes', 'Minuten'), h('span', { class: 'tile-sub', style: { alignSelf: 'center', flex: '0 0 auto' } }, 'min'));
      if (r.type === 'mesh_metric') params.append(nodeSel(r), h('select', { class: 'input', onchange: (e) => (r.metric = e.target.value) }, METRICS.map(([k, l]) => h('option', { value: k, selected: r.metric === k }, l))), opSel(r), num(r, 'value', 'Wert'));
      if (r.type === 'entity') {
        const lbl = h('span', {}, r.entity ? friendly(S.states.get(r.entity), r.entity) : 'Entität wählen');
        params.append(h('button', { type: 'button', class: 'btn', onclick: async () => { const id = await pickEntity(); if (id) { r.entity = id; lbl.textContent = friendly(S.states.get(id), id); } } }, icon('magnify'), lbl), opSel(r), num(r, 'value', 'Wert'), num(r, 'minutes', 'seit min'));
      }
      if (r.type === 'service_down') params.append(h('input', { class: 'input', value: r.url || '', placeholder: 'http://…', oninput: (e) => (r.url = e.target.value) }), h('input', { class: 'input', value: r.label || '', placeholder: 'Name', oninput: (e) => (r.label = e.target.value) }));
      if (r.type === 'container_stopped') params.append(h('select', { class: 'input', onchange: (e) => (r.target = e.target.value) }, h('option', { value: '' }, '– Container/VM –'),
        [...(S.unraid?.containers || []), ...(S.unraid?.vms || [])].map((x) => h('option', { value: x.name, selected: r.target === x.name }, x.name))));
    };
    drawParams();
    const chans = ['browser', 'ha', 'ntfy', 'kopf'];
    const CH = { browser: 'Browser', ha: 'HA-App', ntfy: 'ntfy', kopf: 'Kopf' };
    return h('div', { class: 'rule' },
      h('div', { class: 'row' },
        h('input', { type: 'checkbox', checked: r.enabled !== false, style: { flex: '0 0 auto' }, onchange: (e) => (r.enabled = e.target.checked) }),
        h('input', { class: 'input', value: r.name || '', placeholder: 'Name', oninput: (e) => (r.name = e.target.value) }),
        h('select', { class: 'input', style: { flex: '0 0 190px' }, onchange: (e) => { r.type = e.target.value; drawParams(); } }, Object.entries(types).map(([k, l]) => h('option', { value: k, selected: r.type === k }, l))),
        h('button', { class: 'btn icon sm danger', onclick: () => { rules.splice(i, 1); draw(); } }, icon('delete-outline'))),
      params,
      h('div', { class: 'row', style: { alignItems: 'center', flexWrap: 'wrap' } },
        ...chans.map((c) => h('label', { class: 'chip', style: { flex: '0 0 auto', cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: (r.channels || []).includes(c), onchange: (e) => { r.channels = (r.channels || []).filter((x) => x !== c); if (e.target.checked) r.channels.push(c); } }), CH[c])),
        h('span', { class: 'tile-sub', style: { flex: '0 0 auto' } }, 'höchstens alle'), num(r, 'cooldown', '360'), h('span', { class: 'tile-sub', style: { flex: '0 0 auto' } }, 'min')));
  }
  function draw() {
    box.replaceChildren(...rules.map(row),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn', onclick: () => { rules.push({ name: 'Neue Regel', type: 'entity', enabled: true, cooldown: 360, channels: ['browser', 'ha'] }); draw(); } }, icon('plus'), 'Regel'),
        h('button', { class: 'btn primary', onclick: save }, icon('content-save'), 'Regeln speichern')));
  }
  api('/alerts').then((a) => { rules = a.rules; types = a.types; draw(); }).catch((e) => box.replaceChildren(h('div', { class: 'empty' }, e.message)));
  return h('div', { class: 'card' }, h('h3', {}, icon('bell-alert-outline'), 'Alarm-Regeln'), box);
}

// ---------- Dieses Gerät: Profil + Wandtablet ----------
function deviceCard() {
  const k = kioskConfig();
  const ents = h('div', { class: 'tagline' });
  const drawEnts = () => ents.replaceChildren(...k.entities.map((id, i) => h('span', { class: 'tag' }, friendly(S.states.get(id), id), h('button', { type: 'button', onclick: () => { k.entities.splice(i, 1); drawEnts(); } }, '×'))),
    h('button', { type: 'button', class: 'btn sm', onclick: async () => { const r = await pickEntity({ multiple: true, selected: k.entities }); if (r) { k.entities = r; drawEnts(); } } }, icon('plus'), 'Werte'));
  drawEnts();
  const wLbl = h('span', {}, k.weather ? friendly(S.states.get(k.weather), k.weather) : 'Wetter-Entität wählen');
  return h('div', { class: 'card' }, h('h3', {}, icon('tablet-cellphone'), 'Dieses Gerät'),
    field('Geräteprofil', h('select', { class: 'input', onchange: (e) => { setProfile(e.target.value); toast('Profil: ' + PROFILES[currentProfile()]); emit('reload'); } },
      h('option', { value: '' }, `Automatisch (${PROFILES[autoProfile()]})`), Object.entries(PROFILES).map(([v, l]) => h('option', { value: v, selected: localStorage.getItem('sh-profile') === JSON.stringify(v) }, l))),
      'Bei den Reitern legst du fest, auf welchen Geräten sie erscheinen. Die Einstellung gilt nur für dieses Gerät/diesen Browser.'),
    h('label', { class: 'row', style: { alignItems: 'center', gap: '8px', marginBottom: '12px' } }, h('input', { type: 'checkbox', checked: k.enabled, style: { flex: 'none' }, onchange: (e) => (k.enabled = e.target.checked) }), 'Wandtablet-Modus (Bildschirm bleibt an, Schoner, Nachtdimmung)'),
    h('div', { class: 'row' },
      field('Bildschirmschoner nach (min, 0 = aus)', h('input', { class: 'input', type: 'number', value: k.idleMin, oninput: (e) => (k.idleMin = Number(e.target.value)) })),
      field('Nacht von', h('input', { class: 'input', type: 'number', min: 0, max: 23, value: k.nightFrom, oninput: (e) => (k.nightFrom = Number(e.target.value)) })),
      field('bis', h('input', { class: 'input', type: 'number', min: 0, max: 23, value: k.nightTo, oninput: (e) => (k.nightTo = Number(e.target.value)) }))),
    h('label', { class: 'row', style: { alignItems: 'center', gap: '8px', marginBottom: '12px' } }, h('input', { type: 'checkbox', checked: k.hideNav, style: { flex: 'none' }, onchange: (e) => (k.hideNav = e.target.checked) }), 'Navigation ausblenden (nur Kacheln)'),
    field('Wetter im Schoner', h('button', { type: 'button', class: 'btn', style: { justifyContent: 'flex-start' }, onclick: async () => { const id = await pickEntity({ domains: ['weather'] }); if (id) { k.weather = id; wLbl.textContent = friendly(S.states.get(id), id); } } }, icon('weather-partly-cloudy'), wLbl)),
    field('Werte im Schoner', ents),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { saveKiosk(k); toast('Für dieses Gerät gespeichert'); } }, icon('content-save'), 'Übernehmen'),
      h('button', { class: 'btn', onclick: () => { saveKiosk(k); showSaver(); } }, icon('monitor-eye'), 'Schoner testen')));
}


// ---------- Kopf per Sprache: Befehl für den PC ----------
function kopfVoiceBox() {
  const cmd = () => `kopf-smarthome ${location.origin} ${S.settings.agentToken}`;
  const code = h('code', { class: 'cmd' }, cmd());
  return h('div', { class: 'field' }, h('span', {}, 'Kopf auch per Sprache (Mikrofon am PC)'),
    h('div', { class: 'hint' }, 'Damit Kopf auf Zuruf Licht schalten oder nach dem Server sehen kann, diesen Befehl einmal auf dem PC ausführen:'),
    h('div', { class: 'cmd-row' }, code,
      h('button', { type: 'button', class: 'btn icon sm', title: 'Kopieren', onclick: () => navigator.clipboard?.writeText(cmd()).then(() => toast('Kopiert')) }, icon('content-copy')),
      h('button', { type: 'button', class: 'btn icon sm', title: 'Neuen Schlüssel erzeugen', onclick: async () => {
        if (!confirm('Neuen Schlüssel erzeugen? Danach den Befehl auf dem PC erneut ausführen.')) return;
        const token = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
        const { settings } = await api('/settings', { method: 'PUT', body: { agentToken: token } });
        S.settings = settings;
        code.textContent = cmd();
      } }, icon('key-change'))),
    h('div', { class: 'hint' }, 'Erlaubt sind dieselben Werkzeuge wie für Claude; Schalten nur, wenn „KI darf Smart Home steuern“ an ist.'));
}


// ---------- Werkstatt-Wächter ----------
function guardCard() {
  const box = h('div', {}, h('div', { class: 'empty' }, 'Lade …'));
  api('/workbench').then(({ guard: g }) => {
    const ent = (key, label, domains, hint) => {
      const lbl = h('span', {}, g[key] ? friendly(S.states.get(g[key]), g[key]) : 'wählen …');
      return field(label, h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', style: { justifyContent: 'flex-start' }, onclick: async () => { const id = await pickEntity({ domains }); if (id) { g[key] = id; lbl.textContent = friendly(S.states.get(id), id); } } }, icon('magnify'), lbl),
        h('button', { type: 'button', class: 'btn icon', style: { flex: '0 0 auto' }, onclick: () => { g[key] = ''; lbl.textContent = 'wählen …'; } }, icon('close'))), hint);
    };
    const num = (key, label) => field(label, h('input', { class: 'input', type: 'number', value: g[key], oninput: (e) => (g[key] = Number(e.target.value)) }));
    box.replaceChildren(
      h('label', { class: 'row', style: { alignItems: 'center', gap: '8px', marginBottom: '12px' } }, h('input', { type: 'checkbox', checked: g.enabled, style: { flex: 'none' }, onchange: (e) => (g.enabled = e.target.checked) }), 'Wächter aktiv'),
      ent('iron', 'Lötstation (smarte Steckdose)', ['switch', 'light', 'input_boolean']),
      ent('power', 'Leistung der Lötstation (optional)', ['sensor'], 'Mit Leistungsmessung erkennt der Wächter Leerlauf: Lötkolben hält nur noch Temperatur.'),
      h('div', { class: 'row' }, num('idleWatts', 'Leerlauf unter (W)'), num('idleMinutes', 'Leerlauf länger als (min)'), num('maxMinutes', 'Spätestens aus nach (min)')),
      ent('fan', 'Absaugung (läuft automatisch mit)', ['switch', 'fan', 'light']),
      num('fanAfterMinutes', 'Absaugung läuft nach (min)'),
      ent('person', 'Person (Verlassen-Warnung)', ['person', 'device_tracker']),
      h('label', { class: 'row', style: { alignItems: 'center', gap: '8px', marginBottom: '12px' } }, h('input', { type: 'checkbox', checked: g.offOnLeave, style: { flex: 'none' }, onchange: (e) => (g.offOnLeave = e.target.checked) }), 'Beim Verlassen automatisch ausschalten (sonst nur warnen)'),
      h('button', { class: 'btn primary', onclick: async () => { await api('/workbench/guard', { method: 'PUT', body: g }); toast('Wächter gespeichert'); } }, icon('content-save'), 'Speichern'));
  });
  return h('div', { class: 'card' }, h('h3', {}, icon('soldering-iron'), 'Werkstatt-Wächter'), box);
}
