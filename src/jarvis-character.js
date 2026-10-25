/**
 * <jarvis-character> — personagem 2.5D do Jarvis (Canvas 2D, sem dependências).
 *
 * Carrega as camadas geradas por tools/build_layers.py (assets/rig.json) e as
 * anima com um rig procedural: cabeça/pescoço, sobrancelhas, íris, pálpebras,
 * mandíbula/boca, tronco (respiração), braços (ombro + cotovelo) com mãos e o
 * relógio no pulso esquerdo.
 *
 * Estados: idle | thinking | talking | approval_request | confirmed
 *
 * Uso:
 *   <script type="module" src="./src/jarvis-character.js"></script>
 *   <jarvis-character src="./assets/" state="idle" framing="bust"></jarvis-character>
 *
 *   const j = document.querySelector('jarvis-character');
 *   j.setState('thinking');
 *   j.say(2500);                 // fala por 2,5 s e volta ao estado anterior
 *   j.requestApproval();         // approval_request
 *   j.confirm();                 // confirmed -> idle
 *   j.setMouthLevel(0.6);        // lip-sync externo (0..1 | null)
 *
 *   // Ou por eventos globais (qualquer parte da aplicação):
 *   window.dispatchEvent(new CustomEvent('jarvis:state', { detail: { state: 'talking' } }));
 *
 * Atributos: src, state, framing (full|bust|face|"x,y,w,h"), background (none|white|<cor css>),
 *            listen ("false" desliga os eventos globais), reduced-motion (auto|true|false), paused
 * Eventos:   jarvis-ready, jarvis-statechange {from,to}, jarvis-error
 */

const STATES = ['idle', 'thinking', 'talking', 'approval_request', 'confirmed'];
const DEG = Math.PI / 180;

// ------------------------------------------------------------ utilidades
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const rnd = (a, b) => a + Math.random() * (b - a);

/** ruído suave e determinístico (soma de senos incomensuráveis), em [-1, 1] */
function noise(t, seed) {
  const s = seed * 7.31;
  return 0.5 * Math.sin(t * 0.83 + s) + 0.3 * Math.sin(t * 1.97 + s * 1.7) + 0.2 * Math.sin(t * 3.71 + s * 0.3);
}

/** mola amortecida (segue um alvo com inércia; zeta<1 dá leve overshoot) */
class Spring {
  constructor(value = 0, freq = 3, zeta = 1) {
    this.v = value; this.vel = 0; this.target = value; this.freq = freq; this.zeta = zeta;
  }
  set(value) { this.v = value; this.target = value; this.vel = 0; }
  step(dt) {
    const w = 2 * Math.PI * this.freq;
    const n = Math.max(1, Math.ceil(dt / 0.004)); // sub-passos: estável para qualquer dt
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = w * w * (this.target - this.v) - 2 * this.zeta * w * this.vel;
      this.vel += a * h; this.v += this.vel * h;
    }
    if (!Number.isFinite(this.v)) this.set(this.target);
    return this.v;
  }
}

// ------------------------------------------------------------ rig (parâmetros animáveis)
// [frequência da mola, amortecimento]. Deslocamentos em "unidades" (escaladas por rig.unit); ângulos em graus.
const PARAM_DEFS = {
  headX: [3, 1], headY: [3, 1], headRot: [2.5, 1], headScale: [2.5, 1],
  browLY: [5, 0.9], browRY: [5, 0.9], browLRot: [5, 0.9], browRRot: [5, 0.9],
  gazeX: [9, 1], gazeY: [9, 1],
  lidDroop: [5, 1],
  mouthOpen: [14, 1],
  breath: [1, 1],
  armRShoulder: [2.2, 0.8], armRElbow: [2.4, 0.7],
  armLShoulder: [2.0, 0.8], armLElbow: [2.2, 0.72],
  swayX: [1.2, 1], swayRot: [1.2, 1], // balanço do corpo inteiro sobre os pés
};

