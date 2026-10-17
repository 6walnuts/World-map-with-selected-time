// 大唐地图上的流动效果，画在地图上方的一张透明画布上（经纬度 → 屏幕，每帧重画）：
//   河流顺流光点、运河漕船、季风流线（夏季风 / 冬季风）、海上丝路番舶、飘云与云影。
// 风场为气候学示意，不是某一年的真实气象数据。

const smooth = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
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
export function monsoon(lon, lat, mode, t) {
  let u = 0, v = 0;
  const add = (w, du, dv) => { u += w * du; v += w * dv; };
  if (mode === "summer") {
    add(smooth(27, 21, lat), 1.0, 0.65); // 南海、北部湾：西南季风
    add(smooth(21, 25, lat) * smooth(35, 31, lat) * smooth(104, 108, lon), 0.35, 1.0); // 华南、江南：偏南风
    add(smooth(31, 34, lat) * smooth(43, 40, lat) * smooth(108, 112, lon), -0.45, 0.9); // 华北：东南风
    add(smooth(106, 101, lon) * smooth(25, 29, lat), 0.5, 0.35); // 西部内陆：微弱
    add(smooth(41, 45, lat), 1.0, 0.15); // 塞北：西风
  } else {
    add(smooth(33, 38, lat), 0.8, -0.95); // 北方：西北季风
    add(smooth(36, 31, lat) * smooth(104, 108, lon), -0.55, -0.85); // 华中华南：偏北风
    add(smooth(28, 23, lat) * smooth(108, 112, lon), -0.85, -0.6); // 东南沿海与南海：东北季风
    add(smooth(105, 100, lon) * smooth(27, 30, lat) * smooth(39, 35, lat), 1.25, 0.05); // 高原：西风
  }
  const a = (noise(lon * 0.35 + t * 0.05, lat * 0.35) - 0.5) * 1.1;
  const c = Math.cos(a), s = Math.sin(a);
  return [u * c - v * s, u * s + v * c];
}

const SEA_ROUTES = [
  [[109.6, 16.2], [110.9, 19.4], [112.2, 21.4], [113.6, 22.3], [113.3, 23.05]],
  [[113.6, 22.3], [116.8, 22.9], [118.7, 24.6], [120.2, 26.6], [121.9, 29.5], [121.8, 31.4], [120.6, 32.1], [119.4, 32.35]],
  [[121.9, 29.9], [123.6, 30.6], [125.9, 31.3]],
  [[120.75, 37.8], [122.6, 37.6], [124.6, 37.4], [125.95, 37.3]],
];
export const SEA_ROUTE_LINES = SEA_ROUTES;
// 运河行船方向：1 沿坐标顺序，-1 反向（漕粮自江南北运）
const CANAL_DIR = { 通济渠: -1, 邗沟: 1, 江南河: -1, 永济渠: 1 };
const MAJOR = new Set(["长江", "黄河", "金沙江", "通天河"]);

