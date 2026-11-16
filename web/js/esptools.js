// ESP-Werkzeuge: Pin-Prüfung + Verdrahtungsbild, Flashen per USB (esptool-js), serieller Monitor (Web Serial).
import { h, icon, api, toast, modal } from './core.js';

// ---------- Pin-Regeln je Chip ----------
const CHIPS = {
  esp32: {
    label: 'ESP32', valid: (n) => n >= 0 && n <= 39 && ![20, 24, 28, 29, 30, 31].includes(n),
    flash: [6, 7, 8, 9, 10, 11], strap: { 0: 'Boot-Modus', 2: 'Boot-Modus', 5: 'SDIO-Timing', 12: 'Flash-Spannung (MTDI) – High beim Start = Bootfehler', 15: 'Boot-Logausgabe' },
    inputOnly: [34, 35, 36, 37, 38, 39], adc2: [0, 2, 4, 12, 13, 14, 15, 25, 26, 27], usb: [], uart0: [1, 3],
  },
  esp32s3: {
    label: 'ESP32-S3', valid: (n) => (n >= 0 && n <= 21) || (n >= 26 && n <= 48),
    flash: [26, 27, 28, 29, 30, 31, 32], psram: [33, 34, 35, 36, 37], strap: { 0: 'Boot-Modus', 3: 'JTAG-Auswahl', 45: 'Flash-Spannung', 46: 'Boot-Modus' },
    inputOnly: [], adc2: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], usb: [19, 20], uart0: [43, 44],
  },
  esp32s2: {
    label: 'ESP32-S2', valid: (n) => (n >= 0 && n <= 21) || (n >= 26 && n <= 46),
    flash: [26, 27, 28, 29, 30, 31, 32], strap: { 0: 'Boot-Modus', 45: 'Flash-Spannung', 46: 'Boot-Modus' },
    inputOnly: [46], adc2: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], usb: [19, 20], uart0: [43, 44],
  },
  esp32c3: {
    label: 'ESP32-C3', valid: (n) => n >= 0 && n <= 21,
    flash: [12, 13, 14, 15, 16, 17], strap: { 2: 'Boot-Modus', 8: 'Boot-Modus (muss High sein)', 9: 'Boot-Taste' },
    inputOnly: [], adc2: [5], usb: [18, 19], uart0: [20, 21],
  },
  esp32c6: {
    label: 'ESP32-C6', valid: (n) => n >= 0 && n <= 30,
    flash: [24, 25, 26, 27, 28, 29, 30], strap: { 8: 'Boot-Modus', 9: 'Boot-Taste', 15: 'JTAG-Auswahl' },
    inputOnly: [], adc2: [], usb: [12, 13], uart0: [16, 17],
  },
  esp8266: {
    label: 'ESP8266', valid: (n) => n >= 0 && n <= 17,
    flash: [6, 7, 8, 9, 10, 11], strap: { 0: 'Boot-Modus (Low = Flashmodus)', 2: 'muss beim Start High sein', 15: 'muss beim Start Low sein' },
    inputOnly: [], adc2: [], usb: [], uart0: [1, 3], noIrq: [16],
  },
};

