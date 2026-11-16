// Kalender aus ICS-Adressen (Abfallkalender, Google/Nextcloud-Kalender …) – ohne Abhängigkeiten.
// Kann einfache Wiederholungen (RRULE: täglich/wöchentlich/monatlich/jährlich) und erinnert am Vorabend.
import { layout, readJson, writeJson } from './store.js';
import { alerts } from './alerts.js';

const cache = new Map();

export function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseDate(val, params = '') {
  const m = String(val).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  if (!hh) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +(ss || 0))), allDay: false };
  // TZID oder lokale Zeit: als Ortszeit des Servers lesen (Container läuft mit TZ=Europe/Berlin)
  return { date: new Date(+y, +mo - 1, +d, +hh, +mi, +(ss || 0)), allDay: /VALUE=DATE(?!-)/.test(params) };
}

const unescape = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur?.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(';');
    const val = line.slice(i + 1);
    const p = params.join(';');
    if (name === 'DTSTART') { const d = parseDate(val, p); if (d) { cur.start = d.date; cur.allDay = d.allDay; } }
    else if (name === 'DTEND') cur.end = parseDate(val, p)?.date;
    else if (name === 'SUMMARY') cur.summary = unescape(val);
    else if (name === 'LOCATION') cur.location = unescape(val);
    else if (name === 'DESCRIPTION') cur.description = unescape(val).slice(0, 300);
    else if (name === 'RRULE') cur.rrule = Object.fromEntries(val.split(';').map((kv) => kv.split('=')));
    else if (name === 'EXDATE') val.split(',').forEach((v) => { const d = parseDate(v, p); if (d) cur.exdates.push(d.date.getTime()); });
    else if (name === 'UID') cur.uid = val;
    else if (name === 'RECURRENCE-ID') cur.recurrenceId = parseDate(val, p)?.date?.getTime();
  }
  return events;
}

const DAYS = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

/** Einzeltermine im Zeitraum [from, to) – Wiederholungen werden aufgefaltet. */
export function expand(events, from, to) {
  const out = [];
  const overrides = new Set(events.filter((e) => e.recurrenceId).map((e) => `${e.uid}@${e.recurrenceId}`));
  for (const e of events) {
    const dur = e.end ? e.end - e.start : 0;
    const push = (start) => {
      if (start >= from && start < to && !e.exdates.includes(start.getTime()) && !(e.rrule && overrides.has(`${e.uid}@${start.getTime()}`)))
        out.push({ summary: e.summary || '(ohne Titel)', start: start.getTime(), end: start.getTime() + dur, allDay: e.allDay, location: e.location || '' });
    };
    if (!e.rrule) { push(e.start); continue; }
    const r = e.rrule;
    const freq = r.FREQ, interval = Number(r.INTERVAL) || 1;
    const until = r.UNTIL ? parseDate(r.UNTIL)?.date : null;
    const count = Number(r.COUNT) || Infinity;
    const byDay = r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS[d.slice(-2)]).filter((d) => d != null) : null;
    let n = 0;
    for (let k = 0; k < 2000 && n < count; k++) {
      const base = new Date(e.start);
      if (freq === 'DAILY') base.setDate(base.getDate() + k * interval);
      else if (freq === 'WEEKLY') base.setDate(base.getDate() + k * 7 * interval);
      else if (freq === 'MONTHLY') base.setMonth(base.getMonth() + k * interval);
      else if (freq === 'YEARLY') base.setFullYear(base.getFullYear() + k * interval);
      else break;
      if (until && base > until) break;
      if (base >= to) break;
      const starts = freq === 'WEEKLY' && byDay
        ? byDay.map((wd) => { const d = new Date(base); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + ((wd + 6) % 7)); return d; }).filter((d) => d >= e.start).sort((a, b) => a - b)
        : [base];
      for (const st of starts) {
        if (n >= count || (until && st > until)) break;
        n++;
        push(st);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Abfall erkennen: Farbe + Symbol
const WASTE = [
  [/bio|grün|kompost/i, 'Biotonne', '#8a5a2b'],
  [/papier|pappe|blau|PPK/i, 'Papier', '#2f7cf6'],
  [/gelb|wertstoff|verpackung|leichtverp/i, 'Gelbe Tonne', '#f5c518'],
  [/glas/i, 'Glas', '#3ddc97'],
  [/sperr/i, 'Sperrmüll', '#b07cff'],
  [/schadstoff|problem/i, 'Schadstoffe', '#ff5d6c'],
  [/rest|grau|hausmüll/i, 'Restmüll', '#8a96a3'],
];
export function waste(summary) {
  const w = WASTE.find(([re]) => re.test(summary || ''));
  return w ? { kind: w[1], color: w[2] } : null;
}

export async function fetchCalendar(url) {
  const c = cache.get(url);
  if (c && Date.now() - c.t < 30 * 60e3) return c.events;
  const u = String(url).replace(/^webcal:/i, 'https:');
  const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'smart-home-dashboard' } });
  if (!r.ok) throw new Error(`Kalender ${r.status}`);
  const text = await r.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Keine ICS-Datei');
  const events = parseIcs(text);
  cache.set(url, { t: Date.now(), events });
  return events;
}