class Rig {
  constructor() {
    this.p = {};
    for (const k in PARAM_DEFS) this.p[k] = new Spring(0, PARAM_DEFS[k][0], PARAM_DEFS[k][1]);
    this.p.headScale.set(1);
  }
  setTargets(t) { for (const k in t) if (this.p[k]) this.p[k].target = t[k]; }
  snap() { for (const k in this.p) this.p[k].set(this.p[k].target); }
  step(dt) { const out = {}; for (const k in this.p) out[k] = this.p[k].step(dt); return out; }
}

// ------------------------------------------------------------ controladores de estado
/** Cada controlador devolve alvos para o rig a cada frame. Ângulos positivos nos braços = afastar do corpo / levantar. */
const CONTROLLERS = {
  idle(c) {
    const { t, n } = c;
    return {
      headX: 2.2 * n(t * 0.35, 1), headY: 1.4 * n(t * 0.3, 2), headRot: 1.0 * n(t * 0.28, 3), headScale: 1,
      browLY: 0.4 * n(t * 0.2, 4), browRY: 0.4 * n(t * 0.2, 5), browLRot: 0, browRRot: 0,
      gazeX: c.sacc.x + 0.6 * n(t * 0.9, 6), gazeY: c.sacc.y + 0.4 * n(t * 0.8, 7),
      lidDroop: 0, mouthOpen: 0,
      armRShoulder: 0.5 * n(t * 0.25, 8), armRElbow: 1.2 * n(t * 0.3, 9),
      armLShoulder: 0.5 * n(t * 0.22, 10), armLElbow: 1.2 * n(t * 0.27, 11),
      swayX: 3 * n(t * 0.18, 12), swayRot: 0.35 * n(t * 0.15, 13),
    };
  },
  thinking(c) {
    const { t, n, since } = c;
    const k = smooth(since / 0.9);
    return {
      headX: 4 * k + 1.5 * n(t * 0.3, 1), headY: -2 * k + 1.0 * n(t * 0.3, 2),
      headRot: 3.0 * k + 0.8 * n(t * 0.25, 3), headScale: 1,
      browLY: 1.2 * k, browRY: -3.2 * k, browLRot: 0.5 * k, browRRot: -2 * k,
      gazeX: c.sacc.x + 3.5 * k + 0.6 * n(t * 0.7, 6), gazeY: c.sacc.y - 3.5 * k + 0.4 * n(t * 0.6, 7),
      lidDroop: 0.14 * k, mouthOpen: 0.04 * k,
      armRShoulder: 0.8 * k + 0.4 * n(t * 0.3, 8), armRElbow: 2 * k + 0.8 * n(t * 0.3, 9),
      armLShoulder: 1.5 * k + 0.4 * n(t * 0.2, 10), armLElbow: 9 * k + 1.0 * n(t * 0.25, 11),
      swayX: 4 * k + 2 * n(t * 0.18, 12), swayRot: 0.5 * k + 0.25 * n(t * 0.15, 13),
    };
  },
  talking(c) {
    const { t, n, mouth: m, emph } = c;
    return {
      headX: 2.5 * n(t * 0.5, 1), headY: 1.2 * n(t * 0.6, 2) + 1.3 * m, headRot: 1.3 * n(t * 0.45, 3) + 0.4 * m,
      headScale: 1,
      browLY: -1.2 * emph, browRY: -1.6 * emph, browLRot: 0, browRRot: -0.4 * emph,
      gazeX: c.sacc.x + 0.6 * n(t, 6), gazeY: c.sacc.y + 0.3 * n(t, 7),
      lidDroop: 0, mouthOpen: m,
      // gestos: antebraços vêm para a frente do corpo (ângulo negativo) e voltam, alternando os lados
      armRShoulder: 1.5 * n(t * 0.5, 8) + 1.0 * emph, armRElbow: -9 - 7 * n(t * 0.6, 9) - 8 * emph - 2 * m,
      armLShoulder: 1.2 * n(t * 0.45, 10) + 0.6 * emph, armLElbow: -7 - 6 * n(t * 0.55, 11) - 5 * emph,
      swayX: 4 * n(t * 0.3, 12), swayRot: 0.5 * n(t * 0.25, 13),
    };
  },
  approval_request(c) {
    const { t, n, since } = c;
    const k = smooth(since / 0.7);
    const bob = Math.sin(t * 2 * Math.PI * 0.75) * 0.5 + 0.5;
    return {
      headX: -1.5 * k + 1.0 * n(t * 0.3, 1), headY: -3.5 * k + 0.6 * n(t * 0.3, 2),
      headRot: -1.8 * k + 0.5 * n(t * 0.3, 3), headScale: 1 + 0.012 * k,
      browLY: -3.2 * k, browRY: -3.6 * k, browLRot: -1 * k, browRRot: 1 * k,
      gazeX: 0.3 * n(t * 0.8, 6), gazeY: 0.3 * n(t * 0.7, 7),
      lidDroop: -0.04 * k, mouthOpen: 0.1 * k,
      armRShoulder: 6 * k + 1.0 * bob * k, armRElbow: 30 * k + 3 * bob * k,
      armLShoulder: 4 * k + 0.6 * bob * k, armLElbow: 18 * k + 2 * bob * k + 0.6 * n(t * 0.3, 11),
      swayX: -2 * k + 1.5 * n(t * 0.2, 12), swayRot: -0.3 * k,
    };
  },
  confirmed(c) {
    const { since: s, n, t } = c;
    let nod = 0; // aceno curto: desce, sobe de leve, volta
    if (s < 0.28) nod = 5.5 * smooth(s / 0.28);
    else if (s < 0.55) nod = lerp(5.5, -1.2, smooth((s - 0.28) / 0.27));
    else nod = lerp(-1.2, 0, smooth((s - 0.55) / 0.5));
    const hand = s < 0.22 ? 16 * smooth(s / 0.22) : 16 * (1 - smooth((s - 0.22) / 0.8));
    const relax = smooth((s - 0.4) / 0.9);
    return {
      headX: 1.0 * n(t * 0.3, 1) * relax, headY: nod + 0.8 * n(t * 0.3, 2) * relax, headRot: 0.6 * n(t * 0.3, 3) * relax,
      headScale: 1 + 0.006 * (1 - relax),
      browLY: -1.5 * (1 - relax), browRY: -1.8 * (1 - relax), browLRot: 0, browRRot: 0,
      gazeX: 0, gazeY: 0.5 * (nod / 5.5),
      lidDroop: 0, mouthOpen: s < 0.5 ? 0.12 * Math.sin(Math.PI * s / 0.5) : 0,
      armRShoulder: 3 * (1 - relax), armRElbow: hand + 0.4 * n(t * 0.25, 9) * relax,
      armLShoulder: 1.5 * (1 - relax), armLElbow: hand * 0.6,
      swayX: 2 * n(t * 0.18, 12) * relax, swayRot: 0.3 * n(t * 0.15, 13) * relax,
    };
  },
};

