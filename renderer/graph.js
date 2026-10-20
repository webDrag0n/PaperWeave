// PaperWeave 3D 引用关系图（three.js，自力布局 + 轨道控制）
// 0.3.0 重做：主题联动配色 / 节点辉光 / 选中边流动箭头 / 未入库引用幽灵节点 / 相机平滑过渡
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseInlineMd, inlineMd as inlineMdHtml } from './markdown.js';

const THEMES = {
  dark: {
    selected: 0xffd54a,
    // 每一跳一种颜色（1→5 跳）
    hops: [0x4aa3ff, 0xff7a4a, 0xb678ff, 0x7bf1a8, 0xf06292],
    other: 0x5b6270,
    edgeBase: 0x3a4152,
    pathOutline: 0xffffff,
    labelText: '#f2f4fa',
    labelBg: 'rgba(16,18,24,0.78)',
    codeText: '#7bf1a8',
    codeBg: 'rgba(123,241,168,0.14)',
    glowStrength: 0.72,
  },
  light: {
    selected: 0xf5b800,
    hops: [0x1f6fe0, 0xe85d2a, 0x8a4fe0, 0x1f9d55, 0xd63384],
    other: 0x9aa4b5,
    edgeBase: 0xb9c2d2,
    pathOutline: 0x232a36,
    labelText: '#232a36',
    labelBg: 'rgba(255,255,255,0.88)',
    codeText: '#1f7a44',
    codeBg: 'rgba(31,157,85,0.12)',
    glowStrength: 0.5,
  },
};

let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.32)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  _glowTex = new THREE.CanvasTexture(cv);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

let _pathRingTex = null;
function pathRingTexture() {
  if (_pathRingTex) return _pathRingTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.stroke();
  // 外圈柔光
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(64, 64, 48, 0, Math.PI * 2);
  ctx.stroke();
  _pathRingTex = new THREE.CanvasTexture(cv);
  _pathRingTex.colorSpace = THREE.SRGBColorSpace;
  return _pathRingTex;
}

// 标题支持行内 Markdown（**粗体** / *斜体* / `代码` / ~~删除线~~）：逐段切换字体绘制
function makeLabelSprite(text, theme) {
  const maxChars = 42;
  const t = text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
  const segs = parseInlineMd(t);
  const fontOf = (s) => (s.code
    ? `${s.bold ? '700 ' : ''}${s.italic ? 'italic ' : ''}27px "Cascadia Code", Consolas, monospace`
    : `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : '600 '}30px "Segoe UI", "Microsoft YaHei", sans-serif`);
  const pad = 18;
  const cv = document.createElement('canvas');
  let ctx = cv.getContext('2d');
  let tw = 0;
  for (const s of segs) { ctx.font = fontOf(s); tw += ctx.measureText(s.text).width; }
  cv.width = Math.ceil(tw + pad * 2);
  cv.height = 54;
  ctx = cv.getContext('2d');
  ctx.fillStyle = theme.labelBg;
  ctx.beginPath();
  ctx.roundRect(0, 0, cv.width, cv.height, 12);
  ctx.fill();
  ctx.textBaseline = 'middle';
  let x = pad;
  for (const s of segs) {
    ctx.font = fontOf(s);
    const w = ctx.measureText(s.text).width;
    if (s.code) {
      ctx.fillStyle = theme.codeBg;
      ctx.beginPath();
      ctx.roundRect(x - 3, 8, w + 6, 38, 6);
      ctx.fill();
    }
    ctx.fillStyle = s.code ? theme.codeText : theme.labelText;
    ctx.fillText(s.text, x, cv.height / 2 + 2);
    if (s.strike) {
      ctx.strokeStyle = theme.labelText;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, cv.height / 2 + 2);
      ctx.lineTo(x + w, cv.height / 2 + 2);
      ctx.stroke();
    }
    x += w;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const s = 0.042;
  sprite.scale.set(cv.width * s, cv.height * s, 1);
  return sprite;
}

function disposeObj(c) {
  if (c.geometry) c.geometry.dispose();
  if (c.material) {
    if (c.material.map) c.material.map.dispose();
    c.material.dispose();
  }
}

