import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export const TYPE_COLORS = {
  concept: '#6ee7ff',
  entity: '#a78bfa',
  person: '#fb7185',
  project: '#fbbf24',
  fact: '#34d399',
  event: '#f472b6',
  preference: '#f59e0b',
  question: '#60a5fa',
  task: '#4ade80',
  source: '#94a3b8',
};

const MAX_LABELS = 22;
// World-space lift of a label above its node. Large values make it ambiguous
// which node a label belongs to.
const LABEL_OFFSET_Y = 5.5;
const MAX_PULSES = 260;

/**
 * An animated 3D force-directed graph.
 *
 * The layout is hand-rolled rather than pulled from a library so the physics can
 * be driven by the same clock as the visuals — nodes reheat when memory changes,
 * the core pulses to the speaking amplitude, and pulses run the edges while the
 * brain is thinking.
 */
export class BrainGraph {
  constructor(canvas) {
    this.canvas = canvas;
    this.nodes = [];
    this.edges = [];
    this.nodeById = new Map();
    this.positions = new Map(); // id -> {x,y,z,vx,vy,vz}
    this.highlight = new Map(); // id -> 0..1, decays
    this.selectedId = null;
    this.hoverId = null;
    this.mood = 'idle';
    this.amplitude = 0;
    this.alpha = 1; // simulation temperature
    this.clock = new THREE.Clock();
    this.selectHandlers = [];
    this.hoverHandlers = [];
    this.disposed = false;

    this._initScene();
    this._initObjects();
    this._initEvents();
    this._animate();
  }

  // ── setup ──────────────────────────────────────────────────────────────────