// ------------------------------------------------------------ gerador de visemas (fala sem áudio)
class VisemeGen {
  constructor() { this.reset(); }
  reset() { this.t = 0; this.cur = 0; this.next = 0; this.dur = 0.12; this.phraseEnd = rnd(1.8, 3.6); this.pauseUntil = 0; this.level = 0; this.emph = 0; }
  step(dt, reduced) {
    this.t += dt;
    if (this.t < this.pauseUntil) {
      this.level = lerp(this.level, 0, 1 - Math.exp(-dt / 0.06)); this.emph = lerp(this.emph, 0, dt * 4); return this.level;
    }
    if (this.t > this.phraseEnd) { // pausa entre frases
      this.pauseUntil = this.t + rnd(0.35, 0.8); this.phraseEnd = this.pauseUntil + rnd(1.6, 3.4); this.emph = 1; return this.level;
    }
    if (this.t >= this.next) { // nova sílaba
      const rate = reduced ? rnd(0.16, 0.24) : rnd(0.09, 0.19);
      this.cur = rnd(0.25, 1.0) * (reduced ? 0.55 : 1);
      this.next = this.t + rate; this.dur = rate;
      if (Math.random() < 0.22) this.cur *= 0.35; // consoante/fechamento
    }
    const ph = 1 - (this.next - this.t) / this.dur;
    const target = this.cur * Math.pow(Math.sin(Math.PI * clamp(ph, 0, 1)), 0.8);
    this.level = lerp(this.level, target, 1 - Math.exp(-dt / 0.03));
    this.emph = lerp(this.emph, 0, dt * 2.5);
    return this.level;
  }
}

