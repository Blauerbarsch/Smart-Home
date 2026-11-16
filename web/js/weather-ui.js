// Wetter (DWD), Regenradar und Kalender/Müll – Kacheln und Detailansicht.
import { S, h, icon, api, modal } from './core.js';

export const WX = {
  'clear-day': ['weather-sunny', 'Sonnig'], 'clear-night': ['weather-night', 'Klar'],
  'partly-cloudy-day': ['weather-partly-cloudy', 'Teils bewölkt'], 'partly-cloudy-night': ['weather-night-partly-cloudy', 'Teils bewölkt'],
  cloudy: ['weather-cloudy', 'Bewölkt'], fog: ['weather-fog', 'Nebel'], wind: ['weather-windy', 'Windig'], rain: ['weather-rainy', 'Regen'],
  sleet: ['weather-snowy-rainy', 'Schneeregen'], snow: ['weather-snowy', 'Schnee'], hail: ['weather-hail', 'Hagel'], thunderstorm: ['weather-lightning-rainy', 'Gewitter'],
};
export const wxIcon = (k) => WX[k]?.[0] || 'weather-cloudy';
export const wxText = (k) => WX[k]?.[1] || '';
const WARN_COLOR = ['', '#f5c518', '#ff8a1f', '#ff4d4f', '#b04dff'];
const POLLEN_COLOR = ['transparent', '#9ad66b', '#c9d84a', '#f5c518', '#ffa53a', '#ff7a3a', '#ff4d4f'];
const DAY = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
const HOUR = { format: (d) => String(d.getHours()).padStart(2, '0') };
const fmt = (v, d = 0) => (v == null ? '–' : Number(v).toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d }));
const head = (ic, name, sub, extra) =>
  h('div', { class: 'tile-head' }, h('div', { class: 'tile-icon' }, icon(ic)),
    h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'tile-name' }, name), sub !== undefined ? h('div', { class: 'tile-sub' }, sub) : null), extra || null);
const dayName = (date) => {
  const d = new Date(date + 'T12:00');
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const diff = Math.round((d - today) / 86400e3);
  return diff === 0 ? 'Heute' : diff === 1 ? 'Morgen' : DAY.format(d);
};
const siteOptions = () => [['', 'Erster Standort'], ...S.sites.filter((s) => s.lat).map((s) => [s.id, s.name])];

const wxCache = new Map();
export function loadWeather(site = '', force) {
  const c = wxCache.get(site);
  if (!force && c && Date.now() - c.t < 4 * 60e3) return c.p;
  const p = api('/weather?site=' + encodeURIComponent(site));
  wxCache.set(site, { t: Date.now(), p });
  p.catch(() => wxCache.delete(site));
  return p;
}

function warnBanner(w, compact) {
  const top = w.list[0];
  return h('div', { class: 'wx-warn', style: { '--wc': WARN_COLOR[top.level] || WARN_COLOR[1] }, title: top.text },
    icon('alert'), h('span', { class: 'grow' }, compact ? top.event || top.label : top.headline), w.list.length > 1 ? h('b', {}, '+' + (w.list.length - 1)) : null);
}

function pollenChips(po, day = 'today') {
  const list = (po?.types || []).filter((t) => t[day] > 0).slice(0, 4);
  if (!list.length) return null;
  return h('div', { class: 'wx-pollen' }, icon('flower-pollen-outline'), list.map((t) => h('span', { class: 'pchip', title: po.texts[t[day]] }, h('i', { style: { background: POLLEN_COLOR[t[day]] } }), t.name)));
}

function hourStrip(hourly, n = 12) {
  return h('div', { class: 'wx-hours' }, hourly.slice(0, n).map((x) => h('div', { class: 'wx-h' },
    h('span', { class: 't' }, HOUR.format(new Date(x.ts))), icon(wxIcon(x.icon)), h('b', {}, fmt(x.temp) + '°'),
    h('span', { class: 'p', style: { opacity: x.rainProb >= 20 ? 1 : 0.35 } }, x.rainProb != null ? x.rainProb + '%' : ''))));
}