export class GraphView {
  /**
   * opts: { wrap, onSelect(paperId|'ext:key'|null), onOpen(paperId), tooltipEl, theme }
   */
  constructor(opts) {
    this.opts = opts;
    this.theme = THEMES[opts.theme] ? opts.theme : 'dark';
    this.nodes = [];   // {id,paper,mesh,glow,label,pos,vel,degree}
    this.edges = [];   // {link,a,b,line,pulse,phase,pulseBase}
    this.selectedIds = [];  // 多选集合（有序，最后一个为主选中）
    this.hopDepth = 2;      // N 跳高亮档位（1-5）
    this.hoverId = null;
    this._raf = 0;
    this._built = false;
  }

  get T() { return THEMES[this.theme]; }
  get selectedId() { return this.selectedIds.length ? this.selectedIds[this.selectedIds.length - 1] : null; }

  setTheme(t) {
    if (!THEMES[t] || this.theme === t) return;
    this.theme = t;
    // 主题切换后重建标签（颜色不同）并重着色
    for (const nd of this.nodes) {
      if (nd.label) { this.labelGroup.remove(nd.label); disposeObj(nd.label); nd.label = null; }
    }
    this._recolor();
    this.renderOnce();
  }

  _build() {
    if (this._built) return;
    const wrap = this.opts.wrap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, wrap.clientWidth / wrap.clientHeight, 0.1, 4000);
    this.camera.position.set(0, 0, 160);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    wrap.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points = { threshold: 2 };
    this.pointer = new THREE.Vector2();