// ------------------------------------------------------------ componente
const TEMPLATE = `
<style>
  :host { display:block; position:relative; contain:layout size style; width:100%; aspect-ratio:var(--jarvis-aspect, 1 / 1); }
  :host([hidden]) { display:none; }
  canvas { position:absolute; inset:0; width:100%; height:100%; display:block; pointer-events:none; }
</style>
<canvas part="canvas" aria-hidden="true"></canvas>
`;

export class JarvisCharacter extends HTMLElement {
  static get STATES() { return STATES; }
  static get observedAttributes() { return ['state', 'src', 'framing', 'background', 'listen', 'reduced-motion', 'paused']; }

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;
    this._canvas = root.querySelector('canvas');
    this._ctx = this._canvas.getContext('2d', { alpha: true });
    this._rig = new Rig();
    this._state = 'idle'; this._prevState = 'idle'; this._stateSince = 0;
    this._t = 0; this._last = 0; this._ready = false;
    this._images = {}; this._rigData = null; this._overrides = null; this._mouthExternal = null;
    this._viseme = new VisemeGen();
    this._sacc = { x: 0, y: 0, next: 0 };
    this._blink = { v: 0, phase: 'idle', t0: 0, next: 1.5 + Math.random() * 2 };
    this._returnTimer = null;
    this._dpr = 1; this._framing = 'full'; this._view = [0, 0, 1024, 1536]; this._bg = 'none';
    this._hiddenLayers = new Set(); this._visible = true; this._raf = 0; this._lastParams = null;
    this._loop = this._loop.bind(this);
    this._onGlobalState = (e) => { if (e.detail && e.detail.state) this.setState(e.detail.state, e.detail); };
    this._onGlobalMouth = (e) => this.setMouthLevel(e.detail == null ? null : e.detail.level);
    this._mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.fps = 0; this.maxFps = 60;
  }

  // ---------------------------------------------------------- ciclo de vida
  connectedCallback() {
    this._ro = new ResizeObserver(() => this._resize()); this._ro.observe(this);
    this._io = new IntersectionObserver((es) => { this._visible = es[0].isIntersecting; }, { threshold: 0 }); this._io.observe(this);
    document.addEventListener('visibilitychange', this._onVis = () => this._schedule());
    if (this.getAttribute('listen') !== 'false') this._attachGlobal();
    this._bg = this.getAttribute('background') || 'none';
    const st = this.getAttribute('state');
    if (st && STATES.includes(st)) this._state = st;
    this._applyFraming(this.getAttribute('framing'));
    this._load(this.getAttribute('src') || './assets/');
    this._resize();
    this._schedule();
  }
  disconnectedCallback() {
    cancelAnimationFrame(this._raf); this._raf = 0;
    this._ro && this._ro.disconnect(); this._io && this._io.disconnect();
    document.removeEventListener('visibilitychange', this._onVis);
    this._detachGlobal();
    clearTimeout(this._returnTimer);
  }
  attributeChangedCallback(name, _old, val) {
    if (name === 'state' && val && val !== this._state) this.setState(val);
    else if (name === 'src' && this.isConnected && val) this._load(val);
    else if (name === 'framing') this._applyFraming(val);
    else if (name === 'background') this._bg = val || 'none';
    else if (name === 'listen') { val === 'false' ? this._detachGlobal() : this._attachGlobal(); }
    else if (name === 'paused') this._schedule();
  }
  _attachGlobal() {
    if (this._globalAttached) return; this._globalAttached = true;
    window.addEventListener('jarvis:state', this._onGlobalState);
    window.addEventListener('jarvis:mouth', this._onGlobalMouth);
  }
  _detachGlobal() {
    if (!this._globalAttached) return; this._globalAttached = false;
    window.removeEventListener('jarvis:state', this._onGlobalState);
    window.removeEventListener('jarvis:mouth', this._onGlobalMouth);
  }

  // ---------------------------------------------------------- API pública
  get state() { return this._state; }
  set state(v) { this.setState(v); }
  get ready() { return this._ready; }
  get reducedMotion() {
    const a = this.getAttribute('reduced-motion');
    if (a === 'true') return true; if (a === 'false') return false;
    return !!(this._mq && this._mq.matches);
  }
  get layers() { return this._rigData ? Object.keys(this._rigData.layers) : []; }

  /** Muda o estado. opts.instant pula a transição; opts.duration (ms) volta depois a opts.returnTo (ou ao estado anterior). */
  setState(name, opts = {}) {
    if (!STATES.includes(name)) { console.warn(`[jarvis-character] estado desconhecido: ${name}`); return false; }
    clearTimeout(this._returnTimer);
    const from = this._state;
    if (from !== name) {
      this._prevState = from; this._state = name; this._stateSince = this._t;
      if (name === 'talking') this._viseme.reset();
      if (opts.instant && this._ready) { this._rig.setTargets(this._targets(0)); this._rig.snap(); }
      if (this.getAttribute('state') !== name) this.setAttribute('state', name);
      this.dispatchEvent(new CustomEvent('jarvis-statechange', { detail: { from, to: name }, bubbles: true }));
    } else {
      this._stateSince = this._t; // reinicia gestos one-shot (ex.: confirmed de novo)
    }
    const validReturn = opts.returnTo && STATES.includes(opts.returnTo) ? opts.returnTo : null;
    if (name === 'confirmed') {
      this._returnTimer = setTimeout(() => { if (this._state === 'confirmed') this.setState(validReturn || 'idle'); }, opts.duration || 1500);
    } else if (opts.duration) {
      const back = validReturn || (from === name ? 'idle' : from);
      this._returnTimer = setTimeout(() => { if (this._state === name) this.setState(back); }, opts.duration);
    }
    return true;
  }
  /** Fala por `ms` milissegundos (ou até stopTalking()) e volta ao estado anterior. */
  say(ms = 2000, opts = {}) { return this.setState('talking', { duration: ms, returnTo: opts.returnTo }); }
  stopTalking(returnTo) {
    if (this._state !== 'talking') return;
    const back = returnTo && STATES.includes(returnTo) ? returnTo : (this._prevState === 'talking' ? 'idle' : this._prevState);
    this.setState(back);
  }
  think(ms) { return this.setState('thinking', ms ? { duration: ms } : {}); }
  requestApproval() { return this.setState('approval_request'); }
  confirm(opts) { return this.setState('confirmed', opts); }
  idle() { return this.setState('idle'); }
  /** Lip-sync externo: nível de áudio 0..1 (null volta ao gerador interno). */
  setMouthLevel(level) { this._mouthExternal = level == null ? null : clamp(+level, 0, 1); }
  /** Força parâmetros do rig (uso em desenvolvimento). null limpa. Ex.: {headRot: 5, mouthOpen: 0.5, blink: 1} */
  setOverrides(obj) { this._overrides = obj && Object.keys(obj).length ? { ...obj } : null; }
  getParams() { return { ...(this._lastParams || {}), blink: this._blink.v }; }
  /** Esconde/mostra camadas pelo nome (debug). */
  setLayerVisible(name, visible) { visible ? this._hiddenLayers.delete(name) : this._hiddenLayers.add(name); }
  /** Enquadramento: 'full' | 'bust' | 'face' | [x,y,w,h] em coordenadas da imagem. */
  setFraming(f) { this.setAttribute('framing', Array.isArray(f) ? f.join(',') : f); }
  /** Dispara uma piscada agora. */
  blink() { if (this._blink.phase === 'idle') { this._blink.phase = 'closing'; this._blink.t0 = this._t; } }

  // ---------------------------------------------------------- carga
  async _load(base) {
    this._ready = false;
    const url = base.endsWith('/') ? base : base + '/';
    try {
      const res = await fetch(url + 'rig.json');
      if (!res.ok) throw new Error(`rig.json: HTTP ${res.status}`);
      const rig = await res.json();
      const imgs = {};
      await Promise.all(Object.entries(rig.layers).map(async ([name, L]) => {
        const im = new Image(); im.decoding = 'async'; im.src = url + L.file;
        await (im.decode ? im.decode() : new Promise((ok, err) => { im.onload = ok; im.onerror = err; }));
        imgs[name] = im;
      }));
      this._rigData = rig; this._images = imgs;
      this._prepareGeometry();
      this._applyFraming(this._framing);
      this._rig.setTargets(this._targets(0)); this._rig.snap();
      this._lastParams = this._rig.step(0);
      this._ready = true; this._needsDraw = true;
      this.dispatchEvent(new CustomEvent('jarvis-ready', { bubbles: true }));
      this._schedule();
    } catch (err) {
      console.error('[jarvis-character] falha ao carregar camadas', err);
      this.dispatchEvent(new CustomEvent('jarvis-error', { detail: err, bubbles: true }));
    }
  }
  _prepareGeometry() {
    const g = this._rigData.geometry;
    const sample = (eye) => {
      // reamostra pálpebra superior/inferior nas mesmas abscissas (9 pontos)
      const up = eye.upper, lo = eye.lower.slice().reverse();
      const x0 = up[0][0], x1 = up[up.length - 1][0];
      const at = (pts, x) => {
        for (let i = 1; i < pts.length; i++) {
          const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
          if ((x >= ax && x <= bx) || (x >= bx && x <= ax)) return ay + (by - ay) * ((x - ax) / ((bx - ax) || 1));
        }
        return pts[pts.length - 1][1];
      };
      const n = 9, upper = [], lower = [];
      for (let i = 0; i < n; i++) { const x = x0 + (x1 - x0) * (i / (n - 1)); upper.push([x, at(up, x)]); lower.push([x, at(lo, x)]); }
      return { upper, lower, poly: eye.upper.concat(eye.lower.slice(1, -1)) };
    };
    this._eyes = { L: sample(g.eyeL), R: sample(g.eyeR) };
  }

  // ---------------------------------------------------------- tamanho / enquadramento
  _applyFraming(val) {
    this._framing = val || 'full';
    const presets = (this._rigData && this._rigData.framings) || {};
    const W = this._rigData ? this._rigData.width : 1024, H = this._rigData ? this._rigData.height : 1536;
    let v = presets[this._framing];
    if (!v && this._framing.includes(',')) {
      const parts = this._framing.split(',').map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) v = parts;
    }
    this._view = v || presets.full || [0, 0, W, H];
    this.style.setProperty('--jarvis-aspect', `${this._view[2]} / ${this._view[3]}`);
    this._needsDraw = true;
  }
  _resize() {
    const r = this.getBoundingClientRect();
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this._canvas.width !== w || this._canvas.height !== h) { this._canvas.width = w; this._canvas.height = h; }
    this._dpr = dpr; this._needsDraw = true;
  }

  // ---------------------------------------------------------- loop
  _schedule() {
    const shouldRun = this.isConnected && !document.hidden && this.getAttribute('paused') !== 'true';
    if (shouldRun && !this._raf) { this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }
    if (!shouldRun && this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
  }
  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    if (now - this._last < 1000 / this.maxFps - 1) return;
    const dt = clamp((now - this._last) / 1000, 0, 0.1);
    this._last = now; this._t += dt;
    const inst = 1 / Math.max(dt, 1e-3);
    this.fps = this.fps ? lerp(this.fps, inst, 0.05) : inst;
    if (!this._ready) return;
    this._update(dt);
    if (this._visible || this._needsDraw) { this._draw(); this._needsDraw = false; }
  }

  _targets(dt) {
    const reduced = this.reducedMotion;
    const t = this._t, since = t - this._stateSince;
    const n = reduced ? () => 0 : noise;
    const sacc = this._sacc; // pequenos desvios do olhar de tempos em tempos
    if (t > sacc.next) {
      const look = this._state === 'approval_request' || Math.random() < 0.45;
      sacc.x = look ? 0 : rnd(-2.5, 2.5); sacc.y = look ? 0 : rnd(-1.5, 1.5);
      sacc.next = t + rnd(1.2, 4.5);
    }
    let mouth = 0, emph = 0;
    if (this._state === 'talking') {
      const gen = this._viseme.step(dt, reduced);
      mouth = this._mouthExternal != null ? this._mouthExternal : gen;
      emph = reduced ? 0 : this._viseme.emph;
    }
    const tg = CONTROLLERS[this._state]({ t, since, n, sacc, mouth, emph, reduced });
    if (reduced) { // sem balanço contínuo: só poses + boca
      tg.headX *= 0.5; tg.headY *= 0.5; tg.headRot *= 0.5;
      tg.armRShoulder *= 0.6; tg.armRElbow *= 0.6; tg.armLShoulder *= 0.6; tg.armLElbow *= 0.6;
      tg.gazeX = 0; tg.gazeY = 0; tg.swayX = 0; tg.swayRot = 0;
    }
    tg.breath = reduced ? 0 : 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 4.6);
    if (this._overrides) Object.assign(tg, this._overrides);
    return tg;
  }

  _update(dt) {
    this._rig.setTargets(this._targets(dt));
    this._lastParams = this._rig.step(dt);
    const b = this._blink, t = this._t, reduced = this.reducedMotion;
    if (b.phase === 'idle') {
      if (t > b.next) { b.phase = 'closing'; b.t0 = t; }
      b.v = lerp(b.v, 0, 1 - Math.exp(-dt / 0.05));
    } else if (b.phase === 'closing') {
      const k = (t - b.t0) / 0.085; b.v = smooth(k);
      if (k >= 1) { b.phase = 'hold'; b.t0 = t; }
    } else if (b.phase === 'hold') {
      if (t - b.t0 > 0.045) { b.phase = 'opening'; b.t0 = t; }
    } else if (b.phase === 'opening') {
      const k = (t - b.t0) / 0.14; b.v = 1 - smooth(k);
      if (k >= 1) {
        b.phase = 'idle'; b.v = 0;
        const dbl = !reduced && Math.random() < 0.12;
        const base = this._state === 'approval_request' ? rnd(3.5, 6) : this._state === 'thinking' ? rnd(1.8, 4) : rnd(2.2, 5.5);
        b.next = t + (dbl ? 0.25 : base) * (reduced ? 1.4 : 1);
      }
    }
    if (this._overrides && this._overrides.blink != null) b.v = clamp(this._overrides.blink, 0, 1);
  }

  // ---------------------------------------------------------- desenho
  _layer(name, ctx) {
    if (this._hiddenLayers.has(name)) return;
    const L = this._rigData.layers[name], im = this._images[name];
    if (L && im) ctx.drawImage(im, L.x, L.y, L.w, L.h);
  }
  _draw() {
    const ctx = this._ctx, cv = this._canvas, p = this._lastParams, R = this._rigData, piv = R.pivots;
    const u = R.unit || 1; // escala dos deslocamentos (px da imagem por unidade)
    const W = cv.width, H = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (this._bg && this._bg !== 'none') { ctx.fillStyle = this._bg; ctx.fillRect(0, 0, W, H); }
    const [vx, vy, vw, vh] = this._view; // enquadramento (contain)
    const s = Math.min(W / vw, H / vh);
    ctx.setTransform(s, 0, 0, s, (W - vw * s) / 2 - vx * s, (H - vh * s) / 2 - vy * s);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';

    const breath = p.breath;
    const lid = clamp(this._blink.v + p.lidDroop * (1 - this._blink.v), 0, 1);
    this._layer('shadow', ctx);
    // balanço do corpo inteiro (cabeça + tronco + braços) sobre os pés
    ctx.save();
    const feet = piv.feet || [R.width / 2, R.height * 0.94];
    ctx.translate(feet[0] + p.swayX * u, feet[1]); ctx.rotate(p.swayRot * DEG); ctx.translate(-feet[0], -feet[1]);

    // ---- cabeça (desenhada ANTES do tronco: o pescoço passa por baixo do colarinho)
    ctx.save();
    const [hpx, hpy] = piv.head;
    ctx.translate(hpx + p.headX * u, hpy + (p.headY - 1.6 * breath) * u);
    ctx.rotate(p.headRot * DEG);
    ctx.scale(p.headScale, p.headScale);
    ctx.translate(-hpx, -hpy);
    this._layer('head', ctx);
    for (const [name, y, rot] of [['browL', p.browLY, p.browLRot], ['browR', p.browRY, p.browRRot]]) {
      const [bx, by] = piv[name];
      ctx.save(); ctx.translate(bx, by + y * u); ctx.rotate(rot * DEG); ctx.translate(-bx, -by);
      this._layer(name, ctx); ctx.restore();
    }
    for (const [name, eye] of [['irisL', this._eyes.L], ['irisR', this._eyes.R]]) { // íris recortadas pela abertura
      ctx.save();
      ctx.beginPath(); eye.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.clip();
      ctx.translate(p.gazeX * u, p.gazeY * 0.8 * u);
      this._layer(name, ctx);
      ctx.restore();
    }
    if (lid > 0.005) { // pálpebras: pele reconstruída descendo sobre o olho + linha dos cílios
      for (const [name, eye] of [['lidL', this._eyes.L], ['lidR', this._eyes.R]]) {
        const arc = eye.upper.map(([x, uy], i) => [x, uy + (eye.lower[i][1] - uy) * lid]);
        const topY = Math.min(...eye.upper.map((q) => q[1])) - 14 * u, m = 8 * u;
        const last = arc[arc.length - 1];
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(arc[0][0] - m, topY); ctx.lineTo(last[0] + m, topY); ctx.lineTo(last[0] + m, last[1]);
        for (let i = arc.length - 1; i >= 0; i--) ctx.lineTo(arc[i][0], arc[i][1]);
        ctx.lineTo(arc[0][0] - m, arc[0][1]);
        ctx.closePath(); ctx.clip();
        this._layer(name, ctx);
        ctx.restore();
        ctx.save();
        ctx.beginPath(); arc.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.8 * u; ctx.strokeStyle = `rgba(62,34,28,${0.55 * Math.min(1, lid * 3)})`; ctx.stroke();
        ctx.lineWidth = 3.5 * u; ctx.strokeStyle = `rgba(120,70,50,${0.18 * Math.min(1, lid * 3)})`; ctx.stroke();
        ctx.restore();
      }
    }
    ctx.save(); // mandíbula / boca
    ctx.translate(0, clamp(p.mouthOpen, 0, 1) * R.geometry.mouthDepth);
    this._layer('jaw', ctx);
    ctx.restore();
    ctx.restore(); // fim cabeça

    // ---- corpo (respiração: leve escala a partir do quadril)
    ctx.save();
    const [tpx, tpy] = piv.torso;
    const bs = 1 + 0.003 * breath;
    ctx.translate(tpx, tpy); ctx.scale(bs, bs); ctx.translate(-tpx, -tpy);
    this._layer('torso', ctx);
    // braços: ombro -> braço, cotovelo -> antebraço+mão (relógio acompanha o antebraço esquerdo)
    for (const [key, upperName, foreName, extra, sh, el] of [
      ['armR', 'armRUpper', 'armRFore', null, p.armRShoulder, p.armRElbow],
      ['armL', 'armLUpper', 'armLFore', 'watch', p.armLShoulder, p.armLElbow],
    ]) {
      const a = piv[key], dir = a.dir || 1;
      ctx.save();
      ctx.translate(a.shoulder[0], a.shoulder[1]); ctx.rotate(dir * sh * DEG); ctx.translate(-a.shoulder[0], -a.shoulder[1]);
      this._layer(upperName, ctx);
      ctx.save();
      ctx.translate(a.elbow[0], a.elbow[1]); ctx.rotate(dir * el * DEG); ctx.translate(-a.elbow[0], -a.elbow[1]);
      this._layer(foreName, ctx);
      if (extra) this._layer(extra, ctx);
      ctx.restore();
      ctx.restore();
    }
    ctx.restore(); // fim corpo
    ctx.restore(); // fim balanço
  }
}

if (!customElements.get('jarvis-character')) customElements.define('jarvis-character', JarvisCharacter);
export default JarvisCharacter;
