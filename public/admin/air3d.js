// Les pilotes en l'air dans la vue 3D : une couche WebGL de MapLibre, dont les lignes et les points restent sinon posés
// sur le relief. Trace à l'altitude réelle (multipliée par l'exagération, comme le relief), tige jusqu'au sol, pastille
// et nom. La trace et la tige passent derrière le relief ; la pastille et le nom restent visibles, un pilote derrière
// une crête ne doit pas disparaître. Les noms viennent des pilotes : dessinés sur un canvas, jamais en HTML.
'use strict';

/** segments au plus dans les buffers : au-delà, les traces sont allégées */
const MAX_SEGS = 150000;
const EARTH_CIRC = 40075016.686;
const mercX = lon => (lon + 180) / 360;
const mercY = lat => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
const mercZ = (alt, lat) => alt / (EARTH_CIRC * Math.cos((lat * Math.PI) / 180));

/** « hsl(200 78% 45%) » → [r, g, b] de 0 à 1 */
function rgbOf(css) {
  const m = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(css);
  if (!m) return [0, 0, 0];
  const h = Number(m[1]) / 30, s = Number(m[2]) / 100, l = Number(m[3]) / 100, a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}

const LINE_VS = `#version 300 es
in vec3 a_a; in vec3 a_b; in float a_side; in float a_w; in vec4 a_color;
uniform mat4 u_m; uniform vec2 u_half; uniform float u_dpr;
out vec4 v_color;
void main() {
  vec4 ca = u_m * vec4(a_a, 1.0), cb = u_m * vec4(a_b, 1.0);
  v_color = a_color;
  // un bout derrière la caméra : segment écarté plutôt que déformé
  if (ca.w < 1e-5 || cb.w < 1e-5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * u_half;
  float len = length(d);
  vec2 n = len > 1e-4 ? vec2(-d.y, d.x) / len : vec2(0.0);
  gl_Position = ca;
  gl_Position.xy += n * a_side * a_w * 0.5 * u_dpr / u_half * ca.w;
}`;
const LINE_FS = `#version 300 es
precision mediump float;
in vec4 v_color; out vec4 o;
void main() { o = vec4(v_color.rgb * v_color.a, v_color.a); }`;
const DOT_VS = `#version 300 es
in vec3 a_p; in float a_size; in vec4 a_color;
uniform mat4 u_m; uniform float u_dpr;
out vec4 v_color;
void main() { v_color = a_color; gl_Position = u_m * vec4(a_p, 1.0); gl_PointSize = a_size * u_dpr; }`;
const DOT_FS = `#version 300 es
precision mediump float;
in vec4 v_color; out vec4 o;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  vec3 c = r > 0.68 ? vec3(1.0) : v_color.rgb;
  o = vec4(c * v_color.a, v_color.a);
}`;

class Air3d {
  id = 'air3d';
  type = 'custom';
  renderingMode = '3d';
  /** vue 3D en cours */
  on = false;
  pilots = [];
  ox = 0; oy = 0;
  /** une tige attend encore le relief */
  needsGround = false;

