// STL lesen/schreiben, kleine WebGL-Vorschau (drehen, zoomen) und Gehäuse-Generator.

export function parseStl(buf) {
  const dv = new DataView(buf);
  const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const isBinary = buf.byteLength === 84 + n * 50;
  const pos = [];
  if (isBinary) {
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++) pos.push(dv.getFloat32(o + v * 12, true), dv.getFloat32(o + v * 12 + 4, true), dv.getFloat32(o + v * 12 + 8, true));
    }
  } else {
    const text = new TextDecoder().decode(buf);
    const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let m;
    while ((m = re.exec(text))) pos.push(+m[1], +m[2], +m[3]);
  }
  return new Float32Array(pos);
}

export function stlBinary(tris) {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    const [a, b, c] = t;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    [nx / l, ny / l, nz / l, ...a, ...b, ...c].forEach((x, k) => dv.setFloat32(o + k * 4, x, true));
  });
  return buf;
}

/** Größe (mm) einer Dreiecksliste. */
export function bounds(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  return { min, max, size: max.map((x, k) => x - min[k]) };
}

// ---------- WebGL-Vorschau ----------
export function viewer(canvas, pos, color = [0, 0.85, 1]) {
  const gl = canvas.getContext('webgl', { antialias: true });
  if (!gl) { canvas.replaceWith(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'WebGL nicht verfügbar' })); return () => {}; }
  // Flächennormalen
  const nor = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 9) {
    const u = [pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2]];
    const v = [pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    n = n.map((x) => x / l);
    for (let k = 0; k < 3; k++) nor.set(n, i + k * 3);
  }
  const b = bounds(pos);
  const center = b.min.map((m, k) => m + b.size[k] / 2);
  const radius = Math.hypot(...b.size) / 2 || 1;
  const vs = `attribute vec3 p; attribute vec3 n; uniform mat4 m; uniform mat4 r; varying vec3 vn; void main(){ vn = (r*vec4(n,0.)).xyz; gl_Position = m*vec4(p,1.); }`;
  const fs = `precision mediump float; varying vec3 vn; uniform vec3 c; void main(){ vec3 l = normalize(vec3(0.4,0.6,0.7)); float d = max(dot(normalize(vn), l), 0.); float rim = pow(1.-abs(normalize(vn).z), 2.)*0.35; gl_FragColor = vec4(c*(0.25+0.75*d)+rim*c, 1.); }`;
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = (data, name) => {
    const bo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
  };
  buf(pos, 'p');
  buf(nor, 'n');
  gl.enable(gl.DEPTH_TEST);
  let yaw = -0.6, pitch = -0.9, dist = radius * 2.6;
  const mul = (a, b2) => { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b2[j * 4 + k]; return o; };
  const rotX = (a) => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
  const rotZ = (a) => [Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const trans = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const persp = (f, asp, n, fa) => { const t = 1 / Math.tan(f / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, (2 * fa * n) / (n - fa), 0]; };
  const draw = () => {
    const w = canvas.clientWidth, hh = canvas.clientHeight;
    canvas.width = w * devicePixelRatio; canvas.height = hh * devicePixelRatio;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.02, 0.03, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const rot = mul(rotX(pitch), rotZ(yaw));
    const model = mul(trans(0, 0, -dist), mul(rot, trans(-center[0], -center[1], -center[2])));
    const mvp = mul(persp(0.8, w / hh, radius * 0.05, radius * 20), model);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'm'), false, new Float32Array(mvp));
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'r'), false, new Float32Array(rot));
    gl.uniform3fv(gl.getUniformLocation(prog, 'c'), color);
    gl.drawArrays(gl.TRIANGLES, 0, pos.length / 3);
  };
  let drag = null;
  canvas.onpointerdown = (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    yaw += (e.clientX - drag[0]) * 0.01;
    pitch = Math.max(-3.1, Math.min(0, pitch + (e.clientY - drag[1]) * 0.01));
    drag = [e.clientX, e.clientY];
    draw();
  };
  canvas.onpointerup = () => (drag = null);
  canvas.onwheel = (e) => { e.preventDefault(); dist = Math.max(radius * 0.8, Math.min(radius * 10, dist * (e.deltaY > 0 ? 1.1 : 0.9))); draw(); };
  canvas.style.touchAction = 'none';
  const ro = new ResizeObserver(draw);
  ro.observe(canvas);
  draw();
  return () => ro.disconnect();
}

