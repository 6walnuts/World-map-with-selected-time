// 大唐场景的流动效果：
//   1. 河流流动 —— 河道上一串串亮点顺流而下（按两端高程判断下游），黄河偏暖黄，其余青白
//   2. 漕运 —— 运河上的漕船：通济渠、邗沟、江南河上北运江淮漕粮，永济渠北运河北军需
//   3. 季风风场 —— 夏季风（东南季风、西南季风）与冬季风（西北季风、东北季风）的示意流线
//   4. 海上丝路 —— 广州、泉州、明州、扬州的航线与番舶：夏季乘西南季风北来，冬季乘东北季风南下
// 风场为气候学上的示意，不是某一年的真实气象数据。
import * as THREE from "three";

const smooth = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
function hash(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

// 季风示意：返回 [东向, 北向] 分量
function monsoon(lon, lat, mode, t) {
  let u = 0, v = 0;
  const add = (w, du, dv) => { u += w * du; v += w * dv; };
  if (mode === "summer") {
    add(smooth(27, 21, lat), 1.0, 0.65); // 南海、北部湾：西南季风
    add(smooth(21, 25, lat) * smooth(35, 31, lat) * smooth(104, 108, lon), 0.35, 1.0); // 华南、江南：偏南风
    add(smooth(31, 34, lat) * smooth(43, 40, lat) * smooth(108, 112, lon), -0.45, 0.9); // 华北：东南风
    add(smooth(106, 101, lon) * smooth(25, 29, lat), 0.5, 0.35); // 西部内陆：微弱
    add(smooth(41, 45, lat), 1.0, 0.15); // 塞北：西风
  } else {
    add(smooth(33, 38, lat), 0.8, -0.95); // 北方：西北季风（寒潮南下）
    add(smooth(36, 31, lat) * smooth(104, 108, lon), -0.55, -0.85); // 华中华南：偏北风
    add(smooth(28, 23, lat) * smooth(108, 112, lon), -0.85, -0.6); // 东南沿海与南海：东北季风
    add(smooth(105, 100, lon) * smooth(27, 30, lat) * smooth(39, 35, lat), 1.25, 0.05); // 高原：西风
  }
  // 加一点随时间缓慢变化的扰动，流线才显得自然
  const a = (noise(lon * 0.35 + t * 0.05, lat * 0.35) - 0.5) * 1.1;
  const c = Math.cos(a), s = Math.sin(a);
  return [u * c - v * s, u * s + v * c];
}

const SEA_ROUTES = [
  { name: "南海航路", coords: [[109.6, 16.2], [110.9, 19.4], [112.2, 21.4], [113.6, 22.3], [113.3, 23.05]] },
  { name: "广州—泉州—明州—扬州", coords: [[113.6, 22.3], [116.8, 22.9], [118.7, 24.6], [120.2, 26.6], [121.9, 29.5], [121.8, 31.4], [120.6, 32.1], [119.4, 32.35]] },
  { name: "明州—日本", coords: [[121.9, 29.9], [123.6, 30.6], [125.9, 31.3]] },
  { name: "登州—新罗", coords: [[120.75, 37.8], [122.6, 37.6], [124.6, 37.4], [125.95, 37.3]] },
];

// 运河：dir = 1 表示沿坐标顺序行船，-1 表示反向（漕粮自江南北运）
const CANAL_DIR = { 通济渠: -1, 邗沟: 1, 江南河: -1, 永济渠: 1 };

export function createFlows({ scene, geo, toWorld, fromWorld, heightAt, inside, reduceMotion }) {
  const group = new THREE.Group();
  scene.add(group);

  // 折线 → 世界坐标点列 + 累计长度
  const polyline = (coords, step = 0.6) => {
    const pts = [];
    for (let k = 0; k < coords.length; k++) {
      const p = toWorld(coords[k][0], coords[k][1]);
      if (k) {
        const q = pts.at(-1);
        const n = Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) / step);
        for (let t = 1; t < n; t++) pts.push([q[0] + ((p[0] - q[0]) * t) / n, q[1] + ((p[1] - q[1]) * t) / n]);
      }
      pts.push(p);
    }
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    return { pts, cum, len: cum.at(-1) };
  };
  const pointAt = (pl, s, hint) => {
    let k = hint ?? 0;
    if (k >= pl.cum.length - 1 || pl.cum[k] > s) k = 0;
    while (k < pl.cum.length - 2 && pl.cum[k + 1] < s) k++;
    const t = (s - pl.cum[k]) / (pl.cum[k + 1] - pl.cum[k] || 1);
    const a = pl.pts[k], b = pl.pts[k + 1];
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, k, dx: b[0] - a[0], dz: b[1] - a[1] };
  };

  // ---------- 1. 河流流动 ----------
  const lines = [];
  for (const f of geo.rivers.features) {
    const major = ["长江", "黄河", "金沙江", "通天河"].includes(f.properties.name);
    const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
    // 地图范围外的河段（如黑水、粟末水的北段）切掉，只保留范围内的连续段
    const segs = [];
    for (const c of parts) {
      let cur = [];
      for (const pt of c) {
        const [x, z] = toWorld(pt[0], pt[1]);
        if (inside(x, z)) cur.push(pt);
        else if (cur.length) { segs.push(cur); cur = []; }
      }
      if (cur.length > 1) segs.push(cur);
    }
    for (const c of segs) {
      const pl = polyline(c);
      if (pl.len < 2) continue;
      // 下游：高程低的一端
      const h0 = heightAt(...pl.pts[0]), h1 = heightAt(...pl.pts.at(-1));
      if (h0 < h1) {
        pl.pts.reverse();
        const L = pl.len;
        pl.cum = pl.cum.map((d) => L - d).reverse();
      }
      lines.push({ pl, major, huang: f.properties.name === "黄河" });
    }
  }
  const particles = [];
  for (const [li, l] of lines.entries()) {
    const n = Math.max(1, Math.round(l.pl.len / (l.major ? 4 : 7)));
    for (let k = 0; k < n; k++) particles.push({ li, s: (k / n) * l.pl.len + Math.random() * 2, speed: (l.major ? 3.2 : 2.2) * (0.8 + Math.random() * 0.4), k: 0 });
  }
  const P = particles.length;
  const pPos = new Float32Array(P * 3), pCol = new Float32Array(P * 4), pSize = new Float32Array(P);
  const warm = new THREE.Color("#ffe2a0"), cool = new THREE.Color("#d8f4ff");
  particles.forEach((p, i) => {
    const l = lines[p.li];
    const c = l.huang ? warm : cool;
    pCol.set([c.r, c.g, c.b, 1], i * 4);
    pSize[i] = l.major ? 0.75 : 0.5;
  });
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 4));
  pGeo.setAttribute("size", new THREE.BufferAttribute(pSize, 1));
  const pMat = new THREE.ShaderMaterial({
    uniforms: { scale: { value: 800 } },
    vertexShader: `attribute float size; attribute vec4 color; uniform float scale; varying vec4 vColor;
      void main() { vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(size * scale / -mv.z, 1.6, 7.0); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec4 vColor;
      void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor.rgb, vColor.a * a * 0.9); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const riverPoints = new THREE.Points(pGeo, pMat);
  riverPoints.frustumCulled = false;
  riverPoints.renderOrder = 6;
  group.add(riverPoints);

  function stepRivers(dt) {
    for (let i = 0; i < P; i++) {
      const p = particles[i];
      const l = lines[p.li];
      if (!reduceMotion) p.s += p.speed * dt;
      if (p.s > l.pl.len) { p.s -= l.pl.len; p.k = 0; }
      const q = pointAt(l.pl, p.s, p.k);
      p.k = q.k;
      pPos[i * 3] = q.x;
      pPos[i * 3 + 1] = Math.max(0.02, heightAt(q.x, q.z)) + 0.28;
      pPos[i * 3 + 2] = q.z;
      pCol[i * 4 + 3] = smooth(0, 3, p.s) * smooth(l.pl.len, l.pl.len - 3, p.s);
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  // ---------- 船（漕船与番舶共用一个造型） ----------
  function boatGeometry() {
    const parts = [];
    const paint = (g, hex) => {
      const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) c.toArray(a, i * 3);
      g.setAttribute("color", new THREE.BufferAttribute(a, 3));
      g.deleteAttribute("uv");
      return g.index ? g.toNonIndexed() : g;
    };
    const hull = new THREE.BoxGeometry(0.22, 0.1, 0.7);
    hull.translate(0, 0.05, 0);
    parts.push(paint(hull, "#5a3b22"));
    const sail = new THREE.BoxGeometry(0.02, 0.42, 0.34);
    sail.translate(0, 0.32, 0.02);
    parts.push(paint(sail, "#efe2c2"));
    const out = new THREE.BufferGeometry();
    const merged = { position: [], normal: [], color: [] };
    for (const g of parts) for (const k of Object.keys(merged)) merged[k].push(...g.attributes[k].array);
    for (const k of Object.keys(merged)) out.setAttribute(k, new THREE.Float32BufferAttribute(merged[k], 3));
    return out;
  }
  const boatGeo = boatGeometry();
  const boatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });

  // 漕船
  const canals = geo.canals.map((c) => ({ pl: polyline(c.coords, 0.5), dir: CANAL_DIR[c.name] ?? 1 }));
  const barges = [];
  canals.forEach((c, ci) => {
    const n = Math.max(3, Math.round(c.pl.len / 9));
    for (let k = 0; k < n; k++) barges.push({ ci, s: (k / n) * c.pl.len, speed: 1.1 + Math.random() * 0.4, k: 0 });
  });
  const bargeMesh = new THREE.InstancedMesh(boatGeo, boatMat, barges.length);
  bargeMesh.frustumCulled = false;
  group.add(bargeMesh);

  // 番舶
  const routes = SEA_ROUTES.map((r) => ({ ...r, pl: polyline(r.coords, 0.8) }));
  const routeLine = new THREE.Group();
  for (const r of routes) {
    const g = new THREE.BufferGeometry().setFromPoints(r.pl.pts.map(([x, z]) => new THREE.Vector3(x, 0.08, z)));
    const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: "#f3e3b5", dashSize: 2.2, gapSize: 1.6, transparent: true, opacity: 0.7 }));
    line.computeLineDistances();
    routeLine.add(line);
  }
  group.add(routeLine);
  const ships = [];
  routes.forEach((r, ri) => {
    const n = Math.max(2, Math.round(r.pl.len / 26));
    for (let k = 0; k < n; k++) ships.push({ ri, s: (k / n) * r.pl.len, speed: 3 + Math.random(), k: 0, back: k % 2 === 1 });
  });
  const shipMesh = new THREE.InstancedMesh(boatGeo, boatMat, ships.length);
  shipMesh.frustumCulled = false;
  group.add(shipMesh);

  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  function placeBoat(mesh, i, pl, s, hint, dir, scale, onWater) {
    const q = pointAt(pl, s, hint);
    const y = onWater ? 0.05 : Math.max(0.02, heightAt(q.x, q.z)) + 0.08;
    v3.set(q.x, y, q.z);
    q4.setFromAxisAngle(up, Math.atan2(q.dx * dir, q.dz * dir));
    s3.setScalar(scale);
    m4.compose(v3, q4, s3);
    mesh.setMatrixAt(i, m4);
    return q.k;
  }

  let windMode = "off";
  function stepBoats(dt, dist) {
    const scale = Math.min(8, Math.max(2.2, dist / 35)); // 远看时放大，免得看不见
    barges.forEach((b, i) => {
      const c = canals[b.ci];
      if (!reduceMotion) b.s += b.speed * dt;
      if (b.s > c.pl.len) { b.s -= c.pl.len; b.k = 0; }
      const s = c.dir > 0 ? b.s : c.pl.len - b.s;
      b.k = placeBoat(bargeMesh, i, c.pl, s, c.dir > 0 ? b.k : 0, c.dir, scale * 0.8, false);
    });
    bargeMesh.instanceMatrix.needsUpdate = true;
    ships.forEach((sh, i) => {
      const r = routes[sh.ri];
      // 夏季乘西南季风北上（沿航线正向），冬季乘东北季风南下（反向）；无风时双向往来
      const dir = windMode === "summer" ? 1 : windMode === "winter" ? -1 : sh.back ? -1 : 1;
      if (!reduceMotion) sh.s += sh.speed * (windMode === "off" ? 0.7 : 1.2) * dt;
      if (sh.s > r.pl.len) { sh.s -= r.pl.len; sh.k = 0; }
      const s = dir > 0 ? sh.s : r.pl.len - sh.s;
      sh.k = placeBoat(shipMesh, i, r.pl, s, dir > 0 ? sh.k : 0, dir, scale * 1.5, true);
    });
    shipMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------- 季风风场 ----------
  const W = 6500;
  const wPos = new Float32Array(W * 6), wCol = new Float32Array(W * 8);
  const wind = Array.from({ length: W }, () => ({ x: 0, z: 0, age: 0, max: 0, vx: 0, vz: 0 }));
  const wGeo = new THREE.BufferGeometry();
  wGeo.setAttribute("position", new THREE.BufferAttribute(wPos, 3));
  wGeo.setAttribute("color", new THREE.BufferAttribute(wCol, 4));
  const wMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  const windLines = new THREE.LineSegments(wGeo, wMat);
  windLines.frustumCulled = false;
  windLines.visible = false;
  windLines.renderOrder = 7;
  group.add(windLines);
  let bounds = { w: 1000, d: 1000 };
  const respawn = (p) => {
    p.x = Math.random() * bounds.w;
    p.z = Math.random() * bounds.d;
    p.age = 0;
    p.max = 3 + Math.random() * 4;
  };
  let windTime = 0;
  const windColor = { summer: new THREE.Color("#fffaf0"), winter: new THREE.Color("#f2f7ff") };
  function stepWind(dt) {
    windTime += dt;
    const col = windColor[windMode];
    for (let i = 0; i < W; i++) {
      const p = wind[i];
      p.age += dt;
      if (p.age > p.max || !inside(p.x, p.z)) respawn(p);
      const [lon, lat] = fromWorld(p.x, p.z);
      const [u, v] = monsoon(lon, lat, windMode, windTime);
      const block = 1 / (1 + Math.max(0, heightAt(p.x, p.z)) / 6); // 高山挡风
      const sp = 9 * block;
      p.vx = lerp(p.vx, u * sp, 0.2);
      p.vz = lerp(p.vz, -v * sp, 0.2);
      if (!reduceMotion) {
        p.x += p.vx * dt;
        p.z += p.vz * dt;
      }
      const y = Math.max(0, heightAt(p.x, p.z)) + 1.2;
      const o = i * 6;
      wPos[o] = p.x - p.vx * 1.3; wPos[o + 1] = y; wPos[o + 2] = p.z - p.vz * 1.3;
      wPos[o + 3] = p.x; wPos[o + 4] = y; wPos[o + 5] = p.z;
      const fade = smooth(0, 0.8, p.age) * smooth(p.max, p.max - 0.8, p.age) * 0.9;
      const c = i * 8;
      wCol[c] = col.r; wCol[c + 1] = col.g; wCol[c + 2] = col.b; wCol[c + 3] = 0;
      wCol[c + 4] = col.r; wCol[c + 5] = col.g; wCol[c + 6] = col.b; wCol[c + 7] = fade;
    }
    wGeo.attributes.position.needsUpdate = true;
    wGeo.attributes.color.needsUpdate = true;
  }

  return {
    setBounds(w, d) {
      bounds = { w, d };
      for (const p of wind) { respawn(p); p.age = Math.random() * p.max; }
    },
    setWind(mode) {
      windMode = mode;
      windLines.visible = mode !== "off";
    },
    get windMode() {
      return windMode;
    },
    update(dt, dist, viewportHeight, fov) {
      pMat.uniforms.scale.value = viewportHeight / (2 * Math.tan((fov * Math.PI) / 360));
      stepRivers(dt);
      stepBoats(dt, dist);
      if (windMode !== "off") stepWind(dt);
    },
  };
}