/** Termine mehrerer Kalender für die nächsten N Tage. */
export async function upcoming(urls, days = 14) {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + days * 86400e3);
  const list = [];
  const errors = [];
  for (const url of urls.filter(Boolean)) {
    try { list.push(...expand(await fetchCalendar(url), from, to)); } catch (e) { errors.push(e.message); }
  }
  return { events: list.sort((a, b) => a.start - b.start).map((e) => ({ ...e, waste: waste(e.summary) })), errors };
}

const tileUrls = (t) => String(t.urls || t.url || '').split(/\s+/).filter(Boolean);
export function calendarTiles() {
  return (layout().tabs || []).flatMap((t) => t.tiles || []).filter((t) => t.type === 'calendar');
}

/** Alle Kalender-Kacheln zusammen – für die KI. */
export async function allUpcoming(days = 7) {
  const urls = [...new Set(calendarTiles().flatMap(tileUrls))];
  return upcoming(urls, days);
}

// Erinnerung am Vorabend (z. B. „Morgen: Gelbe Tonne“)
let sent = readJson('calendar-reminders.json', {});
export function startReminders() {
  const tick = async () => {
    const now = new Date();
    for (const t of calendarTiles().filter((x) => x.remind)) {
      const [hh, mm] = String(t.remindAt || '18:00').split(':').map(Number);
      if (now.getHours() * 60 + now.getMinutes() < hh * 60 + (mm || 0)) continue;
      const { events } = await upcoming(tileUrls(t), 2).catch(() => ({ events: [] }));
      const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
      const list = events.filter((e) => e.start >= tomorrow.getTime() && e.start < tomorrow.getTime() + 86400e3 && (t.mode !== 'waste' || e.waste));
      if (!list.length) continue;
      const key = `${t.id}:${tomorrow.toLocaleDateString('sv-SE')}`;
      if (sent[key]) continue;
      sent[key] = Date.now();
      const names = list.map((e) => (t.mode === 'waste' && e.waste ? e.waste.kind : e.summary));
      await alerts.notify({ rule: { id: 'calendar', channels: t.channels || ['browser', 'ha', 'ntfy'] }, level: 'info', title: `Morgen: ${[...new Set(names)].join(', ')}`, text: t.mode === 'waste' ? 'Tonne heute Abend rausstellen.' : list.map((e) => e.summary).join(', ') });
    }
    const cutoff = Date.now() - 14 * 86400e3;
    sent = Object.fromEntries(Object.entries(sent).filter(([, v]) => v > cutoff));
    writeJson('calendar-reminders.json', sent);
  };
  setInterval(() => tick().catch((e) => console.error('Kalender:', e.message)), 10 * 60e3).unref();
  setTimeout(() => tick().catch(() => {}), 20000).unref();
}