export function detectChip(yaml) {
  const y = yaml.toLowerCase();
  if (/^esp8266:/m.test(y)) return 'esp8266';
  const variant = y.match(/variant:\s*(esp32[a-z0-9]*)/)?.[1];
  if (variant && CHIPS[variant]) return variant;
  const board = y.match(/board:\s*([^\s#]+)/)?.[1] || '';
  for (const k of ['esp32s3', 'esp32s2', 'esp32c3', 'esp32c6']) if (board.replace(/-/g, '').includes(k.replace('esp32', '')) && /s3|s2|c3|c6/.test(board)) return k;
  if (/^(rp2040|bk72xx|rtl87xx|libretiny):/m.test(y)) return null;
  return /^esp32:/m.test(y) ? 'esp32' : null;
}

const PIN_KEY = /^(\s*)(-\s*)?([a-z0-9_]*pin[a-z0-9_]*|sda|scl|number|tx|rx|miso|mosi|clk|data|clock|cs|dc|reset|trigger|echo|mclk|bclk|lrclk|dout|din)\s*:\s*(?:GPIO)?(\d{1,2})\b(.*)$/i;

/** Pins aus der YAML lesen: [{pin, key, line, component, output}] */
export function extractPins(yaml) {
  const lines = yaml.split('\n');
  const out = [];
  let top = '', platform = '', block = { name: '' };
  lines.forEach((ln, i) => {
    const topM = ln.match(/^([a-z0-9_]+):/i);
    if (topM) { top = topM[1]; platform = ''; block = { name: '' }; }
    const pf = ln.match(/^\s*-\s*platform:\s*([a-z0-9_]+)/i);
    if (pf) { platform = pf[1]; block = { name: '' }; }
    const nm = ln.match(/^\s+name:\s*["']?([^"'#]+)/);
    if (nm && !block.name) block.name = nm[1].trim();
    const m = ln.match(PIN_KEY);
    if (!m) return;
    const key = m[3].toLowerCase();
    // „number:“ nur innerhalb eines pin:-Blocks werten
    if (key === 'number' && !/pin/i.test(lines.slice(Math.max(0, i - 3), i).join(' '))) return;
    const output = /^(switch|output|light|fan|cover|ledc|gpio)$/.test(platform) && top !== 'binary_sensor' && top !== 'sensor';
    const allowOther = /allow_other_uses:\s*true/i.test(lines.slice(i, i + 4).join('\n'));
    out.push({ pin: Number(m[4]), key, line: i + 1, component: [top, platform].filter(Boolean).join(' · '), platform, top, output, allowOther, block });
  });
  // Namen stehen oft unter dem Pin – erst am Ende übernehmen
  out.forEach((p) => { p.name = p.block.name || p.component; delete p.block; });
  return out;
}

/** Prüft Pins: [{level: 'error'|'warn'|'info', pin, text, line}] */
export function checkPins(yaml) {
  const chipKey = detectChip(yaml);
  const chip = CHIPS[chipKey];
  const pins = extractPins(yaml);
  const issues = [];
  if (!chip) return { chip: null, pins, issues: [{ level: 'info', text: 'Chip nicht erkannt (esp32/esp8266 mit board/variant) – nur Doppelbelegungen geprüft.' }] };
  const usesWifi = /^wifi:/m.test(yaml);
  for (const p of pins) {
    const at = `GPIO${p.pin} (${p.key}, Zeile ${p.line})`;
    if (!chip.valid(p.pin)) issues.push({ level: 'error', pin: p.pin, line: p.line, text: `${at}: gibt es beim ${chip.label} nicht.` });
    else if (chip.flash.includes(p.pin)) issues.push({ level: 'error', pin: p.pin, line: p.line, text: `${at}: gehört zum internen Flash – nicht benutzen.` });
    else if (chip.psram?.includes(p.pin)) issues.push({ level: 'warn', pin: p.pin, line: p.line, text: `${at}: bei Modulen mit Octal-PSRAM belegt.` });
    if (chip.strap[p.pin]) issues.push({ level: p.pin === 12 && chipKey === 'esp32' ? 'warn' : 'info', pin: p.pin, line: p.line, text: `${at}: Strapping-Pin (${chip.strap[p.pin]}). Beschaltung beim Start beachten.` });
    if (chip.inputOnly.includes(p.pin) && p.output) issues.push({ level: 'error', pin: p.pin, line: p.line, text: `${at}: nur Eingang, kann nichts schalten.` });
    if (chip.inputOnly.includes(p.pin) && /pullup|pulldown/i.test(yaml.split('\n').slice(p.line - 1, p.line + 4).join(' '))) issues.push({ level: 'warn', pin: p.pin, line: p.line, text: `${at}: hat keine internen Pull-ups/-downs – externen Widerstand verwenden.` });
    if (usesWifi && p.platform === 'adc' && chip.adc2.includes(p.pin)) issues.push({ level: 'error', pin: p.pin, line: p.line, text: `${at}: ADC2 – funktioniert nicht, solange WLAN an ist. Einen ADC1-Pin nehmen.` });
    if (chip.usb.includes(p.pin)) issues.push({ level: 'warn', pin: p.pin, line: p.line, text: `${at}: USB-Datenleitung – dann geht Flashen/Logs über USB nicht mehr.` });
    if (chip.uart0.includes(p.pin) && !/^logger:[\s\S]*?baud_rate:\s*0/m.test(yaml)) issues.push({ level: 'info', pin: p.pin, line: p.line, text: `${at}: serielle Konsole (UART0). Logger auf baud_rate: 0 setzen, wenn der Pin gebraucht wird.` });
    if (chip.noIrq?.includes(p.pin) && p.top === 'binary_sensor') issues.push({ level: 'info', pin: p.pin, line: p.line, text: `${at}: kein Interrupt möglich, wird nur abgefragt.` });
  }
  // Doppelbelegung
  const by = {};
  pins.forEach((p) => (by[p.pin] ||= []).push(p));
  for (const [pin, list] of Object.entries(by)) {
    if (list.length < 2) continue;
    const sharedBus = list.every((x) => ['sda', 'scl', 'clk', 'mosi', 'miso', 'clk_pin', 'mosi_pin', 'miso_pin'].includes(x.key)) && new Set(list.map((x) => x.top)).size === 1;
    if (sharedBus || list.every((x) => x.allowOther)) continue;
    issues.push({ level: 'error', pin: Number(pin), line: list[1].line, text: `GPIO${pin} ist mehrfach belegt (Zeilen ${list.map((x) => x.line).join(', ')}).${list.some((x) => x.allowOther) ? '' : ' Falls gewollt: allow_other_uses: true.'}` });
  }
  return { chip: chip.label, chipKey, pins, issues: issues.sort((a, b) => ['error', 'warn', 'info'].indexOf(a.level) - ['error', 'warn', 'info'].indexOf(b.level)) };
}

/** Verdrahtungsbild als SVG: Chip links, Pins mit Linien zu den Komponenten rechts. */
export function wiringSvg(result, title) {
  const pins = [...new Map(result.pins.map((p) => [p.pin + p.component + p.key, p])).values()].sort((a, b) => a.pin - b.pin);
  const comps = [...new Set(pins.map((p) => p.name || p.component))];
  const rowH = 26, top = 46;
  const height = Math.max(pins.length, comps.length) * rowH + top + 24;
  const lvl = (pin) => result.issues.find((i) => i.pin === pin && i.level === 'error') ? '#ff5d6c' : result.issues.find((i) => i.pin === pin && i.level === 'warn') ? '#ffb547' : '#00d8ff';
  const compY = (c) => top + comps.indexOf(c) * rowH * Math.max(1, pins.length / Math.max(1, comps.length)) + 10;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 ${height}" font-family="JetBrains Mono, monospace" font-size="12">`;
  svg += `<rect width="640" height="${height}" fill="#05080d"/>`;
  svg += `<text x="16" y="24" fill="#e6eef7" font-size="14" font-weight="700">${esc(title || 'Verdrahtung')} · ${esc(result.chip || 'ESP')}</text>`;
  svg += `<rect x="16" y="${top - 10}" width="130" height="${pins.length * rowH + 14}" rx="8" fill="#0f1722" stroke="#2a3a4c"/>`;
  svg += `<text x="81" y="${top + (pins.length * rowH) / 2}" fill="#8193a8" text-anchor="middle" font-size="13">${esc(result.chip || 'ESP')}</text>`;
  pins.forEach((p, i) => {
    const y = top + i * rowH + 6;
    const c = lvl(p.pin);
    const cy = compY(p.name || p.component);
    svg += `<circle cx="146" cy="${y}" r="5" fill="${c}"/>`;
    svg += `<text x="140" y="${y + 4}" fill="${c}" text-anchor="end">GPIO${p.pin}</text>`;
    svg += `<path d="M151 ${y} C 260 ${y}, 300 ${cy}, 390 ${cy}" stroke="${c}" stroke-width="1.6" fill="none" opacity="0.8"/>`;
    svg += `<text x="${(151 + 390) / 2}" y="${(y + cy) / 2 - 4}" fill="#8193a8" text-anchor="middle" font-size="10">${esc(p.key)}</text>`;
  });
  comps.forEach((c) => {
    const y = compY(c);
    svg += `<rect x="390" y="${y - 11}" width="234" height="22" rx="6" fill="#0f1722" stroke="#2a3a4c"/>`;
    svg += `<text x="400" y="${y + 4}" fill="#e6eef7">${esc(String(c).slice(0, 30))}</text>`;
  });
  return svg + '</svg>';
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function pinDialog(yaml, title) {
  const r = checkPins(yaml);
  const svg = wiringSvg(r, title);
  const review = h('div', { class: 'md-lite', style: { marginTop: '10px' } });
  const COLORS = { error: 'var(--bad)', warn: 'var(--warn)', info: 'var(--muted)' };
  modal([icon('chip'), `Pin-Prüfung · ${r.chip || 'unbekannter Chip'}`], h('div', {},
    h('div', { class: 'list' }, r.issues.length ? r.issues.map((i) => h('div', { class: 'list-item' }, h('span', { class: 'fresh', style: { background: COLORS[i.level] } }), h('span', { class: 'grow', style: { whiteSpace: 'normal' } }, i.text)))
      : h('div', { class: 'list-item' }, icon('check-circle-outline'), 'Keine Auffälligkeiten bei ' + r.pins.length + ' Pins.')),
    h('div', { class: 'wiring', html: svg }), review), {
    wide: false,
    actions: () => [
      h('a', { class: 'btn', href: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), download: `${title || 'verdrahtung'}.svg` }, icon('download'), 'SVG'),
      h('button', { class: 'btn primary', onclick: async (e) => {
        e.target.disabled = true;
        review.textContent = 'KI prüft …';
        try { review.textContent = (await api('/esphome/review', { body: { yaml, issues: r.issues.map((i) => i.text) } })).review; } catch (er) { review.textContent = er.message; }
        e.target.disabled = false;
      } }, icon('robot-outline'), 'KI-Prüfung'),
    ],
  });
  return r;
}

// ---------- Flashen per USB ----------
export async function flashDialog({ configuration, friendly, firmwareFile }) {
  if (!('serial' in navigator)) {
    return modal([icon('usb'), 'Flashen per USB'], h('div', { class: 'note-text' },
      'Dein Browser kann nicht auf USB-Geräte zugreifen. Nötig ist Chrome, Edge oder Brave am PC – und die Seite muss über HTTPS (oder localhost) laufen.'));
  }
  const log = h('pre', { class: 'esp-console', style: { display: 'block', maxHeight: '220px' } });
  const bar = h('div', { class: 'bar-mini' }, h('div', { style: { width: '0%' } }));
  const status = h('div', { class: 'tile-sub' }, 'Board per USB anschließen. Bei manchen Boards beim Verbinden die BOOT-Taste halten.');
  const erase = h('input', { type: 'checkbox' });
  const addr = h('select', { class: 'input', style: { flex: '0 0 150px' }, title: 'Startadresse' },
    h('option', { value: 'auto' }, 'Adresse: auto'), h('option', { value: '0' }, '0x0 (factory)'), h('option', { value: '65536' }, '0x10000 (App)'));
  const file = h('input', { type: 'file', accept: '.bin', style: { flex: 1 } });
  const write = (t) => { log.textContent += t; log.scrollTop = log.scrollHeight; };
  const go = async (btn) => {
    btn.disabled = true;
    let transport;
    try {
      let data;
      if (file.files[0]) data = new Uint8Array(await file.files[0].arrayBuffer());
      else if (configuration) {
        status.textContent = 'Lade fertige Firmware aus ESPHome …';
        const r = await fetch('/api/esphome/firmware?configuration=' + encodeURIComponent(configuration));
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Firmware nicht verfügbar – erst kompilieren');
        data = new Uint8Array(await r.arrayBuffer());
      } else throw new Error('Bitte eine .bin-Datei wählen');
      write(`Firmware: ${(data.length / 1024).toFixed(0)} kB\n`);
      const { ESPLoader, Transport } = await import('/vendor/esptool/esptool.mjs');
      const port = await navigator.serial.requestPort();
      transport = new Transport(port, false);
      const loader = new ESPLoader({ transport, baudrate: 460800, terminal: { clean() {}, writeLine: (d) => write(d + '\n'), write } });
      status.textContent = 'Verbinde …';
      const chip = await loader.main();
      status.textContent = `Verbunden: ${chip}. Schreibe …`;
      // Factory-Images (ESPHome „factory“, Meshtastic „…factory.bin“) beginnen bei 0x0,
      // reine App-/Update-Images bei 0x10000. Auswahl „Adresse“ überschreibt.
      const fname = file.files[0]?.name || 'factory';
      const factory = addr.value === 'auto' ? /factory/i.test(fname) : addr.value === '0';
      write(`Adresse: 0x${(factory ? 0 : 0x10000).toString(16)}\n`);
      await loader.writeFlash({
        fileArray: [{ data, address: factory ? 0 : 0x10000 }],
        flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep', eraseAll: erase.checked, compress: true,
        reportProgress: (i, written, total) => { bar.firstChild.style.width = Math.round((written / total) * 100) + '%'; },
      });
      await loader.after('hard_reset');
      status.textContent = '✓ Fertig – das Board startet neu.';
      toast('Geflasht');
    } catch (e) {
      status.textContent = '✗ ' + e.message;
      write('\nFehler: ' + e.message + '\n');
    } finally {
      try { await transport?.disconnect(); } catch {}
      btn.disabled = false;
    }
  };
  modal([icon('usb'), `Per USB flashen${friendly ? ' · ' + friendly : ''}`], h('div', {},
    status, h('div', { style: { margin: '10px 0' } }, bar),
    configuration ? h('div', { class: 'tile-sub' }, `Firmware: fertig kompilierte Version aus ESPHome (${configuration}). Oder eigene Datei:`) : h('div', { class: 'tile-sub' }, 'Firmware-Datei (.bin), z. B. ESPHome „factory“ oder Meshtastic:'),
    h('div', { class: 'row', style: { margin: '6px 0 10px', alignItems: 'center', flexWrap: 'wrap' } }, file, addr, h('label', { class: 'chip', style: { flex: '0 0 auto' } }, erase, ' Flash vorher löschen')),
    log), {
    actions: () => [
      h('a', { class: 'btn', href: 'https://flasher.meshtastic.org', target: '_blank' }, icon('radio-tower'), 'Meshtastic-Flasher'),
      h('button', { class: 'btn primary', onclick: (e) => go(e.currentTarget) }, icon('flash'), 'Verbinden & flashen'),
    ],
  });
}

// ---------- Serieller Monitor ----------
export async function serialMonitor() {
  if (!('serial' in navigator)) return toast('Web Serial braucht Chrome/Edge am PC und HTTPS', true);
  const out = h('pre', { class: 'esp-console serial-out', style: { display: 'block', height: '50vh', maxHeight: 'none' } });
  const baud = h('select', { class: 'input', style: { flex: '0 0 120px' } }, [115200, 9600, 57600, 74880, 230400, 460800, 921600].map((b) => h('option', { value: b }, b)));
  const input = h('input', { class: 'input', placeholder: 'Senden (Enter)' });
  let port, reader, writer, running = false;
  const append = (t) => { out.textContent += t; if (out.textContent.length > 200000) out.textContent = out.textContent.slice(-150000); out.scrollTop = out.scrollHeight; };
  const connect = async (btn) => {
    try {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: Number(baud.value) });
      running = true;
      btn.textContent = 'Verbunden';
      writer = port.writable.getWriter();
      const dec = new TextDecoderStream();
      port.readable.pipeTo(dec.writable).catch(() => {});
      reader = dec.readable.getReader();
      while (running) {
        const { value, done } = await reader.read();
        if (done) break;
        append(value.replace(/\u001b\[[0-9;]*m/g, ''));
      }
    } catch (e) { append('\n[' + e.message + ']\n'); }
  };
  input.onkeydown = async (e) => {
    if (e.key !== 'Enter' || !writer) return;
    await writer.write(new TextEncoder().encode(input.value + '\r\n'));
    append('> ' + input.value + '\n');
    input.value = '';
  };
  const reset = async () => {
    if (!port) return;
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await new Promise((r) => setTimeout(r, 120));
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  };
  modal([icon('console'), 'Serieller Monitor'], h('div', {}, h('div', { class: 'row', style: { marginBottom: '8px' } }, baud,
    h('button', { class: 'btn primary', onclick: (e) => connect(e.currentTarget) }, icon('usb'), 'Verbinden'),
    h('button', { class: 'btn', onclick: reset }, icon('restart'), 'Reset'),
    h('button', { class: 'btn', onclick: () => (out.textContent = '') }, icon('broom'))), out, input), {
    wide: true,
    onClose: async () => {
      running = false;
      try { await reader?.cancel(); } catch {}
      try { writer?.releaseLock(); } catch {}
      try { await port?.close(); } catch {}
    },
  });
}