function dayRows(daily, n) {
  const all = daily.slice(0, n);
  const lo = Math.min(...all.map((d) => d.min)), hi = Math.max(...all.map((d) => d.max));
  return h('div', { class: 'wx-days' }, all.map((d) => h('div', { class: 'wx-d' },
    h('span', { class: 'n' }, dayName(d.date)), icon(wxIcon(d.icon)),
    h('span', { class: 'r', title: `${d.rain} mm` }, d.rainProb >= 20 ? d.rainProb + ' %' : ''),
    h('span', { class: 'lo' }, fmt(d.min) + '°'),
    h('div', { class: 'range' }, h('div', { style: { left: ((d.min - lo) / (hi - lo || 1)) * 100 + '%', right: (100 - ((d.max - lo) / (hi - lo || 1)) * 100) + '%' } })),
    h('span', { class: 'hi' }, fmt(d.max) + '°'))));
}

// ---------- Kacheln ----------
export const WEATHER_TILES = {
  weather: {
    label: 'Wetter (DWD)', icon: 'weather-partly-cloudy', desc: 'Aktuelles Wetter, Regen in den nächsten 2 Stunden, Vorhersage, Unwetterwarnungen und Pollenflug vom Deutschen Wetterdienst',
    defaults: { w: 2, h: 2 },
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }, { key: 'site', label: 'Standort', kind: 'site' },
      { key: 'days', label: 'Tage', kind: 'number' }, { key: 'hideHours', label: 'Stundenleiste', kind: 'select', options: [['', 'zeigen'], ['true', 'ausblenden']] }],
    render(tile, el) {
      el.classList.add('clickable', 'wx-tile');
      el.addEventListener('click', () => !S.editing && weatherDetail(tile.site));
      const body = h('div', { class: 'wx-body' }, h('div', { class: 'empty' }, 'Lade Wetter …'));
      el.append(body);
      const draw = (o) => {
        if (o.error) return body.replaceChildren(head('weather-cloudy-alert', tile.title || 'Wetter', o.error));
        const c = o.current || {};
        const today = o.forecast?.daily?.[0];
        const big = tile.h >= 2 || tile.w >= 3;
        const kids = [];
        if (o.warnings?.list?.length) kids.push(warnBanner(o.warnings, tile.w < 2));
        kids.push(h('div', { class: 'wx-now' },
          h('i', { class: 'mdi mdi-' + wxIcon(c.icon) + ' wx-big' }),
          h('div', { class: 'wx-temp' }, fmt(c.temp, 0), h('small', {}, '°C')),
          h('div', { class: 'wx-meta' },
            h('div', { class: 'tile-name' }, tile.title || o.site.name),
            h('div', { class: 'tile-sub' }, [wxText(c.icon), today && `${fmt(today.min)}° / ${fmt(today.max)}°`].filter(Boolean).join(' · ')),
            tile.w >= 2 ? h('div', { class: 'tile-sub' }, `Wind ${fmt(c.wind)} km/h${c.gust > 30 ? ` · Böen ${fmt(c.gust)}` : ''} · ${fmt(c.humidity)} %`) : null)));
        if (o.nowcast?.text && tile.w >= 2) kids.push(h('div', { class: 'wx-nowcast' + (/Kein Regen/.test(o.nowcast.text) ? '' : ' wet') }, icon('umbrella-outline'), o.nowcast.text));
        if (big && !tile.hideHours && o.forecast?.hourly?.length) kids.push(hourStrip(o.forecast.hourly, tile.w * 4));
        const rows = (tile.h >= 4 ? 7 : tile.h === 3 ? (tile.hideHours ? 7 : 4) : tile.h === 2 ? (tile.hideHours ? 3 : 0) : 0) - (o.warnings?.list?.length ? 1 : 0);
        if (big && o.forecast?.daily?.length && rows > 0) kids.push(dayRows(o.forecast.daily, Math.min(tile.days || 7, rows)));
        if (o.pvKwp && today?.pv != null && tile.w >= 2 && tile.h >= 3) {
          const tm = o.forecast.daily[1];
          kids.push(h('div', { class: 'wx-pv' }, icon('solar-power-variant-outline'), `PV-Prognose: heute ≈ ${fmt(today.pv, 1)} kWh${tm?.pv != null ? ` · morgen ≈ ${fmt(tm.pv, 1)} kWh` : ''}`));
        }
        if (tile.h >= 3) { const pc = pollenChips(o.pollen); if (pc) kids.push(pc); }
        body.replaceChildren(...kids);
      };
      loadWeather(tile.site || '').then(draw).catch((e) => draw({ error: e.message }));
      const iv = setInterval(() => (el.isConnected ? loadWeather(tile.site || '').then(draw).catch(() => {}) : clearInterval(iv)), 5 * 60e3);
    },
  },

  radar: {
    label: 'Regenradar (DWD)', icon: 'radar', desc: 'Niederschlagsradar rund um einen Standort – die letzte Stunde und die Prognose für die nächste',
    defaults: { w: 2, h: 2, km: 50 },
    fields: [{ key: 'title', label: 'Titel', kind: 'text' }, { key: 'site', label: 'Standort', kind: 'site' },
      { key: 'km', label: 'Umkreis', kind: 'select', options: [['25', '25 km'], ['50', '50 km'], ['100', '100 km']] }],
    render(tile, el) {
      el.classList.add('wx-radar');
      const canvas = h('canvas', { class: 'radar-cv' });
      const label = h('span', { class: 'radar-t' }, 'Lade Radar …');
      const bar = h('div', { class: 'radar-bar' }, h('div'));
      el.append(head('radar', tile.title || 'Regenradar', undefined, label), h('div', { class: 'radar-wrap' }, canvas), bar);
      let frames = [], idx = 0, playing = true, timer, data;
      const draw = () => {
        const f = frames[idx];
        if (!f) return;
        const wrap = canvas.parentElement.getBoundingClientRect();
        const size = Math.max(60, Math.min(wrap.width, wrap.height));
        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvas.height = Math.round(size * dpr);
        canvas.style.width = canvas.style.height = size + 'px';
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(f.w, f.h);
        for (let i = 0; i < f.px.length; i++) {
          const v = f.px[i];
          if (!v) continue;
          const [r, g, b] = v < 50 ? [120, 200, 255] : v < 90 ? [40, 140, 255] : v < 130 ? [40, 210, 120] : v < 170 ? [250, 210, 40] : v < 210 ? [255, 120, 40] : [255, 50, 80];
          img.data.set([r, g, b, Math.min(255, 110 + v)], i * 4);
        }
        const off = document.createElement('canvas'); off.width = f.w; off.height = f.h;
        off.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.fillStyle = '#060b12';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
        // Ringe + Standort
        const cx = ((data.pos?.x ?? f.w / 2) / f.w) * canvas.width, cy = ((data.pos?.y ?? f.h / 2) / f.h) * canvas.height;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = dpr;
        for (const r of [0.33, 0.66, 1]) { ctx.beginPath(); ctx.arc(cx, cy, (canvas.width / 2) * r, 0, Math.PI * 2); ctx.stroke(); }
        ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--accent') || '#00d8ff';
        ctx.beginPath(); ctx.arc(cx, cy, 4 * dpr, 0, Math.PI * 2); ctx.fill();
        const dt = Math.round((Date.parse(f.ts) - Date.now()) / 60e3 / 5) * 5;
        label.textContent = dt > 2 ? `+${dt} min · Prognose` : dt < -2 ? `${dt} min` : 'jetzt';
        label.classList.toggle('fc', dt > 2);
        bar.firstChild.style.width = ((idx + 1) / frames.length) * 100 + '%';
      };
      const step = () => {
        if (!el.isConnected) return clearTimeout(timer);
        if (playing) { idx = (idx + 1) % frames.length; draw(); }
        const nowIdx = frames.findIndex((f) => Date.parse(f.ts) > Date.now() - 2.5 * 60e3);
        timer = setTimeout(step, idx === frames.length - 1 ? 1800 : idx === nowIdx ? 1200 : 450);
      };
      el.addEventListener('click', () => { if (!S.editing) { playing = !playing; label.classList.toggle('paused', !playing); } });
      api(`/weather/radar?site=${encodeURIComponent(tile.site || '')}&km=${tile.km || 50}`).then((d) => {
        if (d.error) { label.textContent = d.error; return; }
        data = d;
        frames = d.frames.map((f) => ({ ...f, px: Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0)) }));
        if (!frames.length) { label.textContent = 'Keine Radardaten'; return; }
        idx = 0; draw(); step();
        new ResizeObserver(() => draw()).observe(canvas.parentElement);
      }).catch((e) => (label.textContent = e.message));
    },
  },

  calendar: {
    label: 'Kalender / Müll', icon: 'calendar-month-outline', desc: 'Termine aus ICS-Kalendern (Abfallkalender, Google, Nextcloud) – mit Erinnerung am Vorabend',
    defaults: { w: 2, h: 2, mode: 'waste', days: 21 },
    fields: [{ key: 'title', label: 'Titel', kind: 'text' },
      { key: 'urls', label: 'ICS-Adressen (eine pro Zeile)', kind: 'textarea', hint: 'Abfallkalender deiner Gemeinde als ICS-Link (oft „Kalender abonnieren“), Google: „Privatadresse im iCal-Format“' },
      { key: 'mode', label: 'Anzeige', kind: 'select', options: [['waste', 'Müllabfuhr (nur Tonnen)'], ['all', 'Alle Termine']] },
      { key: 'days', label: 'Tage voraus', kind: 'number' },
      { key: 'remind', label: 'Erinnerung am Vorabend', kind: 'select', options: [['', 'aus'], ['true', 'an (Push/HA/Browser)']] },
      { key: 'remindAt', label: 'Erinnern um', kind: 'text', hint: 'z. B. 18:00' }],
    render(tile, el) {
      const list = h('div', { class: 'cal-list' });
      el.append(head(tile.mode === 'all' ? 'calendar-month-outline' : 'delete-outline', tile.title || (tile.mode === 'all' ? 'Termine' : 'Müllabfuhr'), undefined,
        tile.remind ? h('span', { class: 'chip', title: 'Erinnerung um ' + (tile.remindAt || '18:00') }, icon('bell-ring-outline')) : null), list);
      const urls = String(tile.urls || '').split(/\s+/).filter(Boolean);
      if (!urls.length) return list.append(h('div', { class: 'empty' }, 'Bearbeiten → ICS-Adresse eintragen'));
      api(`/calendar?days=${tile.days || 21}&urls=${encodeURIComponent(urls.join(' '))}`).then(({ events, errors }) => {
        const evs = tile.mode === 'all' ? events : events.filter((e) => e.waste);
        if (!evs.length) return list.replaceChildren(h('div', { class: 'empty' }, errors?.length ? errors[0] : 'Keine Termine'));
        const today0 = new Date(); today0.setHours(0, 0, 0, 0);
        const label = (t) => {
          const d = Math.floor((t - today0) / 86400e3);
          return d === 0 ? 'Heute' : d === 1 ? 'Morgen' : new Date(t).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
        };
        const rows = [];
        const first = evs[0];
        if (tile.mode !== 'all' && first) {
          const sameDay = evs.filter((e) => label(e.start) === label(first.start));
          rows.push(h('div', { class: 'cal-next' }, h('div', { class: 'when' }, label(first.start)),
            h('div', { class: 'bins' }, sameDay.map((e) => h('span', { class: 'bin', style: { '--bc': e.waste.color } }, icon('delete'), e.waste.kind)))));
        }
        const rest = tile.mode !== 'all' ? evs.filter((e) => label(e.start) !== label(first.start)) : evs;
        rows.push(...rest.slice(0, tile.h * 4).map((e) => h('div', { class: 'list-item' },
          e.waste ? h('span', { class: 'fresh', style: { background: e.waste.color } }) : icon('calendar-blank-outline'),
          h('span', { class: 'grow' }, tile.mode !== 'all' && e.waste ? e.waste.kind : e.summary),
          h('span', { class: 'val' }, label(e.start) + (e.allDay ? '' : ' ' + new Date(e.start).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }))))));
        list.replaceChildren(...rows);
      }).catch((e) => list.replaceChildren(h('div', { class: 'empty' }, e.message)));
    },
  },
};

