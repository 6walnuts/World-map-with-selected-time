// 2.5D 大唐场景（800 年）：three.js 立体地形 + 按方镇着色的州 + 立体城池 + 飘云与水面。
// 坐标：与地形底图相同的 z6 级 Web 墨卡托像素，x 向东、z 向南、y 向上；整块地形宽 1000 个单位。
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import * as d3 from "d3";

const WORLD_W = 1000;
const EXAG = 5; // 高程夸张倍数
const MAJOR_RIVERS = new Set(["长江", "黄河", "金沙江", "通天河"]);
const CAPITALS = { 京兆府: "长安", 河南府: "洛阳" };
const SKIRT = 6; // 地形块侧面向下延伸的深度（桌面沙盘效果）

export function createTang3D({ DATA, zhName, textEm, onExit }) {
  const screen = document.getElementById("tang-screen");
  const view = document.getElementById("tang-view");
  const labelLayer = document.getElementById("tang-labels");
  const tip = document.getElementById("tang-tip");
  const panel = document.getElementById("tang-panel");
  const loading = document.getElementById("tang-loading");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let renderer, scene, camera, controls, clock;
  let terrain = null; // 网格、高程等，只构建一次
  let built = null; // china.js 里算好的州 → 方镇数据
  let tang = null;
  let geo = null;
  let open = false;
  let frame = 0;
  let selectedCircuit = null;
  let selectedPref = null;
  let highlightType = null;
  let hoverIndex = null;
  let showClouds = true;
  let tween = null;

  // ---------- 初始化 three.js ----------
  function initRenderer() {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    view.prepend(renderer.domElement);
    scene = new THREE.Scene();
    scene.background = new THREE.Color("#1c1610");
    scene.fog = new THREE.Fog("#1c1610", 900, 2400);
    camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
    controls = new MapControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = false;
    controls.minDistance = 18;
    controls.maxDistance = 1500;
    controls.maxPolarAngle = 1.22;
    controls.addEventListener("start", () => (tween = null));
    clock = new THREE.Timer();

    scene.add(new THREE.HemisphereLight("#fff4dc", "#5a4630", 1.35));
    const sun = new THREE.DirectionalLight("#fff1d6", 1.9);
    sun.position.set(-500, 700, -400); // 西北方高空，与底图晕渲一致
    scene.add(sun);

    new ResizeObserver(resize).observe(view);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", () => setHover(null));
    renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  let downAt = null;

  function resize() {
    const w = view.clientWidth;
    const h = view.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    labelsDirty = true;
  }

  // ---------- 坐标换算 ----------
  let M; // { N, gx0, gy0, W, H, U, vert }
  const gxOf = (lon) => ((lon + 180) / 360) * M.N;
  const gyOf = (lat) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * M.N;
  };
  const toWorld = (lon, lat) => [(gxOf(lon) - M.gx0) * M.U, (gyOf(lat) - M.gy0) * M.U];
  const fromWorld = (x, z) => {
    const gx = x / M.U + M.gx0;
    const gy = z / M.U + M.gy0;
    const lon = (gx / M.N) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / M.N))) * 180) / Math.PI;
    return [lon, lat];
  };
  // 高程网格上的双线性插值（世界坐标 → 世界高度）
  function heightAt(x, z) {
    const { W, H, hy } = terrain;
    const px = Math.max(0, Math.min(W - 1.001, x / M.U - 0.5));
    const py = Math.max(0, Math.min(H - 1.001, z / M.U - 0.5));
    const xi = Math.floor(px), yi = Math.floor(py);
    const fx = px - xi, fy = py - yi;
    const i = yi * W + xi;
    return (hy[i] * (1 - fx) + hy[i + 1] * fx) * (1 - fy) + (hy[i + W] * (1 - fx) + hy[i + W + 1] * fx) * fy;
  }
  const inside = (x, z) => x >= 0 && z >= 0 && x <= WORLD_W && z <= terrain.depth;

  // ---------- 地形 ----------
  async function loadHeight() {
    const meta = await d3.json(`${DATA}height_tang.json`);
    const blob = await (await fetch(`${DATA}height_tang.png`)).blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const elev = new Float32Array(bmp.width * bmp.height);
    for (let i = 0; i < elev.length; i++) elev[i] = px[i * 4] * 256 + px[i * 4 + 1] - 1000;
    return { meta, elev };
  }

  function buildTerrain({ meta, elev }) {
    const W = meta.width, H = meta.height;
    const N = 256 * 2 ** meta.z;
    const U = WORLD_W / W;
    const midLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (meta.gy0 + H / 2)) / N))) * 180) / Math.PI;
    const metersPerUnit = (156543.03 * Math.cos((midLat * Math.PI) / 180)) / 2 ** meta.z / U;
    M = { N, gx0: meta.gx0, gy0: meta.gy0, W, H, U, vert: EXAG / metersPerUnit };
    // 陆地最低也抬到水面之上一点，海底按深度略微下沉
    const hy = new Float32Array(W * H);
    for (let i = 0; i < hy.length; i++) {
      const e = elev[i];
      hy[i] = e > 0 ? 0.06 + e * M.vert : -0.35 - Math.min(1, -e / 3000) * 1.6;
    }
    const depth = H * U;
    terrain = { W, H, hy, elev, depth };

    const SX = Math.round(W / 2), SZ = Math.round(H / 2);
    const g = new THREE.PlaneGeometry(WORLD_W, depth, SX, SZ);
    g.rotateX(-Math.PI / 2);
    g.translate(WORLD_W / 2, 0, depth / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
    g.computeVertexNormals();

    terrain.texture = new THREE.CanvasTexture(document.createElement("canvas"));
    terrain.material = new THREE.MeshStandardMaterial({ map: terrain.texture, roughness: 0.93, metalness: 0 });
    terrain.mesh = new THREE.Mesh(g, terrain.material);
    scene.add(terrain.mesh);

    // 沙盘侧面：沿四条边把地形向下封住
    const skirt = [];
    const edge = (pts) => {
      const verts = [];
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const ay = Math.max(heightAt(ax, az), -0.3), by = Math.max(heightAt(bx, bz), -0.3);
        verts.push(ax, ay, az, bx, by, bz, ax, -SKIRT, az, bx, by, bz, bx, -SKIRT, bz, ax, -SKIRT, az);
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      sg.computeVertexNormals();
      skirt.push(sg);
    };
    const n = 400;
    edge(d3.range(n + 1).map((k) => [(k / n) * WORLD_W, 0]));
    edge(d3.range(n + 1).map((k) => [WORLD_W, (k / n) * depth]));
    edge(d3.range(n + 1).map((k) => [WORLD_W - (k / n) * WORLD_W, depth]));
    edge(d3.range(n + 1).map((k) => [0, depth - (k / n) * depth]));
    const skirtMesh = new THREE.Mesh(mergeGeometries(skirt), new THREE.MeshStandardMaterial({ color: "#4a3622", roughness: 1, side: THREE.DoubleSide }));
    scene.add(skirtMesh);
    // 桌面
    const table = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ color: "#2a1f15", roughness: 1 }));
    table.rotation.x = -Math.PI / 2;
    table.position.set(WORLD_W / 2, -SKIRT, depth / 2);
    scene.add(table);

    buildWater(depth);
    terrain.baseCanvas = paintBase();
  }

  // 底色：分层设色 + 轻度晕渲（立体光照另外再加一层），海面按深浅着色
  function paintBase() {
    const { W, H, elev } = terrain;
    const STOPS = [[0, [214, 204, 160]], [200, [204, 194, 146]], [800, [190, 168, 118]], [1800, [168, 140, 98]], [3500, [146, 118, 88]], [5200, [136, 116, 96]], [6200, [238, 234, 226]]];
    const tint = (e) => {
      for (let i = 1; i < STOPS.length; i++) {
        if (e <= STOPS[i][0]) {
          const [e0, c0] = STOPS[i - 1], [e1, c1] = STOPS[i];
          const t = Math.max(0, (e - e0) / (e1 - e0));
          return c0.map((v, k) => v + (c1[k] - v) * t);
        }
      }
      return STOPS.at(-1)[1];
    };
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");
    const img = g.createImageData(W, H);
    const res = (156543.03 * Math.cos(0.58)) / 2 ** 6; // 约略的米/像素（北纬 33°），只用于晕渲强度
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const e = elev[i];
        const o = i * 4;
        if (e <= 0) {
          const d = Math.min(1, -e / 2500);
          img.data[o] = 74 - 34 * d; img.data[o + 1] = 118 - 40 * d; img.data[o + 2] = 128 - 30 * d; img.data[o + 3] = 255;
          continue;
        }
        const ex = (elev[i + (x < W - 1 ? 1 : 0)] - elev[i - (x > 0 ? 1 : 0)]) / (2 * res) * 3;
        const ez = (elev[i + (y < H - 1 ? W : 0)] - elev[i - (y > 0 ? W : 0)]) / (2 * res) * 3;
        const shade = Math.max(0, Math.min(1.3, 0.82 + (ex + ez) * 0.25));
        const col = tint(e);
        img.data[o] = Math.min(255, col[0] * shade);
        img.data[o + 1] = Math.min(255, col[1] * shade);
        img.data[o + 2] = Math.min(255, col[2] * shade);
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // ---------- 水面 ----------
  let water = null;
  function buildWater(depth) {
    // 法线贴图：几层正弦波叠加，平铺后滚动
    const S = 256;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    const img = g.createImageData(S, S);
    const hgt = (x, y) =>
      Math.sin((x / S) * Math.PI * 2 * 3 + Math.sin((y / S) * Math.PI * 2 * 2) * 1.5) * 0.5 +
      Math.sin((y / S) * Math.PI * 2 * 5 + (x / S) * Math.PI * 2 * 2) * 0.35 +
      Math.sin(((x + y) / S) * Math.PI * 2 * 7) * 0.15;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = hgt(x + 1, y) - hgt(x - 1, y);
        const dy = hgt(x, y + 1) - hgt(x, y - 1);
        const v = new THREE.Vector3(-dx * 3, -dy * 3, 1).normalize();
        const o = (y * S + x) * 4;
        img.data[o] = (v.x * 0.5 + 0.5) * 255;
        img.data[o + 1] = (v.y * 0.5 + 0.5) * 255;
        img.data[o + 2] = (v.z * 0.5 + 0.5) * 255;
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const normal = new THREE.CanvasTexture(c);
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    normal.repeat.set(60, 60);
    const mat = new THREE.MeshStandardMaterial({
      color: "#3f7280", roughness: 0.32, metalness: 0.15, transparent: true, opacity: 0.82,
      normalMap: normal, normalScale: new THREE.Vector2(0.35, 0.35),
    });
    water = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W, depth), mat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(WORLD_W / 2, 0, depth / 2);
    scene.add(water);
  }

  // ---------- 贴图：州、方镇、他国、河流 ----------
  let texScale = 1;
  let idCanvas = null; // 拾取用：每个州/国画成唯一颜色
  let idData = null;
  const pickables = []; // id → { kind: "pref"|"country", f }

  function texProjection(f) {
    const S = M.N / (2 * Math.PI);
    return d3.geoMercator()
      .scale(S * f)
      .translate([(M.N / 2 - M.gx0) * f, (M.N / 2 - M.gy0) * f])
      .clipExtent([[-10, -10], [M.W * f + 10, M.H * f + 10]]);
  }

  function prepareTexture() {
    const maxTex = Math.min(renderer.capabilities.maxTextureSize, 4096);
    texScale = Math.min(maxTex / M.W, maxTex / M.H);
    const c = terrain.texture.image;
    c.width = Math.round(M.W * texScale);
    c.height = Math.round(M.H * texScale);
    terrain.texture.colorSpace = THREE.SRGBColorSpace;
    terrain.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    // 拾取图
    idCanvas = document.createElement("canvas");
    idCanvas.width = M.W;
    idCanvas.height = M.H;
    const g = idCanvas.getContext("2d", { willReadFrequently: true });
    const path = d3.geoPath(texProjection(1), g);
    pickables.length = 0;
    const paint = (f, item) => {
      pickables.push(item);
      const id = pickables.length;
      g.fillStyle = `rgb(${id >> 16},${(id >> 8) & 255},${id & 255})`;
      g.beginPath();
      path(f);
      g.fill();
    };
    for (const f of foreignCountries()) paint(f, { kind: "country", f });
    for (const f of built.family) paint(f, { kind: "pref", f });
    idData = g.getImageData(0, 0, M.W, M.H).data;
  }

  const foreignCountries = () => built.current.countries.filter((f) => !built.isFamily(f.properties.name));

  function paintTexture() {
    const c = terrain.texture.image;
    const g = c.getContext("2d");
    const f = texScale;
    const path = d3.geoPath(texProjection(f), g);
    g.imageSmoothingQuality = "high";
    g.drawImage(terrain.baseCanvas, 0, 0, c.width, c.height);

    // 他国：淡淡一层国色
    g.lineJoin = "round";
    for (const cf of foreignCountries()) {
      if (cf.properties.unorganized) continue;
      g.beginPath();
      path(cf);
      g.globalAlpha = 0.22;
      g.fillStyle = cf.properties.color;
      g.fill();
      g.globalAlpha = 0.7;
      g.strokeStyle = "#3a2410";
      g.lineWidth = 1.4 * f;
      g.stroke();
    }

    // 唐朝体系：各州按方镇着色
    const dimType = (c) => highlightType && c?.type !== highlightType;
    for (const pf of built.family) {
      const cc = built.circuitOf.get(pf.properties.index);
      g.beginPath();
      path(pf);
      g.globalAlpha = dimType(cc) ? 0.1 : selectedCircuit && cc?.id !== selectedCircuit ? 0.3 : 0.48;
      g.fillStyle = cc?.color ?? "#bba";
      g.fill();
      g.globalAlpha = 0.32;
      g.strokeStyle = "#3a2410";
      g.lineWidth = 0.5 * f;
      g.stroke();
    }
    g.globalAlpha = 0.85;
    g.strokeStyle = "#2e1a0a";
    g.lineWidth = 1.5 * f;
    g.beginPath();
    path(built.borderMesh);
    g.stroke();

    // 河湖与运河
    g.globalAlpha = 0.9;
    g.strokeStyle = "#3d7590";
    g.lineCap = "round";
    for (const r of geo.rivers.features) {
      g.lineWidth = (MAJOR_RIVERS.has(r.properties.name) ? 1.7 : 1) * f;
      g.beginPath();
      path(r);
      g.stroke();
    }
    g.fillStyle = "#5f93a3";
    for (const l of geo.lakes.features) {
      g.beginPath();
      path(l);
      g.fill();
    }
    g.strokeStyle = "#255f7d";
    g.lineWidth = 1.3 * f;
    g.setLineDash([4 * f, 2.5 * f]);
    for (const cn of geo.canals) {
      g.beginPath();
      path({ type: "LineString", coordinates: cn.coords });
      g.stroke();
    }
    g.setLineDash([]);

    // 选中的方镇：提亮 + 金边
    const sel = selectedCircuit && built.byId.get(selectedCircuit);
    if (sel?.geometry) {
      g.beginPath();
      path(sel.geometry);
      g.globalAlpha = 0.16;
      g.fillStyle = "#fff2c4";
      g.fill();
      g.globalAlpha = 1;
      g.shadowColor = "rgba(255, 220, 120, 0.9)";
      g.shadowBlur = 6 * f;
      g.strokeStyle = "#e3c26d";
      g.lineWidth = 2.6 * f;
      g.stroke();
      g.shadowBlur = 0;
    }
    g.globalAlpha = 1;
    terrain.texture.needsUpdate = true;
  }

  function pickAt(x, z) {
    if (!inside(x, z)) return null;
    const px = Math.floor(x / M.U), py = Math.floor(z / M.U);
    const o = (py * M.W + px) * 4;
    const id = (idData[o] << 16) | (idData[o + 1] << 8) | idData[o + 2];
    return pickables[id - 1] ?? null;
  }

  // 沿视线在高程场上步进求交，比对 50 万个三角形做射线检测快得多
  const raycaster = new THREE.Raycaster();
  function groundHit(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
    const { origin, direction } = raycaster.ray;
    const step = Math.max(0.3, camera.position.distanceTo(controls.target) / 600);
    let prev = 0;
    for (let t = 0; t < 5000; t += step) {
      const x = origin.x + direction.x * t, y = origin.y + direction.y * t, z = origin.z + direction.z * t;
      const h = inside(x, z) ? Math.max(0, heightAt(x, z)) : 0;
      if (y <= h) {
        // 二分细化
        let lo = prev, hi = t;
        for (let k = 0; k < 8; k++) {
          const m = (lo + hi) / 2;
          const mx = origin.x + direction.x * m, mz = origin.z + direction.z * m;
          const my = origin.y + direction.y * m;
          if (my <= (inside(mx, mz) ? Math.max(0, heightAt(mx, mz)) : 0)) hi = m; else lo = m;
        }
        return [origin.x + direction.x * hi, origin.z + direction.z * hi];
      }
      prev = t;
      if (y < -SKIRT) break;
    }
    return null;
  }

  // ---------- 贴地描边（悬停的州、选中的方镇） ----------
  const hoverLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#fff6da", transparent: true, opacity: 0.95, depthTest: false }));
  hoverLine.renderOrder = 5;
  const selLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#ffd97a", transparent: true, depthTest: false }));
  selLine.renderOrder = 4;

  function drapeOutline(geometry) {
    const verts = [];
    const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.type === "MultiPolygon" ? geometry.coordinates.flat() : [];
    for (const ring of rings) {
      let prev = null;
      for (const [lon, lat] of ring) {
        const p = toWorld(lon, lat);
        if (prev) {
          const n = Math.max(1, Math.ceil(Math.hypot(p[0] - prev[0], p[1] - prev[1]) / 0.6));
          let a = prev;
          for (let k = 1; k <= n; k++) {
            const b = [prev[0] + ((p[0] - prev[0]) * k) / n, prev[1] + ((p[1] - prev[1]) * k) / n];
            verts.push(a[0], Math.max(0, heightAt(a[0], a[1])) + 0.12, a[1], b[0], Math.max(0, heightAt(b[0], b[1])) + 0.12, b[1]);
            a = b;
          }
        }
        prev = p;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    return g;
  }

  function setHover(item) {
    const key = item ? (item.kind === "pref" ? item.f.properties.index : `c${item.f.properties.id}`) : null;
    if (key === hoverIndex) return;
    hoverIndex = key;
    hoverLine.geometry.dispose();
    hoverLine.geometry = item && item.kind === "pref" ? drapeOutline(item.f.geometry) : new THREE.BufferGeometry();
    if (!item) tip.hidden = true;
  }

  function onPointerMove(e) {
    if (e.buttons) return;
    const hit = groundHit(e.clientX, e.clientY);
    const item = hit && pickAt(hit[0], hit[1]);
    setHover(item);
    if (!item) return;
    if (item.kind === "pref") {
      const p = item.f.properties;
      const c = built.circuitOf.get(p.index);
      tip.innerHTML = `<span class="prov">${p.label}</span>` +
        (c ? `<strong>${c.name}</strong><span class="sub">${tang.types[c.type].label} · ${c.title}：${c.holder ?? "待考"}</span>` : "");
    } else {
      const p = item.f.properties;
      tip.innerHTML = `<strong>${zhName(p.name)}</strong>${tang.rulers[p.name] ? `<span class="sub">${tang.rulers[p.name]}</span>` : ""}`;
    }
    const r = view.getBoundingClientRect();
    tip.style.left = `${e.clientX - r.left + 14}px`;
    tip.style.top = `${e.clientY - r.top + 14}px`;
    tip.hidden = false;
  }

  function onClick(e) {
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return; // 拖动不算点击
    const hit = groundHit(e.clientX, e.clientY);
    const item = hit && pickAt(hit[0], hit[1]);
    if (!item) return clearSelection();
    if (item.kind === "pref") {
      const c = built.circuitOf.get(item.f.properties.index);
      selectedPref = item.f.properties.label;
      if (c) selectCircuit(c.id, { fly: false });
    } else {
      showForeign(item.f.properties.name);
    }
  }

  // ---------- 城池 ----------
  function cityGeometry(tier) {
    const parts = [];
    const color = (g, hex) => {
      const c = new THREE.Color(hex);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
      g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
      g.deleteAttribute("uv");
      return g;
    };
    const box = (w, h, d, x, y, z, hex) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y + h / 2, z);
      parts.push(color(g, hex));
    };
    const roof = (w, d, h, x, y, z, hex) => {
      const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
      g.rotateY(Math.PI / 4);
      g.scale(w, h, d);
      g.translate(x, y + h / 2, z);
      parts.push(color(g, hex));
    };
    const WALL = "#b3a184", TOWER = "#8f3b2c", TILE = "#3c474b", HOUSE = "#cdb88f", HOUSE_ROOF = "#5b4a3a", PALACE = "#a8342a", GOLD = "#c9a24a";
    const s = 1; // 半边长，按等级缩放实例
    const t = tier === "town" ? 0.11 : 0.07;
    const h = tier === "capital" ? 0.13 : tier === "seat" ? 0.18 : 0.24;
    // 四面城墙
    box(2 * s, h, t, 0, 0, -s, WALL);
    box(2 * s, h, t, 0, 0, s, WALL);
    box(t, h, 2 * s, -s, 0, 0, WALL);
    box(t, h, 2 * s, s, 0, 0, WALL);
    // 角楼
    for (const [x, z] of [[-s, -s], [s, -s], [-s, s], [s, s]]) {
      box(t * 2.2, h * 1.35, t * 2.2, x, 0, z, WALL);
      if (tier !== "town") roof(t * 2.6, t * 2.6, h * 0.5, x, h * 1.35, z, TILE);
    }
    // 城门楼：都城四面开门，治所南北两门，县城一门
    const gates = tier === "capital" ? [[0, s], [0, -s], [-s, 0], [s, 0]] : tier === "seat" ? [[0, s], [0, -s]] : [[0, s]];
    for (const [x, z] of gates) {
      const along = z === 0;
      const gw = tier === "town" ? 0.34 : 0.26, gd = t * 2.6;
      box(along ? gd : gw, h * 1.25, along ? gw : gd, x, 0, z, WALL);
      box(along ? gd * 0.8 : gw * 0.8, h * 0.6, along ? gw * 0.8 : gd * 0.8, x, h * 1.25, z, TOWER);
      roof(along ? gd * 1.25 : gw * 1.1, along ? gw * 1.1 : gd * 1.25, h * 0.55, x, h * 1.85, z, TILE);
    }
    if (tier === "capital") {
      // 里坊：整齐的方格街区
      const n = 8;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const x = -s + ((i + 0.5) / n) * 2 * s, z = -s + ((j + 0.5) / n) * 2 * s;
          if (Math.abs(x) < 0.3 && z < -0.3) continue; // 留出宫城与皇城
          box(0.2, 0.035, 0.2, x, 0, z, HOUSE);
          box(0.15, 0.03, 0.15, x, 0.035, z, HOUSE_ROOF);
        }
      }
      // 宫城与大殿
      box(0.56, 0.1, 0.5, 0, 0, -0.62, "#c2ae8a");
      box(0.28, 0.12, 0.16, 0, 0.1, -0.66, PALACE);
      roof(0.36, 0.22, 0.1, 0, 0.22, -0.66, GOLD);
      box(0.12, 0.08, 0.08, -0.17, 0.1, -0.5, PALACE);
      roof(0.16, 0.12, 0.06, -0.17, 0.18, -0.5, TILE);
      box(0.12, 0.08, 0.08, 0.17, 0.1, -0.5, PALACE);
      roof(0.16, 0.12, 0.06, 0.17, 0.18, -0.5, TILE);
    } else {
      // 鼓楼与民居
      box(0.24, 0.16, 0.24, 0, 0, 0, TOWER);
      roof(0.32, 0.32, 0.14, 0, 0.16, 0, TILE);
      const rnd = d3.randomLcg(tier === "seat" ? 3 : 7);
      const count = tier === "seat" ? 14 : 6;
      for (let k = 0; k < count; k++) {
        const x = (rnd() * 1.6 - 0.8) * s, z = (rnd() * 1.6 - 0.8) * s;
        if (Math.abs(x) < 0.22 && Math.abs(z) < 0.22) continue;
        const w = 0.14 + rnd() * 0.12;
        box(w, 0.06, w * 0.7, x, 0, z, HOUSE);
        roof(w * 1.15, w * 0.85, 0.06, x, 0.06, z, HOUSE_ROOF);
      }
    }
    return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  }

  let cities = [];
  let cityMeshes = {};
  function buildCities() {
    const seats = new Set(built.circuits.map((c) => c.seat));
    cities = [];
    for (const f of built.family) {
      const p = f.properties;
      if (p.seatLon == null) continue;
      const tier = CAPITALS[p.label] ? "capital" : seats.has(p.label) ? "seat" : "town";
      const name = CAPITALS[p.label] ?? p.label;
      cities.push({ tier, name, lon: p.seatLon, lat: p.seatLat, size: p.label === "京兆府" ? 4.6 : p.label === "河南府" ? 3.4 : tier === "seat" ? 1.8 : 1.0 });
    }
    // 他国都城
    for (const c of built.current.cities) {
      if (!c.capital || built.isFamily(c.country)) continue;
      const [x, z] = toWorld(c.lon, c.lat);
      if (!inside(x, z)) continue;
      cities.push({ tier: "seat", name: c.name, lon: c.lon, lat: c.lat, size: 1.8, foreign: true });
    }
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    for (const tier of ["capital", "seat", "town"]) {
      const list = cities.filter((c) => c.tier === tier);
      const mesh = new THREE.InstancedMesh(cityGeometry(tier), material, list.length);
      const m = new THREE.Matrix4();
      list.forEach((c, i) => {
        const [x, z] = toWorld(c.lon, c.lat);
        // 取城址范围内的最高点，免得城墙陷进山坡
        let y = 0;
        for (const [dx, dz] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) y = Math.max(y, heightAt(x + dx * c.size, z + dz * c.size));
        c.pos = new THREE.Vector3(x, y, z);
        m.compose(c.pos, new THREE.Quaternion(), new THREE.Vector3(c.size, c.size * 1.6, c.size));
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      cityMeshes[tier] = mesh;
      scene.add(mesh);
    }
  }

  // ---------- 云 ----------
  let clouds = [];
  function makeCloudTexture(seed, dark) {
    const rand = d3.randomLcg(seed);
    const w = 512, h = 256;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    for (let i = 0; i < 34; i++) {
      const x = w * (0.16 + rand() * 0.68);
      const y = h * (0.28 + rand() * 0.44);
      const r = 26 + rand() * 70;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, dark ? "rgba(20,14,6,0.5)" : "rgba(255,252,244,0.55)");
      grad.addColorStop(1, dark ? "rgba(20,14,6,0)" : "rgba(255,252,244,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function buildClouds() {
    const rand = d3.randomLcg(11);
    const tex = [1, 2, 3, 4].map((s) => [makeCloudTexture(s, false), makeCloudTexture(s, true)]);
    for (let i = 0; i < 18; i++) {
      const [light, dark] = tex[i % tex.length];
      const w = 70 + rand() * 120;
      const geom = new THREE.PlaneGeometry(w, w / 2);
      geom.rotateX(-Math.PI / 2);
      const cloud = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ map: light, transparent: true, depthWrite: false, opacity: 0.8, fog: true }));
      const shadow = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ map: dark, transparent: true, depthWrite: false, opacity: 0.35 }));
      const x = rand() * (WORLD_W + 300) - 150, z = 60 + rand() * (terrain.depth - 120);
      cloud.position.set(x, 30 + rand() * 18, z);
      cloud.renderOrder = 10;
      shadow.position.set(x + 10, 12.5, z + 8);
      shadow.renderOrder = 3;
      scene.add(cloud, shadow);
      clouds.push({ cloud, shadow, speed: 3 + rand() * 4, w });
    }
  }

  function updateClouds(dt, dist) {
    // 镜头拉近时云渐隐，免得挡住视线
    const fade = THREE.MathUtils.smoothstep(dist, 140, 420);
    for (const c of clouds) {
      if (!reduceMotion) {
        c.cloud.position.x += c.speed * dt;
        c.shadow.position.x += c.speed * dt;
        if (c.cloud.position.x > WORLD_W + 180) {
          c.cloud.position.x -= WORLD_W + 360;
          c.shadow.position.x -= WORLD_W + 360;
        }
      }
      // 飘到沙盘边缘时渐隐，不让云飘到桌面上
      const x = c.cloud.position.x;
      const edge = THREE.MathUtils.smoothstep(x, -c.w * 0.3, c.w * 0.4) * (1 - THREE.MathUtils.smoothstep(x, WORLD_W - c.w * 0.4, WORLD_W + c.w * 0.3));
      const vis = showClouds ? fade * edge : 0;
      c.cloud.material.opacity = 0.62 * vis;
      c.shadow.material.opacity = 0.28 * vis;
      c.cloud.visible = c.shadow.visible = vis > 0.01;
    }
  }

  // ---------- 标签（HTML，投影到屏幕） ----------
  let labels = [];
  let labelsDirty = true;

  function buildLabels() {
    labelLayer.innerHTML = "";
    labels = [];
    const add = (text, lon, lat, cls, prio, opts = {}) => {
      const [x, z] = toWorld(lon, lat);
      if (!inside(x, z)) return;
      const el = document.createElement("div");
      el.className = `tl ${cls}`;
      el.textContent = text;
      labelLayer.append(el);
      labels.push({ el, text, prio, pos: new THREE.Vector3(x, Math.max(0, heightAt(x, z)) + (opts.lift ?? 0.6), z), fs: opts.fs ?? 13, minD: opts.minD ?? 0, maxD: opts.maxD ?? Infinity, cls, ...opts });
    };
    const largest = (g) => {
      if (g.type !== "MultiPolygon") return g;
      let best = null, bestA = -1;
      for (const coords of g.coordinates) {
        const poly = { type: "Polygon", coordinates: coords };
        const raw = d3.geoArea(poly);
        const a = raw > 2 * Math.PI ? 4 * Math.PI - raw : raw;
        if (a > bestA) { bestA = a; best = poly; }
      }
      return best;
    };
    // 方镇名
    for (const c of built.circuits) {
      if (!c.geometry) continue;
      const poly = largest(c.geometry);
      const [lon, lat] = d3.geoCentroid(poly);
      const area = d3.geoArea(poly);
      add(c.name.replace(/（.*）/, ""), lon, lat, "circuit", 50 + Math.sqrt(area) * 2000, { fs: 15 + Math.min(9, Math.sqrt(area) * 260), circuit: c.id, scaleWithZoom: true });
    }
    // 他国名
    for (const f of foreignCountries()) {
      if (f.properties.unorganized || f.properties.areaKm2 < 40000) continue;
      const poly = largest(f.geometry);
      const [lon, lat] = d3.geoCentroid(poly);
      add(zhName(f.properties.name), lon, lat, "country", 80 + Math.sqrt(f.properties.areaKm2) / 10, { fs: 22, scaleWithZoom: true, lift: 2 });
    }
    // 城
    for (const c of cities) {
      const prio = c.tier === "capital" ? 200 : c.tier === "seat" ? 40 : 5;
      add(c.name, c.lon, c.lat, `city ${c.tier}${c.foreign ? " foreign" : ""}`, prio, {
        fs: c.tier === "capital" ? 15 : c.tier === "seat" ? 12 : 11,
        maxD: c.tier === "capital" ? Infinity : c.tier === "seat" ? 520 : 200,
        lift: c.size * 0.7 + 0.4, city: true,
      });
    }
    // 山川
    for (const r of geo.regions) {
      add(r.name, r.lon, r.lat, `geo ${r.kind}`, 20 - r.rank, { fs: r.kind === "mountain" ? 14 : 13, maxD: r.rank <= 3 ? Infinity : 700, lift: 1.5 });
    }
    const seen = new Set();
    for (const f of [...geo.rivers.features].sort((a, b) => (a.properties.rank ?? 9) - (b.properties.rank ?? 9))) {
      const name = f.properties.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const line = f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates.flat();
      const mid = line[Math.floor(line.length / 2)];
      add(name, mid[0], mid[1], "geo river", 10 - (f.properties.rank ?? 9), { fs: 12, maxD: 650, lift: 0.4 });
    }
    for (const cn of geo.canals) {
      const mid = cn.coords[Math.floor(cn.coords.length / 2)];
      add(cn.name, mid[0], mid[1], "geo river", 6, { fs: 12, maxD: 650, lift: 0.4 });
    }
    labels.sort((a, b) => b.prio - a.prio);
    labelsDirty = true;
  }

  const v = new THREE.Vector3();
  function layoutLabels(dist) {
    const w = view.clientWidth, h = view.clientHeight;
    const placed = [];
    const zoomScale = THREE.MathUtils.clamp(700 / dist, 0.75, 2.2);
    for (const l of labels) {
      let show = dist >= l.minD && dist <= l.maxD;
      if (show) {
        v.copy(l.pos).project(camera);
        show = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
      }
      if (show) {
        const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
        const fs = l.scaleWithZoom ? Math.min(l.fs * zoomScale, l.circuit ? 30 : 34) : l.fs;
        const tw = textEm(l.text) * fs * (l.cls.startsWith("circuit") || l.cls.startsWith("country") ? 1.25 : 1.05);
        const box = l.city ? [x - 4, y - fs - 6, x + tw + 10, y + 2] : [x - tw / 2, y - fs * 0.7, x + tw / 2, y + fs * 0.7];
        if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) show = false;
        else {
          placed.push(box);
          l.el.style.transform = l.city ? `translate(${x}px, ${y}px)` : `translate(${x}px, ${y}px) translate(-50%, -50%)`;
          l.el.style.fontSize = `${fs}px`;
          l.el.classList.toggle("dim", Boolean(highlightType && l.circuit && built.byId.get(l.circuit)?.type !== highlightType));
          l.el.classList.toggle("sel", Boolean(l.circuit && l.circuit === selectedCircuit));
        }
      }
      if (l.shown !== show) {
        l.el.style.display = show ? "" : "none";
        l.shown = show;
      }
    }
  }

  // ---------- 动画循环 ----------
  const lastCam = new THREE.Matrix4();
  function animate() {
    if (!open) return;
    frame = requestAnimationFrame(animate);
    clock.update();
    const dt = Math.min(0.1, clock.getDelta());
    if (tween) stepTween();
    controls.update();
    clampTarget();
    const dist = camera.position.distanceTo(controls.target);
    updateClouds(dt, dist);
    if (!reduceMotion) water.material.normalMap.offset.x += dt * 0.004;
    selLine.material.opacity = 0.55 + 0.4 * Math.sin(performance.now() / 380);
    cityMeshes.town.visible = dist < 260;
    renderer.render(scene, camera);
    if (labelsDirty || !lastCam.equals(camera.matrixWorld)) {
      lastCam.copy(camera.matrixWorld);
      labelsDirty = false;
      layoutLabels(dist);
    }
  }

  function clampTarget() {
    const t = controls.target;
    const cx = THREE.MathUtils.clamp(t.x, 0, WORLD_W), cz = THREE.MathUtils.clamp(t.z, 0, terrain.depth);
    if (cx !== t.x || cz !== t.z) {
      camera.position.x += cx - t.x;
      camera.position.z += cz - t.z;
      t.x = cx;
      t.z = cz;
    }
  }

  // 镜头飞行：目标点、距离、俯仰、方位
  function flyTo({ x, z, dist, polar = 0.85, azimuth = null, duration = 1.4 }) {
    const from = {
      tx: controls.target.x, tz: controls.target.z,
      dist: camera.position.distanceTo(controls.target),
      polar: controls.getPolarAngle(), az: controls.getAzimuthalAngle(),
    };
    tween = { from, to: { tx: x, tz: z, dist, polar, az: azimuth ?? from.az }, start: performance.now(), duration: reduceMotion ? 0.001 : duration };
  }
  function stepTween() {
    // 按真实时间推进，掉帧时也不会拖慢
    tween.t = Math.min(1, (performance.now() - tween.start) / 1000 / tween.duration);
    const k = d3.easeCubicInOut(tween.t);
    const { from, to } = tween;
    const lerp = (a, b) => a + (b - a) * k;
    const tx = lerp(from.tx, to.tx), tz = lerp(from.tz, to.tz);
    const ty = Math.max(0, heightAt(tx, tz));
    const dist = lerp(from.dist, to.dist), polar = lerp(from.polar, to.polar), az = lerp(from.az, to.az);
    controls.target.set(tx, ty, tz);
    camera.position.set(
      tx + dist * Math.sin(polar) * Math.sin(az),
      ty + dist * Math.cos(polar),
      tz + dist * Math.sin(polar) * Math.cos(az),
    );
    camera.lookAt(controls.target);
    if (tween.t >= 1) tween = null;
  }

  function overview(duration = 1.6) {
    const [x, z] = toWorld(111, 32.5);
    flyTo({ x, z, dist: 780, polar: 0.82, azimuth: 0, duration });
  }

  // ---------- 侧边栏 ----------
  const RELATION_CLASS = { 归附: "good", 册封: "good", 同盟: "good", 遣唐使: "good", 通商: "neutral", 羁縻: "neutral", 敌对: "bad" };

  function renderPanel() {
    const court = tang.court;
    const c = selectedCircuit && built.byId.get(selectedCircuit);
    const types = Object.entries(tang.types).map(([key, t]) => {
      const n = built.circuits.filter((x) => x.type === key).length;
      return n ? `<li class="type-item${highlightType === key ? " on" : ""}" data-type="${key}"><span class="swatch" style="background:${t.color}"></span>${t.label}<span class="count">${n}</span></li>` : "";
    }).join("");

    let detail = `<p class="hint">点击地形上的州，查看所属方镇；点击类型可在地图上突出显示。</p>`;
    if (c) {
      const t = tang.types[c.type];
      const prefs = c.provinces
        .map((i) => built.current.set.provinces[i].properties.label)
        .filter((v, i, arr) => arr.indexOf(v) === i);
      detail = `
        <div class="circuit-card">
          <div class="circuit-head"><span class="swatch big" style="background:${c.color}"></span><h2>${c.name}</h2></div>
          <span class="badge" style="--badge:${t.color}">${t.label}</span>
          <dl class="stats">
            <dt>${c.title}</dt><dd>${c.holder ?? '<span class="unknown">待考</span>'}</dd>
            <dt>治所</dt><dd>${c.seat ?? "—"}</dd>
            <dt>辖州</dt><dd>${prefs.length}</dd>
            <dt>与朝廷</dt><dd>${c.relation}</dd>
          </dl>
          <p class="type-desc">${t.desc}</p>
          <ul class="chips">${prefs.map((p) => `<li${p === selectedPref ? ' class="on"' : ""}>${p}</li>`).join("")}</ul>
          <button class="ghost fly" data-fly="${c.id}">镜头飞往${c.name.replace(/（.*）/, "")}</button>
        </div>`;
    }

    const foreign = tang.foreign.map((f) => `
      <li class="foreign" data-name="${f.name}">
        <span class="rel ${RELATION_CLASS[f.relation] ?? "neutral"}">${f.relation}</span>
        <strong>${zhName(f.name)}</strong>
        <span class="ruler">${tang.rulers[f.name] ?? ""}</span>
        <p>${f.desc}</p>
      </li>`).join("");

    panel.innerHTML = `
      <div class="china-head">
        <div class="ruler-line">${court.ruler}</div>
        <p class="era-desc">${court.note}</p>
      </div>
      <h3>方镇类型</h3>
      <ul class="type-legend">${types}</ul>
      ${detail}
      <h3>四夷与邻国</h3>
      <ul class="foreign-list">${foreign}</ul>`;

    panel.querySelectorAll(".type-item").forEach((el) => {
      el.onclick = () => {
        highlightType = highlightType === el.dataset.type ? null : el.dataset.type;
        paintTexture();
        renderPanel();
        labelsDirty = true;
      };
    });
    panel.querySelector(".fly")?.addEventListener("click", () => flyToCircuit(selectedCircuit));
    panel.querySelectorAll(".foreign").forEach((el) => (el.onclick = () => flyToCountry(el.dataset.name)));
  }

  function selectCircuit(id, { fly = true } = {}) {
    selectedCircuit = id;
    const c = built.byId.get(id);
    selLine.geometry.dispose();
    selLine.geometry = c?.geometry ? drapeOutline(c.geometry) : new THREE.BufferGeometry();
    paintTexture();
    renderPanel();
    labelsDirty = true;
    if (fly) flyToCircuit(id);
  }

  function flyToCircuit(id) {
    const c = built.byId.get(id);
    if (!c?.geometry) return;
    const [[w, s], [e, n]] = d3.geoBounds(c.geometry);
    const [x0, z0] = toWorld(w, n), [x1, z1] = toWorld(e, s);
    const span = Math.max(x1 - x0, z1 - z0);
    flyTo({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, dist: THREE.MathUtils.clamp(span * 2.6, 70, 700), polar: 0.9 });
  }

  function flyToCountry(name) {
    const f = built.current.byName.get(name);
    if (!f) return;
    const [lon, lat] = d3.geoCentroid(f);
    const [x, z] = toWorld(lon, lat);
    if (inside(x, z)) flyTo({ x, z, dist: 520, polar: 0.85 });
    showForeign(name);
  }

  function showForeign(name) {
    selectedCircuit = null;
    selectedPref = null;
    selLine.geometry.dispose();
    selLine.geometry = new THREE.BufferGeometry();
    paintTexture();
    renderPanel();
    const el = panel.querySelector(`.foreign[data-name="${CSS.escape(name)}"]`);
    if (el) {
      el.classList.add("flash");
      el.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    }
  }

  function clearSelection() {
    if (!selectedCircuit && !highlightType) return;
    selectedCircuit = null;
    selectedPref = null;
    highlightType = null;
    selLine.geometry.dispose();
    selLine.geometry = new THREE.BufferGeometry();
    paintTexture();
    renderPanel();
    labelsDirty = true;
  }

  // ---------- 顶栏按钮与键盘 ----------
  document.getElementById("tang-back").onclick = () => close();
  document.getElementById("tang-reset").onclick = () => overview(1.2);
  const cloudBtn = document.getElementById("tang-clouds");
  cloudBtn.onclick = () => {
    showClouds = !showClouds;
    cloudBtn.classList.toggle("off", !showClouds);
  };
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    if (!open || e.target.closest?.("input, textarea")) return;
    if (e.key === "Escape") {
      if (selectedCircuit || highlightType) clearSelection();
      else close();
      return;
    }
    keys.add(e.key.toLowerCase());
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());
  // WASD 平移、Q/E 旋转
  const keyPan = () => {
    if (!open || !keys.size) return;
    const dist = camera.position.distanceTo(controls.target);
    const sp = dist * 0.012;
    const az = controls.getAzimuthalAngle();
    const fwd = new THREE.Vector3(-Math.sin(az), 0, -Math.cos(az));
    const right = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
    const move = new THREE.Vector3();
    if (keys.has("w") || keys.has("arrowup")) move.add(fwd);
    if (keys.has("s") || keys.has("arrowdown")) move.sub(fwd);
    if (keys.has("d") || keys.has("arrowright")) move.add(right);
    if (keys.has("a") || keys.has("arrowleft")) move.sub(right);
    if (move.lengthSq()) {
      tween = null;
      move.normalize().multiplyScalar(sp);
      controls.target.add(move);
      camera.position.add(move);
    }
    if (keys.has("q") || keys.has("e")) {
      tween = null;
      const a = (keys.has("q") ? 1 : -1) * 0.025;
      const off = camera.position.clone().sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      camera.position.copy(controls.target).add(off);
    }
  };
  setInterval(keyPan, 16);

  // ---------- 打开 / 关闭 ----------
  let ready = null;
  async function prepare(assets) {
    if (!renderer) initRenderer();
    tang = assets.tang;
    geo = assets.geo;
    if (!terrain) buildTerrain(await loadHeight());
    scene.add(hoverLine, selLine);
  }

  async function openScene(b, assets) {
    built = b;
    screen.hidden = false;
    loading.hidden = false;
    requestAnimationFrame(() => screen.classList.add("shown"));
    // 先让加载提示画出来，再做重活
    await new Promise((r) => setTimeout(r, 30));
    ready ??= prepare(assets);
    await ready;
    if (terrain.builtFor !== b) {
      for (const m of Object.values(cityMeshes)) scene.remove(m);
      cityMeshes = {};
      prepareTexture();
      buildCities();
      if (!clouds.length) buildClouds();
      buildLabels();
      terrain.builtFor = b;
    }
    selectedCircuit = null;
    selectedPref = null;
    highlightType = null;
    selLine.geometry = new THREE.BufferGeometry();
    paintTexture();
    renderPanel();
    resize();
    loading.hidden = true;
    open = true;
    // 开场镜头：从正上方俯视（衔接二维地图）缓缓压低成 2.5D 视角
    const [x, z] = toWorld(111, 32.5);
    controls.target.set(x, 0, z);
    camera.position.set(x, 1400, z + 1);
    camera.lookAt(controls.target);
    controls.update();
    overview(2.4);
    clock.update();
    animate();
  }

  function close() {
    if (!open) return;
    open = false;
    cancelAnimationFrame(frame);
    tip.hidden = true;
    screen.classList.remove("shown");
    setTimeout(() => {
      if (!open) screen.hidden = true;
    }, 450);
    onExit?.();
  }

  return {
    open: openScene,
    close,
    get isOpen() {
      return open;
    },
  };
}
