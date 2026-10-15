// 生成 2.5D 大唐场景用的高程图：public/data/height_tang.png 与 .json
// 用法：先运行 node scripts/build-terrain.mjs（会把原始高程存到 data-src/elev_china.bin），再运行本脚本。
// 高程编码在 R、G 两个通道：v = 海拔(米) + 1000，R = v >> 8，G = v & 255（-1000 ~ 64535 米）。
// 网格与地形底图同为 z6 级 Web 墨卡托像素，前端按墨卡托坐标铺网格即可与州界对齐。
import fs from "node:fs";
import { PNG } from "pngjs";

const BBOX = { west: 94, east: 126, south: 16, north: 44 };
const meta = JSON.parse(fs.readFileSync("data-src/elev_china.json", "utf8"));
const elev = new Int16Array(new Uint8Array(fs.readFileSync("data-src/elev_china.bin")).buffer);
const n = 2 ** meta.z;
const lon2gx = (lon) => ((lon + 180) / 360) * n * 256;
const lat2gy = (lat) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * 256;
};
const gx0 = Math.floor(lon2gx(BBOX.west)), gx1 = Math.ceil(lon2gx(BBOX.east));
const gy0 = Math.floor(lat2gy(BBOX.north)), gy1 = Math.ceil(lat2gy(BBOX.south));
const W = gx1 - gx0, H = gy1 - gy0;
const ox = gx0 - meta.x0 * 256, oy = gy0 - meta.y0 * 256;

const png = new PNG({ width: W, height: H });
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const e = elev[(oy + y) * meta.width + ox + x];
    const v = Math.max(0, Math.min(65535, e + 1000));
    const o = (y * W + x) * 4;
    png.data[o] = v >> 8;
    png.data[o + 1] = v & 255;
    png.data[o + 2] = 0;
    png.data[o + 3] = 255;
  }
}
fs.writeFileSync("public/data/height_tang.png", PNG.sync.write(png));
const out = { z: meta.z, gx0, gy0, width: W, height: H };
fs.writeFileSync("public/data/height_tang.json", JSON.stringify(out));
console.log("高程图", out, `${(fs.statSync("public/data/height_tang.png").size / 1e6).toFixed(1)} MB`);