// ---------- Detailansicht ----------
export async function weatherDetail(site = '') {
  const box = h('div', { class: 'wx-detail' }, h('div', { class: 'empty' }, 'Lade …'));
  modal([icon('weather-partly-cloudy'), 'Wetter'], box, { wide: true });
  const o = await loadWeather(site, true).catch((e) => ({ error: e.message }));
  if (o.error) return box.replaceChildren(h('div', { class: 'empty' }, o.error));
  const c = o.current || {};
  const parts = [];
  parts.push(h('div', { class: 'wx-now big' }, h('i', { class: 'mdi mdi-' + wxIcon(c.icon) + ' wx-big' }), h('div', { class: 'wx-temp' }, fmt(c.temp, 1), h('small', {}, '°C')),
    h('div', { class: 'wx-meta' }, h('div', { class: 'tile-name' }, o.site.name), h('div', { class: 'tile-sub' }, wxText(c.icon)),
      h('div', { class: 'tile-sub' }, c.station ? `Messstation ${c.station} (${fmt(c.stationKm, 1)} km)` : ''))));
  parts.push(h('div', { class: 'wx-facts' }, [
    ['weather-windy', 'Wind', `${fmt(c.wind)} km/h`], ['weather-windy-variant', 'Böen', `${fmt(c.gust)} km/h`], ['water-percent', 'Feuchte', `${fmt(c.humidity)} %`],
    ['gauge', 'Luftdruck', `${fmt(c.pressure)} hPa`], ['weather-rainy', 'Regen 1 h', `${fmt(c.rain60, 1)} mm`], ['cloud-outline', 'Wolken', `${fmt(c.clouds)} %`],
  ].map(([ic, k, v]) => h('div', { class: 'fact' }, icon(ic), h('span', {}, k), h('b', {}, v)))));
  if (o.nowcast?.text) parts.push(h('div', { class: 'wx-nowcast' + (/Kein Regen/.test(o.nowcast.text) ? '' : ' wet') }, icon('umbrella-outline'), o.nowcast.text));
  for (const w of o.warnings?.list || []) {
    parts.push(h('div', { class: 'wx-warn big', style: { '--wc': WARN_COLOR[w.level] } },
      h('div', {}, h('b', {}, w.headline), h('div', { class: 'tile-sub' }, `${w.label} · bis ${w.expires ? new Date(w.expires).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'auf Weiteres'}`),
        h('p', {}, w.text), w.instruction ? h('p', { class: 'tile-sub' }, w.instruction) : null)));
  }
  if (o.forecast?.hourly?.length) {
    const hrs = o.forecast.hourly.slice(0, 24);
    parts.push(h('h3', {}, 'Nächste 24 Stunden'), hourChart(hrs));
  }
  if (o.forecast?.daily?.length) {
    parts.push(h('h3', {}, 'Vorhersage'), h('div', { class: 'wx-table' }, o.forecast.daily.map((d) => h('div', { class: 'row' },
      h('span', { class: 'n' }, dayName(d.date)), icon(wxIcon(d.icon)), h('span', {}, `${fmt(d.min)}° / ${fmt(d.max)}°`),
      h('span', { title: 'Regenwahrscheinlichkeit / Menge' }, icon('water-outline'), `${d.rainProb} % · ${fmt(d.rain, 1)} mm`),
      h('span', {}, icon('white-balance-sunny'), `${fmt(d.sun, 1)} h`), h('span', {}, icon('weather-windy'), `${fmt(d.gust)} km/h`),
      d.pv != null ? h('span', {}, icon('solar-power-variant-outline'), `${fmt(d.pv, 1)} kWh`) : null))));
  }
  if (o.pollen) {
    const days = [['today', 'Heute'], ['tomorrow', 'Morgen'], ['dayafter', 'Übermorgen']];
    parts.push(h('h3', {}, `Pollenflug · ${o.pollen.region}`), h('div', { class: 'wx-table pollen' },
      h('div', { class: 'row head' }, h('span', {}), days.map(([, l]) => h('span', {}, l))),
      o.pollen.types.map((t) => h('div', { class: 'row' }, h('span', { class: 'n' }, t.name),
        days.map(([k]) => h('span', { title: o.pollen.texts[t[k]] }, h('i', { class: 'pdot', style: { background: POLLEN_COLOR[t[k]] || 'rgba(255,255,255,.08)' } }), o.pollen.texts[t[k]]))))));
  } else if (!S.settings.pollenRegion) parts.push(h('p', { class: 'tile-sub' }, 'Pollenflug: Region unter Einstellungen → Wetter wählen.'));
  parts.push(h('p', { class: 'tile-sub', style: { marginTop: '14px' } }, 'Daten: Deutscher Wetterdienst (über Bright Sky)'));
  box.replaceChildren(...parts);
}