  onAdd(map, gl) {
    this.map = map; this.gl = gl;
    const prog = (vs, fs, attrs) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return { p, a: Object.fromEntries(attrs.map(n => [n, gl.getAttribLocation(p, n)])), u: n => gl.getUniformLocation(p, n) };
    };
    this.line = prog(LINE_VS, LINE_FS, ['a_a', 'a_b', 'a_side', 'a_w', 'a_color']);
    this.dot = prog(DOT_VS, DOT_FS, ['a_p', 'a_size', 'a_color']);
    const vao = (buf, stride, fields) => {
      const v = gl.createVertexArray();
      gl.bindVertexArray(v);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (const [loc, n, off] of fields) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride * 4, off * 4); }
      gl.bindVertexArray(null);
      return v;
    };
    this.lineBuf = gl.createBuffer(); this.dotBuf = gl.createBuffer();
    const l = this.line.a, d = this.dot.a;
    this.lineVao = vao(this.lineBuf, 12, [[l.a_a, 3, 0], [l.a_b, 3, 3], [l.a_side, 1, 6], [l.a_w, 1, 7], [l.a_color, 4, 8]]);
    this.dotVao = vao(this.dotBuf, 8, [[d.a_p, 3, 0], [d.a_size, 1, 3], [d.a_color, 4, 4]]);
    this.lineN = 0; this.dotN = 0;

    // noms au-dessus de la carte, sans prendre les clics
    this.cv = document.createElement('canvas');
    this.cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
    map.getContainer().append(this.cv);
    this.ctx = this.cv.getContext('2d');
    // le relief arrivé, les tiges trouvent le sol
    map.on('idle', () => { if (this.on && this.needsGround) { this.needsGround = false; this.build(); } });
  }

  /** items : { id, label, color, sel, old, pts } ; segColor(fix) : couleur d'un morceau de trace, sinon celle du pilote */
  setData(items, showTracks, segColor) {
    this.items = items; this.showTracks = showTracks; this.segColor = segColor;
    if (this.on) this.build();
  }

  setOn(on) {
    this.on = on;
    if (on && this.items) this.build();
    if (!on) this.ctx?.clearRect(0, 0, this.cv.width, this.cv.height);
    this.map?.triggerRepaint();
  }

  /** hauteur du sol (exagérée), null tant que le relief n'est pas là */
  ground(lat, lon) {
    const e = this.map.queryTerrainElevation([lon, lat]);
    return e === null || e === undefined ? null : e;
  }

  build() {
    if (!this.map || !this.items) return;
    const total = this.items.reduce((n, p) => n + p.pts.length, 0);
    const skip = Math.max(1, Math.ceil(total / MAX_SEGS));
    const first = this.items[0]?.pts.at(-1);
    this.ox = first ? mercX(first[2]) : 0; this.oy = first ? mercY(first[1]) : 0;
    const lines = [], dots = [], colors = new Map();
    const rgb = css => { let c = colors.get(css); if (!c) colors.set(css, c = rgbOf(css)); return c; };
    const seg = (a, b, w, [r, g, bl], al) => {
      const ax = a[0] - this.ox, ay = a[1] - this.oy, bx = b[0] - this.ox, by = b[1] - this.oy;
      // deux triangles ; le côté s'inverse avec le sens du segment
      for (const [p, q, side] of [[[ax, ay, a[2]], [bx, by, b[2]], 1], [[ax, ay, a[2]], [bx, by, b[2]], -1], [[bx, by, b[2]], [ax, ay, a[2]], 1],
        [[ax, ay, a[2]], [bx, by, b[2]], 1], [[bx, by, b[2]], [ax, ay, a[2]], 1], [[bx, by, b[2]], [ax, ay, a[2]], -1]]) {
        lines.push(p[0], p[1], p[2], q[0], q[1], q[2], side, w, r, g, bl, al);
      }
    };
    this.pilots = [];
    this.needsGround = false;
    for (const p of this.items) {
      const pts = p.pts, world = [];
      let alt = null;
      for (let i = 0; i < pts.length; i++) {
        const f = pts[i];
        alt = f[3] ?? alt;
        if (i % skip && i !== pts.length - 1) continue;
        // pas d'altitude connue : sur le sol, sans exagérer deux fois
        const z = alt !== null ? alt * EXAGGERATION : this.ground(f[1], f[2]) ?? 0;
        world.push([mercX(f[2]), mercY(f[1]), mercZ(z, f[1]), f]);
      }
      const last = world.at(-1), lf = pts.at(-1);
      const a = p.old ? 0.45 : 0.95;
      if (this.showTracks) {
        const w = p.sel ? 4 : 2;
        for (let i = 1; i < world.length; i++) seg(world[i - 1], world[i], w, rgb(this.segColor?.(world[i][3]) ?? p.color), a);
      }
      const g = this.ground(lf[1], lf[2]);
      if (g === null) this.needsGround = true;
      else seg(last, [last[0], last[1], mercZ(g, lf[1])], 1.5, rgb(p.color), 0.75 * a);
      const [r, gr, b] = rgb(p.color);
      dots.push(last[0] - this.ox, last[1] - this.oy, last[2], p.sel ? 18 : 14, r, gr, b, p.old ? 0.6 : 1);
      this.pilots.push({ id: p.id, label: p.label, sel: p.sel, old: p.old, at: last, world });
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dotBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(dots), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.lineN = lines.length / 12; this.dotN = dots.length / 8;
    this.map.triggerRepaint();
  }

  render(gl, args) {
    if (!this.on) return;
    const m = args.defaultProjectionData.mainMatrix;
    this.m = m;
    // les buffers sont relatifs à une origine : en float 32 les coordonnées absolues tremblent
    const t = new Float32Array(m);
    for (let i = 0; i < 4; i++) t[12 + i] = m[i] * this.ox + m[4 + i] * this.oy + m[12 + i];
    const dpr = this.map.getPixelRatio();
    gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
    if (this.lineN) {
      gl.useProgram(this.line.p);
      gl.uniformMatrix4fv(this.line.u('u_m'), false, t);
      gl.uniform2f(this.line.u('u_half'), gl.drawingBufferWidth / 2, gl.drawingBufferHeight / 2);
      gl.uniform1f(this.line.u('u_dpr'), dpr);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.lineN);
    }
    gl.disable(gl.DEPTH_TEST);
    if (this.dotN) {
      gl.useProgram(this.dot.p);
      gl.uniformMatrix4fv(this.dot.u('u_m'), false, t);
      gl.uniform1f(this.dot.u('u_dpr'), dpr);
      gl.bindVertexArray(this.dotVao);
      gl.drawArrays(gl.POINTS, 0, this.dotN);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    this.drawNames();
  }

  /** position à l'écran (px CSS), null derrière la caméra */
  screen([x, y, z]) {
    const m = this.m;
    if (!m) return null;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(cw > 1e-9)) return null;
    const c = this.map.getCanvas();
    return { x: (((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) / 2) * c.clientWidth, y: ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) / 2) * c.clientHeight };
  }

  drawNames() {
    const c = this.map.getCanvas(), dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight, cx = this.ctx;
    if (this.cv.width !== Math.round(W * dpr) || this.cv.height !== Math.round(H * dpr)) { this.cv.width = Math.round(W * dpr); this.cv.height = Math.round(H * dpr); }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, H);
    cx.font = '600 12px system-ui, sans-serif'; cx.textAlign = 'center'; cx.lineJoin = 'round';
    const taken = [];
    // le pilote choisi d'abord : son nom passe avant les autres
    for (const p of [...this.pilots].sort((a, b) => b.sel - a.sel)) {
      const s = p.label ? this.screen(p.at) : null;
      if (!s || s.x < -50 || s.x > W + 50 || s.y < -20 || s.y > H + 20) continue;
      const w = cx.measureText(p.label).width + 8, x0 = s.x - w / 2, y0 = s.y - 26;
      if (taken.some(r => x0 < r.x + r.w && x0 + w > r.x && y0 < r.y + 16 && y0 + 16 > r.y)) continue;
      taken.push({ x: x0, y: y0, w });
      cx.globalAlpha = p.old ? 0.6 : 1;
      cx.lineWidth = 3.5; cx.strokeStyle = '#fff'; cx.strokeText(p.label, s.x, s.y - 14);
      cx.fillStyle = '#1d2330'; cx.fillText(p.label, s.x, s.y - 14);
    }
    cx.globalAlpha = 1;
  }

  /** le pilote sous le pointeur : sa pastille à 14 px, et sa trace à 7 px si `track` */
  pick(pt, track) {
    let best = null, bestD = 14;
    const near = (id, at, within) => {
      const s = this.screen(at);
      if (!s) return;
      const d = Math.hypot(s.x - pt.x, s.y - pt.y);
      if (d <= within && d < bestD) { bestD = d; best = id; }
    };
    for (const p of this.pilots) near(p.id, p.at, 14);
    if (!best && track) for (const p of this.pilots) for (const w of p.world) near(p.id, w, 7);
    return best;
  }
}