  _initScene() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    if ('outputColorSpace' in this.renderer) this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x04060f, 0.0016);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.5, 6000);
    this.camera.position.set(0, 60, 340);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed = 0.5;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 2200;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.22;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.85, 0.6, 0.12);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.setSize(w, h);
  }

  /**
   * A soft round dot. Untextured THREE.Points render as hard squares, which
   * read as UI artefacts rather than lights.
   */
  _dotTexture() {
    if (this._dotTex) return this._dotTex;
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    this._dotTex = new THREE.CanvasTexture(canvas);
    return this._dotTex;
  }

  _initObjects() {
    // Starfield — cheap depth cue so the graph reads as floating in space.
    const starCount = 1400;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 1600 + Math.random() * 2200;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPos[i * 3 + 2] = r * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(
      starGeo,
      // Deliberately dim: at full brightness these read as graph nodes.
      new THREE.PointsMaterial({
        color: 0x4a6690,
        size: 2.6,
        map: this._dotTexture(),
        sizeAttenuation: true,
        transparent: true,
        depthWrite: false,
        opacity: 0.3,
      }),
    );
    this.scene.add(this.stars);

    // The core: what the brain "is" when it has nothing to point at.
    this.core = new THREE.Group();
    // Kept small and dim: it sits at the centre of mass where real nodes also
    // live, so anything bolder competes with the graph instead of framing it.
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(11, 2),
      new THREE.MeshBasicMaterial({ color: 0x7dd3fc, wireframe: true, transparent: true, opacity: 0.18 }),
    );
    const inner = new THREE.Mesh(
      new THREE.IcosahedronGeometry(6, 1),
      new THREE.MeshBasicMaterial({ color: 0xc4b5fd, wireframe: true, transparent: true, opacity: 0.3 }),
    );
    this.coreShell = shell;
    this.coreInner = inner;
    this.core.add(shell, inner);
    this.scene.add(this.core);

    // Edges
    this.edgeGeo = new THREE.BufferGeometry();
    this.edgeLines = new THREE.LineSegments(
      this.edgeGeo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.scene.add(this.edgeLines);

    // Nodes
    this.nodeGeo = new THREE.BufferGeometry();
    this.nodeMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        // Distance from camera to the orbit pivot. Node size is expressed
        // relative to this, so nodes read at a sensible size whatever the
        // graph's absolute scale — a fixed constant only looks right at one
        // zoom level.
        uFocal: { value: 320 },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute vec3 aColor;
        attribute float aGlow;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uFocal;
        varying vec3 vColor;
        varying float vGlow;
        void main() {
          vColor = aColor;
          vGlow = aGlow;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float breathe = 1.0 + 0.1 * sin(uTime * 1.7 + position.x * 0.05 + position.y * 0.03);
          gl_PointSize = aSize * breathe * (1.0 + aGlow * 1.7) * (uFocal / max(-mvPosition.z, 1.0)) * uPixelRatio;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vGlow;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float falloff = smoothstep(0.5, 0.0, d);
          float halo = pow(falloff, 2.6);
          vec3 col = mix(vColor, vec3(1.0), vGlow * 0.4);
          float alpha = halo * (0.6 + vGlow * 0.4);
          gl_FragColor = vec4(col * (1.0 + vGlow * 1.2), alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.nodePoints = new THREE.Points(this.nodeGeo, this.nodeMat);
    this.nodePoints.frustumCulled = false;
    this.scene.add(this.nodePoints);

    // Signal pulses travelling along edges
    this.pulseGeo = new THREE.BufferGeometry();
    this.pulseGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PULSES * 3), 3));
    this.pulses = new THREE.Points(
      this.pulseGeo,
      new THREE.PointsMaterial({
        color: 0x9fe4ff,
        // Small on purpose — these are signals travelling the edges, not nodes.
        size: 1.5,
        map: this._dotTexture(),
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.pulses.frustumCulled = false;
    this.scene.add(this.pulses);
    this.pulseState = Array.from({ length: MAX_PULSES }, () => ({ edge: -1, t: 0, speed: 0 }));

    // Label sprite pool
    this.labelPool = [];
    for (let i = 0; i < MAX_LABELS; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false, opacity: 0 }),
      );
      sprite.visible = false;
      sprite.renderOrder = 10;
      sprite.userData = { text: null, canvas: null, texture: null };
      this.labelPool.push(sprite);
      this.scene.add(sprite);
    }
    this._labelTimer = 0;
  }

  _initEvents() {
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    this._pointer = { x: 0, y: 0, down: false, moved: 0 };

    this._onPointerDown = (e) => {
      this._pointer.down = true;
      this._pointer.moved = 0;
      this._pointer.x = e.clientX;
      this._pointer.y = e.clientY;
    };
    this._onPointerMove = (e) => {
      if (this._pointer.down) {
        this._pointer.moved += Math.abs(e.clientX - this._pointer.x) + Math.abs(e.clientY - this._pointer.y);
        this._pointer.x = e.clientX;
        this._pointer.y = e.clientY;
        return;
      }
      const hit = this._pick(e.clientX, e.clientY);
      const id = hit?.id || null;
      if (id !== this.hoverId) {
        this.hoverId = id;
        this.canvas.style.cursor = id ? 'pointer' : 'grab';
        this.hoverHandlers.forEach((cb) => cb(id ? this.nodeById.get(id) : null));
      }
    };
    this._onPointerUp = (e) => {
      const wasDrag = this._pointer.moved > 6;
      this._pointer.down = false;
      if (wasDrag) return;
      const hit = this._pick(e.clientX, e.clientY);
      this.selectedId = hit?.id || null;
      if (hit) {
        this.highlight.set(hit.id, 1);
        this.flyTo([hit.id]);
      }
      this.selectHandlers.forEach((cb) => cb(hit ? this.nodeById.get(hit.id) : null));
    };

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointerleave', () => {
      this._pointer.down = false;
    });
  }

  /**
   * Screen-space nearest-node pick. More reliable than a Points raycast here,
   * because node sizes vary and the raycast threshold is a single global value.
   */
  _pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const v = new THREE.Vector3();
    let best = null;
    let bestDist = 26; // px

    for (const node of this.nodes) {
      const p = this.positions.get(node.id);
      if (!p) continue;
      v.set(p.x, p.y, p.z).project(this.camera);
      if (v.z > 1) continue; // behind camera
      const sx = ((v.x + 1) / 2) * rect.width;
      const sy = ((1 - v.y) / 2) * rect.height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestDist) {
        bestDist = d;
        best = { id: node.id, screen: { x: sx, y: sy } };
      }
    }
    return best;
  }

  // ── data ───────────────────────────────────────────────────────────────────

  setData({ nodes = [], edges = [] }) {
    const previous = this.positions;
    this.nodes = nodes;
    this.edges = edges.filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to));
    this.nodeById = new Map(nodes.map((n) => [n.id, n]));

    const next = new Map();
    for (const node of nodes) {
      if (previous.has(node.id)) {
        next.set(node.id, previous.get(node.id));
        continue;
      }
      // Spawn a new node beside a neighbour it already links to, so it doesn't
      // fly in from across the scene and yank the layout apart.
      const anchorEdge = this.edges.find((e) => e.from === node.id || e.to === node.id);
      const anchorId = anchorEdge ? (anchorEdge.from === node.id ? anchorEdge.to : anchorEdge.from) : null;
      const anchor = anchorId ? previous.get(anchorId) : null;
      const spread = anchor ? 26 : 130;
      next.set(node.id, {
        x: (anchor?.x || 0) + (Math.random() - 0.5) * spread,
        y: (anchor?.y || 0) + (Math.random() - 0.5) * spread,
        z: (anchor?.z || 0) + (Math.random() - 0.5) * spread,
        vx: 0,
        vy: 0,
        vz: 0,
      });
      // New memories announce themselves — but not on the very first load, or
      // the entire existing graph flashes white on startup.
      if (this._framedOnce) this.highlight.set(node.id, 1);
    }
    this.positions = next;

    this._degree = new Map();
    for (const e of this.edges) {
      this._degree.set(e.from, (this._degree.get(e.from) || 0) + 1);
      this._degree.set(e.to, (this._degree.get(e.to) || 0) + 1);
    }

    this._rebuildBuffers();
    this.alpha = Math.max(this.alpha, 0.9); // reheat

    // Frame the graph once, after the first layout has had time to settle.
    // Later updates leave the camera alone — yanking the view mid-conversation
    // is disorienting.
    if (!this._framedOnce && nodes.length) {
      this._framedOnce = true;
      clearTimeout(this._frameTimer);
      this._frameTimer = setTimeout(() => this.frameAll(), 1400);
    }
  }

  /** Fit every node in view. */
  frameAll({ padding = 1.35 } = {}) {
    const points = [...this.positions.values()];
    if (!points.length) return;

    const center = points.reduce(
      (acc, p) => ({
        x: acc.x + p.x / points.length,
        y: acc.y + p.y / points.length,
        z: acc.z + p.z / points.length,
      }),
      { x: 0, y: 0, z: 0 },
    );
    const radius = Math.max(
      50,
      ...points.map((p) => Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z)),
    );

    // Fit the bounding sphere to the narrower of the two field-of-view axes.
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const distance = (radius * padding) / Math.sin(Math.min(vFov, hFov) / 2);

    const target = new THREE.Vector3(center.x, center.y, center.z);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.001) dir.set(0.25, 0.35, 1).normalize();

    this._tween = {
      t: 0,
      duration: 1.2,
      fromCam: this.camera.position.clone(),
      toCam: target.clone().add(dir.multiplyScalar(distance)),
      fromTarget: this.controls.target.clone(),
      toTarget: target,
    };
  }

  _rebuildBuffers() {
    const n = this.nodes.length;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const color = new Float32Array(n * 3);
    const glow = new Float32Array(n);
    const c = new THREE.Color();

    this.nodes.forEach((node, i) => {
      const p = this.positions.get(node.id);
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
      const degree = this._degree.get(node.id) || 0;
      size[i] = 7 + node.importance * 13 + Math.min(degree, 12) * 1.0 + (node.pinned ? 4 : 0);
      c.set(node.color || TYPE_COLORS[node.type] || '#8ab4ff');
      color[i * 3] = c.r;
      color[i * 3 + 1] = c.g;
      color[i * 3 + 2] = c.b;
      glow[i] = this.highlight.get(node.id) || 0;
    });

    this.nodeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.nodeGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.nodeGeo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    this.nodeGeo.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));

    const ePos = new Float32Array(this.edges.length * 6);
    const eCol = new Float32Array(this.edges.length * 6);
    this.edgeGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
    this.edgeGeo.setAttribute('color', new THREE.BufferAttribute(eCol, 3));

    this._index = new Map(this.nodes.map((node, i) => [node.id, i]));

    for (const p of this.pulseState) {
      p.edge = this.edges.length ? Math.floor(Math.random() * this.edges.length) : -1;
      p.t = Math.random();
      p.speed = 0.15 + Math.random() * 0.35;
    }
  }

  // ── simulation ─────────────────────────────────────────────────────────────

  _step(dt) {
    const n = this.nodes.length;
    if (!n) return;

    const alpha = this.alpha;
    if (alpha < 0.005) return;

    const REPULSION = 2200;
    const CELL = 64;
    const IDEAL = 46;
    const MIN_SEPARATION = 7;
    const MAX_STEP_DISPLACEMENT = 22;

    // Uniform spatial grid so repulsion stays near-linear instead of O(n²).
    const grid = new Map();
    const key = (x, y, z) =>
      `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
    for (const node of this.nodes) {
      const p = this.positions.get(node.id);
      const k = key(p.x, p.y, p.z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(node.id);
    }

    for (const node of this.nodes) {
      const p = this.positions.get(node.id);
      const cx = Math.floor(p.x / CELL);
      const cy = Math.floor(p.y / CELL);
      const cz = Math.floor(p.z / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!bucket) continue;
            for (const otherId of bucket) {
              if (otherId === node.id) continue;
              const q = this.positions.get(otherId);
              let ox = p.x - q.x;
              let oy = p.y - q.y;
              let oz = p.z - q.z;
              let d2 = ox * ox + oy * oy + oz * oz;
              if (d2 < 0.01) {
                // Coincident nodes get a nudge apart.
                ox = Math.random() - 0.5;
                oy = Math.random() - 0.5;
                oz = Math.random() - 0.5;
                d2 = 0.01;
              }
              if (d2 > CELL * CELL * 4) continue;
              // Clamp the separation used for the inverse-square term. Without a
              // floor, two nodes that spawn on top of each other produce an
              // effectively infinite impulse and blow the whole layout apart.
              const sep = Math.max(Math.sqrt(d2), MIN_SEPARATION);
              const inv = REPULSION / (sep * sep * sep);
              p.vx += ox * inv * dt;
              p.vy += oy * inv * dt;
              p.vz += oz * inv * dt;
            }
          }
        }
      }
    }

    for (const e of this.edges) {
      const a = this.positions.get(e.from);
      const b = this.positions.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const dist = Math.hypot(dx, dy, dz) || 0.001;
      const target = IDEAL + (1 - (e.weight ?? 0.6)) * 46;
      const force = (dist - target) * 0.9 * (0.35 + (e.weight ?? 0.6)) * dt;
      const ux = (dx / dist) * force;
      const uy = (dy / dist) * force;
      const uz = (dz / dist) * force;
      a.vx += ux;
      a.vy += uy;
      a.vz += uz;
      b.vx -= ux;
      b.vy -= uy;
      b.vz -= uz;
    }

    const damping = 0.86;
    for (const node of this.nodes) {
      const p = this.positions.get(node.id);
      // Gravity toward the core, weaker for important nodes so they sit outward
      // where they're readable rather than buried in the middle.
      const gravity = 0.3 * (1.15 - node.importance * 0.5) * dt;
      p.vx -= p.x * gravity;
      p.vy -= p.y * gravity;
      p.vz -= p.z * gravity;

      p.vx *= damping;
      p.vy *= damping;
      p.vz *= damping;

      const speedCap = 240;
      const sp = Math.hypot(p.vx, p.vy, p.vz);
      if (sp > speedCap) {
        const s = speedCap / sp;
        p.vx *= s;
        p.vy *= s;
        p.vz *= s;
      }

      // Hard cap on movement per step. This is what keeps the layout stable
      // when a slow frame hands us a large delta.
      let dx = p.vx * alpha * dt;
      let dy = p.vy * alpha * dt;
      let dz = p.vz * alpha * dt;
      const disp = Math.hypot(dx, dy, dz);
      if (disp > MAX_STEP_DISPLACEMENT) {
        const s = MAX_STEP_DISPLACEMENT / disp;
        dx *= s;
        dy *= s;
        dz *= s;
      }
      p.x += dx;
      p.y += dy;
      p.z += dz;
    }

    this.alpha *= 0.994;
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  _animate = () => {
    if (this.disposed) return;
    this._raf = requestAnimationFrame(this._animate);

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    // Clamp the simulation step so a dropped frame can't destabilise the layout.
    this._step(Math.min(dt * 60, 1.6));
    this._updateTween(dt);
    this._writeBuffers(dt);
    this._updatePulses(dt);
    this._updateCore(dt, t);

    this._labelTimer -= dt;
    if (this._labelTimer <= 0) {
      this._labelTimer = 0.16;
      this._updateLabels();
    }

    this.nodeMat.uniforms.uTime.value = t;
    this.nodeMat.uniforms.uFocal.value = this.camera.position.distanceTo(this.controls.target);
    this.stars.rotation.y += dt * 0.004;
    this.controls.update();
    this.composer.render();
  };

  _writeBuffers(dt) {
    if (!this.nodes.length) return;
    const posAttr = this.nodeGeo.getAttribute('position');
    const glowAttr = this.nodeGeo.getAttribute('aGlow');
    const pos = posAttr.array;
    const glow = glowAttr.array;

    this.nodes.forEach((node, i) => {
      const p = this.positions.get(node.id);
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;

      let g = this.highlight.get(node.id) || 0;
      if (g > 0) {
        g = Math.max(0, g - dt * 0.32);
        if (g <= 0.001) this.highlight.delete(node.id);
        else this.highlight.set(node.id, g);
      }
      const isSelected = node.id === this.selectedId;
      const isHovered = node.id === this.hoverId;
      glow[i] = Math.min(1, g + (isSelected ? 0.85 : 0) + (isHovered ? 0.4 : 0));
    });
    posAttr.needsUpdate = true;
    glowAttr.needsUpdate = true;

    if (!this.edges.length) return;
    const eposAttr = this.edgeGeo.getAttribute('position');
    const ecolAttr = this.edgeGeo.getAttribute('color');
    const epos = eposAttr.array;
    const ecol = ecolAttr.array;

    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const a = this.positions.get(e.from);
      const b = this.positions.get(e.to);
      if (!a || !b) continue;
      epos[i * 6] = a.x;
      epos[i * 6 + 1] = a.y;
      epos[i * 6 + 2] = a.z;
      epos[i * 6 + 3] = b.x;
      epos[i * 6 + 4] = b.y;
      epos[i * 6 + 5] = b.z;

      const hot = Math.max(this.highlight.get(e.from) || 0, this.highlight.get(e.to) || 0);
      const touchesSelection =
        this.selectedId && (e.from === this.selectedId || e.to === this.selectedId) ? 1 : 0;
      const base = 0.16 + (e.weight ?? 0.6) * 0.22;
      const lit = base + hot * 0.8 + touchesSelection * 0.7;
      ecol[i * 6] = lit * 0.45;
      ecol[i * 6 + 1] = lit * 0.85;
      ecol[i * 6 + 2] = lit;
      ecol[i * 6 + 3] = lit * 0.5;
      ecol[i * 6 + 4] = lit * 0.7;
      ecol[i * 6 + 5] = lit;
    }
    eposAttr.needsUpdate = true;
    ecolAttr.needsUpdate = true;
  }

  _updatePulses(dt) {
    const arr = this.pulseGeo.getAttribute('position').array;
    const activeCount =
      this.mood === 'thinking' ? MAX_PULSES : Math.floor(MAX_PULSES * (this.mood === 'speaking' ? 0.22 : 0.1));
    const speedScale = this.mood === 'thinking' ? 2.4 : this.mood === 'speaking' ? 1.5 : 1;

    for (let i = 0; i < MAX_PULSES; i++) {
      const p = this.pulseState[i];
      if (i >= activeCount || p.edge < 0 || p.edge >= this.edges.length || !this.edges.length) {
        // Park unused pulses far away rather than resizing the buffer each frame.
        arr[i * 3] = 0;
        arr[i * 3 + 1] = 0;
        arr[i * 3 + 2] = -100000;
        continue;
      }
      const e = this.edges[p.edge];
      const a = this.positions.get(e.from);
      const b = this.positions.get(e.to);
      if (!a || !b) {
        p.edge = Math.floor(Math.random() * this.edges.length);
        continue;
      }
      p.t += p.speed * dt * speedScale;
      if (p.t > 1) {
        p.t = 0;
        p.edge = Math.floor(Math.random() * this.edges.length);
        p.speed = 0.15 + Math.random() * 0.35;
      }
      arr[i * 3] = a.x + (b.x - a.x) * p.t;
      arr[i * 3 + 1] = a.y + (b.y - a.y) * p.t;
      arr[i * 3 + 2] = a.z + (b.z - a.z) * p.t;
    }
    this.pulseGeo.getAttribute('position').needsUpdate = true;
  }

  _updateCore(dt, t) {
    const speaking = this.mood === 'speaking';
    const thinking = this.mood === 'thinking';

    const targetScale = speaking ? 1 + this.amplitude * 0.9 : thinking ? 1.15 + Math.sin(t * 6) * 0.09 : 1;
    this.core.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.18);

    const spin = thinking ? 1.1 : speaking ? 0.55 : 0.16;
    this.coreShell.rotation.y += dt * spin;
    this.coreShell.rotation.x += dt * spin * 0.4;
    this.coreInner.rotation.y -= dt * spin * 1.8;
    this.coreInner.rotation.z += dt * spin * 0.9;

    const targetBloom = speaking ? 1.0 + this.amplitude * 1.1 : thinking ? 1.25 : 0.85;
    this.bloom.strength += (targetBloom - this.bloom.strength) * 0.1;

    this.coreShell.material.opacity = 0.16 + (speaking ? this.amplitude * 0.4 : thinking ? 0.16 : 0.03);
  }

  _updateLabels() {
    if (!this.nodes.length) {
      for (const s of this.labelPool) s.visible = false;
      return;
    }

    const camPos = this.camera.position;
    const scored = this.nodes.map((node) => {
      const p = this.positions.get(node.id);
      const dist = Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z);
      const boost =
        (this.highlight.get(node.id) || 0) * 100 +
        (node.id === this.selectedId ? 200 : 0) +
        (node.id === this.hoverId ? 150 : 0) +
        (node.pinned ? 40 : 0);
      return { node, score: boost + node.importance * 30 - dist * 0.05 };
    });
    scored.sort((a, b) => b.score - a.score);

    // Place labels in score order, skipping any that would collide with one
    // already placed. Without this the graph turns into a pile of overlapping
    // text as soon as a cluster forms.
    const rect = { w: this.canvas.clientWidth || 1, h: this.canvas.clientHeight || 1 };
    const worldPerPixel = (dist) => (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / rect.h;
    const placed = [];
    const v = new THREE.Vector3();
    let used = 0;

    for (const { node } of scored) {
      if (used >= MAX_LABELS) break;
      const p = this.positions.get(node.id);
      if (!p) continue;

      v.set(p.x, p.y + LABEL_OFFSET_Y, p.z);
      const dist = camPos.distanceTo(v);
      v.project(this.camera);
      if (v.z > 1) continue; // behind the camera
      const sx = ((v.x + 1) / 2) * rect.w;
      const sy = ((1 - v.y) / 2) * rect.h;
      if (sx < -120 || sx > rect.w + 120 || sy < -40 || sy > rect.h + 40) continue; // off-screen

      const sprite = this.labelPool[used];
      if (sprite.userData.text !== node.label) {
        this._paintLabel(sprite, node);
        sprite.userData.text = node.label;
      }
      const canvas = sprite.userData.canvas;
      // Sprites shrink with distance by default, which makes labels unreadable
      // zoomed out and absurd up close. Scale by distance for a constant
      // on-screen size instead — the factor is derived from the vertical FOV.
      const scale = THREE.MathUtils.clamp(dist * 0.00032, 0.006, 0.9);
      const wpp = worldPerPixel(dist) || 1;
      const halfW = (canvas.width * scale) / wpp / 2;
      const halfH = (canvas.height * scale) / wpp / 2;

      const emphasised = node.id === this.selectedId || node.id === this.hoverId;
      const collides =
        !emphasised &&
        placed.some((q) => Math.abs(q.sx - sx) < q.halfW + halfW && Math.abs(q.sy - sy) < q.halfH + halfH);
      if (collides) continue;

      sprite.position.set(p.x, p.y + LABEL_OFFSET_Y, p.z);
      sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
      sprite.material.opacity = emphasised ? 1 : 0.62;
      sprite.visible = true;
      placed.push({ sx, sy, halfW, halfH });
      used++;
    }
    for (let i = used; i < this.labelPool.length; i++) this.labelPool[i].visible = false;
  }

  _paintLabel(sprite, node) {
    const text = node.label.length > 30 ? `${node.label.slice(0, 29)}…` : node.label;
    const canvas = sprite.userData.canvas || document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontSize = 44;
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif`;
    const width = Math.ceil(ctx.measureText(text).width) + 32;
    canvas.width = width;
    canvas.height = fontSize + 28;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 8, 20, 0.95)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = node.color || TYPE_COLORS[node.type] || '#cfe4ff';
    ctx.fillText(text, 16, canvas.height / 2);

    sprite.userData.texture?.dispose();
    const texture = new THREE.CanvasTexture(canvas);
    if ('colorSpace' in texture) texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    sprite.material.map = texture;
    sprite.material.needsUpdate = true;
    sprite.userData.canvas = canvas;
    sprite.userData.texture = texture;
    // Actual scale is set per frame in _updateLabels, from camera distance.
  }

  // ── camera ─────────────────────────────────────────────────────────────────

  flyTo(ids, { padding = 2.4 } = {}) {
    const points = ids.map((id) => this.positions.get(id)).filter(Boolean);
    if (!points.length) return;

    const center = points.reduce(
      (acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length, z: acc.z + p.z / points.length }),
      { x: 0, y: 0, z: 0 },
    );
    const radius = Math.max(
      40,
      ...points.map((p) => Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z)),
    );

    const target = new THREE.Vector3(center.x, center.y, center.z);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() < 0.001) dir.set(0, 0.3, 1).normalize();
    const distance = Math.max(90, radius * padding + 70);

    this._tween = {
      t: 0,
      duration: 1.15,
      fromCam: this.camera.position.clone(),
      toCam: target.clone().add(dir.multiplyScalar(distance)),
      fromTarget: this.controls.target.clone(),
      toTarget: target,
    };
    this.controls.autoRotate = false;
    clearTimeout(this._autoRotateTimer);
    this._autoRotateTimer = setTimeout(() => {
      this.controls.autoRotate = true;
    }, 9000);
  }

  _updateTween(dt) {
    if (!this._tween) return;
    const tw = this._tween;
    tw.t = Math.min(1, tw.t + dt / tw.duration);
    const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2; // easeInOutCubic
    this.camera.position.lerpVectors(tw.fromCam, tw.toCam, e);
    this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
    if (tw.t >= 1) this._tween = null;
  }

  // ── public controls ────────────────────────────────────────────────────────

  focus(ids = [], _note = '') {
    const known = ids.filter((id) => this.positions.has(id));
    if (!known.length) return;
    for (const id of known) this.highlight.set(id, 1);
    this.flyTo(known);
  }

  select(id) {
    this.selectedId = id;
    if (id) this.focus([id]);
  }

  resetView() {
    this.selectedId = null;
    this.frameAll();
    this.controls.autoRotate = true;
    clearTimeout(this._autoRotateTimer);
  }

  setMood(mood) {
    this.mood = mood;
    if (mood === 'thinking') this.alpha = Math.max(this.alpha, 0.25);
  }

  setAmplitude(v) {
    this.amplitude = Math.max(0, Math.min(1, v));
  }

  onSelect(cb) {
    this.selectHandlers.push(cb);
  }

  onHover(cb) {
    this.hoverHandlers.push(cb);
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.nodeMat.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    clearTimeout(this._autoRotateTimer);
    clearTimeout(this._frameTimer);
    window.removeEventListener('resize', this._onResize);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    for (const s of this.labelPool) s.userData.texture?.dispose();
    this._dotTex?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
