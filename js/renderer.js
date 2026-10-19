// WebGL2 renderer for the warped map plus a 2D overlay for rings & markers.

// Times within this many minutes over the budget still count as inside (they
// round to the budget in the readout).
export const LIMIT_SLACK = 0.5;

const VS = `#version 300 es
in vec2 a_orig;
in vec2 a_dist;
in vec2 a_size;
in vec2 a_uv;
in float a_time;
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_res;
uniform float u_strength;
uniform float u_blend;
out vec2 v_uv;
out float v_time;
void main() {
  vec2 target = mix(a_dist, a_size, u_blend);
  vec2 p = mix(a_orig, target, u_strength);
  vec2 px = (p - u_center) * u_scale;
  gl_Position = vec4(px / (u_res * 0.5), 0.0, 1.0);
  v_uv = a_uv;
  v_time = a_time;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_time;
uniform sampler2D u_tex;
uniform sampler2D u_detail; // sharper re-render of the zoomed-in area
uniform vec4 u_detailRect;  // its extent in base uv (u0, v0, u1, v1); u1 <= u0 = none
uniform float u_budget;
uniform float u_limit;
uniform float u_shade;
uniform vec2 u_style; // x: tint strength inside budget, y: how much to lighten the greyscale beyond
out vec4 outColor;
void main() {
  vec3 base = texture(u_tex, v_uv).rgb;
  vec2 duv = (v_uv - u_detailRect.xy) / (u_detailRect.zw - u_detailRect.xy);
  if (u_detailRect.z > u_detailRect.x && all(greaterThanEqual(duv, vec2(0.0))) && all(lessThanEqual(duv, vec2(1.0)))) {
    base = texture(u_detail, duv).rgb;
  }
  // "Within budget" means the time rounds to <= the budget (u_limit =
  // budget + 0.5 min), matching the minutes shown in the tooltip.
  float t = v_time / u_limit;

  // Beyond the budget: fully greyscale (map, styles and transit lines alike),
  // lightened a little. The switch is about one pixel wide - right under the
  // red budget line - so no coloured fringe is left outside the envelope.
  float edge = max(fwidth(t), 1e-4);
  float beyond = smoothstep(1.0 - edge, 1.0 + edge, t) * u_shade;
  float g = dot(base, vec3(0.299, 0.587, 0.114));
  vec3 washed = mix(vec3(g), vec3(0.93), u_style.y);
  vec3 col = mix(base, washed, beyond);

  // Within budget: tint from teal (close) to amber (at the limit).
  vec3 ramp = mix(vec3(0.0, 0.62, 0.58), vec3(1.0, 0.62, 0.12), clamp(t, 0.0, 1.0));
  col = mix(col, ramp, (1.0 - beyond) * u_style.x * u_shade);

  // Contours every quarter of the budget, and a strong line at the budget.
  float q = v_time / (u_budget * 0.25);
  float wq = max(fwidth(q), 1e-4);
  float dq = abs(fract(q + 0.5) - 0.5) / wq;
  float minor = (1.0 - smoothstep(0.4, 1.3, dq)) * step(q, 8.5) * step(0.5, abs(q - 4.0)); // q=4 is the budget line
  col = mix(col, vec3(0.16, 0.20, 0.27), minor * 0.35 * u_shade);

  float wt = max(fwidth(v_time), 1e-4);
  float dt = abs(v_time - u_limit) / wt;
  float major = 1.0 - smoothstep(1.0, 2.4, dt);
  col = mix(col, vec3(0.87, 0.15, 0.33), major * 0.95 * u_shade);

  outColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class WarpRenderer {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.ctx2d = overlay.getContext('2d');
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = {};
    for (const a of ['a_orig', 'a_dist', 'a_size', 'a_uv', 'a_time']) this.loc[a] = gl.getAttribLocation(prog, a);
    for (const u of ['u_center', 'u_scale', 'u_res', 'u_strength', 'u_blend', 'u_tex', 'u_budget', 'u_limit', 'u_shade', 'u_style', 'u_detail', 'u_detailRect'])
      this.loc[u] = gl.getUniformLocation(prog, u);
    this.vao = gl.createVertexArray();
    this.buffers = {};
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([233, 230, 223, 255]));
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxAniso = 1;
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    if (this.anisoExt) this.maxAniso = gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT);

    this.state = { strength: 0, blend: 0, budget: 30, shade: 1, tint: 0.2, wash: 0.35, cx: 0, cy: 0, scale: 0.01 };
    this.mesh = null;
    this.overlayDraw = null;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
    }
  }

  _buffer(name, data, size) {
    const gl = this.gl;
    if (!this.buffers[name]) this.buffers[name] = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[name]);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const loc = this.loc[name];
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  setMesh(mesh, uvs) {
    const gl = this.gl;
    this.mesh = mesh;
    this._buffer('a_uv', uvs, 2);
    gl.bindVertexArray(this.vao);
    if (!this.ibo) this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  }

  setTimes(times) {
    this._buffer('a_time', times, 1);
  }

  setWarps(warps) {
    this.warps = warps;
    this._buffer('a_orig', warps.orig, 2);
    this._buffer('a_dist', warps.dist, 2);
    this._buffer('a_size', warps.size, 2);
  }

  // Higher-resolution texture for part of the base texture (rect in base uv),
  // or null to drop it.
  setDetail(canvas, rect) {
    if (!canvas) {
      this.detailRect = null;
      return;
    }
    this.detailTex ||= this.gl.createTexture();
    this.detailRect = rect;
    this._upload(this.detailTex, canvas);
  }

  setTexture(canvas) {
    this._upload(this.tex, canvas);
  }

  _upload(tex, canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisoExt) gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, this.maxAniso));
  }

  // world (metres, y up) -> CSS pixels
  toScreen(x, y) {
    const s = this.state;
    return [(x - s.cx) * s.scale + this.width / 2, this.height / 2 - (y - s.cy) * s.scale];
  }

  toWorld(px, py) {
    const s = this.state;
    return [(px - this.width / 2) / s.scale + s.cx, (this.height / 2 - py) / s.scale + s.cy];
  }

  render() {
    const gl = this.gl;
    const s = this.state;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.95, 0.95, 0.95, 1); // neutral: outside the map is 'not reachable' too
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.mesh && this.warps) {
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.loc.u_tex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.detailRect ? this.detailTex : this.tex);
      gl.uniform1i(this.loc.u_detail, 1);
      const r = this.detailRect || [0, 0, 0, 0];
      gl.uniform4f(this.loc.u_detailRect, r[0], r[1], r[2], r[3]);
      gl.uniform2f(this.loc.u_center, s.cx, s.cy);
      gl.uniform1f(this.loc.u_scale, s.scale);
      gl.uniform2f(this.loc.u_res, this.width, this.height);
      gl.uniform1f(this.loc.u_strength, s.strength);
      gl.uniform1f(this.loc.u_blend, s.blend);
      gl.uniform1f(this.loc.u_budget, s.budget);
      gl.uniform1f(this.loc.u_limit, s.budget + LIMIT_SLACK);
      gl.uniform1f(this.loc.u_shade, s.shade);
      gl.uniform2f(this.loc.u_style, s.tint, s.wash);
      gl.drawElements(gl.TRIANGLES, this.mesh.indices.length, gl.UNSIGNED_SHORT, 0);
    }
    this.drawOverlay();
  }

  drawOverlay() {
    const ctx = this.ctx2d;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.warps) return;
    const s = this.state;
    const [ox, oy] = this.toScreen(0, 0);

    // Concentric time rings: exact in the distance warp, fade out otherwise.
    const ringAlpha = s.strength * Math.pow(1 - s.blend, 2);
    if (ringAlpha > 0.02) {
      ctx.save();
      ctx.globalAlpha = ringAlpha;
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let q = 1; q <= 8; q++) {
        const t = (s.budget * q) / 4;
        const r = this.warps.k * t * s.scale;
        if (r < 8) continue;
        const isBudget = q === 4;
        ctx.beginPath();
        ctx.arc(ox, oy, r, 0, Math.PI * 2);
        ctx.setLineDash(isBudget ? [] : [4, 5]);
        ctx.lineWidth = isBudget ? 2 : 1;
        ctx.strokeStyle = isBudget ? 'rgba(222,38,84,0.9)' : 'rgba(40,50,70,0.55)';
        ctx.stroke();
        const label = formatTime(t);
        const ly = oy - r;
        if (ly > 10) {
          const w = ctx.measureText(label).width + 10;
          ctx.fillStyle = isBudget ? 'rgba(222,38,84,0.95)' : 'rgba(255,255,255,0.9)';
          roundRect(ctx, ox - w / 2, ly - 9, w, 18, 9);
          ctx.fill();
          ctx.fillStyle = isBudget ? '#fff' : '#26303f';
          ctx.fillText(label, ox, ly);
        }
      }
      ctx.restore();
    }

    if (this.overlayDraw) this.overlayDraw(ctx, this);

    // Ripples radiating from the destination while travel times load.
    if (s.loading) {
      const now = performance.now() / 1000;
      const maxR = Math.min(this.width, this.height) * 0.42;
      ctx.save();
      for (let k = 0; k < 3; k++) {
        const u = (now / 2.4 + k / 3) % 1;
        ctx.beginPath();
        ctx.arc(ox, oy, 10 + u * maxR, 0, Math.PI * 2);
        ctx.lineWidth = 2.5 * (1 - u) + 0.5;
        ctx.strokeStyle = `rgba(222,38,84,${0.55 * (1 - u) * (1 - u)})`;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Destination pin
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(ox, oy, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(222,38,84,0.18)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ox, oy, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#de2654';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function formatTime(t) {
  if (t < 90) return `${Math.round(t)} min`;
  const h = Math.floor(t / 60);
  const m = Math.round(t - h * 60);
  return m ? `${h} h ${m}` : `${h} h`;
}