    this.nodeGroup = new THREE.Group();
    this.edgeGroup = new THREE.Group();
    this.labelGroup = new THREE.Group();
    this.pathGroup = new THREE.Group(); // 多选最短关联的轮廓高亮
    this.scene.add(this.edgeGroup, this.nodeGroup, this.labelGroup, this.pathGroup);

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this._onMove(e));
    el.addEventListener('click', (e) => this._onClick(e));
    el.addEventListener('dblclick', (e) => this._onDblClick(e));
    el.addEventListener('pointerdown', (e) => {
      this._downPos = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);

    this._built = true;
    this._loop();
  }

  _resize() {
    if (!this._built) return;
    const wrap = this.opts.wrap;
    if (!wrap.clientWidth) return;
    this.camera.aspect = wrap.clientWidth / wrap.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(wrap.clientWidth, wrap.clientHeight);
  }

  setData(papers, links, keepSelection = true) {
    this._build();
    const prevSel = keepSelection ? [...this.selectedIds] : [];
    this.selectedIds = [];

    // 清空
    for (const g of [this.nodeGroup, this.edgeGroup, this.labelGroup, this.pathGroup]) {
      while (g.children.length) {
        const c = g.children.pop();
        disposeObj(c);
        g.remove(c);
      }
    }
    this.nodes = [];
    this.edges = [];

    const degree = {};
    for (const l of links) { degree[l.from] = (degree[l.from] || 0) + 1; degree[l.to] = (degree[l.to] || 0) + 1; }

    const n = papers.length;
    const R = Math.max(30, 14 * Math.cbrt(Math.max(8, n)));
    const byId = new Map();
    for (const p of papers) {
      const deg = degree[p.id] || 0;
      // 节点整体缩小一倍，保留「引用关联越多节点越大」的梯度
      const radius = 1.2 + Math.min(3, Math.sqrt(deg) * 0.8);
      const geo = new THREE.SphereGeometry(radius, 24, 16);
      const mat = new THREE.MeshBasicMaterial({ color: this.T.other });
      const mesh = new THREE.Mesh(geo, mat);
      const pos = new THREE.Vector3(
        (Math.random() - 0.5) * 2 * R,
        (Math.random() - 0.5) * 2 * R,
        (Math.random() - 0.5) * 2 * R
      );
      mesh.position.copy(pos);
      mesh.userData.paperId = p.id;
      // 辉光
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: this.T.other, transparent: true, opacity: 0.12,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.scale.set(radius * 4.4, radius * 4.4, 1);
      glow.position.copy(pos);
      this.nodeGroup.add(mesh);
      this.nodeGroup.add(glow);
      const node = { id: p.id, paper: p, mesh, glow, pos: mesh.position, vel: new THREE.Vector3(), degree: deg, label: null };
      this.nodes.push(node);
      byId.set(p.id, node);
    }

    for (const l of links) {
      const a = byId.get(l.from), b = byId.get(l.to);
      if (!a || !b) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([a.pos, b.pos]);
      const mat = new THREE.LineBasicMaterial({ color: this.T.edgeBase, transparent: true, opacity: 0.7 });
      const line = new THREE.Line(geo, mat);
      // 流光：光点沿连线从被引（b = link.to）流向引用方（a = link.from）
      const pulse = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: this.T.edgeBase, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      pulse.scale.set(2.4, 2.4, 1);
      this.edgeGroup.add(line);
      this.edgeGroup.add(pulse);
      this.edges.push({ link: l, a, b, line, pulse, phase: Math.random(), pulseBase: 0.5 });
    }

    this._layout();
    this._fitCamera(true);
    const validSel = prevSel.filter(id => byId.has(id));
    if (validSel.length) { this.selectedIds = validSel; this._recolor(); }
    else this._recolor();
    this.renderOnce();
  }

  renderOnce() {
    if (this._built) this.renderer.render(this.scene, this.camera);
  }

  _layout() {
    const nodes = this.nodes;
    const edges = this.edges;
    if (!nodes.length) return;
    const k = 26;               // 理想间距
    const iterations = Math.min(500, 120 + nodes.length * 8);
    const tmp = new THREE.Vector3();
    for (let it = 0; it < iterations; it++) {
      const cooling = 1 - it / iterations;
      // 斥力
      for (let i = 0; i < nodes.length; i++) {
        const ni = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const nj = nodes[j];
          tmp.subVectors(ni.pos, nj.pos);
          let d = tmp.length();
          if (d < 0.01) { tmp.set(Math.random() - .5, Math.random() - .5, Math.random() - .5); d = 0.5; }
          const f = (k * k) / (d * d) * 0.5 * cooling;
          tmp.normalize().multiplyScalar(f);
          ni.vel.add(tmp);
          nj.vel.sub(tmp);
        }
      }
      // 弹簧
      for (const e of edges) {
        tmp.subVectors(e.b.pos, e.a.pos);
        const d = Math.max(0.1, tmp.length());
        const f = (d - k * 1.4) * 0.03 * cooling;
        tmp.normalize().multiplyScalar(f);
        e.a.vel.add(tmp);
        e.b.vel.sub(tmp);
      }
      // 向心力 + 积分
      for (const nd of nodes) {
        tmp.copy(nd.pos).multiplyScalar(-0.015 * cooling);
        nd.vel.add(tmp);
        nd.vel.multiplyScalar(0.82);
        nd.pos.add(nd.vel);
        nd.vel.set(0, 0, 0);
      }
    }
    // 更新线段位置
    for (const e of edges) {
      e.line.geometry.setFromPoints([e.a.pos, e.b.pos]);
    }
  }

  _fitCamera(instant) {
    if (!this.nodes.length) { this.camera.position.set(0, 0, 160); return; }
    const box = new THREE.Box3();
    for (const nd of this.nodes) box.expandByPoint(nd.pos);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const dist = Math.max(70, size * 1.15);
    const toPos = new THREE.Vector3(center.x, center.y + dist * 0.18, center.z + dist);
    if (instant) {
      this.camera.position.copy(toPos);
      this.controls.target.copy(center);
      this.controls.update();
    } else {
      this._tweenCam(toPos, center);
    }
  }

  // 相机平滑过渡
  _tweenCam(toPos, toTarget, dur = 650) {
    this._camAnim = {
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: toPos.clone(),
      toTarget: toTarget.clone(),
      t0: performance.now(),
      dur,
    };
  }

  relations(id) {
    const refs = [], cites = [];
    for (const e of this.edges) {
      if (e.link.from === id) refs.push(e.link.to);
      if (e.link.to === id) cites.push(e.link.from);
    }
    return { refs, cites };
  }

  /** 选中节点；additive=true（按住 Shift）时加入/移出多选集合 */
  select(id, additive = false) {
    if (!additive) {
      this.selectedIds = id ? [id] : [];
    } else if (id) {
      const i = this.selectedIds.indexOf(id);
      if (i >= 0) this.selectedIds.splice(i, 1);
      else this.selectedIds.push(id);
    }
    this._recolor();
  }

  setHopDepth(n) {
    this.hopDepth = Math.max(1, Math.min(5, n | 0));
    this._recolor();
  }

  // 从所有选中节点做无向 BFS，跳数 = 到最近选中节点的距离
  _computeHops() {
    const hop = new Map();
    const adj = new Map();
    for (const e of this.edges) {
      if (!adj.has(e.a.id)) adj.set(e.a.id, []);
      if (!adj.has(e.b.id)) adj.set(e.b.id, []);
      adj.get(e.a.id).push(e.b.id);
      adj.get(e.b.id).push(e.a.id);
    }
    const queue = [];
    for (const id of this.selectedIds) { hop.set(id, 0); queue.push(id); }
    while (queue.length) {
      const cur = queue.shift();
      const h = hop.get(cur);
      for (const nx of adj.get(cur) || []) {
        if (!hop.has(nx)) { hop.set(nx, h + 1); queue.push(nx); }
      }
    }
    return hop;
  }

  // 多选时：计算所有选中论文两两之间的最短路径（无向 BFS），返回路径节点与边集合
  _computeShortestPaths() {
    const pathNodes = new Set();
    const pathEdges = new Set();
    if (this.selectedIds.length < 2) return { pathNodes, pathEdges };
    const adj = new Map();
    for (const e of this.edges) {
      if (!adj.has(e.a.id)) adj.set(e.a.id, []);
      if (!adj.has(e.b.id)) adj.set(e.b.id, []);
      adj.get(e.a.id).push({ to: e.b.id, edge: e });
      adj.get(e.b.id).push({ to: e.a.id, edge: e });
    }
    for (let i = 0; i < this.selectedIds.length; i++) {
      for (let j = i + 1; j < this.selectedIds.length; j++) {
        const src = this.selectedIds[i], dst = this.selectedIds[j];
        // BFS 找最短路径
        const prev = new Map([[src, null]]);
        const queue = [src];
        while (queue.length) {
          const cur = queue.shift();
          if (cur === dst) break;
          for (const { to, edge } of adj.get(cur) || []) {
            if (!prev.has(to)) { prev.set(to, { from: cur, edge }); queue.push(to); }
          }
        }
        if (!prev.has(dst)) continue;
        let cur = dst;
        while (cur !== src) {
          pathNodes.add(cur);
          const p = prev.get(cur);
          pathEdges.add(p.edge);
          cur = p.from;
        }
        pathNodes.add(src);
      }
    }
    return { pathNodes, pathEdges };
  }

  _recolor() {
    const T = this.T;
    const sel = this.selectedIds;
    const hop = sel.length ? this._computeHops() : new Map();

    for (const nd of this.nodes) {
      const h = hop.get(nd.id);
      let color = T.other;
      if (sel.length && h !== undefined && h <= this.hopDepth) {
        color = h === 0 ? T.selected : T.hops[Math.min(h, T.hops.length) - 1];
      }
      nd.mesh.material.color.setHex(color);
      nd.mesh.material.needsUpdate = true;
      if (nd.glow) {
        const active = sel.length && h !== undefined && h <= this.hopDepth;
        nd.glow.material.color.setHex(color);
        nd.glow.material.opacity = active ? T.glowStrength : 0.12;
      }
      // 所有论文的标签默认常显（无论是否选中）
      if (!nd.label) {
        nd.label = makeLabelSprite(nd.paper.title || '未命名', T);
        this.labelGroup.add(nd.label);
      }
      nd.label.position.copy(nd.pos).add(new THREE.Vector3(0, nd.mesh.geometry.parameters.radius + 4.5, 0));
    }

    // 边：两端都在 N 跳内的高亮，颜色取较深一端的跳色
    for (const e of this.edges) {
      let color = T.edgeBase, opacity = 0.55;
      if (sel.length) {
        const ha = hop.get(e.a.id), hb = hop.get(e.b.id);
        if (ha !== undefined && hb !== undefined && Math.max(ha, hb) <= this.hopDepth) {
          const h = Math.max(ha, hb);
          color = h === 0 ? T.selected : T.hops[Math.min(h, T.hops.length) - 1];
          opacity = 0.95;
        }
      }
      e.line.material.color.setHex(color);
      e.line.material.opacity = opacity;
      if (e.pulse) {
        e.pulse.material.color.setHex(color);
        e.pulseBase = opacity >= 0.9 ? 0.95 : 0.5; // 高亮边的流光更明显
      }
    }

    // 多选：最短关联的轮廓高亮（不覆盖跳数颜色，仅叠加描边环与亮线）
    while (this.pathGroup.children.length) {
      const c = this.pathGroup.children.pop();
      disposeObj(c);
      this.pathGroup.remove(c);
    }
    if (sel.length >= 2) {
      const { pathNodes, pathEdges } = this._computeShortestPaths();
      for (const id of pathNodes) {
        const nd = this.nodes.find(n => n.id === id);
        if (!nd) continue;
        const r = nd.mesh.geometry.parameters.radius;
        const ring = new THREE.Sprite(new THREE.SpriteMaterial({
          map: pathRingTexture(), color: T.pathOutline, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        ring.scale.set(r * 4.6, r * 4.6, 1);
        ring.position.copy(nd.pos);
        this.pathGroup.add(ring);
      }
      for (const e of pathEdges) {
        const geo = new THREE.BufferGeometry().setFromPoints([e.a.pos, e.b.pos]);
        const mat = new THREE.LineBasicMaterial({
          color: T.pathOutline, transparent: true, opacity: 0.9,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        this.pathGroup.add(new THREE.Line(geo, mat));
      }
    }
    this.renderOnce();
  }

  _pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = this.nodeGroup.children.filter(c => c.isMesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0].object.userData.paperId : null;
  }

  _onMove(e) {
    const id = this._pick(e);
    this.hoverId = id;
    const tip = this.opts.tooltipEl;
    this.renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
    if (id) {
      const nd = this.nodes.find(n => n.id === id);
      if (nd && tip) {
        tip.innerHTML = '';
        const t = document.createElement('div');
        t.style.fontWeight = '600';
        t.innerHTML = inlineMdHtml(nd.paper.title || '未命名论文');
        tip.appendChild(t);
        const sub = document.createElement('div');
        sub.style.color = '#9aa0ae';
        sub.style.marginTop = '3px';
        sub.textContent = [(nd.paper.authors || []).slice(0, 3).join(', '), nd.paper.year].filter(Boolean).join(' · ');
        tip.appendChild(sub);
        tip.classList.remove('hidden');
        tip.style.left = (e.clientX + 14) + 'px';
        tip.style.top = (e.clientY + 12) + 'px';
      }
    } else if (tip) tip.classList.add('hidden');
  }

  _onClick(e) {
    if (this._dragMoved(e)) return;
    const id = this._pick(e);
    this.select(id, !!e.shiftKey);
    this.opts.onSelect && this.opts.onSelect(this.selectedId, [...this.selectedIds]);
  }

  _onDblClick(e) {
    const id = this._pick(e);
    if (id) this.opts.onOpen && this.opts.onOpen(id);
  }

  _dragMoved(e) {
    // OrbitControls 拖动后 click 也会触发，用位移阈值过滤
    const now = performance.now();
    if (this._downPos) {
      const dx = e.clientX - this._downPos.x, dy = e.clientY - this._downPos.y;
      if (Math.hypot(dx, dy) > 5) return true;
      if (now - (this._downPos.t || 0) > 350) return true;
    }
    return false;
  }

  focusNode(id) {
    const nd = this.nodes.find(n => n.id === id);
    if (!nd) return;
    const dist = 60;
    const toPos = new THREE.Vector3(nd.pos.x, nd.pos.y + dist * 0.25, nd.pos.z + dist);
    this._tweenCam(toPos, nd.pos.clone());
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    // 相机过渡动画
    if (this._camAnim) {
      const a = this._camAnim;
      const t = Math.min(1, (now - a.t0) / a.dur);
      const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
      this.camera.position.lerpVectors(a.fromPos, a.toPos, ease);
      this.controls.target.lerpVectors(a.fromTarget, a.toTarget, ease);
      if (t >= 1) this._camAnim = null;
    }
    // 辉光跟随节点
    for (const nd of this.nodes) {
      if (nd.glow) nd.glow.position.copy(nd.pos);
    }
    // 流光：光点沿连线从被引流向引用方，两端淡入淡出
    for (const e of this.edges) {
      if (!e.pulse) continue;
      const len = Math.max(8, e.a.pos.distanceTo(e.b.pos));
      const t = ((now * 0.001 * 22) / len + e.phase) % 1;
      e.pulse.position.lerpVectors(e.b.pos, e.a.pos, t);
      e.pulse.material.opacity = (e.pulseBase ?? 0.5) * Math.sin(Math.PI * t);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  attachPointerDown() {
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this._downPos = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._resizeHandler);
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    this._built = false;
  }
}

/* 供 HTML 浮层（图例圆点等）同步主题配色的调色板 */
export function graphThemePalette(theme) {
  const T = THEMES[theme] ? THEMES[theme] : THEMES.dark;
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  return { selected: hex(T.selected), hops: T.hops.map(hex), other: hex(T.other) };
}
