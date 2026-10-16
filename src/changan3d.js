// 三维长安城（800 年，贞元十六年）：从大唐场景点击长安进入。
// 内容：外郭城与护城河、十二座城门、宫城与皇城、大明宫、兴庆宫、东西两市、百坊宅院、
// 寺塔（大雁塔、小雁塔等）、曲江池；空中漫游、昼夜切换（夜里宵禁：坊门关闭、街上只有金吾卫巡夜）。
// 坐标单位为米，原点在外郭城中心，x 向东、z 向南。布局数据见 public/data/changan.json。
//
// 宅院、曲面屋顶、瓦面与石板路贴图、按「形状 × 材质」分组的实例化绘制，改写自
// 三坊七巷 3D 地图（https://github.com/fanhuayishiy/ai-demo，sanfang-qixiang-atlas/src/district.js），
// MIT 许可，Copyright (c) 2026 fanhuayishiy，许可全文见 src/vendor/sanfang-qixiang-LICENSE.txt。
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";

// ---------- 改写自三坊七巷（MIT）：随机数、贴图、屋顶、实例化批量绘制 ----------

function random(seed = 74913) {
  return () => {
    seed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed);
    return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296;
  };
}

// 唐代筒瓦：比福州的小青瓦更深一些
function roofTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const rng = random(299);
  ctx.fillStyle = "#4f585c";
  ctx.fillRect(0, 0, 256, 256);
  for (let x = 0; x < 256; x += 16) {
    const shade = 70 + Math.floor(rng() * 20);
    ctx.fillStyle = `rgb(${shade},${shade + 8},${shade + 12})`;
    ctx.fillRect(x, 0, 12, 256);
    ctx.fillStyle = "rgba(190,200,205,.22)";
    ctx.fillRect(x + 1, 0, 2, 256);
    ctx.fillStyle = "rgba(15,22,24,.35)";
    ctx.fillRect(x + 13, 0, 3, 256);
    for (let y = 0; y < 256; y += 24) {
      ctx.fillStyle = "rgba(12,18,20,.2)";
      ctx.fillRect(x, y + Math.floor(rng() * 3), 16, 2);
    }
  }
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function pavingTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const rng = random(384);
  ctx.fillStyle = "#cfc9b9";
  ctx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 32)
    for (let x = -64; x < 256; x += 64) {
      const shade = 202 + Math.floor(rng() * 17);
      const offset = (y / 32) % 2 ? 32 : 0;
      ctx.fillStyle = `rgb(${shade + 10},${shade + 7},${shade - 4})`;
      ctx.fillRect(x + offset + 1, y + 1, 62, 30);
    }
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 曲面屋顶：正脊挺直、屋面微凹、檐角起翘。唐代屋顶坡度平缓、出檐深远，这里压低了屋面
function makeRoofGeometry() {
  const positions = [], uvs = [], indices = [];
  // 本项目改动：沿屋脊方向只保留檐角那几段，三角形数减半（全城有三万多座屋顶）
  const xs = [-0.5, -0.46, 0.46, 0.5];
  const zs = [-0.5, -0.44, -0.24, 0, 0.24, 0.44, 0.5];
  for (let zi = 0; zi < zs.length; zi++)
    for (let xi = 0; xi < xs.length; xi++) {
      const x = xs[xi], z = zs[zi];
      const sag = Math.abs(z) * 2;
      const y = 1 - sag * (0.85 + 0.15 * sag) + (Math.abs(z) > 0.43 ? 0.09 : 0) + (Math.abs(x) > 0.46 ? 0.07 : 0);
      positions.push(x, y, z);
      uvs.push((x + 0.5) * 3, (z + 0.5) * 2);
    }
  for (let z = 0; z < zs.length - 1; z++)
    for (let x = 0; x < xs.length - 1; x++) {
      const a = z * xs.length + x, b = a + 1, c = a + xs.length, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createBatches(group, materials, geometries) {
  const batches = new Map();
  const dummy = new THREE.Object3D();
  // 本项目改动：按 2 公里见方分块，镜头拉近时屏幕外的块会被整块剔除
  const add = (geometry, material, x, y, z, sx, sy, sz, rotation = 0) => {
    const big = Math.max(sx, sz) > 1500; // 地面、长墙这类大件单独成块
    const key = big ? `${geometry}:${material}:big` : `${geometry}:${material}:${Math.floor((x + 6000) / 2000)}:${Math.floor((z + 7600) / 2000)}`;
    if (!batches.has(key)) batches.set(key, { geometry, material, matrices: [] });
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rotation, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    batches.get(key).matrices.push(dummy.matrix.clone());
  };
  const finish = (noShadow = new Set()) => {
    const meshes = {};
    let count = 0;
    for (const [key, { geometry, material, matrices }] of batches) {
      const mesh = new THREE.InstancedMesh(geometries[geometry], materials[material], matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.castShadow = !noShadow.has(material) && geometry !== "sphere";
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = key;
      group.add(mesh);
      meshes[key] = mesh;
      count += matrices.length;
    }
    batches.clear();
    return { meshes, count };
  };
  return { add, finish };
}

// ---------- 以下为本项目代码 ----------

export function createChangan({ DATA, textEm, onExit }) {
  const screen = document.getElementById("city-screen");
  const view = document.getElementById("city-view");
  const labelLayer = document.getElementById("city-labels");
  const tip = document.getElementById("city-tip");
  const panel = document.getElementById("city-panel");
  const loading = document.getElementById("city-loading");
  const toast = document.getElementById("city-toast");
  const tourCard = document.getElementById("city-tour");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let renderer, scene, camera, controls, timer, hemi, sun;
  let data = null;
  let built = false;
  let open = false;
  let frame = 0;
  let selected = null;
  let night = 0; // 0 白天 → 1 夜晚，切换时渐变
  let nightTarget = 0;
  let flight = null;
  let labelsDirty = true;
  const tour = { active: false, paused: false, index: 0, elapsed: 0 };
  const STOP_SECONDS = 9;

  const materials = {};
  let gateDoors = null; // 夜里关闭的坊门
  let walkers = null;
  let patrols = null;
  let water = [];
  const wards = []; // { x0, x1, z0, z1, name, county }
  const markers = [];

  // ---------- 渲染器与场景 ----------
  function init() {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    view.prepend(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color("#e6dcc4");
    scene.fog = new THREE.Fog("#e6dcc4", 9000, 32000);
    camera = new THREE.PerspectiveCamera(36, 1, 4, 80000);
    controls = new MapControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = false;
    controls.minDistance = 40;
    controls.maxDistance = 24000;
    controls.maxPolarAngle = 1.38;
    controls.addEventListener("start", () => {
      flight = null;
      if (tour.active && !tour.paused) pauseTour(true);
    });
    timer = new THREE.Timer();

    hemi = new THREE.HemisphereLight("#fff6e4", "#8a7a5a", 1.6);
    scene.add(hemi);
    sun = new THREE.DirectionalLight("#fff0d6", 2.6);
    sun.castShadow = true;
    const size = Math.min(4096, renderer.capabilities.maxTextureSize);
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.8;
    scene.add(sun, sun.target);

    new ResizeObserver(resize).observe(view);
    renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", () => (tip.hidden = true));
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  let downAt = null;

  function resize() {
    const w = view.clientWidth, h = view.clientHeight;
    if (!w || !h || !renderer) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    labelsDirty = true;
  }

  // ---------- 材质与基本形体 ----------
  function makeMaterials() {
    const roofMap = roofTexture();
    const paving = pavingTexture();
    // 大量构件用 Lambert 光照，比 PBR 省得多；只有金饰用 PBR
    const std = (color, extra = {}) => {
      const { roughness, metalness, ...rest } = extra;
      return metalness != null ? new THREE.MeshStandardMaterial({ color, roughness: roughness ?? 0.9, metalness, ...rest }) : new THREE.MeshLambertMaterial({ color, ...rest });
    };
    Object.assign(materials, {
      wall: std("#c4ab80"), // 夯土
      cityWall: std("#b79e74"),
      whiteWall: std("#efe7d4"),
      red: std("#a2402c"), // 唐代建筑的朱红柱额
      trim: std("#bdb3a0"),
      platform: std("#d2c6a6"),
      roof: std("#d6dde0", { map: roofMap, side: THREE.DoubleSide }),
      palaceRoof: std("#bfc9c4", { map: roofMap, side: THREE.DoubleSide }),
      ridge: std("#454e52"),
      gold: std("#c8a24c", { roughness: 0.5, metalness: 0.2 }),
      brick: std("#a39079"),
      brickDark: std("#7f6e5c"),
      door: std("#3f2a1d"),
      court: std("#f2ebda", { map: paving }),
      street: std("#d9c79c"),
      wardGround: std("#c7b88f"),
      field: std("#a9ad6d"),
      field2: std("#c7b46a"),
      garden: std("#9fae7c"),
      trunk: std("#6f6248", { roughness: 1 }),
      leaf1: std("#456b4c", { flatShading: true }),
      leaf2: std("#5b7a4d", { flatShading: true }),
      leaf3: std("#6d8758", { flatShading: true }),
      leafPink: std("#d9a6a4", { flatShading: true }),
      banner1: std("#a33a2c"),
      banner2: std("#3b5f7a"),
      awning1: std("#e2d3a8"),
      awning2: std("#b9875a"),
      awning3: std("#7d8f6a"),
      lantern: new THREE.MeshBasicMaterial({ color: "#ffb24e" }),
      window: std("#6a4a2c", { emissive: "#ffc46a", emissiveIntensity: 0 }),
    });
  }

  function makeGeometries() {
    const pyramid = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
    pyramid.rotateY(Math.PI / 4);
    pyramid.translate(0, 0.5, 0);
    return {
      box: new THREE.BoxGeometry(1, 1, 1),
      roof: makeRoofGeometry(),
      leaf: new THREE.IcosahedronGeometry(1, 0),
      trunk: new THREE.CylinderGeometry(0.7, 1, 1, 5, 1, true),
      sphere: new THREE.SphereGeometry(1, 7, 5),
      pyramid,
    };
  }

  // ---------- 布局 ----------
  function layout() {
    const cols = {};
    data.columns.east.forEach(([a, b], i) => {
      cols[`E${i}`] = [a, b];
      cols[`W${i}`] = [-b, -a];
    });
    const rows = {};
    data.rows.north.forEach((r, i) => (rows[`n${i}`] = r));
    data.rows.south.forEach((r, i) => (rows[`s${i}`] = r));
    return { cols, rows };
  }

  // ---------- 构建全城 ----------
  function build() {
    const group = new THREE.Group();
    scene.add(group);
    makeMaterials();
    const geometries = makeGeometries();
    const B = createBatches(group, materials, geometries);
    const add = B.add;
    const rng = random(800);
    const AWNINGS = ["banner1", "banner2", "awning1", "awning2", "awning3"];
    const { cols, rows } = layout();
    const CW = data.city.width / 2, CD = data.city.depth / 2;

    // 地面：城外田野、城内街道（夯土路面）
    const fieldsTex = fieldTexture();
    fieldsTex.repeat.set(26, 26);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(70000, 70000), new THREE.MeshStandardMaterial({ color: "#d6cba6", map: fieldsTex, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    group.add(ground);
    add("box", "street", 0, 0.05, 0, CW * 2, 0.1, CD * 2);
    // 出城大道
    for (const g of data.gates) {
      if (g.inner) continue;
      const len = 9000;
      if (g.side === "s") add("box", "street", g.x, 0.06, g.z + len / 2, 60, 0.1, len);
      if (g.side === "n") add("box", "street", g.x, 0.06, g.z - len / 2, 60, 0.1, len);
      if (g.side === "e") add("box", "street", g.x + len / 2, 0.06, g.z, len, 0.1, 60);
      if (g.side === "w") add("box", "street", g.x - len / 2, 0.06, g.z, len, 0.1, 60);
    }

    // ---- 常用构件 ----
    const house = (x, z, w, d, h, rot = 0, opt = {}) => {
      const y0 = opt.y ?? 0;
      const base = opt.base ?? 0.8;
      if (base > 0.6) add("box", "trim", x, y0 + base / 2, z, w + 0.8, base, d + 0.8, rot);
      add("box", opt.wall ?? "whiteWall", x, y0 + base + h / 2, z, w, h, d, rot);
      const rh = Math.min(opt.roofH ?? 5, d * 0.3);
      add("roof", opt.roof ?? "roof", x, y0 + base + h, z, w + 2.6, rh, d + 3, rot);
      add("box", "ridge", x, y0 + base + h + rh + 0.05, z, w + 2.2, 0.45, 0.6, rot);
    };
    // 殿堂：台基 + 朱红柱额 + 屋顶（可重檐、可加鸱尾）
    const hall = (x, z, w, d, h, opt = {}) => {
      const y0 = opt.y ?? 0;
      const ph = opt.platform ?? 2;
      const rot = opt.rot ?? 0;
      add("box", "platform", x, y0 + ph / 2, z, w + (opt.apron ?? 12), ph, d + (opt.apron ?? 12), rot);
      const top = y0 + ph;
      add("box", "red", x, top + h / 2, z, w, h, d, rot);
      add("box", "whiteWall", x, top + h * 0.82, z, w + 0.2, h * 0.14, d + 0.2, rot); // 额枋
      let roofY = top + h;
      if (opt.double) {
        add("roof", "palaceRoof", x, roofY - h * 0.08, z, w + 7, Math.min(4, d * 0.16), d + 7, rot);
        add("box", "red", x, roofY + h * 0.18, z, w * 0.86, h * 0.36, d * 0.8, rot);
        roofY += h * 0.36;
      }
      const rh = Math.min(opt.roofH ?? 9, d * 0.34);
      add("roof", "palaceRoof", x, roofY, z, w + 6, rh, d + 6, rot);
      add("box", "ridge", x, roofY + rh, z, w + 4, 0.8, 1, rot);
      if (opt.chiwei !== false) {
        const c = Math.cos(rot), s = Math.sin(rot);
        for (const side of [-1, 1]) {
          const dx = side * (w / 2 + 1.5);
          add("box", "gold", x + c * dx, roofY + rh + 1.1, z - s * dx, 1, 2.2, 1.2, rot);
        }
      }
    };
    const tree = (x, z, size = 5, pink = false) => {
      const h = size * 1.5;
      add("trunk", "trunk", x, h / 2, z, size * 0.12, h, size * 0.12);
      for (let k = 0; k < 2; k++) {
        const a = k * 2.399 + rng() * 6;
        const reach = size * (k ? 0.4 : 0);
        const s = size * (0.7 + rng() * 0.2);
        add("leaf", pink ? "leafPink" : `leaf${1 + Math.floor(rng() * 3)}`, x + Math.cos(a) * reach, h + (k ? rng() * size * 0.4 : size * 0.3), z + Math.sin(a) * reach, s, s * 0.75, s, rng() * 6);
      }
    };
    // 沿一段墙（轴对齐）砌墙，gaps 为开口中心与宽度
    const wallRun = (axis, fixed, from, to, h, t, mat, gaps = []) => {
      const cuts = gaps.map(([c, w]) => [c - w / 2, c + w / 2]).sort((a, b) => a[0] - b[0]);
      let start = from;
      for (const [g0, g1] of [...cuts, [to, to]]) {
        const end = Math.min(g0, to);
        if (end - start > 0.5) {
          const len = end - start, mid = (start + end) / 2;
          if (axis === "x") add("box", mat, mid, h / 2, fixed, len, h, t);
          else add("box", mat, fixed, h / 2, mid, t, h, len);
        }
        start = Math.max(start, g1);
      }
    };
    // 城门：墩台 + 门道 + 城楼
    const cityGate = (g, scale = 1) => {
      const ns = g.side === "n" || g.side === "s";
      const rot = ns ? 0 : Math.PI / 2;
      const len = (g.portals * 9 + 26) * scale;
      const H = 11 * scale, D = 26 * scale;
      add("box", "cityWall", g.x, H / 2, g.z, ns ? len : D, H, ns ? D : len);
      for (let p = 0; p < g.portals; p++) {
        const off = (p - (g.portals - 1) / 2) * 9 * scale;
        for (const face of [-1, 1]) {
          const fx = ns ? g.x + off : g.x + face * (D / 2 + 0.05);
          const fz = ns ? g.z + face * (D / 2 + 0.05) : g.z + off;
          add("box", "door", fx, 3.4 * scale, fz, ns ? 5.4 * scale : 0.3, 6.8 * scale, ns ? 0.3 : 5.4 * scale);
        }
      }
      hall(g.x, g.z, len * 0.72, 15 * scale, 7 * scale, { y: H, platform: 0.8, apron: 3, rot, roofH: 6 * scale, double: g.portals >= 5 });
    };

    // ---- 外郭城：城墙、角楼、护城河 ----
    const gatesOn = (side) => data.gates.filter((g) => g.side === side && !g.inner).map((g) => [side === "n" || side === "s" ? g.x : g.z, (g.portals * 9 + 26)]);
    const T = data.city.wallThickness, H = data.city.wallHeight;
    wallRun("x", -CD, -CW, CW, H, T, "cityWall", gatesOn("n"));
    wallRun("x", CD, -CW, CW, H, T, "cityWall", gatesOn("s"));
    wallRun("z", -CW, -CD, CD, H, T, "cityWall", gatesOn("w"));
    wallRun("z", CW, -CD, CD, H, T, "cityWall", gatesOn("e"));
    for (const [x, z] of [[-CW, -CD], [CW, -CD], [-CW, CD], [CW, CD]]) {
      add("box", "cityWall", x, H * 0.6, z, T * 2.4, H * 1.2, T * 2.4);
      house(x, z, T * 2, T * 2, 4, 0, { y: H * 1.2, base: 0.3, roof: "palaceRoof", wall: "red" });
    }
    // 城墙顶的女墙
    for (const [axis, fixed] of [["x", -CD], ["x", CD], ["z", -CW], ["z", CW]]) {
      const pos = fixed + (fixed < 0 ? -T / 2 + 0.6 : T / 2 - 0.6);
      if (axis === "x") add("box", "cityWall", 0, H + 0.7, pos, CW * 2, 1.4, 1.2);
      else add("box", "cityWall", pos, H + 0.7, 0, 1.2, 1.4, CD * 2);
    }
    for (const g of data.gates) if (!g.inner) cityGate(g, g.portals >= 5 ? 1.25 : 1);
    // 护城河与门前桥
    const moatOff = 30, moatW = 16;
    const moat = new THREE.Group();
    const addWater = (x, z, w, d) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), waterMaterial());
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.25, z);
      moat.add(m);
      water.push(m);
    };
    addWater(0, -CD - moatOff, CW * 2 + 2 * moatOff + moatW, moatW);
    addWater(0, CD + moatOff, CW * 2 + 2 * moatOff + moatW, moatW);
    addWater(-CW - moatOff, 0, moatW, CD * 2 + 2 * moatOff);
    addWater(CW + moatOff, 0, moatW, CD * 2 + 2 * moatOff);
    group.add(moat);
    for (const g of data.gates) {
      if (g.inner) continue;
      const ns = g.side === "n" || g.side === "s";
      const sgn = g.side === "s" || g.side === "e" ? 1 : -1;
      const bx = ns ? g.x : g.x + sgn * moatOff, bz = ns ? g.z + sgn * moatOff : g.z;
      add("box", "trim", bx, 0.9, bz, ns ? 40 : moatW + 10, 1.2, ns ? moatW + 10 : 40);
    }

    // ---- 宫城、皇城 ----
    const PW = data.palace.width / 2;
    const pz0 = -CD, pz1 = -CD + data.palace.depth;
    const iz0 = pz1 + data.imperial.gapStreet, iz1 = iz0 + data.imperial.depth;
    const innerGate = (id) => data.gates.find((g) => g.id === id);
    wallRun("x", pz1, -PW, PW, 10, 10, "cityWall", [[0, 70]]);
    wallRun("z", -PW, pz0, pz1, 10, 10, "cityWall");
    wallRun("z", PW, pz0, pz1, 10, 10, "cityWall");
    wallRun("z", -642, pz0, pz1, 7, 6, "cityWall", [[-3600, 20]]);
    wallRun("z", 642, pz0, pz1, 7, 6, "cityWall", [[-3600, 20]]);
    wallRun("x", iz0, -PW, PW, 8, 8, "cityWall", [[0, 40], [-700, 30], [700, 30]]);
    wallRun("x", iz1, -PW, PW, 8, 8, "cityWall", [[0, 60], [-666, 34], [666, 34]]);
    wallRun("z", -PW, iz0, iz1, 8, 8, "cityWall", [[-1800, 30]]);
    wallRun("z", PW, iz0, iz1, 8, 8, "cityWall", [[-1800, 30]]);
    cityGate(innerGate("chengtian"), 1.05);
    cityGate(innerGate("zhuque"), 1);
    for (const x of [-666, 666]) cityGate({ x, z: iz1, side: "s", portals: 1 }, 0.8);
    // 太极宫：中轴上的门、殿与廊庑
    add("box", "court", 0, 0.2, -3500, 1180, 0.2, 1300);
    house(0, -3230, 70, 18, 7, 0, { roof: "palaceRoof", wall: "red" }); // 太极门
    hall(0, -3420, 64, 30, 13, { platform: 4, double: true, apron: 26 }); // 太极殿
    hall(0, -3720, 46, 24, 11, { platform: 3 }); // 两仪殿
    hall(0, -3990, 40, 22, 10, { platform: 2.5 }); // 甘露殿
    for (const side of [-1, 1]) {
      house(side * 170, -3410, 260, 9, 5, Math.PI / 2, { roof: "palaceRoof" }); // 东西廊
      house(side * 100, -3285, 130, 8, 5, 0, { roof: "palaceRoof" });
      hall(side * 120, -3720, 26, 16, 8, { platform: 1.5, chiwei: false });
    }
    // 太极宫北部：园林与海池
    addPond(group, -200, -4170, 120, 70);
    for (let i = 0; i < 70; i++) {
      const x = -600 + rng() * 1200, z = -4260 + rng() * 200;
      if (((x + 200) / 135) ** 2 + ((z + 4170) / 85) ** 2 < 1) continue;
      tree(x, z, 6 + rng() * 3);
    }
    // 东宫与掖庭：院落
    fillLots({ x0: 680, x1: 1380, z0: -4290, z1: -2870 }, 0.9, { lot: [90, 80], big: true, avoid: { x0: 990, x1: 1062, z0: -3530, z1: -3470 } });
    fillLots({ x0: -1380, x1: -680, z0: -4290, z1: -2870 }, 0.95, { lot: [70, 60] });
    hall(1026, -3500, 44, 22, 10, { platform: 2.5 }); // 东宫显德殿
    // 皇城：百司衙署
    add("box", "court", 0, 0.15, (iz0 + iz1) / 2, PW * 2 - 20, 0.1, iz1 - iz0 - 20);
    const xCells = [[-1380, -760], [-700, -90], [90, 700], [760, 1380]];
    const zCells = [[iz0 + 30, iz0 + 560], [iz0 + 620, iz0 + 1080], [iz0 + 1140, iz1 - 30]];
    xCells.forEach(([x0, x1], xi) => zCells.forEach(([z0, z1], zi) => {
      if (xi === 3 && zi === 2) return taimiao(x0, x1, z0, z1);
      if (xi === 0 && zi === 2) return taishe(x0, x1, z0, z1);
      fillLots({ x0: x0 + 10, x1: x1 - 10, z0: z0 + 10, z1: z1 - 10 }, 1, { lot: [150, 130], office: true });
    }));
    // 承天门街两侧的槐树
    for (let z = iz0 + 20; z < iz1 - 20; z += 28) for (const s of [-1, 1]) tree(s * 55, z, 6);

    function taimiao(x0, x1, z0, z1) {
      wallRun("x", z0, x0, x1, 4, 2, "red");
      wallRun("x", z1, x0, x1, 4, 2, "red", [[(x0 + x1) / 2, 20]]);
      wallRun("z", x0, z0, z1, 4, 2, "red");
      wallRun("z", x1, z0, z1, 4, 2, "red");
      hall((x0 + x1) / 2, (z0 + z1) / 2 - 40, 70, 26, 12, { platform: 3, double: true });
      for (let i = 0; i < 60; i++) tree(x0 + 15 + rng() * (x1 - x0 - 30), z0 + 15 + rng() * (z1 - z0 - 30), 6);
    }
    function taishe(x0, x1, z0, z1) {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      add("box", "platform", cx, 1, cz, 60, 2, 60);
      add("box", "field2", cx, 2.1, cz, 50, 0.4, 50);
      for (let i = 0; i < 70; i++) tree(x0 + 15 + rng() * (x1 - x0 - 30), z0 + 15 + rng() * (z1 - z0 - 30), 6);
    }

    // ---- 大明宫（龙首原上，北墙以外） ----
    const D0 = { x0: 1050, x1: 2700, z0: -6582, z1: -CD };
    const LONGSHOU = 9; // 龙首原比城内高出的示意高度
    add("box", "wardGround", (D0.x0 + D0.x1) / 2, LONGSHOU / 2, (D0.z0 + D0.z1) / 2 - 6, D0.x1 - D0.x0, LONGSHOU, D0.z1 - D0.z0 - 12);
    const dmWall = (axis, fixed, a, b, gaps) => {
      const cuts = (gaps ?? []).map(([c, w]) => [c - w / 2, c + w / 2]);
      let s = a;
      for (const [g0, g1] of [...cuts, [b, b]]) {
        const e = Math.min(g0, b);
        if (e - s > 0.5) {
          const mid = (s + e) / 2, len = e - s;
          if (axis === "x") add("box", "cityWall", mid, LONGSHOU + 5, fixed, len, 10, 10);
          else add("box", "cityWall", fixed, LONGSHOU + 5, mid, 10, 10, len);
        }
        s = Math.max(s, g1);
      }
    };
    dmWall("x", D0.z0, D0.x0, D0.x1, [[1870, 40]]);
    dmWall("z", D0.x0, D0.z0, D0.z1);
    dmWall("z", D0.x1, D0.z0, D0.z1);
    dmWall("x", -5150, D0.x0, D0.x1, [[1870, 30]]); // 外朝与中朝之间的宫墙
    dmWall("x", -5420, D0.x0, D0.x1, [[1870, 30]]);
    const Y = LONGSHOU;
    // 含元殿：高台、两阁、龙尾道
    add("box", "platform", 1870, Y + 7, -4985, 200, 14, 80);
    hall(1870, -4990, 67, 29, 14, { y: Y + 14, platform: 2, double: true, apron: 14 });
    for (const side of [-1, 1]) {
      const ax = 1870 + side * 150;
      add("box", "platform", ax, Y + 9, -4900, 40, 18, 40);
      hall(ax, -4900, 22, 18, 9, { y: Y + 18, platform: 1, apron: 4, double: true });
      house(1870 + side * 95, -4950, 100, 8, 5, Math.atan2(50, side * 90), { y: Y + 14, roof: "palaceRoof" });
    }
    for (const side of [-1, 0, 1]) {
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(side ? 9 : 12, 1.2, 150), materials.platform);
      ramp.position.set(1870 + side * 22, Y + 7, -4870);
      ramp.rotation.x = Math.atan2(14, 150);
      ramp.castShadow = ramp.receiveShadow = true;
      group.add(ramp);
    }
    hall(1870, -5300, 54, 26, 12, { y: Y, platform: 3 }); // 宣政殿
    hall(1870, -5560, 44, 24, 11, { y: Y, platform: 3 }); // 紫宸殿
    for (const dz of [-60, 0, 60]) hall(1300, -5850 + dz, 58, 30, 12, { y: Y, platform: dz ? 2 : 4, apron: 8 }); // 麟德殿
    addPond(group, 2100, -6050, 420, 260, Y);
    const peng = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), materials.garden);
    peng.scale.set(70, 22, 50);
    peng.position.set(2150, Y, -6070);
    peng.receiveShadow = true;
    group.add(peng);
    for (let i = 0; i < 260; i++) {
      const x = D0.x0 + 30 + rng() * (D0.x1 - D0.x0 - 60), z = -6550 + rng() * 1050;
      if (((x - 2100) / 440) ** 2 + ((z + 6050) / 280) ** 2 < 1) continue;
      treeAt(x, z, 6 + rng() * 3, Y);
    }
    fillLots({ x0: D0.x0 + 30, x1: 1700, z0: -5440, z1: -5160 }, 0.8, { lot: [80, 70], y: Y });
    fillLots({ x0: 2050, x1: D0.x1 - 30, z0: -5440, z1: -5160 }, 0.8, { lot: [80, 70], y: Y });
    // 外朝两侧：中书省、门下省等官署
    fillLots({ x0: D0.x0 + 30, x1: 1650, z0: -5130, z1: -4360 }, 1, { lot: [140, 120], y: Y, office: true });
    fillLots({ x0: 2100, x1: D0.x1 - 30, z0: -5130, z1: -4360 }, 1, { lot: [140, 120], y: Y, office: true });
    // 内廷：宫殿院落
    fillLots({ x0: 1560, x1: D0.x1 - 30, z0: -5740, z1: -5460 }, 0.9, { lot: [110, 90], y: Y, big: true, avoid: { x0: 1800, x1: 1940, z0: -5600, z1: -5520 } });
    fillLots({ x0: D0.x0 + 30, x1: D0.x1 - 30, z0: -6560, z1: -6360 }, 0.6, { lot: [110, 90], y: Y, big: true });
    add("box", "garden", (D0.x0 + D0.x1) / 2, Y + 0.05, -6000, D0.x1 - D0.x0 - 40, 0.1, 700);

    function treeAt(x, z, size, y) {
      const h = size * 1.5;
      add("trunk", "trunk", x, y + h / 2, z, size * 0.12, h, size * 0.12);
      const s = size * 0.8;
      add("leaf", `leaf${1 + Math.floor(rng() * 3)}`, x, y + h + size * 0.3, z, s, s * 0.75, s, rng() * 6);
    }

    // ---- 坊、市、宫苑、寺院 ----
    const special = new Map();
    for (const sp of data.specials) for (const r of sp.rows) special.set(`${sp.col}:${r}`, sp);
    const temples = {
      "E2:s4": { name: "大慈恩寺", part: "east", pagoda: "big" },
      "E0:s1": { name: "荐福寺", part: "south" },
      "E0:s2": { name: "荐福寺塔院", part: "north", pagoda: "small", small: true },
      "E0:s4": { name: "大兴善寺", part: "all" },
      "E4:s3": { name: "青龙寺", part: "east" },
      "W2:s1": { name: "西明寺", part: "sw" },
    };
    const wardName = (col, row) => {
      const ri = +row.slice(1);
      if (row[0] === "s") return data.wards[col]?.[ri] ?? null;
      return data.wards[`${col}n`]?.[ri] ?? null;
    };
    const density = (row) => {
      if (row[0] === "n") return 0.92;
      const i = +row.slice(1);
      return [0.88, 0.85, 0.75, 0.62, 0.5, 0.36, 0.26, 0.2, 0.16][i];
    };
    const doneSpecial = new Set();
    for (const [col, [x0, x1]] of Object.entries(cols)) {
      const central = +col.slice(1) < data.columns.centralCount;
      for (const [row, [z0, z1]] of Object.entries(rows)) {
        if (central && row[0] === "n") continue; // 宫城、皇城
        const sp = special.get(`${col}:${row}`);
        if (sp) {
          if (doneSpecial.has(sp.id)) continue;
          doneSpecial.add(sp.id);
          const rr = sp.rows.map((r) => rows[r]);
          const box = { x0, x1, z0: Math.min(...rr.map((r) => r[0])), z1: Math.max(...rr.map((r) => r[1])) };
          if (sp.kind === "market") market(box);
          else if (sp.kind === "palace") xingqing(box);
          else if (sp.kind === "lake") qujiang(box);
          wards.push({ ...box, name: sp.name, county: x0 > 0 ? "万年县" : "长安县" });
          continue;
        }
        const name = wardName(col, row);
        wards.push({ x0, x1, z0, z1, name, county: x0 > 0 ? "万年县" : "长安县", col, row });
        ward({ x0, x1, z0, z1 }, central, density(row), temples[`${col}:${row}`]);
      }
    }

    function ward(b, central, dens, temple) {
      const { x0, x1, z0, z1 } = b;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
      add("box", "wardGround", cx, 0.3, cz, w, 0.6, d);
      const WH = 3.2, WT = 2.6, GW = 18;
      // 坊墙：朱雀街两侧的小坊只开东西门，其余四面开门
      wallRun("x", z0, x0, x1, WH, WT, "wall", central ? [] : [[cx, GW]]);
      wallRun("x", z1, x0, x1, WH, WT, "wall", central ? [] : [[cx, GW]]);
      wallRun("z", x0, z0, z1, WH, WT, "wall", [[cz, GW]]);
      wallRun("z", x1, z0, z1, WH, WT, "wall", [[cz, GW]]);
      // 坊内十字街 / 横街
      add("box", "street", cx, 0.65, cz, w - WT, 0.1, 14);
      if (!central) add("box", "street", cx, 0.66, cz, 14, 0.1, d - WT);
      // 坊门：门楼 + 夜里关闭的门扇
      const gates = central ? [[x0, cz, true], [x1, cz, true]] : [[x0, cz, true], [x1, cz, true], [cx, z0, false], [cx, z1, false]];
      for (const [gx, gz, ew] of gates) {
        const rot = ew ? Math.PI / 2 : 0;
        for (const s of [-1, 1]) add("box", "red", gx + (ew ? 0 : s * (GW / 2 + 0.8)), 2.6, gz + (ew ? s * (GW / 2 + 0.8) : 0), 1.6, 5.2, 1.6);
        add("roof", "roof", gx, 5.2, gz, GW + 6, 2.4, 6, rot);
        doorList.push([gx, gz, ew, GW]);
      }
      const quads = central
        ? [{ x0: x0 + 6, x1: x1 - 6, z0: z0 + 6, z1: cz - 10 }, { x0: x0 + 6, x1: x1 - 6, z0: cz + 10, z1: z1 - 6 }]
        : [
          { x0: x0 + 6, x1: cx - 10, z0: z0 + 6, z1: cz - 10 }, { x0: cx + 10, x1: x1 - 6, z0: z0 + 6, z1: cz - 10 },
          { x0: x0 + 6, x1: cx - 10, z0: cz + 10, z1: z1 - 6 }, { x0: cx + 10, x1: x1 - 6, z0: cz + 10, z1: z1 - 6 },
        ];
      let templeBox = null;
      if (temple) {
        templeBox = temple.part === "all" ? { x0: x0 + 8, x1: x1 - 8, z0: z0 + 8, z1: z1 - 8 }
          : temple.part === "east" ? { x0: cx + 10, x1: x1 - 8, z0: z0 + 8, z1: z1 - 8 }
            : temple.part === "south" ? { x0: x0 + 8, x1: x1 - 8, z0: cz + 10, z1: z1 - 8 }
              : temple.part === "north" ? { x0: x0 + 8, x1: x1 - 8, z0: z0 + 8, z1: cz - 10 }
                : { x0: x0 + 8, x1: cx - 10, z0: cz + 10, z1: z1 - 8 };
        templeCompound(templeBox, temple);
      }
      for (const q of quads) {
        if (templeBox && q.x0 >= templeBox.x0 - 20 && q.x1 <= templeBox.x1 + 20 && q.z0 >= templeBox.z0 - 20 && q.z1 <= templeBox.z1 + 20) continue;
        if (temple?.part === "all") continue;
        fillLots(q, dens, { avoid: templeBox });
      }
    }

    // 在一块地里排宅院；空地为田园或园林
    function fillLots(q, dens, opt = {}) {
      const [lw, ld] = opt.lot ?? [66, 58];
      const y = opt.y ?? 0;
      const nx = Math.max(1, Math.floor((q.x1 - q.x0) / lw)), nz = Math.max(1, Math.floor((q.z1 - q.z0) / ld));
      const w = (q.x1 - q.x0) / nx, d = (q.z1 - q.z0) / nz;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const x = q.x0 + (i + 0.5) * w, z = q.z0 + (j + 0.5) * d;
          if (opt.avoid && x > opt.avoid.x0 - w / 2 && x < opt.avoid.x1 + w / 2 && z > opt.avoid.z0 - d / 2 && z < opt.avoid.z1 + d / 2) continue;
          const r = rng();
          if (r < dens) courtyard(x, z, w - 4, d - 4, { y, office: opt.office, big: opt.big });
          else if (r < dens + (1 - dens) * 0.7) {
            add("box", rng() < 0.5 ? "field" : "field2", x, y + 0.7, z, w - 3, 0.1, d - 3);
            if (rng() < 0.3) tree(x + (rng() - 0.5) * w * 0.6, z + (rng() - 0.5) * d * 0.6, 4 + rng() * 2);
          } else {
            add("box", "garden", x, y + 0.7, z, w - 3, 0.1, d - 3);
            for (let k = 0; k < 3; k++) tree(x + (rng() - 0.5) * w * 0.7, z + (rng() - 0.5) * d * 0.7, 4 + rng() * 2.5);
          }
        }
      }
    }

    // 唐式宅院：正堂、东西厢、门屋、院墙（三坊七巷 courtyard() 的简化改写）
    function courtyard(x, z, w, d, opt = {}) {
      const y = opt.y ?? 0;
      const h = (opt.office ? 7 : opt.big ? 6.5 : 5) + rng() * 1.5;
      add("box", "court", x, y + 0.75, z, w, 0.2, d);
      add("box", opt.office ? "red" : "whiteWall", x, y + 1.9, z - d / 2, w, 2.6, 0.8);
      add("box", opt.office ? "red" : "whiteWall", x, y + 1.9, z + d / 2, w, 2.6, 0.8);
      add("box", opt.office ? "red" : "whiteWall", x - w / 2, y + 1.9, z, 0.8, 2.6, d);
      add("box", opt.office ? "red" : "whiteWall", x + w / 2, y + 1.9, z, 0.8, 2.6, d);
      const mainW = w * 0.62, mainD = Math.min(16, d * 0.26);
      if (opt.office) hall(x, z - d * 0.2, mainW, mainD, h, { y, platform: 1.2, apron: 4, chiwei: false, roofH: 6 });
      else house(x, z - d * 0.22, mainW, mainD, h, 0, { y });
      house(x - w * 0.34, z + d * 0.08, d * 0.36, Math.min(9, w * 0.15), h * 0.8, Math.PI / 2, { y });
      house(x + w * 0.34, z + d * 0.08, d * 0.36, Math.min(9, w * 0.15), h * 0.8, Math.PI / 2, { y });
      house(x, z + d * 0.44, w * 0.24, 4.5, 3.4, 0, { y, base: 0.5 });
      // 门前灯笼：夜里发光，做得比实际大一些，远看才能看到点点灯火
      add("box", "lantern", x + w * 0.16, y + 3.6, z + d / 2 + 1.2, 2, 2.4, 2);
      if (rng() < 0.5) add("box", "lantern", x - w * 0.2, y + h + 1.5, z - d * 0.22 + 6, 1.8, 2, 1.8);
      if (rng() < 0.4) {
        const tx = x + (rng() - 0.5) * w * 0.3, tz = z + d * 0.1;
        add("trunk", "trunk", tx, y + 3.5, tz, 0.5, 7, 0.5);
        const s = 3.5 + rng() * 1.5;
        add("leaf", `leaf${1 + Math.floor(rng() * 3)}`, tx, y + 7.5, tz, s, s * 0.75, s, rng() * 6);
      }
    }

    function templeCompound(b, t) {
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, w = b.x1 - b.x0, d = b.z1 - b.z0;
      add("box", "court", cx, 0.75, cz, w, 0.2, d);
      wallRun("x", b.z0, b.x0, b.x1, 4, 2, "red");
      wallRun("x", b.z1, b.x0, b.x1, 4, 2, "red", [[cx, 16]]);
      wallRun("z", b.x0, b.z0, b.z1, 4, 2, "red");
      wallRun("z", b.x1, b.z0, b.z1, 4, 2, "red");
      house(cx, b.z1 - 10, 30, 10, 6, 0, { roof: "palaceRoof", wall: "red" }); // 山门
      if (t.pagoda === "small") {
        smallPagoda(cx, cz);
        for (let i = 0; i < 24; i++) tree(b.x0 + 12 + rng() * (w - 24), b.z0 + 12 + rng() * (d - 24), 5);
        return;
      }
      hall(cx, cz + d * 0.12, Math.min(48, w * 0.3), 24, 11, { platform: 2.5, double: t.part === "all" }); // 大殿
      hall(cx, cz - d * 0.08, Math.min(36, w * 0.24), 18, 9, { platform: 2 }); // 后殿 / 法堂
      for (const s of [-1, 1]) house(cx + s * w * 0.3, cz + d * 0.05, d * 0.5, 8, 5, Math.PI / 2, { roof: "palaceRoof" }); // 廊
      if (t.pagoda === "big") bigPagoda(cx, cz - d * 0.3);
      for (let i = 0; i < 40; i++) {
        const x = b.x0 + 12 + rng() * (w - 24), z = b.z0 + 12 + rng() * (d - 24);
        if (Math.abs(x - cx) < w * 0.22) continue;
        tree(x, z, 5 + rng() * 2);
      }
      // 小院（僧舍）
      fillLots({ x0: b.x0 + 10, x1: b.x0 + w * 0.18, z0: b.z0 + 10, z1: b.z1 - 30 }, 0.9, { lot: [50, 50] });
      fillLots({ x0: b.x1 - w * 0.18, x1: b.x1 - 10, z0: b.z0 + 10, z1: b.z1 - 30 }, 0.9, { lot: [50, 50] });
    }

    // 大雁塔：方形楼阁式砖塔，七层，约 64 米
    function bigPagoda(x, z) {
      add("box", "platform", x, 2.2, z, 48, 4.4, 48);
      let y = 4.4;
      for (let i = 0; i < 7; i++) {
        const s = 25 - i * 1.6, h = i ? 7.4 : 9;
        add("box", "brick", x, y + h / 2, z, s, h, s);
        add("box", "brickDark", x, y + h - 0.5, z, s + 3.2, 1, s + 3.2);
        for (const sd of [-1, 1]) {
          add("box", "door", x + sd * (s / 2 + 0.05), y + h * 0.45, z, 0.2, h * 0.32, 2.4);
          add("box", "door", x, y + h * 0.45, z + sd * (s / 2 + 0.05), 2.4, h * 0.32, 0.2);
        }
        y += h;
      }
      add("pyramid", "brickDark", x, y, z, 14, 5, 14);
      add("box", "gold", x, y + 6, z, 0.8, 4, 0.8);
    }
    // 小雁塔：密檐式，十五层，约 43 米
    function smallPagoda(x, z) {
      add("box", "platform", x, 1.6, z, 26, 3.2, 26);
      let y = 3.2;
      for (let i = 0; i < 15; i++) {
        const t = i / 14;
        const s = 11.4 * (1 + 0.08 * Math.sin(t * Math.PI * 0.8)) * (1 - 0.42 * t * t);
        const h = i ? 2.3 : 7;
        add("box", "brick", x, y + h / 2, z, s, h, s);
        add("box", "brickDark", x, y + h - 0.3, z, s + 2, 0.6, s + 2);
        y += h;
      }
      add("box", "brickDark", x, y + 1.2, z, 2.2, 2.4, 2.2);
    }

    function market(b) {
      const { x0, x1, z0, z1 } = b;
      const w = x1 - x0, d = z1 - z0;
      add("box", "court", (x0 + x1) / 2, 0.35, (z0 + z1) / 2, w, 0.5, d);
      const xs = [x0 + w / 3, x0 + (2 * w) / 3], zs = [z0 + d / 3, z0 + (2 * d) / 3];
      wallRun("x", z0, x0, x1, 4, 3, "wall", xs.map((x) => [x, 30]));
      wallRun("x", z1, x0, x1, 4, 3, "wall", xs.map((x) => [x, 30]));
      wallRun("z", x0, z0, z1, 4, 3, "wall", zs.map((z) => [z, 30]));
      wallRun("z", x1, z0, z1, 4, 3, "wall", zs.map((z) => [z, 30]));
      for (const x of xs) add("box", "street", x, 0.62, (z0 + z1) / 2, 30, 0.1, d);
      for (const z of zs) add("box", "street", (x0 + x1) / 2, 0.63, z, w, 0.1, 30);
      // 九个街区，四周临街为一间间店铺（行），中间为邸店仓库
      const xb = [x0 + 6, xs[0] - 15, xs[0] + 15, xs[1] - 15, xs[1] + 15, x1 - 6];
      const zb = [z0 + 6, zs[0] - 15, zs[0] + 15, zs[1] - 15, zs[1] + 15, z1 - 6];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        const bx0 = xb[i * 2], bx1 = xb[i * 2 + 1], bz0 = zb[j * 2], bz1 = zb[j * 2 + 1];
        const shopRow = (axis, fixed, a, bEnd, face) => {
          for (let p = a + 7; p < bEnd - 7; p += 13) {
            const sx = axis === "x" ? p : fixed + face * 6, sz = axis === "x" ? fixed + face * 6 : p;
            house(sx, sz, 12, 10, 4 + rng() * 1.5, axis === "x" ? 0 : Math.PI / 2, { base: 0.4, roofH: 3 });
            // 店前的布棚
            const ax = axis === "x" ? p : fixed - face * 1.5, az = axis === "x" ? fixed - face * 1.5 : p;
            add("box", AWNINGS[Math.floor(rng() * AWNINGS.length)], ax, 3.2, az, axis === "x" ? 11 : 3, 0.25, axis === "x" ? 3 : 11);
            if (rng() < 0.25) {
              const px = axis === "x" ? p : fixed - face * 1, pz = axis === "x" ? fixed - face * 1 : p;
              add("box", "trunk", px, 4, pz, 0.3, 8, 0.3);
              add("box", rng() < 0.5 ? "banner1" : "banner2", px + (axis === "x" ? 1.2 : 0), 6.2, pz + (axis === "x" ? 0 : 1.2), axis === "x" ? 2.2 : 0.2, 3, axis === "x" ? 0.2 : 2.2);
            }
          }
        };
        shopRow("x", bz0, bx0, bx1, 1);
        shopRow("x", bz1, bx0, bx1, -1);
        shopRow("z", bx0, bz0 + 14, bz1 - 14, 1);
        shopRow("z", bx1, bz0 + 14, bz1 - 14, -1);
        // 街区内部：一排排长条形的行肆与邸店
        for (let rz = bz0 + 34; rz < bz1 - 30; rz += 24) {
          house((bx0 + bx1) / 2, rz, bx1 - bx0 - 50, 8, 4.2, 0, { base: 0.4, roofH: 2.6 });
          for (let px = bx0 + 35; px < bx1 - 35; px += 18) {
            if (rng() < 0.55) add("box", AWNINGS[Math.floor(rng() * AWNINGS.length)], px, 3, rz + 6, 7, 0.25, 3);
          }
        }
      }
      // 市楼
      hall((x0 + x1) / 2, (z0 + z1) / 2, 18, 18, 9, { platform: 2, double: true });
    }

    function xingqing(b) {
      const { x0, x1, z0, z1 } = b;
      const cx = (x0 + x1) / 2;
      add("box", "court", cx, 0.35, (z0 + z1) / 2, x1 - x0, 0.5, z1 - z0);
      wallRun("x", z0, x0, x1, 8, 6, "cityWall", [[cx, 30]]);
      wallRun("x", z1, x0, x1, 8, 6, "cityWall", [[cx, 30]]);
      wallRun("z", x0, z0, z1, 8, 6, "cityWall", [[(z0 + z1) / 2, 30]]);
      wallRun("z", x1, z0, z1, 8, 6, "cityWall");
      addPond(group, cx, z1 - 230, 260, 150);
      hall(cx, z0 + 160, 50, 24, 11, { platform: 3 }); // 兴庆殿
      hall(x0 + 110, z1 - 40, 36, 20, 9, { platform: 2, double: true }); // 勤政务本楼
      hall(x0 + 230, z1 - 40, 36, 20, 9, { platform: 2, double: true }); // 花萼相辉楼
      for (let i = 0; i < 150; i++) {
        const x = x0 + 20 + rng() * (x1 - x0 - 40), z = z0 + 20 + rng() * (z1 - z0 - 40);
        if (((x - cx) / 280) ** 2 + ((z - (z1 - 230)) / 170) ** 2 < 1) continue;
        tree(x, z, 5 + rng() * 2);
      }
      fillLots({ x0: x0 + 30, x1: x1 - 30, z0: z0 + 260, z1: z0 + 420 }, 0.8, { lot: [80, 70], big: true });
    }

    function qujiang(b) {
      const { x0, x1, z0, z1 } = b;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      add("box", "garden", cx, 0.3, cz, x1 - x0, 0.6, z1 - z0);
      // 曲江：不规则的弯曲水面
      const shape = new THREE.Shape();
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const r = 1 + 0.18 * Math.sin(a * 3 + 1) + 0.1 * Math.sin(a * 5);
        const px = cx + Math.cos(a) * 300 * r, pz = cz + 60 + Math.sin(a) * 420 * r;
        k ? shape.lineTo(px, -pz) : shape.moveTo(px, -pz);
      }
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), waterMaterial());
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.7;
      group.add(m);
      water.push(m);
      hall(cx - 40, z0 + 70, 30, 18, 9, { platform: 3, double: true }); // 紫云楼
      for (const [px, pz] of [[cx + 260, cz - 200], [cx - 280, cz + 260], [cx + 240, cz + 380]]) house(px, pz, 12, 12, 4, 0, { roof: "palaceRoof", wall: "red" });
      for (let i = 0; i < 380; i++) {
        const a = rng() * Math.PI * 2, rr = 1.15 + rng() * 0.5;
        const x = cx + Math.cos(a) * 300 * rr, z = cz + 60 + Math.sin(a) * 420 * rr;
        if (x < x0 + 10 || x > x1 - 10 || z < z0 + 10 || z > z1 - 10) continue;
        tree(x, z, 5 + rng() * 2.5, z > cz + 200 && rng() < 0.5); // 杏园
      }
    }

    // ---- 街道两旁的槐树（“槐衙”） ----
    const avenue = (axis, fixed, a, b, half) => {
      for (let p = a; p < b; p += 26) for (const s of [-1, 1]) {
        if (axis === "z") tree(fixed + s * half, p, 5.5 + rng());
        else tree(p, fixed + s * half, 5.5 + rng());
      }
    };
    avenue("z", 0, -870, CD - 40, 70); // 朱雀大街
    for (const z of [-3550, -2700]) { avenue("x", z, PW + 20, CW - 30, 50); avenue("x", z, -CW + 30, -PW - 20, 50); }
    avenue("x", 1425, -CW + 30, CW - 30, 40);
    avenue("x", -930, -CW + 30, CW - 30, 50);
    for (const x of [-666, 666]) avenue("z", x, -870, CD - 40, 26);

    // 坊门的门扇：白天收起，夜里关闭
    const doorGeo = new THREE.BoxGeometry(1, 1, 1);
    gateDoors = new THREE.InstancedMesh(doorGeo, materials.door, doorList.length);
    const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s4 = new THREE.Vector3();
    doorList.forEach(([gx, gz, ew, gw], i) => {
      s4.set(ew ? 1 : gw, 4.6, ew ? gw : 1);
      m4.compose(new THREE.Vector3(gx, 2.4, gz), q4, s4);
      gateDoors.setMatrixAt(i, m4);
    });
    gateDoors.visible = false;
    group.add(gateDoors);

    const { meshes, count } = B.finish(new Set(["court", "street", "wardGround", "field", "field2", "garden", "lantern"]));
    lanternMeshes = Object.entries(meshes).filter(([k]) => k.includes(":lantern")).map(([, m]) => m);
    // 远看时看不清的小构件（屋脊、台基、树干、幡旗）整批隐藏
    detailMeshes = Object.entries(meshes).filter(([k]) => /^(box:(ridge|trim|banner1|banner2|door)|trunk:trunk):/.test(k)).map(([, m]) => m);
    console.info(`长安城：${count} 个构件，${wards.length} 个坊市`);

    buildPeople(group);
  }
  const doorList = [];
  let lanternMeshes = [];
  let detailMeshes = [];
  let detailShown = true;

  function addPond(group, x, z, rx, rz, y = 0) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(1, 48), waterMaterial());
    m.rotation.x = -Math.PI / 2;
    m.scale.set(rx, rz, 1);
    m.position.set(x, y + 0.75, z);
    group.add(m);
    water.push(m);
  }

  let waterMat = null;
  function waterMaterial() {
    if (waterMat) return waterMat;
    const S = 128;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    const img = g.createImageData(S, S);
    const hgt = (x, y) => Math.sin((x / S) * Math.PI * 6 + Math.sin((y / S) * Math.PI * 4) * 1.5) * 0.5 + Math.sin((y / S) * Math.PI * 10 + (x / S) * Math.PI * 4) * 0.35;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const v = new THREE.Vector3(-(hgt(x + 1, y) - hgt(x - 1, y)) * 3, -(hgt(x, y + 1) - hgt(x, y - 1)) * 3, 1).normalize();
      const o = (y * S + x) * 4;
      img.data[o] = (v.x * 0.5 + 0.5) * 255;
      img.data[o + 1] = (v.y * 0.5 + 0.5) * 255;
      img.data[o + 2] = (v.z * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const normal = new THREE.CanvasTexture(c);
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    normal.repeat.set(0.02, 0.02);
    waterMat = new THREE.MeshStandardMaterial({ color: "#7fa6a2", roughness: 0.22, metalness: 0.1, normalMap: normal, normalScale: new THREE.Vector2(0.4, 0.4) });
    // 法线贴图按世界坐标平铺，水面大小不同也不会拉伸
    waterMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace("#include <uv_vertex>", "#include <uv_vertex>\n#ifdef USE_NORMALMAP\nvNormalMapUv = (modelMatrix * vec4(position, 1.0)).xz * 0.02 + vec2(normalMapTransform[2][0], normalMapTransform[2][1]);\n#endif");
    };
    return waterMat;
  }

  function fieldTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 512;
    const g = c.getContext("2d");
    const rng = random(55);
    g.fillStyle = "#cdbf94";
    g.fillRect(0, 0, 512, 512);
    const cols = ["#b9b779", "#a9ad6d", "#c9b86c", "#9fa66a", "#d1c38a", "#b5a76a"];
    for (let y = 0; y < 512; y += 64) {
      let x = 0;
      while (x < 512) {
        const w = 20 + rng() * 60;
        g.fillStyle = cols[Math.floor(rng() * cols.length)];
        g.fillRect(x + 1, y + 1, w - 2, 62);
        g.fillStyle = "rgba(90,80,50,.12)";
        for (let k = 4; k < 62; k += 5) g.fillRect(x + 1, y + k, w - 2, 1);
        x += w;
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }

  // ---------- 行人与巡夜的金吾卫 ----------
  const routes = [];
  function buildPeople(group) {
    const CW = data.city.width / 2, CD = data.city.depth / 2;
    const seg = (a, b, w) => routes.push({ a: new THREE.Vector2(...a), b: new THREE.Vector2(...b), w });
    seg([0, -930], [0, CD - 30], 130); // 朱雀大街
    for (const z of [-3550, -2700]) { seg([1430, z], [CW - 20, z], 90); seg([-CW + 20, z], [-1430, z], 90); }
    seg([-CW + 20, 1425], [CW - 20, 1425], 80);
    seg([-CW + 20, -930], [CW - 20, -930], 100);
    for (const x of [-666, 666, -1420, 1420]) seg([x, -870], [x, CD - 30], 40);
    const rng = random(17);
    const N = 1600;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    walkers = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), N);
    walkers.userData.items = [];
    const palette = ["#f1ead8", "#8a4a3a", "#3e5a6e", "#b48a4a", "#6b7a52", "#d8c49a", "#5a3e5e", "#a04030"];
    const col = new THREE.Color();
    for (let i = 0; i < N; i++) {
      // 西市、东市附近与朱雀大街更热闹
      const r = routes[Math.floor(rng() * routes.length)];
      const cart = rng() < 0.12;
      walkers.userData.items.push({ r, t: rng(), off: (rng() - 0.5) * r.w * 0.8, speed: (cart ? 3 : 5 + rng() * 5) * (rng() < 0.5 ? 1 : -1), cart });
      walkers.setColorAt(i, col.set(cart ? "#6b5238" : palette[Math.floor(rng() * palette.length)]));
    }
    walkers.instanceColor.needsUpdate = true;
    walkers.castShadow = true;
    group.add(walkers);

    const P = 60;
    patrols = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: "#5a2a20", emissive: "#ff9a3a", emissiveIntensity: 0.6 }), P);
    patrols.userData.items = [];
    for (let i = 0; i < P; i++) {
      const r = routes[i % routes.length];
      patrols.userData.items.push({ r, t: rng(), off: (rng() - 0.5) * r.w * 0.5, speed: 6 * (rng() < 0.5 ? 1 : -1) });
    }
    patrols.visible = false;
    group.add(patrols);
    torch = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 4), new THREE.MeshBasicMaterial({ color: "#ffcf7a" }), P);
    torch.visible = false;
    group.add(torch);
  }
  let torch = null;

  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();
  function stepPeople(dt, dist) {
    // 镜头太远时看不见行人，不必更新
    const showPeople = dist < 3500;
    walkers.visible = showPeople && night < 0.5;
    patrols.visible = torch.visible = showPeople && night >= 0.5;
    const mesh = walkers.visible ? walkers : patrols.visible ? patrols : null;
    if (!mesh) return;
    const scale = THREE.MathUtils.clamp(dist / 600, 1, 3); // 远看时适当放大，免得看不见
    mesh.userData.items.forEach((it, i) => {
      const len = it.r.a.distanceTo(it.r.b);
      if (!reduceMotion) {
        it.t += (it.speed * dt) / len;
        if (it.t > 1 || it.t < 0) { it.speed = -it.speed; it.t = THREE.MathUtils.clamp(it.t, 0, 1); }
      }
      const dx = (it.r.b.x - it.r.a.x) / len, dz = (it.r.b.y - it.r.a.y) / len;
      const x = it.r.a.x + (it.r.b.x - it.r.a.x) * it.t - dz * it.off;
      const z = it.r.a.y + (it.r.b.y - it.r.a.y) * it.t + dx * it.off;
      tmpP.set(x, 0.7, z);
      if (it.cart) tmpS.set(2.4 * scale, 2 * scale, 4 * scale);
      else tmpS.set(0.8 * scale, 1.8 * scale, 0.8 * scale);
      tmpQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(dx, dz));
      tmpM.compose(tmpP, tmpQ, tmpS);
      mesh.setMatrixAt(i, tmpM);
      if (mesh === patrols) {
        tmpP.y = 0.7 + 2.3 * scale;
        tmpS.setScalar(0.45 * scale);
        tmpM.compose(tmpP, tmpQ, tmpS);
        torch.setMatrixAt(i, tmpM);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh === patrols) torch.instanceMatrix.needsUpdate = true;
  }

  // ---------- 昼夜 ----------
  const DAY = { bg: new THREE.Color("#e6dcc4"), hemiSky: new THREE.Color("#fff6e4"), hemiGround: new THREE.Color("#8a7a5a"), sun: new THREE.Color("#fff0d6") };
  const NIGHT = { bg: new THREE.Color("#141c2a"), hemiSky: new THREE.Color("#5d77a6"), hemiGround: new THREE.Color("#1d1a20"), sun: new THREE.Color("#9fb6e0") };
  const tmpC = new THREE.Color();
  function applyNight() {
    const k = night;
    scene.background.copy(tmpC.copy(DAY.bg).lerp(NIGHT.bg, k));
    scene.fog.color.copy(scene.background);
    hemi.color.copy(tmpC.copy(DAY.hemiSky).lerp(NIGHT.hemiSky, k));
    hemi.groundColor.copy(tmpC.copy(DAY.hemiGround).lerp(NIGHT.hemiGround, k));
    hemi.intensity = THREE.MathUtils.lerp(1.6, 0.75, k);
    sun.color.copy(tmpC.copy(DAY.sun).lerp(NIGHT.sun, k));
    sun.intensity = THREE.MathUtils.lerp(2.6, 0.5, k);
    renderer.toneMappingExposure = THREE.MathUtils.lerp(1.05, 0.95, k);
    for (const m of lanternMeshes) m.visible = k > 0.02;
    materials.window.emissiveIntensity = k * 1.5;
    gateDoors.visible = k > 0.5;
  }

  function setNight(on) {
    nightTarget = on ? 1 : 0;
    document.getElementById("city-night").textContent = on ? "☀ 昼" : "☾ 夜";
    showToast(on ? "暮鼓八百声，坊门皆闭——宵禁开始，街上只有金吾卫巡夜" : "晨鼓自承天门起，诸街鼓承振，坊门洞开");
    if (reduceMotion) night = nightTarget;
  }

  let toastTimer = 0;
  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 4200);
  }

  // ---------- 标签 ----------
  function buildLabels() {
    labelLayer.innerHTML = "";
    markers.length = 0;
    const icon = { 城门: "门", 宫城皇城: "宫", 街市: "市", 寺塔: "塔", 园池: "园", 坊里: "坊" };
    for (const p of data.landmarks) {
      const el = document.createElement("button");
      el.className = "cmark";
      el.innerHTML = `<span class="cmark-icon">${icon[p.group] ?? "·"}</span><span>${p.name}</span>`;
      el.onclick = () => selectPlace(p.id);
      labelLayer.append(el);
      const y = p.id === "cien" ? 75 : p.id === "jianfu" ? 50 : p.id === "hanyuan" ? 50 : 22;
      markers.push({ el, p, pos: new THREE.Vector3(p.x, y, p.z), prio: 100, w: textEm(p.name) * 13 + 40, marker: true });
    }
    for (const w of wards) {
      if (!w.name || data.landmarks.some((p) => p.name === w.name)) continue;
      const el = document.createElement("div");
      el.className = "cward";
      el.textContent = w.name;
      labelLayer.append(el);
      markers.push({ el, pos: new THREE.Vector3((w.x0 + w.x1) / 2, 4, (w.z0 + w.z1) / 2), prio: 10, w: textEm(w.name) * 12 + 8, maxD: 5200 });
    }
    for (const g of data.gates) {
      if (data.landmarks.some((p) => p.name === g.name)) continue;
      const el = document.createElement("div");
      el.className = "cward gate";
      el.textContent = g.name;
      labelLayer.append(el);
      markers.push({ el, pos: new THREE.Vector3(g.x, 24, g.z), prio: 30, w: textEm(g.name) * 12 + 8, maxD: 9000 });
    }
    markers.sort((a, b) => b.prio - a.prio);
    labelsDirty = true;
  }

  const proj = new THREE.Vector3();
  function layoutLabels(dist) {
    const w = view.clientWidth, h = view.clientHeight;
    const placed = [];
    const ordered = selected ? [...markers].sort((a, b) => (b.p?.id === selected) - (a.p?.id === selected)) : markers;
    for (const m of ordered) {
      let show = dist <= (m.maxD ?? Infinity);
      let x = 0, y = 0;
      if (show) {
        proj.copy(m.pos).project(camera);
        x = (proj.x * 0.5 + 0.5) * w;
        y = (-proj.y * 0.5 + 0.5) * h;
        show = proj.z < 1 && x > 10 && x < w - 10 && y > 10 && y < h - 10;
      }
      if (show) {
        const box = m.marker ? [x - m.w / 2, y - 34, x + m.w / 2, y] : [x - m.w / 2, y - 9, x + m.w / 2, y + 9];
        if (m.p?.id !== selected && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) show = false;
        else {
          placed.push(box);
          m.el.style.transform = m.marker ? `translate(${x}px, ${y}px) translate(-50%, -100%)` : `translate(${x}px, ${y}px) translate(-50%, -50%)`;
          if (m.marker) m.el.classList.toggle("sel", m.p.id === selected);
        }
      }
      if (m.shown !== show) {
        m.el.style.display = show ? "" : "none";
        m.shown = show;
      }
    }
  }

  // ---------- 拾取：地面上的坊 ----------
  const ray = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function wardAt(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.ray.intersectPlane(groundPlane, new THREE.Vector3());
    if (!hit) return null;
    return wards.find((w) => hit.x >= w.x0 && hit.x <= w.x1 && hit.z >= w.z0 && hit.z <= w.z1) ?? null;
  }
  function onPointerMove(e) {
    if (e.buttons) return;
    const w = wardAt(e);
    if (!w) return (tip.hidden = true);
    tip.innerHTML = `<strong>${w.name ?? "坊"}</strong><span class="sub">${w.county}${w.name ? "" : " · 坊名未标"}</span>`;
    const r = view.getBoundingClientRect();
    tip.style.left = `${e.clientX - r.left + 14}px`;
    tip.style.top = `${e.clientY - r.top + 14}px`;
    tip.hidden = false;
  }
  function onClick(e) {
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const w = wardAt(e);
    const p = w && data.landmarks.find((l) => l.x >= w.x0 && l.x <= w.x1 && l.z >= w.z0 && l.z <= w.z1);
    if (p) selectPlace(p.id);
  }

  // ---------- 镜头 ----------
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function flyTo(target, position, duration = 1800) {
    flight = {
      fromTarget: controls.target.clone(), fromPosition: camera.position.clone(),
      target, position, start: performance.now(), duration: reduceMotion ? 1 : duration,
    };
  }
  function viewFrom(target, dist, polar = 0.95, azimuth = 0.35) {
    return target.clone().add(new THREE.Vector3(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth)).multiplyScalar(dist));
  }
  function overview(duration = 2200) {
    const t = new THREE.Vector3(500, 0, -900);
    flyTo(t, viewFrom(t, 15500, 0.82, 0.12), duration);
  }
  function topDown() {
    const t = controls.target.clone();
    const d = camera.position.distanceTo(t);
    flyTo(t, t.clone().add(new THREE.Vector3(0, d, 1)), 1200);
  }

  function selectPlace(id, fromTour = false) {
    const p = data.landmarks.find((l) => l.id === id);
    if (!p) return;
    if (!fromTour && tour.active) stopTour();
    selected = id;
    const dist = { cien: 420, jianfu: 300, hanyuan: 650, "zhuque-street": 1400, dongshi: 1500, xishi: 1500, qujiang: 1800, xingqing: 1400, huangcheng: 2000, taiji: 1100, taiye: 1200, leyou: 1300 }[id] ?? 520;
    const y = p.id === "hanyuan" || p.id === "linde" || p.id === "taiye" ? 10 : 0;
    const t = new THREE.Vector3(p.x, y, p.z);
    flyTo(t, viewFrom(t, dist, 0.98, 0.5 + (p.x > 0 ? 0.2 : -0.2)), fromTour ? 2600 : 1800);
    renderPanel();
    labelsDirty = true;
  }

  // ---------- 漫游 ----------
  function startTour() {
    tour.active = true;
    tour.paused = false;
    tour.index = 0;
    visitStop();
  }
  function visitStop() {
    tour.elapsed = 0;
    const id = data.tour[tour.index];
    selectPlace(id, true);
    renderTourCard();
  }
  function nextStop() {
    if (!tour.active) return;
    if (tour.index + 1 >= data.tour.length) return stopTour(true);
    tour.index++;
    tour.paused = false;
    visitStop();
  }
  function pauseTour(byUser = false) {
    tour.paused = !tour.paused || byUser;
    renderTourCard();
  }
  function stopTour(finished = false) {
    tour.active = false;
    renderTourCard();
    if (finished) {
      showToast("漫游结束");
      overview(2600);
    }
  }
  function renderTourCard() {
    if (!tour.active) {
      tourCard.innerHTML = `<button class="tang-btn" data-act="tour-start">▶ 开始空中漫游</button><span class="tour-hint">${data.tour.length} 站：明德门 → 朱雀大街 → 宫城 → 大明宫 → 东市 → 大雁塔 → 曲江</span>`;
    } else {
      const p = data.landmarks.find((l) => l.id === data.tour[tour.index]);
      tourCard.innerHTML = `<span class="tour-step">${String(tour.index + 1).padStart(2, "0")} / ${data.tour.length}</span><strong>${p.name}</strong>
        <span class="tour-hint">${tour.paused ? "已暂停 · 可自由拖动镜头" : "镜头飞行中，稍后自动前往下一站"}</span>
        <button class="tang-btn" data-act="tour-pause">${tour.paused ? "▶ 继续" : "❚❚ 暂停"}</button>
        <button class="tang-btn" data-act="tour-next">下一站 →</button>
        <button class="tang-btn" data-act="tour-stop">✕</button>`;
    }
    tourCard.querySelector('[data-act="tour-start"]')?.addEventListener("click", startTour);
    tourCard.querySelector('[data-act="tour-pause"]')?.addEventListener("click", () => pauseTour());
    tourCard.querySelector('[data-act="tour-next"]')?.addEventListener("click", nextStop);
    tourCard.querySelector('[data-act="tour-stop"]')?.addEventListener("click", () => stopTour());
  }

  // ---------- 侧边栏 ----------
  function renderPanel() {
    const p = selected && data.landmarks.find((l) => l.id === selected);
    const groups = {};
    for (const l of data.landmarks) (groups[l.group] ??= []).push(l);
    const order = ["宫城皇城", "街市", "寺塔", "园池", "城门", "坊里"];
    const card = p
      ? `<div class="circuit-card city-card">
          <span class="badge" style="--badge:#a2402c">${p.group}</span>
          <h2>${p.name}</h2>
          <div class="city-ward">${p.ward}</div>
          <p class="type-desc">${p.desc}</p>
        </div>`
      : `<p class="hint">点击地图上的标记或下面的名录，镜头会飞过去；悬停在坊上可看坊名。右上角可切换昼夜：夜里宵禁，坊门关闭。</p>`;
    panel.innerHTML = `
      <div class="china-head">
        <div class="ruler-line">长安 · 贞元十六年</div>
        <p class="era-desc">外郭城东西约 9.7 公里、南北约 8.7 公里，朱雀大街以东属万年县、以西属长安县。宫城、皇城居北，百余坊与东西两市棋布其南，人口约百万（通说）。</p>
      </div>
      ${card}
      ${order.filter((g) => groups[g]).map((g) => `<h3>${g}</h3><ul class="city-list">${groups[g].map((l) => `<li data-id="${l.id}" class="${l.id === selected ? "on" : ""}">${l.name}<span>${l.ward}</span></li>`).join("")}</ul>`).join("")}
      <p class="city-credit">布局依考古实测与《长安志》《唐两京城坊考》示意复原，建筑为风格化表达。宅院与屋顶建模改写自 <a href="https://github.com/fanhuayishiy/ai-demo/tree/main/sanfang-qixiang-atlas" target="_blank" rel="noopener">三坊七巷 3D</a>（MIT）。</p>`;
    panel.querySelectorAll(".city-list li").forEach((li) => (li.onclick = () => selectPlace(li.dataset.id)));
  }

  // ---------- 动画 ----------
  const lastCam = new THREE.Matrix4();
  const sunDir = new THREE.Vector3(-0.55, 0.75, -0.38).normalize();
  let shadowSpan = 0;
  function animate(time) {
    if (!open) return;
    frame = requestAnimationFrame(animate);
    timer.update(time);
    const rawDt = timer.getDelta();
    const dt = Math.min(0.1, rawDt);
    if (flight) {
      const t = Math.min(1, (performance.now() - flight.start) / flight.duration);
      camera.position.lerpVectors(flight.fromPosition, flight.position, ease(t));
      controls.target.lerpVectors(flight.fromTarget, flight.target, ease(t));
      if (t >= 1) flight = null;
    }
    controls.update();
    const dist = camera.position.distanceTo(controls.target);
    if (tour.active && !tour.paused && !flight) {
      tour.elapsed += dt;
      if (tour.elapsed >= STOP_SECONDS) nextStop();
    }
    if (night !== nightTarget) {
      night = THREE.MathUtils.clamp(night + Math.sign(nightTarget - night) * Math.min(rawDt, 1) / 2.5, 0, 1);
      applyNight();
    }
    // 阴影跟着镜头：近处细、远处粗
    const span = THREE.MathUtils.clamp(dist * 0.9, 400, 9000);
    if (Math.abs(span - shadowSpan) / span > 0.08) {
      shadowSpan = span;
      const c = sun.shadow.camera;
      c.left = c.bottom = -span;
      c.right = c.top = span;
      c.near = 10;
      c.far = span * 4 + 2000;
      c.updateProjectionMatrix();
      // 阴影贴图每个像素覆盖的地面随范围变化，偏移量跟着调，避免远看时地面出现条纹
      sun.shadow.normalBias = (span / sun.shadow.mapSize.x) * 2.5;
    }
    // 远看全城时阴影几乎看不见，关掉以节省开销
    sun.castShadow = dist < 6500 && !lowQuality;
    watchFrameRate(rawDt);
    sun.target.position.copy(controls.target);
    sun.position.copy(controls.target).addScaledVector(sunDir, span * 2 + 800);
    if (!reduceMotion && waterMat?.normalMap) waterMat.normalMap.offset.x += dt * 0.02;
    // 雾与远裁剪面随镜头远近收放：拉近时远处的块被裁掉，省下大半绘制
    scene.fog.near = Math.min(9000, dist * 2.5);
    scene.fog.far = Math.min(32000, Math.max(dist * 7, 4500));
    if (Math.abs(camera.far - scene.fog.far * 1.05) > scene.fog.far * 0.1) {
      camera.far = scene.fog.far * 1.05;
      camera.updateProjectionMatrix();
    }
    stepPeople(dt, dist);
    const wantDetail = dist < 5000;
    if (wantDetail !== detailShown) {
      detailShown = wantDetail;
      for (const m of detailMeshes) m.visible = wantDetail;
    }
    renderer.render(scene, camera);
    if (labelsDirty || !lastCam.equals(camera.matrixWorld)) {
      lastCam.copy(camera.matrixWorld);
      labelsDirty = false;
      layoutLabels(dist);
    }
  }

  // 显卡吃力时自动降级：关掉阴影、降低像素比（URL 加 ?lowgfx 可直接使用低画质）
  let lowQuality = new URLSearchParams(location.search).has("lowgfx");
  const frameTimes = [];
  function watchFrameRate(dt) {
    if (lowQuality) return;
    frameTimes.push(dt);
    if (frameTimes.length < 6) return;
    if (frameTimes.length > 30) frameTimes.shift();
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    if (avg > 0.07) {
      lowQuality = true;
      renderer.setPixelRatio(1);
      resize();
      showToast("画面较卡，已自动关闭阴影以提升流畅度");
    }
  }

  // ---------- 键盘与按钮 ----------
  document.getElementById("city-back").onclick = () => close();
  document.getElementById("city-reset").onclick = () => { stopTour(); selected = null; renderPanel(); overview(1600); };
  document.getElementById("city-top").onclick = () => topDown();
  document.getElementById("city-night").onclick = () => setNight(nightTarget === 0);
  window.addEventListener("keydown", (e) => {
    if (!open || e.target.closest?.("input, textarea")) return;
    e.stopImmediatePropagation(); // 城池打开时，按键不再传给下面的大唐场景
    if (e.key === "Escape") {
      if (tour.active) stopTour();
      else if (selected) { selected = null; renderPanel(); labelsDirty = true; }
      else close();
    } else if (e.key === "n" || e.key === "N") setNight(nightTarget === 0);
  });

  // ---------- 打开 / 关闭 ----------
  let ready = null;
  async function prepare() {
    init();
    data = await (await fetch(`${DATA}changan.json`)).json();
    build();
    buildLabels();
    renderTourCard();
  }

  async function openCity() {
    screen.hidden = false;
    loading.hidden = false;
    requestAnimationFrame(() => screen.classList.add("shown"));
    await new Promise((r) => setTimeout(r, 40));
    ready ??= prepare();
    await ready;
    resize();
    selected = null;
    renderPanel();
    loading.hidden = true;
    open = true;
    night = nightTarget = 0;
    applyNight();
    document.getElementById("city-night").textContent = "☾ 夜";
    // 开场：从高空俯冲到城市全景
    const t = new THREE.Vector3(500, 0, -900);
    controls.target.copy(t);
    camera.position.copy(t.clone().add(new THREE.Vector3(0, 30000, 1)));
    camera.lookAt(t);
    controls.update();
    overview(2600);
    showToast("长安城 · 贞元十六年。右上角可开始空中漫游、切换昼夜");
    frame = requestAnimationFrame(animate);
  }

  function close() {
    if (!open) return;
    open = false;
    cancelAnimationFrame(frame);
    tour.active = false;
    tip.hidden = true;
    screen.classList.remove("shown");
    setTimeout(() => {
      if (!open) screen.hidden = true;
    }, 450);
    onExit?.();
  }

  return {
    open: openCity,
    close,
    get isOpen() {
      return open;
    },
  };
}
