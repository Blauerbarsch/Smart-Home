// Wetter vom Deutschen Wetterdienst (DWD) – über Bright Sky (freie JSON-API für die DWD-Open-Data)
// und direkt von opendata.dwd.de (Pollenflug). Kein API-Schlüssel nötig.
import { EventEmitter } from 'node:events';
import { settings, layout } from './store.js';
import { alerts } from './alerts.js';
import { ha } from './ha.js';

const API = () => (process.env.BRIGHTSKY_URL || settings().weatherApiUrl || 'https://api.brightsky.dev').replace(/\/$/, '');
const DWD = () => (process.env.DWD_OPENDATA_URL || 'https://opendata.dwd.de').replace(/\/$/, '');
const UA = { 'user-agent': 'smart-home-dashboard (github.com/Blauerbarsch/Smart-Home)' };

export const ICONS = {
  'clear-day': ['weather-sunny', 'Sonnig'], 'clear-night': ['weather-night', 'Klar'],
  'partly-cloudy-day': ['weather-partly-cloudy', 'Teils bewölkt'], 'partly-cloudy-night': ['weather-night-partly-cloudy', 'Teils bewölkt'],
  cloudy: ['weather-cloudy', 'Bewölkt'], fog: ['weather-fog', 'Nebel'], wind: ['weather-windy', 'Windig'], rain: ['weather-rainy', 'Regen'],
  sleet: ['weather-snowy-rainy', 'Schneeregen'], snow: ['weather-snowy', 'Schnee'], hail: ['weather-hail', 'Hagel'], thunderstorm: ['weather-lightning-rainy', 'Gewitter'],
};
const SEVERE = ['thunderstorm', 'hail', 'snow', 'sleet', 'rain'];
export const SEVERITY = { minor: 1, moderate: 2, severe: 3, extreme: 4 };
const SEV_DE = { minor: 'Wetterwarnung', moderate: 'Markante Wetterwarnung', severe: 'Unwetterwarnung', extreme: 'Extremes Unwetter' };

const cache = new Map(); // key → {t, data, p}
async function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c?.data && Date.now() - c.t < ttl) return c.data;
  if (c?.p) return c.p;
  const p = fn().then((data) => { cache.set(key, { t: Date.now(), data }); return data; })
    .catch((e) => { cache.set(key, { ...c, p: null }); if (c?.data) return c.data; throw e; });
  cache.set(key, { ...c, p });
  return p;
}