export function createFx({ map, canvas, geo, elevAt, bounds, reduceMotion }) {
  const ctx = canvas.getContext("2d");
  const inB = (lon, lat) => lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;

  // 经纬度折线：加密 + 累计长度（按公里近似）
  const polyline = (coords, step = 0.03) => {
    const pts = [];
    for (let k = 0; k < coords.length; k++) {
      const p = coords[k];
      if (k) {
        const q = pts.at(-1);
        const n = Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) / step);
        for (let t = 1; t < n; t++) pts.push([q[0] + ((p[0] - q[0]) * t) / n, q[1] + ((p[1] - q[1]) * t) / n]);
      }
      pts.push(p);
    }
    const cum = [0];
    for (let k = 1; k < pts.length; k++) {
      const c = Math.cos((pts[k][1] * Math.PI) / 180);
      cum.push(cum[k - 1] + Math.hypot((pts[k][0] - pts[k - 1][0]) * c, pts[k][1] - pts[k - 1][1]) * 111.3);
    }
    return { pts, cum, len: cum.at(-1) };
  };
  const pointAt = (pl, s, hint = 0) => {
    let k = hint;
    if (k >= pl.cum.length - 1 || pl.cum[k] > s) k = 0;
    while (k < pl.cum.length - 2 && pl.cum[k + 1] < s) k++;
    const t = (s - pl.cum[k]) / (pl.cum[k + 1] - pl.cum[k] || 1);
    const a = pl.pts[k], b = pl.pts[k + 1];
    return { lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, k, dlon: b[0] - a[0], dlat: b[1] - a[1] };
  };

  // ---------- 河流 ----------
  const rivers = [];
  for (const f of geo.rivers.features) {
    const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const c of parts) {
      // 只保留地图范围内的连续河段
      let cur = [];
      const flush = () => {
        if (cur.length > 1) {
          const pl = polyline(cur);
          // 下游 = 高程低的一端
          if (elevAt(...pl.pts[0]) < elevAt(...pl.pts.at(-1))) {
            pl.pts.reverse();
            const L = pl.len;
            pl.cum = pl.cum.map((d) => L - d).reverse();
          }
          if (pl.len > 20) rivers.push({ pl, major: MAJOR.has(f.properties.name), huang: f.properties.name === "黄河" });
        }
        cur = [];
      };
      for (const p of c) (inB(p[0], p[1]) ? cur.push(p) : flush());
      flush();
    }
  }
  const drops = [];
  for (const [ri, r] of rivers.entries()) {
    const n = Math.max(1, Math.round(r.pl.len / (r.major ? 22 : 38)));
    for (let k = 0; k < n; k++) drops.push({ ri, s: (k / n) * r.pl.len, speed: (r.major ? 26 : 17) * (0.8 + Math.random() * 0.4), k: 0 });
  }

  // ---------- 漕船与番舶 ----------
  const canals = geo.canals.map((c) => ({ pl: polyline(c.coords, 0.02), dir: CANAL_DIR[c.name] ?? 1 }));
  const barges = [];
  canals.forEach((c, ci) => {
    const n = Math.max(3, Math.round(c.pl.len / 60));
    for (let k = 0; k < n; k++) barges.push({ ci, s: (k / n) * c.pl.len, speed: 9 + Math.random() * 3, k: 0 });
  });
  const routes = SEA_ROUTES.map((r) => polyline(r, 0.05));
  const ships = [];
  routes.forEach((pl, ri) => {
    const n = Math.max(2, Math.round(pl.len / 170));
    for (let k = 0; k < n; k++) ships.push({ ri, s: (k / n) * pl.len, speed: 22 + Math.random() * 8, k: 0, back: k % 2 === 1 });
  });

  // ---------- 季风 ----------
  let windMode = "off";
  let windTime = 0;
  const WIND_N = 3800;
  const wind = Array.from({ length: WIND_N }, () => ({ lon: 0, lat: 0, age: 0, max: 0, u: 0, v: 0 }));
  const respawn = (p) => {
    p.lon = bounds.west + Math.random() * (bounds.east - bounds.west);
    p.lat = bounds.south + Math.random() * (bounds.north - bounds.south);
    p.age = 0;
    p.max = 2.5 + Math.random() * 3.5;
  };
  for (const p of wind) { respawn(p); p.age = Math.random() * p.max; }

  // ---------- 云 ----------
  const sprites = [1, 2, 3, 4].map((seed) => {
    let s = seed * 9301;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const c = document.createElement("canvas");
    c.width = 360;
    c.height = 180;
    const g = c.getContext("2d");
    for (let i = 0; i < 26; i++) {
      const x = 360 * (0.18 + rnd() * 0.64), y = 180 * (0.32 + rnd() * 0.38), r = 24 + rnd() * 52;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(255,253,246,0.55)");
      grad.addColorStop(1, "rgba(255,253,246,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  });
  const clouds = Array.from({ length: 14 }, (_, i) => ({
    lon: bounds.west + Math.random() * (bounds.east - bounds.west),
    lat: bounds.south + 2 + Math.random() * (bounds.north - bounds.south - 4),
    km: 260 + Math.random() * 380,
    speed: 0.05 + Math.random() * 0.06, // 度/秒
    sprite: sprites[i % 4],
  }));
  let showClouds = true;

  // ---------- 绘制 ----------
  let w = 0, h = 0, dpr = 1;
  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const onScreen = (p, m = 30) => p.x > -m && p.x < w + m && p.y > -m && p.y < h + m;

  function drawBoat(p, angle, size, sail = "#f3e7c8") {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(angle);
    ctx.fillStyle = "#4a3020";
    ctx.beginPath();
    ctx.moveTo(-size, -size * 0.3);
    ctx.lineTo(size * 1.1, 0);
    ctx.lineTo(-size, size * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = sail;
    ctx.fillRect(-size * 0.25, -size * 0.75, size * 0.35, size * 1.5);
    ctx.restore();
  }

  function frame(dt) {
    if (!w) resize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const zoom = map.getZoom();
    const move = reduceMotion ? 0 : dt;

    // 云影与云（远看时出现，拉近渐隐）
    const cloudFade = showClouds ? 1 - smooth(5.6, 6.6, zoom) : 0;
    if (cloudFade > 0.01) {
      const pxPerKm = (512 * 2 ** zoom) / 40075;
      for (const c of clouds) {
        c.lon += c.speed * move;
        if (c.lon > bounds.east + 6) c.lon = bounds.west - 6;
        const p = map.project([c.lon, c.lat]);
        const cw = c.km * pxPerKm, ch = cw / 2;
        if (!onScreen(p, cw)) continue;
        const edge = smooth(bounds.west - 4, bounds.west + 2, c.lon) * smooth(bounds.east + 4, bounds.east - 2, c.lon);
        ctx.globalAlpha = 0.22 * cloudFade * edge;
        ctx.filter = "brightness(0.15)";
        ctx.drawImage(c.sprite, p.x - cw / 2 + cw * 0.08, p.y - ch / 2 + ch * 0.35, cw, ch);
        ctx.filter = "none";
        ctx.globalAlpha = 0.7 * cloudFade * edge;
        ctx.drawImage(c.sprite, p.x - cw / 2, p.y - ch / 2 - ch * 0.4, cw, ch);
      }
      ctx.globalAlpha = 1;
    }

    // 河流光点
    const dotR = Math.max(1.1, Math.min(3.2, 0.5 + (zoom - 3.5) * 0.45));
    ctx.globalCompositeOperation = "lighter";
    for (const d of drops) {
      const r = rivers[d.ri];
      d.s += d.speed * move;
      if (d.s > r.pl.len) { d.s -= r.pl.len; d.k = 0; }
      const q = pointAt(r.pl, d.s, d.k);
      d.k = q.k;
      const p = map.project([q.lon, q.lat]);
      if (!onScreen(p, 4)) continue;
      const fade = smooth(0, 15, d.s) * smooth(r.pl.len, r.pl.len - 15, d.s);
      ctx.globalAlpha = 0.85 * fade;
      ctx.fillStyle = r.huang ? "#ffe0a0" : "#d6f3ff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, r.major ? dotR : dotR * 0.75, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    // 季风流线
    if (windMode !== "off") {
      windTime += move;
      ctx.lineWidth = 1.1;
      ctx.lineCap = "round";
      ctx.strokeStyle = windMode === "summer" ? "#fff8ea" : "#eef4ff";
      for (const p of wind) {
        p.age += dt;
        if (p.age > p.max || !inB(p.lon, p.lat)) respawn(p);
        const [u, v] = monsoon(p.lon, p.lat, windMode, windTime);
        const block = 1 / (1 + Math.max(0, elevAt(p.lon, p.lat)) / 2500); // 高山挡风
        p.u += (u * block - p.u) * 0.2;
        p.v += (v * block - p.v) * 0.2;
        p.lon += p.u * 0.9 * move;
        p.lat += p.v * 0.9 * move;
        const head = map.project([p.lon, p.lat]);
        if (!onScreen(head, 10)) continue;
        const tail = map.project([p.lon - p.u * 0.8, p.lat - p.v * 0.8]);
        ctx.globalAlpha = smooth(0, 0.7, p.age) * smooth(p.max, p.max - 0.7, p.age) * 0.75;
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);
        ctx.lineTo(head.x, head.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 漕船与番舶
    const boat = Math.max(3, Math.min(9, (zoom - 3) * 1.6));
    for (const b of barges) {
      const c = canals[b.ci];
      b.s += b.speed * move;
      if (b.s > c.pl.len) { b.s -= c.pl.len; b.k = 0; }
      const s = c.dir > 0 ? b.s : c.pl.len - b.s;
      const q = pointAt(c.pl, s, c.dir > 0 ? b.k : 0);
      if (c.dir > 0) b.k = q.k;
      const p = map.project([q.lon, q.lat]);
      if (!onScreen(p)) continue;
      const p2 = map.project([q.lon + q.dlon * c.dir, q.lat + q.dlat * c.dir]);
      drawBoat(p, Math.atan2(p2.y - p.y, p2.x - p.x), boat * 0.8);
    }
    for (const sh of ships) {
      const pl = routes[sh.ri];
      const dir = windMode === "summer" ? -1 : windMode === "winter" ? 1 : sh.back ? -1 : 1;
      sh.s += sh.speed * (windMode === "off" ? 0.7 : 1.2) * move;
      if (sh.s > pl.len) { sh.s -= pl.len; sh.k = 0; }
      // 航线坐标自南向北；夏季风时北来（沿坐标顺序），冬季风时南归（反向）
      const s = dir < 0 ? sh.s : pl.len - sh.s;
      const q = pointAt(pl, s, dir < 0 ? sh.k : 0);
      if (dir < 0) sh.k = q.k;
      const p = map.project([q.lon, q.lat]);
      if (!onScreen(p)) continue;
      const sgn = dir < 0 ? 1 : -1;
      const p2 = map.project([q.lon + q.dlon * sgn, q.lat + q.dlat * sgn]);
      drawBoat(p, Math.atan2(p2.y - p.y, p2.x - p.x), boat * 1.2, "#e9d7a8");
    }
  }

  return {
    resize,
    frame,
    setWind(mode) {
      windMode = mode;
    },
    get windMode() {
      return windMode;
    },
    setClouds(on) {
      showClouds = on;
    },
  };
}
