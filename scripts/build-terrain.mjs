// 生成中国视图用的地形底图（晕渲 + 分层设色），输出 public/data/terrain_china.png 与 .json。
// 用法：node scripts/build-terrain.mjs
//
// 高程来源：AWS Open Data 上的 Terrarium 高程瓦片（Mapzen / Tilezen，汇编自 SRTM、GMTED2010、
// ETOPO1 等公开数据）。瓦片是 Web 墨卡托投影，与地图用的 d3.geoMercator 一致，
// 所以把图片的四角放到投影后的位置即可严丝合缝地叠在地图上。
import fs from "node:fs";
import { PNG } from "pngjs";

const Z = 6; // 瓦片级别：每像素约 2.4 公里（赤道）
const BBOX = { west: 72, east: 136, south: 14, north: 54 };
const DOWNSAMPLE = 2; // 输出时每 2×2 像素合并为 1，控制文件大小
const URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const CACHE = "data-src/terrarium";

const lon2x = (lon) => ((lon + 180) / 360) * 2 ** Z;
const lat2y = (lat) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z;
};
const x2lon = (x) => (x / 2 ** Z) * 360 - 180;
const y2lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** Z))) * 180) / Math.PI;

const x0 = Math.floor(lon2x(BBOX.west));
const x1 = Math.floor(lon2x(BBOX.east));
const y0 = Math.floor(lat2y(BBOX.north));
const y1 = Math.floor(lat2y(BBOX.south));
const W = (x1 - x0 + 1) * 256;
const H = (y1 - y0 + 1) * 256;

fs.mkdirSync(CACHE, { recursive: true });
async function tile(x, y) {
  const f = `${CACHE}/${Z}_${x}_${y}.png`;
  if (!fs.existsSync(f)) {
    const res = await fetch(URL(Z, x, y));
    if (!res.ok) throw new Error(`下载失败 ${res.status}: ${URL(Z, x, y)}`);
    fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  }
  return PNG.sync.read(fs.readFileSync(f));
}

// 1. 拼出整块高程（米）
const elev = new Float32Array(W * H);
for (let ty = y0; ty <= y1; ty++) {
  for (let tx = x0; tx <= x1; tx++) {
    const png = await tile(tx, ty);
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const i = (py * 256 + px) * 4;
        const e = png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
        elev[((ty - y0) * 256 + py) * W + (tx - x0) * 256 + px] = e;
      }
    }
  }
}
console.log(`高程拼接完成：${W}×${H}`);

// 2. 分层设色：低地暖米色 → 丘陵 → 高原褐色 → 雪线以上近白
const STOPS = [
  [0, [216, 206, 162]],
  [200, [208, 196, 148]],
  [800, [192, 170, 120]],
  [1800, [170, 142, 100]],
  [3500, [146, 116, 86]],
  [5200, [132, 112, 92]],
  [6500, [236, 232, 224]],
];
function tint(e) {
  for (let i = 1; i < STOPS.length; i++) {
    if (e <= STOPS[i][0]) {
      const [e0, c0] = STOPS[i - 1];
      const [e1, c1] = STOPS[i];
      const t = Math.max(0, (e - e0) / (e1 - e0));
      return c0.map((v, k) => v + (c1[k] - v) * t);
    }
  }
  return STOPS.at(-1)[1];
}

// 3. 晕渲：光源来自西北上方；按纬度换算像素的实际地面尺寸，并适度夸大起伏
const AZ = (315 * Math.PI) / 180;
const ALT = (45 * Math.PI) / 180;
const EXAG = 3;
const shade = new Float32Array(W * H);
for (let y = 1; y < H - 1; y++) {
  const lat = y2lat(y0 + y / 256);
  const res = (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** Z; // 米/像素
  for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const dzdx = ((elev[i + 1] - elev[i - 1]) / (2 * res)) * EXAG;
    const dzdy = ((elev[i + W] - elev[i - W]) / (2 * res)) * EXAG;
    const slope = Math.atan(Math.hypot(dzdx, dzdy));
    const aspect = Math.atan2(dzdy, -dzdx);
    const h = Math.sin(ALT) * Math.cos(slope) + Math.cos(ALT) * Math.sin(slope) * Math.cos(AZ - aspect);
    shade[i] = Math.max(0, h);
  }
}

// 4. 合成并降采样输出；海面（海拔 ≤ 0）透明
const OW = Math.floor(W / DOWNSAMPLE);
const OH = Math.floor(H / DOWNSAMPLE);
const out = new PNG({ width: OW, height: OH });
for (let y = 0; y < OH; y++) {
  for (let x = 0; x < OW; x++) {
    let r = 0, g = 0, b = 0, land = 0;
    for (let dy = 0; dy < DOWNSAMPLE; dy++) {
      for (let dx = 0; dx < DOWNSAMPLE; dx++) {
        const i = (y * DOWNSAMPLE + dy) * W + x * DOWNSAMPLE + dx;
        if (elev[i] <= 0) continue;
        const c = tint(elev[i]);
        const s = 0.36 + 0.88 * shade[i];
        r += c[0] * s; g += c[1] * s; b += c[2] * s;
        land++;
      }
    }
    const o = (y * OW + x) * 4;
    const n = Math.max(1, land);
    out.data[o] = Math.min(255, r / n);
    out.data[o + 1] = Math.min(255, g / n);
    out.data[o + 2] = Math.min(255, b / n);
    out.data[o + 3] = Math.round((255 * land) / DOWNSAMPLE ** 2);
  }
}
fs.writeFileSync("public/data/terrain_china.png", PNG.sync.write(out, { colorType: 6 }));
const bounds = { west: x2lon(x0), east: x2lon(x1 + 1), north: y2lat(y0), south: y2lat(y1 + 1), width: OW, height: OH };
fs.writeFileSync("public/data/terrain_china.json", JSON.stringify(bounds));
console.log(`地形底图：${OW}×${OH}`, bounds);