async function get(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Wetterdienst ${r.status}`);
  return r.json();
}

/** Ohne eigene Standorte: „Zuhause“ aus Home Assistant (zone.home) – außer es ist noch HAs Vorgabe (Amsterdam). */
function haHome() {
  const z = ha.states?.get?.('zone.home');
  const lat = Number(z?.attributes?.latitude), lon = Number(z?.attributes?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat - 52.3731339) < 1e-4 && Math.abs(lon - 4.8903147) < 1e-4) return null;
  return { id: 'ha-home', name: z.attributes.friendly_name || 'Zuhause', lat, lon };
}
export function sitesWithCoords() {
  const own = (layout().sites || []).filter((s) => s.lat !== '' && s.lat != null && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)));
  if (own.length) return own;
  const home = haHome();
  return home ? [home] : [];
}
/** Standort auflösen: Standort-ID, sonst erster Standort mit Koordinaten. */
export function siteFor(siteId) {
  const sites = sitesWithCoords();
  return sites.find((s) => s.id === siteId) || sites[0] || null;
}
export const haHomeIsDefault = () => {
  const z = ha.states?.get?.('zone.home');
  return Boolean(z && Math.abs(Number(z.attributes.latitude) - 52.3731339) < 1e-4);
};
const ll = (s) => `lat=${Number(s.lat).toFixed(4)}&lon=${Number(s.lon).toFixed(4)}`;

const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export function current(site) {
  return cached('cur:' + site.id + ll(site), 10 * 60e3, async () => {
    const d = await get(`${API()}/current_weather?${ll(site)}&tz=Europe/Berlin`);
    const w = d.weather || {};
    const st = d.sources?.[0];
    return {
      ts: w.timestamp, temp: round(w.temperature, 1), icon: w.icon, condition: w.condition, humidity: w.relative_humidity,
      wind: round(w.wind_speed_10 ?? w.wind_speed_30 ?? w.wind_speed_60), gust: round(w.wind_gust_speed_10 ?? w.wind_gust_speed_60),
      windDir: w.wind_direction_10 ?? w.wind_direction_60, rain60: w.precipitation_60, pressure: w.pressure_msl, clouds: w.cloud_cover,
      dewPoint: w.dew_point, visibility: w.visibility, station: st?.station_name, stationKm: st ? round(st.distance / 1000, 1) : null,
    };
  });
}

function dayIcon(hours) {
  const day = hours.filter((h) => { const hr = new Date(h.timestamp).getHours(); return hr >= 8 && hr <= 20; });
  const list = day.length ? day : hours;
  const count = {};
  for (const h of list) if (h.icon) count[h.icon] = (count[h.icon] || 0) + 1;
  const severe = SEVERE.find((k) => (count[k] || 0) >= (k === 'thunderstorm' || k === 'hail' ? 1 : 3));
  if (severe) return severe;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0]?.replace('-night', '-day') || 'cloudy';
}

export function forecast(site) {
  return cached('fc:' + site.id + ll(site), 30 * 60e3, async () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 8 * 86400e3);
    const d = await get(`${API()}/weather?${ll(site)}&date=${start.toISOString()}&last_date=${end.toISOString()}&tz=Europe/Berlin`);
    const hours = (d.weather || []).filter((h) => h.temperature != null);
    const byDay = new Map();
    for (const h of hours) {
      const k = h.timestamp.slice(0, 10);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(h);
    }
    const s = settings();
    const kwp = site.id === sitesWithCoords()[0]?.id ? Number(s.pvKwp) || 0 : 0; // PV-Anlage gehört zum ersten Standort
    const pr = Number(s.pvRatio) || 0.85;
    const daily = [...byDay.entries()].filter(([, hs]) => hs.length >= 12).map(([date, hs]) => {
      const sum = (k) => hs.reduce((a, h) => a + (h[k] || 0), 0);
      const solar = sum('solar');
      return {
        date, icon: dayIcon(hs),
        min: round(Math.min(...hs.map((h) => h.temperature)), 1), max: round(Math.max(...hs.map((h) => h.temperature)), 1),
        rain: round(sum('precipitation'), 1), rainProb: Math.max(0, ...hs.map((h) => h.precipitation_probability || 0)),
        sun: round(sum('sunshine') / 60, 1), gust: round(Math.max(0, ...hs.map((h) => h.wind_gust_speed || 0))),
        solar: round(solar, 2), pv: kwp ? round(solar * kwp * pr, 1) : null,
      };
    });
    const now = Date.now() - 3600e3;
    const hourly = hours.filter((h) => Date.parse(h.timestamp) >= now).slice(0, 48).map((h) => ({
      ts: h.timestamp, temp: round(h.temperature, 1), icon: h.icon, rain: h.precipitation, rainProb: h.precipitation_probability,
      wind: round(h.wind_speed), gust: round(h.wind_gust_speed), solar: h.solar, pv: kwp ? round((h.solar || 0) * kwp * pr, 2) : null,
    }));
    return { daily, hourly, station: d.sources?.find((x) => x.observation_type === 'forecast')?.station_name };
  });
}

/** Regen in den nächsten 2 Stunden am Standort (Radar + Kurzfristprognose, 5-Minuten-Schritte). */
export function nowcast(site) {
  return cached('nc:' + site.id + ll(site), 5 * 60e3, async () => {
    const d = await get(`${API()}/radar?${ll(site)}&distance=2000&format=plain&tz=Europe/Berlin`);
    const series = (d.radar || []).map((r) => {
      const g = r.precipitation_5 || [];
      const h = g.length, w = g[0]?.length || 0;
      let y = Math.floor(d.latlon_position?.y ?? h / 2), x = Math.floor(d.latlon_position?.x ?? w / 2);
      if (!(y >= 0 && y < h && x >= 0 && x < w)) { y = Math.floor(h / 2); x = Math.floor(w / 2); }
      let max = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) max = Math.max(max, g[y + dy]?.[x + dx] || 0);
      return { ts: r.timestamp, mmh: round((max / 100) * 12, 1) }; // 0,01 mm / 5 min → mm/h
    });
    return { series, text: nowcastText(series) };
  });
}

function nowcastText(series) {
  const now = Date.now();
  const fut = series.filter((s) => Date.parse(s.ts) >= now - 5 * 60e3);
  if (!fut.length) return '';
  const wet = (s) => s.mmh >= 0.2;
  const nowWet = wet(fut[0]);
  const idx = fut.findIndex((s) => wet(s) !== nowWet);
  const mins = idx > 0 ? Math.max(5, Math.round((Date.parse(fut[idx].ts) - now) / 60e3 / 5) * 5) : null;
  const strength = (v) => (v >= 10 ? 'Starkregen' : v >= 2.5 ? 'Regen' : 'leichter Regen');
  if (nowWet) return mins ? `${strength(fut[0].mmh)} – hört in etwa ${mins} min auf` : `${strength(Math.max(...fut.map((s) => s.mmh)))} – hält vorerst an`;
  return mins ? `${strength(Math.max(...fut.slice(idx).map((s) => s.mmh)))} in etwa ${mins} min` : 'Kein Regen in den nächsten 2 Stunden';
}

/** Radarbild rund um den Standort: Einzelbilder als 8-Bit-Raster (Stufe 0–255). */
export function radar(site, km = 50) {
  return cached('rad:' + site.id + ll(site) + km, 5 * 60e3, async () => {
    const d = await get(`${API()}/radar?${ll(site)}&distance=${km * 1000}&format=plain&tz=Europe/Berlin`);
    const frames = (d.radar || []).filter((_, i, a) => i % 2 === 0 || i === a.length - 1).map((r) => {
      const g = r.precipitation_5 || [];
      const h = g.length, w = g[0]?.length || 0;
      const buf = Buffer.alloc(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const mmh = ((g[y][x] || 0) / 100) * 12;
        buf[y * w + x] = mmh <= 0.05 ? 0 : Math.min(255, Math.round(Math.log2(1 + mmh * 4) * 40));
      }
      return { ts: r.timestamp, w, h, data: buf.toString('base64') };
    });
    return { frames, pos: d.latlon_position || null, km, geometry: d.geometry || null };
  });
}

export function warnings(site) {
  return cached('al:' + site.id + ll(site), 5 * 60e3, async () => {
    const d = await get(`${API()}/alerts?${ll(site)}&tz=Europe/Berlin`);
    const list = (d.alerts || []).filter((a) => a.status !== 'test').map((a) => ({
      id: a.alert_id || String(a.id), severity: a.severity, level: SEVERITY[a.severity] || 1, event: a.event_de || a.event_en,
      headline: a.headline_de || a.headline_en, text: a.description_de || a.description_en, instruction: a.instruction_de || '',
      onset: a.onset || a.effective, expires: a.expires, label: SEV_DE[a.severity] || 'Warnung',
    })).sort((a, b) => b.level - a.level);
    return { list, cell: d.location ? `${d.location.name}${d.location.district ? ' · ' + d.location.district : ''}` : '' };
  });
}

// ---------- Pollenflug (DWD-Gefahrenindex) ----------
const POLLEN_LEVEL = { '0': 0, '0-1': 1, '1': 2, '1-2': 3, '2': 4, '2-3': 5, '3': 6 };
const POLLEN_TEXT = ['keine', 'keine bis gering', 'gering', 'gering bis mittel', 'mittel', 'mittel bis hoch', 'hoch'];
const pollenFile = () => cached('pollen', 3 * 3600e3, () => get(`${DWD()}/climate_environment/health/alerts/s31fg.json`));
export async function pollenRegions() {
  const d = await pollenFile();
  return (d.content || []).map((c) => ({ id: c.partregion_id > 0 ? c.partregion_id : c.region_id, name: (c.partregion_name || c.region_name || '').trim(), region: (c.region_name || '').trim() }));
}
export async function pollen(regionId) {
  if (!regionId) return null;
  const d = await pollenFile();
  const c = (d.content || []).find((x) => String(x.partregion_id > 0 ? x.partregion_id : x.region_id) === String(regionId));
  if (!c) return null;
  const types = Object.entries(c.Pollen || {}).map(([name, v]) => ({
    name, today: POLLEN_LEVEL[v.today] ?? 0, tomorrow: POLLEN_LEVEL[v.tomorrow] ?? 0, dayafter: POLLEN_LEVEL[v.dayafter_to] ?? 0,
  })).sort((a, b) => b.today - a.today || b.tomorrow - a.tomorrow);
  return { region: (c.partregion_name || c.region_name || '').trim(), types, texts: POLLEN_TEXT, updated: d.last_update };
}

/** Alles für eine Kachel/Standort in einem Rutsch; Teilfehler bleiben Teilfehler. */
export async function overview(siteId) {
  const site = siteFor(siteId);
  if (!site) throw new Error(haHomeIsDefault()
    ? 'Kein Standort: Lege unter „Standorte“ einen Ort an (in Home Assistant steht als Zuhause noch die Vorgabe Amsterdam).'
    : 'Kein Standort mit Koordinaten – unter „Standorte“ einen Ort anlegen');
  const s = settings();
  const part = (p) => p.then((v) => v, (e) => ({ error: e.message }));
  const [cur, fc, nc, wa, po] = await Promise.all([part(current(site)), part(forecast(site)), part(nowcast(site)), part(warnings(site)), part(pollen(s.pollenRegion))]);
  return { site: { id: site.id, name: site.name, lat: site.lat, lon: site.lon }, current: cur, forecast: fc, nowcast: nc, warnings: wa, pollen: po, pvKwp: site.id === sitesWithCoords()[0]?.id ? Number(s.pvKwp) || 0 : 0 };
}

/** Kurzfassung für die KI. */
export async function summary(siteId) {
  const o = await overview(siteId);
  const c = o.current?.temp != null ? o.current : null;
  return {
    ort: o.site.name,
    jetzt: c && { temperatur: c.temp, lage: ICONS[c.icon]?.[1], wind_kmh: c.wind, boeen_kmh: c.gust, feuchte: c.humidity },
    regen_kurzfristig: o.nowcast?.text,
    tage: (o.forecast?.daily || []).slice(0, 4).map((d) => ({ datum: d.date, lage: ICONS[d.icon]?.[1], min: d.min, max: d.max, regen_mm: d.rain, regen_wahrsch: d.rainProb, sonne_h: d.sun, boeen_kmh: d.gust, ...(d.pv != null ? { pv_kwh: d.pv } : {}) })),
    warnungen: (o.warnings?.list || []).map((w) => `${w.label}: ${w.headline}`),
    pollen: o.pollen ? o.pollen.types.filter((t) => t.today > 0).map((t) => `${t.name}: ${o.pollen.texts[t.today]}`) : undefined,
  };
}

// ---------- Hintergrund: Warnungen melden, Daten für Alarmregeln ----------
class WeatherWatch extends EventEmitter {
  constructor() { super(); this.seen = new Map(); this.summary = {}; }
  start() {
    const tick = () => this.tick().catch((e) => console.error('Wetter:', e.message));
    setTimeout(tick, 8000).unref();
    setInterval(tick, 5 * 60e3).unref();
  }
  async tick() {
    const s = settings();
    if (s.weatherEnabled === false) return;
    const min = SEVERITY[s.weatherAlertMin || 'moderate'] || 2;
    for (const site of sitesWithCoords()) {
      const [wa, fc] = await Promise.all([warnings(site).catch(() => null), forecast(site).catch(() => null)]);
      if (fc) {
        const next = fc.hourly.filter((h) => Date.parse(h.ts) <= Date.now() + 24 * 3600e3);
        this.summary[site.id] = {
          name: site.name,
          min24: next.length ? Math.min(...next.map((h) => h.temp)) : null,
          max24: next.length ? Math.max(...next.map((h) => h.temp)) : null,
          gust24: next.length ? Math.max(0, ...next.map((h) => h.gust || 0)) : null,
          rain24: Math.round(next.reduce((a, h) => a + (h.rain || 0), 0) * 10) / 10,
          snow24: next.some((h) => ['snow', 'sleet'].includes(h.icon)),
          warnLevel: Math.max(0, ...(wa?.list || []).map((w) => w.level)),
        };
      }
      if (!wa) continue;
      const seen = this.seen.get(site.id) || new Set();
      const first = !this.seen.has(site.id);
      for (const w of wa.list) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        if (first || w.level < min) continue; // beim Start nichts nachmelden
        const title = `${site.name}: ${w.headline || w.event}`;
        alerts.notify({ rule: { id: 'weather', channels: s.weatherAlertChannels || ['browser', 'ha', 'ntfy'] }, level: 'warning', title, text: (w.text || '').slice(0, 400) });
      }
      this.seen.set(site.id, seen);
      this.emit('update', { site: site.id, warnings: wa.list.length });
    }
    alerts.extra.weather = this.summary;
  }
}
export const watch = new WeatherWatch();
