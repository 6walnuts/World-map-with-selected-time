// 大唐场景的地表画法：从高程算出坡度、晕渲、沟谷与山脊，再按气候带和画风上色。
// 两种画风：
//   real   —— 写实：黄土、农田、江南青绿丘陵、西北草原荒漠、青藏高原、裸岩、雪顶，海面按深浅着色并带浪花
//   qinglv —— 青绿山水：绢本底色，山脚赭石、山腰石绿、山顶石青，沟谷以墨线勾勒，海面画鱼鳞水纹
// 另生成一张「物体空间法线贴图」，让立体光照按全分辨率高程计算，山脊沟谷更清楚。

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (c0, c1, t) => [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];

function hash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
const fbm = (x, y) => valueNoise(x / 24, y / 24) * 0.55 + valueNoise(x / 7, y / 7) * 0.3 + valueNoise(x / 2.5, y / 2.5) * 0.15;

// 盒式模糊（横竖各一遍，重复两次近似高斯）
function blur(src, W, H, r) {
  let a = Float32Array.from(src);
  const b = new Float32Array(src.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) {
      let sum = 0;
      const row = y * W;
      for (let x = -r; x <= r; x++) sum += a[row + clamp(x, 0, W - 1)];
      for (let x = 0; x < W; x++) {
        b[row + x] = sum / (2 * r + 1);
        sum += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += b[clamp(y, 0, H - 1) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = sum / (2 * r + 1);
        sum += b[Math.min(H - 1, y + r + 1) * W + x] - b[Math.max(0, y - r) * W + x];
      }
    }
  }
  return a;
}

// 地形分析：只做一次，两种画风共用
export function analyzeTerrain({ elev, W, H, lonOf, latOf, metersPerPx }) {
  const N = W * H;
  const land = new Float32Array(N);
  for (let i = 0; i < N; i++) land[i] = Math.max(0, elev[i]);
  const slope = new Float32Array(N);
  const hill = new Float32Array(N);
  // 光源：西北上方 45°
  const L = [-0.5, 0.7071, -0.5];
  for (let y = 0; y < H; y++) {
    const res = metersPerPx(y);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const dx = (land[i + (x < W - 1 ? 1 : 0)] - land[i - (x > 0 ? 1 : 0)]) / (2 * res);
      const dz = (land[i + (y < H - 1 ? W : 0)] - land[i - (y > 0 ? W : 0)]) / (2 * res);
      slope[i] = Math.hypot(dx, dz);
      const z = 2.2; // 晕渲的高程夸张
      const nx = -dx * z, nz = -dz * z;
      const len = Math.hypot(nx, 1, nz);
      hill[i] = Math.max(0, (nx * L[0] + L[1] + nz * L[2]) / len);
    }
  }
  const near = blur(land, W, H, 3);
  const far = blur(land, W, H, 22);
  const cavity = new Float32Array(N); // 正值为山脊，负值为沟谷
  const ridge = new Float32Array(N); // 相对周围大范围的高出程度
  for (let i = 0; i < N; i++) {
    cavity[i] = land[i] - near[i];
    ridge[i] = land[i] - far[i];
  }
  // 海面离岸距离（像素，最多 14），用于浅海与浪花
  const coast = new Uint8Array(N).fill(255);
  let frontier = [];
  for (let i = 0; i < N; i++) {
    if (elev[i] > 0) continue;
    const x = i % W, y = (i / W) | 0;
    if ((x > 0 && elev[i - 1] > 0) || (x < W - 1 && elev[i + 1] > 0) || (y > 0 && elev[i - W] > 0) || (y < H - 1 && elev[i + W] > 0)) {
      coast[i] = 1;
      frontier.push(i);
    }
  }
  for (let d = 2; d <= 14 && frontier.length; d++) {
    const next = [];
    for (const i of frontier) {
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= N || elev[j] > 0 || coast[j] !== 255) continue;
        coast[j] = d;
        next.push(j);
      }
    }
    frontier = next;
  }
  const lon = new Float32Array(W), lat = new Float32Array(H);
  for (let x = 0; x < W; x++) lon[x] = lonOf(x);
  for (let y = 0; y < H; y++) lat[y] = latOf(y);
  return { W, H, elev, slope, hill, cavity, ridge, coast, lon, lat };
}

const C = {
  paddy: [124, 154, 92], farm: [178, 176, 116], steppe: [188, 176, 122], desert: [216, 198, 150],
  loess: [206, 172, 112], forestN: [92, 120, 76], forestS: [70, 116, 72], alpine: [156, 146, 104],
  alpineDry: [172, 152, 110], rock: [126, 116, 104], snow: [244, 245, 247],
  shelf: [120, 176, 176], sea: [62, 124, 144], deep: [32, 72, 100], foam: [224, 234, 224],
  silk: [232, 216, 178], ochre: [184, 108, 56], green: [64, 150, 98], blue: [28, 98, 140], ink: [78, 62, 46],
  silkSea: [182, 202, 186], silkSeaDeep: [150, 182, 176],
};

