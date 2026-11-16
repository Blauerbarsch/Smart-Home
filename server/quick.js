// Schnellweg für Kopf: einfache Befehle („Licht an“, „Gäste-WLAN aus“, „Wohnzimmer Pause“)
// werden direkt in Home Assistant ausgeführt – ohne Sprachmodell, in unter einer Sekunde.
// Und: zu einer Anfrage nur die passenden Werkzeuge auswählen, damit das Modell weniger lesen muss.
import { ha } from './ha.js';
import { settings, layout } from './store.js';

const norm = (s) => String(s || '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const SWITCHABLE = ['light', 'switch', 'fan', 'input_boolean', 'media_player', 'cover', 'climate'];

// Befehlswörter am Satzende oder -anfang
const ACTIONS = [
  { re: /\b(an|ein|einschalten|anschalten|anmachen|starten)\b/, op: 'on' },
  { re: /\b(aus|ausschalten|ausmachen|abschalten)\b/, op: 'off' },
  { re: /\b(umschalten|toggle)\b/, op: 'toggle' },
  { re: /\b(pause|pausieren|anhalten)\b/, op: 'pause', domains: ['media_player'] },
  { re: /\b(weiter|play|abspielen|fortsetzen)\b/, op: 'play', domains: ['media_player'] },
  { re: /\b(naechster|naechstes|skip)\b/, op: 'next', domains: ['media_player'] },
  { re: /\b(auf|oeffnen|hoch)\b/, op: 'open', domains: ['cover'] },
  { re: /\b(zu|schliessen|runter)\b/, op: 'close', domains: ['cover'] },
];
const FILLER = new Set(['mach', 'mache', 'schalt', 'schalte', 'bitte', 'mal', 'das', 'die', 'den', 'der', 'im', 'in', 'kopf', 'hey', 'jetzt', 'doch', 'kannst', 'du', 'auch']);

/** Namen → Entität: Kachel-Titel und Anzeigenamen aus Home Assistant. */
function candidates() {
  const out = [];
  for (const s of ha.states.values()) {
    const d = s.entity_id.split('.')[0];
    if (!SWITCHABLE.includes(d) || ['unavailable', 'unknown'].includes(s.state)) continue;
    const n = norm(s.attributes.friendly_name);
    if (n) out.push({ name: n, label: s.attributes.friendly_name, entity: s.entity_id });
  }
  for (const t of (layout().tabs || []).flatMap((x) => x.tiles || [])) {
    if (!t.entity || !t.title || !SWITCHABLE.includes(t.entity.split('.')[0])) continue;
    if (!ha.states.has(t.entity)) continue;
    out.push({ name: norm(t.title), label: t.title, entity: t.entity, tile: true });
  }
  return out;
}

export function parse(text) {
  const t = norm(text);
  if (!t || t.split(' ').length > 8) return null;
  if (/\b(wie|warum|was|wann|wer|ist|sind|welche|welcher|wieviel|nicht|nie|wenn|dann|um \d|in \d+ minuten)\b/.test(t) || /\?/.test(text)) return null;
  const act = ACTIONS.find((a) => a.re.test(t));
  if (!act) return null;
  // Was bleibt ohne Befehls- und Füllwörter?
  const rest = t.replace(act.re, ' ').split(' ').filter((w) => w && !FILLER.has(w)).join(' ');
  if (!rest) return null;
  const list = candidates().filter((c) => !act.domains || act.domains.includes(c.entity.split('.')[0]));
  // Treffer: Name komplett im Rest enthalten (Wortgrenzen); der längste gewinnt
  const hits = list.filter((c) => (' ' + rest + ' ').includes(' ' + c.name + ' ') || rest === c.name);
  if (!hits.length) {
    // Kurzform: „Werkstatt an“ für „Werkstatt Licht“ – nur wenn eindeutig
    const words = rest.split(' ');
    const part = [...new Map(list.filter((c) => words.every((w) => c.name.split(' ').includes(w))).map((c) => [c.entity, c])).values()];
    if (part.length !== 1) return null;
    return { entity: part[0].entity, label: part[0].label, op: act.op };
  }
  const best = Math.max(...hits.map((c) => c.name.length));
  const top = [...new Map(hits.filter((c) => c.name.length === best).map((c) => [c.entity, c])).values()];
  if (top.length !== 1) return null; // mehrdeutig → das Modell soll fragen
  // Der Rest darf nicht viel mehr enthalten als den Namen (sonst ist es kein einfacher Befehl)
  if (rest.split(' ').length > top[0].name.split(' ').length + 1) return null;
  return { entity: top[0].entity, label: top[0].label, op: act.op };
}

const SERVICE = {
  on: (d) => (d === 'cover' ? 'open_cover' : d === 'media_player' ? 'turn_on' : 'turn_on'),
  off: (d) => (d === 'cover' ? 'close_cover' : 'turn_off'),
  toggle: () => 'toggle',
  pause: () => 'media_pause', play: () => 'media_play', next: () => 'media_next_track',
  open: () => 'open_cover', close: () => 'close_cover',
};
const SAY = { on: 'ist an', off: 'ist aus', toggle: 'umgeschaltet', pause: 'pausiert', play: 'spielt weiter', next: 'nächster Titel', open: 'fährt hoch', close: 'fährt runter' };

/** Versucht den Schnellweg. Gibt { reply, entity, service } zurück oder null. */
export async function quick(text) {
  if (!settings().aiHomeControl) return null;
  const p = parse(text);
  if (!p) return null;
  const domain = p.entity.split('.')[0];
  const service = SERVICE[p.op](domain);
  await ha.callService(domain, service, {}, { entity_id: p.entity });
  const label = p.label.replace(/^(.)/, (c) => c.toUpperCase());
  return { reply: `${label} ${SAY[p.op]}.`, entity: p.entity, service: `${domain}.${service}` };
}

// ---------- Passende Werkzeuge zu einer Anfrage ----------
const GROUPS = [
  [/licht|lampe|leuchte|schalt|\ban\b|\baus\b|dimm|hell|dunkel|heiz|thermostat|temperatur|grad|warm|kalt|feucht|rollo|jalousie|rolllad|steckdose|fenster|tuer|alarm|sensor|strom|watt|pv|solar|akku|batterie|musik|lautsprecher|fernseh|tv|wlan|pause|play|leiser|lauter/, ['find_entities', 'call_service']],
  [/server|unraid|container|docker|\bvm\b|minecraft|plex|nextcloud|home ?assistant|neustart|starte|stopp/, ['server_status', 'manage_server']],
  [/mesh|meshtastic|node|funk|huette|garten/, ['mesh_nodes', 'find_entities']],
  [/projekt|aufgabe|repo|github|build|commit|bauteil|lager|teil/, ['repo_info', 'add_project_task', 'append_project_notes', 'parts_search']],
  [/notiz|notier|schreib|tagebuch|foto/, ['diary_add', 'append_project_notes']],
  [/was ist das|erkenn|kamera|bild/, ['identify_part']],
  [/timer|wecker|erinner|minuten|stunden/, ['set_timer', 'list_timers']],
  [/wann war|wann hab|wann habe|chronik|zuletzt|gestern|heute morgen/, ['chronik_search']],
  [/nick|schuettel|zwinker|umschau|kopf beweg|bewegung/, ['kopf_move']],
  [/automation|automatisier|wenn .* dann|jeden (tag|morgen|abend)/, ['automation_draft', 'find_entities']],
  [/wetter|regn|regen|schirm|schnee|frost|glaette|gewitter|sturm|wind|unwetter|warnung|pollen|heuschnupfen|sonne|grad draussen|draussen/, ['get_weather']],
  [/muell|tonne|abfuhr|termin|kalender|morgen frueh|naechste woche/, ['calendar_upcoming']],
];

/** Nur die Werkzeuge, die zur Anfrage passen. Leere Liste = normales Gespräch. */
export function pickTools(text, all) {
  const t = norm(text);
  const want = new Set(GROUPS.filter(([re]) => re.test(t)).flatMap(([, names]) => names));
  return all.filter((x) => want.has(x.name));
}