function hourChart(hrs) {
  const W = 720, H = 150, pad = 26;
  const temps = hrs.map((x) => x.temp);
  const lo = Math.floor(Math.min(...temps) - 1), hi = Math.ceil(Math.max(...temps) + 1);
  const X = (i) => pad + (i / (hrs.length - 1)) * (W - pad * 2);
  const Y = (t) => 18 + (1 - (t - lo) / (hi - lo || 1)) * (H - 58);
  const maxRain = Math.max(1, ...hrs.map((x) => x.rain || 0));
  const bars = hrs.map((x, i) => {
    const bh = ((x.rain || 0) / maxRain) * 34;
    return bh > 0.5 ? `<rect x="${X(i) - 6}" y="${H - 22 - bh}" width="12" height="${bh}" rx="2" fill="rgba(80,160,255,.55)"/>` : '';
  }).join('');
  const line = hrs.map((x, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(x.temp).toFixed(1)}`).join('');
  const labels = hrs.map((x, i) => (i % 3 === 0 ? `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${HOUR.format(new Date(x.ts))}:00</text><text x="${X(i)}" y="${Y(x.temp) - 7}" text-anchor="middle" class="v">${Math.round(x.temp)}°</text>` : '')).join('');
  return h('div', { class: 'wx-chart', html: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>${labels}</svg>` });
}

/** Wetter-Kennzeichen für die Standortliste auf der Karte. */
let sitesWx = { t: 0, p: null };
export function siteWeather() {
  if (!sitesWx.p || Date.now() - sitesWx.t > 5 * 60e3) sitesWx = { t: Date.now(), p: api('/weather/sites').catch(() => []) };
  return sitesWx.p;
}
export function wxChip(w) {
  if (!w || w.temp == null) return null;
  return h('span', { class: 'chip wx-chip', title: w.warnings?.join('\n') || '', style: w.warnLevel ? { borderColor: WARN_COLOR[w.warnLevel], color: WARN_COLOR[w.warnLevel] } : {} },
    icon(w.warnLevel ? 'alert' : wxIcon(w.icon)), `${Math.round(w.temp)}°`);
}