export function paintTerrainArt(A, style) {
  const { W, H, elev, slope, hill, cavity, ridge, coast, lon, lat } = A;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  const img = g.createImageData(W, H);
  const d = img.data;
  const flatHill = 0.7071;
  for (let y = 0; y < H; y++) {
    const la = lat[y];
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const e = elev[i];
      const lo = lon[x];
      const n = fbm(x, y);
      let col;
      if (e <= 0) {
        if (style === "qinglv") {
          col = mix(C.silkSea, C.silkSeaDeep, smooth(0, 14, coast[i]));
          // 鱼鳞水纹：错位排列的小弧线
          const cw = 9, ch = 5;
          const row = Math.floor(y / ch);
          const u = ((x + (row % 2) * cw * 0.5) % cw) / cw - 0.5;
          const v = (y % ch) / ch;
          const arc = Math.abs(Math.hypot(u * 1.6, v - 1.05) - 0.62);
          if (arc < 0.07) col = mix(col, [104, 140, 140], 0.55);
        } else {
          const depth = -e;
          col = mix(C.shelf, C.sea, smooth(0, 220, depth));
          col = mix(col, C.deep, smooth(250, 3200, depth));
          if (coast[i] <= 3) col = mix(col, C.foam, 0.5 * (1 - (coast[i] - 1) / 3));
          col = col.map((c) => c * (0.97 + 0.06 * n));
        }
      } else if (style === "qinglv") {
        // 山体：按相对高低从赭石过渡到石绿、石青
        const mountain = smooth(150, 1100, e) * (0.6 + 0.4 * smooth(0.03, 0.2, slope[i]));
        const r = clamp(0.42 + ridge[i] / 550 + smooth(1500, 4000, e) * 0.25);
        let mc = r < 0.5 ? mix(C.ochre, C.green, smooth(0.15, 0.5, r)) : mix(C.green, C.blue, smooth(0.5, 0.85, r));
        mc = mix(mc, C.ochre, smooth(400, 0, e) * 0.5);
        col = mix(C.silk, mc, mountain);
        // 沟谷墨线与山脊留白
        const cv = cavity[i];
        if (cv < -30) col = mix(col, C.ink, smooth(-30, -160, cv) * 0.4 * mountain);
        if (cv > 30) col = mix(col, [240, 232, 210], smooth(30, 160, cv) * 0.35 * mountain);
        const shade = 0.86 + (hill[i] - flatHill) * 0.55;
        col = col.map((c) => c * shade);
        // 绢纹：细的横向纤维 + 斑驳
        const fiber = hash(0, y * 3 + Math.floor(x / 40)) * 0.05;
        col = col.map((c) => c * (0.95 + 0.08 * n - fiber));
      } else {
        // 写实：按气候带混合
        let arid = clamp(0.6 * (la - 33) / 7 + 0.8 * (107 - lo) / 9);
        arid = clamp(arid - clamp((lo - 118) / 6) * clamp((la - 39) / 4) * 0.7);
        const south = smooth(35, 28.5, la);
        let c0 = mix(C.farm, C.paddy, south);
        c0 = mix(c0, C.steppe, smooth(0.35, 0.7, arid));
        c0 = mix(c0, C.desert, smooth(0.72, 1, arid) * smooth(1800, 600, e + 0 * arid));
        // 黄土高原
        const loessW = smooth(103, 105, lo) * smooth(114, 112, lo) * smooth(33.8, 34.8, la) * smooth(39.5, 38, la) * smooth(500, 900, e) * smooth(2400, 1800, e);
        c0 = mix(c0, C.loess, loessW * 0.85);
        // 山地森林：坡上更绿
        const forestW = smooth(300, 1200, e) * (1 - arid) * smooth(0.02, 0.15, slope[i]) * smooth(3600, 2600, e);
        c0 = mix(c0, mix(C.forestN, C.forestS, south), forestW * 0.8);
        // 高原
        const plat = smooth(2800, 3800, e);
        c0 = mix(c0, mix(C.alpine, C.alpineDry, arid), plat);
        // 裸岩与雪顶
        c0 = mix(c0, C.rock, smooth(0.35, 0.9, slope[i]) * smooth(1500, 3500, e) * 0.75);
        const snowline = 5300 - Math.max(0, la - 28) * 95;
        c0 = mix(c0, C.snow, smooth(snowline - 250, snowline + 350, e) * (1 - smooth(0.7, 1.3, slope[i]) * 0.5));
        const cv = clamp(cavity[i] / 220, -1, 1);
        const shade = (1 + (hill[i] - flatHill) * 0.45) * (1 + cv * 0.14);
        col = c0.map((c) => c * shade * (0.93 + 0.12 * n));
      }
      const o = i * 4;
      d[o] = clamp(col[0], 0, 255);
      d[o + 1] = clamp(col[1], 0, 255);
      d[o + 2] = clamp(col[2], 0, 255);
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

// 物体空间法线贴图：hy 为世界坐标下的高度，U 为每像素的世界单位
export function buildNormalCanvas(hy, elev, W, H, U) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  const img = g.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let nx = 0, ny = 1, nz = 0;
      if (elev[i] > 0) {
        const h = (j) => Math.max(0, hy[j]);
        const dx = (h(i + (x < W - 1 ? 1 : 0)) - h(i - (x > 0 ? 1 : 0))) / (2 * U);
        const dz = (h(i + (y < H - 1 ? W : 0)) - h(i - (y > 0 ? W : 0))) / (2 * U);
        const len = Math.hypot(dx, 1, dz);
        nx = -dx / len;
        ny = 1 / len;
        nz = -dz / len;
      }
      const o = i * 4;
      d[o] = (nx * 0.5 + 0.5) * 255;
      d[o + 1] = (ny * 0.5 + 0.5) * 255;
      d[o + 2] = (nz * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}
