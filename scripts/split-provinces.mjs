// 把 Natural Earth 一级行政区切成大小接近 P 社省份的块。
// 用法：node scripts/split-provinces.mjs <输入 geojson> <输出 geojson>
//
// 做法：面积超过目标值的行政区，在内部撒点 → k-means 聚成 k 个中心 →
// Voronoi 分割 → 与原多边形求交。全程在"经度 × cos(纬度)"的局部平面里算，
// 避免高纬度地区被横向拉长。随机数带种子，结果可复现。
import fs from "node:fs";
import * as turf from "@turf/turf";

const [, , input, output] = process.argv;

// 目标省份面积（km²）。和 P 社一样：欧洲最细，人口稠密的亚洲次之，
// 高纬度和其他地区更粗
function targetArea(lon, lat) {
  const a = Math.abs(lat);
  if (a > 62) return 140000;
  if (lon > -15 && lon < 45 && lat > 34 && lat < 72) return 9000;
  if (a > 55) return 60000;
  if (lon > 25 && lon < 146 && lat > 5 && lat < 46) return 16000;
  return 30000;
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mapCoords(geom, fn) {
  const ring = (r) => r.map(fn);
  if (geom.type === "Polygon") return { type: "Polygon", coordinates: geom.coordinates.map(ring) };
  return { type: "MultiPolygon", coordinates: geom.coordinates.map((p) => p.map(ring)) };
}

function kmeans(points, k, rand, iters = 25) {
  let centers = [];
  const used = new Set();
  while (centers.length < k) {
    const i = Math.floor(rand() * points.length);
    if (!used.has(i)) {
      used.add(i);
      centers.push(points[i].slice());
    }
  }
  for (let it = 0; it < iters; it++) {
    const sums = centers.map(() => [0, 0, 0]);
    for (const p of points) {
      let best = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const dx = p[0] - centers[j][0];
        const dy = p[1] - centers[j][1];
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      sums[best][0] += p[0];
      sums[best][1] += p[1];
      sums[best][2]++;
    }
    centers = centers.map((c, j) => (sums[j][2] ? [sums[j][0] / sums[j][2], sums[j][1] / sums[j][2]] : c));
  }
  return centers;
}

function split(feature, seed) {
  const areaKm2 = turf.area(feature) / 1e6;
  const [minX, minY, maxX, maxY] = turf.bbox(feature);
  const lat0 = (minY + maxY) / 2;
  const k = Math.round(areaKm2 / targetArea((minX + maxX) / 2, lat0));
  if (k < 2) return [feature];

  const c = Math.cos((lat0 * Math.PI) / 180);
  const toLocal = ([x, y]) => [x * c, y];
  const toGeo = ([x, y]) => [x / c, y];
  const local = turf.feature(mapCoords(feature.geometry, toLocal));
  const bbox = turf.bbox(local);

  // 在多边形内部均匀撒点
  const rand = mulberry32(seed);
  const pts = [];
  const want = k * 40;
  for (let tries = 0; pts.length < want && tries < want * 60; tries++) {
    const p = [bbox[0] + rand() * (bbox[2] - bbox[0]), bbox[1] + rand() * (bbox[3] - bbox[1])];
    if (turf.booleanPointInPolygon(p, local)) pts.push(p);
  }
  if (pts.length < k * 4) return [feature];

  const centers = kmeans(pts, k, rand);
  const pad = 1;
  const cells = turf.voronoi(turf.featureCollection(centers.map((p) => turf.point(p))), {
    bbox: [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad],
  });

  const pieces = [];
  cells.features.forEach((cell, i) => {
    if (!cell) return;
    const part = turf.intersect(turf.featureCollection([cell, local]));
    if (!part) return;
    pieces.push({
      type: "Feature",
      properties: { ...feature.properties, part: i + 1 },
      geometry: mapCoords(part.geometry, toGeo),
    });
  });
  return pieces.length ? pieces : [feature];
}

const src = JSON.parse(fs.readFileSync(input, "utf8"));
const out = [];
src.features.forEach((f, i) => {
  if (!f.geometry) return;
  try {
    out.push(...split(f, 1000 + i));
  } catch (e) {
    console.warn(`切分失败，保留原样：${f.properties.name}（${e.message}）`);
    out.push(f);
  }
});

fs.writeFileSync(output, JSON.stringify({ type: "FeatureCollection", features: out }));
console.log(`${src.features.length} 个行政区 → ${out.length} 个省份`);