// ---------- Gehäuse-Generator ----------
// Geschlossene Quader und Rohre; Überlappungen vereinigt der Slicer.
function box(t, x, y, z, w, d, hgt) {
  const p = [[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z], [x, y, z + hgt], [x + w, y, z + hgt], [x + w, y + d, z + hgt], [x, y + d, z + hgt]];
  [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
    .forEach(([a, b, c]) => t.push([p[a], p[b], p[c]]));
}
function tube(t, cx, cy, z, ro, ri, hgt, seg = 28) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const P = (r, a, zz) => [cx + r * Math.cos(a), cy + r * Math.sin(a), zz];
    const o0 = P(ro, a0, z), o1 = P(ro, a1, z), O0 = P(ro, a0, z + hgt), O1 = P(ro, a1, z + hgt);
    t.push([o0, o1, O1], [o0, O1, O0]);
    if (ri > 0) {
      const i0 = P(ri, a0, z), i1 = P(ri, a1, z), I0 = P(ri, a0, z + hgt), I1 = P(ri, a1, z + hgt);
      t.push([i0, I1, i1], [i0, I0, I1]);
      t.push([o0, i1, o1], [o0, i0, i1]);
      t.push([O0, O1, I1], [O0, I1, I0]);
    } else {
      t.push([[cx, cy, z], o1, o0], [[cx, cy, z + hgt], O0, O1]);
    }
  }
}
/** Wand mit rechteckiger Aussparung (aus vier Quadern). axis 'x' = Wand in x-Richtung. */
function wallWithHole(t, x, y, z, len, thick, hgt, axis, hole) {
  if (!hole) return axis === 'x' ? box(t, x, y, z, len, thick, hgt) : box(t, x, y, z, thick, len, hgt);
  const h0 = Math.max(0, hole.pos - hole.w / 2), h1 = Math.min(len, hole.pos + hole.w / 2);
  const z0 = Math.max(0, hole.z), z1 = Math.min(hgt, hole.z + hole.h);
  const part = (a, la, zz, lz) => (axis === 'x' ? box(t, x + a, y, z + zz, la, thick, lz) : box(t, x, y + a, z + zz, thick, la, lz));
  if (h0 > 0) part(0, h0, 0, hgt);
  if (h1 < len) part(h1, len - h1, 0, hgt);
  if (z0 > 0) part(h0, h1 - h0, 0, z0);
  if (z1 < hgt) part(h0, h1 - h0, z1, hgt - z1);
}

/**
 * o: { l, w, h (Innenmaße mm), wall, floor, standoff: {h, d, hole, inset}, hole: {side, w, h, pos, z}, lidH, lip, tol }
 * Liefert { base, lid } als Dreieckslisten (Deckel neben dem Unterteil platziert).
 */
export function enclosure(o) {
  const { l, w, h, wall = 2, floor = 2 } = o;
  const L = l + 2 * wall, W = w + 2 * wall;
  const base = [];
  box(base, 0, 0, 0, L, W, floor);
  const hole = o.hole?.w ? o.hole : null;
  wallWithHole(base, 0, 0, floor, L, wall, h, 'x', hole?.side === 'front' ? hole : null);
  wallWithHole(base, 0, W - wall, floor, L, wall, h, 'x', hole?.side === 'back' ? hole : null);
  wallWithHole(base, 0, 0, floor, W, wall, h, 'y', hole?.side === 'left' ? hole : null);
  wallWithHole(base, L - wall, 0, floor, W, wall, h, 'y', hole?.side === 'right' ? hole : null);
  const s = o.standoff;
  if (s?.h > 0) {
    const ins = s.inset ?? 3.5;
    for (const [sx, sy] of [[ins, ins], [l - ins, ins], [ins, w - ins], [l - ins, w - ins]]) tube(base, wall + sx, wall + sy, floor - 0.01, s.d / 2, s.hole / 2, s.h + 0.01);
  }
  // Deckel: Platte + umlaufende Lippe, die innen in die Wände greift
  const lid = [];
  const off = L + 10, lidH = o.lidH ?? 2, lip = o.lip ?? 3, tol = o.tol ?? 0.3, lw = 1.6;
  box(lid, off, 0, 0, L, W, lidH);
  const ix = off + wall + tol, iy = wall + tol, il = l - 2 * tol, iw = w - 2 * tol;
  box(lid, ix, iy, lidH, il, lw, lip);
  box(lid, ix, iy + iw - lw, lidH, il, lw, lip);
  box(lid, ix, iy, lidH, lw, iw, lip);
  box(lid, ix + il - lw, iy, lidH, lw, iw, lip);
  return { base, lid, outer: [L, W, h + floor] };
}

export function trisToPos(tris) {
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, k) => out.set(v, i * 9 + k * 3)));
  return out;
}
