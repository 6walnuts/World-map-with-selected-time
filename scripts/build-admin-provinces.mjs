// 按某一年的行政区划治所生成该年专用的省份底图。
// 用法：node scripts/build-admin-provinces.mjs <年份>
//
// 输入：
//   public/data/provinces.json         通用省份底图
//   public/data/owners_<年份>.json      由 build-owners.mjs 生成的通用归属表（决定各国疆域）
//   data/admin_<年份>.json              该年各国的治所列表
// 输出：
//   public/data/provinces_<年份>.json   该年专用的省份底图
//   public/data/owners_<年份>.json      改写为对应新底图的归属表（带 "provinces" 字段）
//
// 做法：先把通用省份按归属合并成各国疆域；每个治所落在哪国疆域，就是哪国的省。
// 有两个以上治所的国家，在疆域内按"离哪个治所最近"划分（Voronoi）；
// 没有治所或只有一个治所的国家（史料中没有明确区划的），整体算一个省。
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as d3 from "d3";
import * as topojson from "topojson-client";
import * as turf from "@turf/turf";

const NEW_WORLD_MAX_LON = -25; // 与前端 config.js 保持一致
const [, , year] = process.argv;

const baseTopo = JSON.parse(fs.readFileSync("public/data/provinces.json", "utf8"));
const baseObj = Object.values(baseTopo.objects)[0];
const baseProvinces = topojson.feature(baseTopo, baseObj).features;
const owners = JSON.parse(fs.readFileSync(`public/data/owners_${year}.json`, "utf8"));
if (owners.provinces) {
  console.error(`owners_${year}.json 已经是按行政区划改写过的，请先重新运行 build-owners.mjs ${year}`);
  process.exit(1);
}
const admin = JSON.parse(fs.readFileSync(`data/admin_${year}.json`, "utf8"));

// 本地的受限数据（如 CHGIS，见 import-chgis.mjs）存在时优先使用：
// 手工治所与其中任一治所相距不到 40 公里的视为重复，去掉
// 设置环境变量 NO_LOCAL=1 可强制只用仓库内的手工数据（生成可公开的版本）
const USE_LOCAL = !process.env.NO_LOCAL;
const LOCAL = `data-local/chgis_seats_${year}.json`;
if (USE_LOCAL && fs.existsSync(LOCAL)) {
  const local = JSON.parse(fs.readFileSync(LOCAL, "utf8"));
  const km = ([, lon1, lat1], [, lon2, lat2]) => {
    const r = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
      + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
  };
  let dropped = 0;
  for (const g of admin.groups) {
    const before = g.seats.length;
    g.seats = g.seats.filter((s) => !local.seats.some((t) => km(s, t) < 40));
    dropped += before - g.seats.length;
  }
  admin.groups.push(local);
  console.log(`  使用本地数据 ${LOCAL}：${local.seats.length} 个治所，替换手工治所 ${dropped} 个`);
}

// ---------- 各国疆域 ----------

function fixWinding(geometry) {
  const fix = (rings) =>
    d3.geoArea({ type: "Polygon", coordinates: rings }) > 2 * Math.PI ? rings.map((r) => r.slice().reverse()) : rings;
  if (geometry.type === "Polygon") geometry.coordinates = fix(geometry.coordinates);
  if (geometry.type === "MultiPolygon") geometry.coordinates = geometry.coordinates.map(fix);
  return geometry;
}

const merge = (ids) => fixWinding(topojson.merge(baseTopo, ids.map((i) => baseObj.geometries[i])));

const byOwner = new Map();
owners.owner.forEach((o, i) => {
  // 无主之地按新旧大陆分成两块，方便前端隐藏美洲
  const key = o >= 0 ? o : d3.geoCentroid(baseProvinces[i])[0] < NEW_WORLD_MAX_LON ? "nw" : "ow";
  if (!byOwner.has(key)) byOwner.set(key, []);
  byOwner.get(key).push(i);
});

// ---------- 治所归属：看治所落在哪个通用省份里 ----------

const bboxes = baseProvinces.map((f) => turf.bbox(f));
function baseProvinceAt(p) {
  for (let i = 0; i < baseProvinces.length; i++) {
    const b = bboxes[i];
    if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) continue;
    if (d3.geoContains(baseProvinces[i], p)) return i;
  }
  return -1;
}

// 海港城市常常落在简化后的海岸线外面：由近及远在周围找最近的有主陆地
function seatProvince(lon, lat) {
  const here = baseProvinceAt([lon, lat]);
  if (here >= 0 && owners.owner[here] >= 0) return here;
  for (let r = 0.05; r <= 0.5; r += 0.05) {
    for (let a = 0; a < 360; a += 30) {
      const t = (a * Math.PI) / 180;
      const i = baseProvinceAt([lon + (r * Math.cos(t)) / Math.cos((lat * Math.PI) / 180), lat + r * Math.sin(t)]);
      if (i >= 0 && owners.owner[i] >= 0) return i;
    }
  }
  return here;
}

const seatsByOwner = new Map();
let lost = 0;
for (const g of admin.groups) {
  for (const [name, lon, lat] of g.seats) {
    const i = seatProvince(lon, lat);
    const o = i < 0 ? -1 : owners.owner[i];
    if (o < 0) {
      console.warn(`  治所 ${name} (${lon}, ${lat}) 不在任何国家疆域内，跳过`);
      lost++;
      continue;
    }
    if (!seatsByOwner.has(o)) seatsByOwner.set(o, []);
    seatsByOwner.get(o).push({ name, lon, lat });
  }
}

const allSeats = [...seatsByOwner.values()].flat();

// ---------- Voronoi 划分 ----------

function mapCoords(geom, fn) {
  const ring = (r) => r.map(fn);
  if (geom.type === "Polygon") return { type: "Polygon", coordinates: geom.coordinates.map(ring) };
  return { type: "MultiPolygon", coordinates: geom.coordinates.map((p) => p.map(ring)) };
}

function voronoiSplit(territory, seats) {
  const lat0 = d3.mean(seats, (s) => s.lat);
  const c = Math.cos((lat0 * Math.PI) / 180);
  const toLocal = ([x, y]) => [x * c, y];
  const toGeo = ([x, y]) => [x / c, y];
  const local = turf.feature(mapCoords(territory, toLocal));
  const [x0, y0, x1, y1] = turf.bbox(local);
  const pts = turf.featureCollection(seats.map((s) => turf.point(toLocal([s.lon, s.lat]))));
  const cells = turf.voronoi(pts, { bbox: [x0 - 1, y0 - 1, x1 + 1, y1 + 1] });
  const out = [];
  cells.features.forEach((cell, i) => {
    if (!cell) return;
    const part = turf.intersect(turf.featureCollection([cell, local]));
    if (part) out.push({ seat: seats[i], geometry: mapCoords(part.geometry, toGeo) });
  });
  return out;
}

// ---------- 按地形划分（有高程数据时） ----------
// 直线 Voronoi 会切出几何多边形；这里改成「走过去代价最小」：在网格上从各治所同时做
// Dijkstra，翻山、上高原代价更高，于是州界会沿山脊、分水岭走。高程来自 build-terrain.mjs
// 另存的 data-src/elev_china.bin（Web 墨卡托网格，Int16 米）。

const DEM_META = "data-src/elev_china.json";
const dem = fs.existsSync(DEM_META)
  ? { ...JSON.parse(fs.readFileSync(DEM_META, "utf8")), data: new Int16Array(new Uint8Array(fs.readFileSync("data-src/elev_china.bin")).buffer) }
  : null;
if (dem) {
  const n = 2 ** dem.z;
  dem.lon2px = (lon) => (((lon + 180) / 360) * n - dem.x0) * 256;
  dem.lat2py = (lat) => {
    const r = (lat * Math.PI) / 180;
    return (((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - dem.y0) * 256;
  };
  dem.west = (dem.x0 / n) * 360 - 180;
  dem.east = ((dem.x0 + dem.width / 256) / n) * 360 - 180;
  const y2lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  dem.north = y2lat(dem.y0);
  dem.south = y2lat(dem.y0 + dem.height / 256);
}
function elevAt(lon, lat) {
  const x = dem.lon2px(lon) - 0.5, y = dem.lat2py(lat) - 0.5;
  const xi = Math.max(0, Math.min(dem.width - 2, Math.floor(x)));
  const yi = Math.max(0, Math.min(dem.height - 2, Math.floor(y)));
  const fx = Math.min(1, Math.max(0, x - xi)), fy = Math.min(1, Math.max(0, y - yi));
  const d = dem.data, i = yi * dem.width + xi;
  const top = d[i] * (1 - fx) + d[i + 1] * fx;
  const bot = d[i + dem.width] * (1 - fx) + d[i + dem.width + 1] * fx;
  return top * (1 - fy) + bot * fy;
}
const demCovers = ([x0, y0, x1, y1]) => dem && x0 >= dem.west && x1 <= dem.east && y0 >= dem.south && y1 <= dem.north;

const CELL = 0.04; // 网格边长（度），约 4 公里
const SLOPE_W = 25; // 坡度权重：每公里爬升 100 米，代价约 ×3.5
const HIGH_START = 1500, HIGH_SPAN = 1500; // 1500 米以上逐级加价（高原、雪山难以跨越）
const OUTSIDE_W = 6; // 疆域外（海、他国）也要标号以便多边形贴合海岸，但很难穿越
const RIVER_KM = 12; // 渡过大河额外代价（公里）：平原上的州界多以河为界

// 大河（来自 build-china-geo.mjs 的 Natural Earth 河流）
const RIVER_LINES = fs.existsSync("public/data/china_geo.json")
  ? JSON.parse(fs.readFileSync("public/data/china_geo.json", "utf8")).rivers.features
    .filter((f) => (f.properties.rank ?? 9) <= 7)
    .flatMap((f) => (f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates))
  : [];
function rasterizeRivers(gx0, gy1, w, h) {
  const river = new Uint8Array(w * h);
  for (const line of RIVER_LINES) {
    for (let k = 1; k < line.length; k++) {
      const [ax, ay] = line[k - 1], [bx, by] = line[k];
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL / 3)) + 1;
      for (let t = 0; t <= n; t++) {
        const c = Math.floor((ax + ((bx - ax) * t) / n - gx0) / CELL);
        const r = Math.floor((gy1 - (ay + ((by - ay) * t) / n)) / CELL);
        if (r >= 0 && c >= 0 && r < h && c < w) river[r * w + c] = 1;
      }
    }
  }
  return river;
}

// 扫描线奇偶填充：返回 mask[row*w+col]，行从北往南
function rasterize(geom, gx0, gy1, w, h) {
  const mask = new Uint8Array(w * h);
  const rings = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  for (let r = 0; r < h; r++) {
    const lat = gy1 - (r + 0.5) * CELL;
    const xs = [];
    for (const ring of rings) {
      for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
        const [ax, ay] = ring[j], [bx, by] = ring[k];
        if ((ay > lat) !== (by > lat)) xs.push(ax + ((lat - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - gx0) / CELL - 0.5));
      const c1 = Math.min(w - 1, Math.floor((xs[k + 1] - gx0) / CELL - 0.5));
      for (let c = c0; c <= c1; c++) mask[r * w + c] = 1;
    }
  }
  return mask;
}

function costSplit(territory, seats) {
  const [bx0, by0, bx1, by1] = turf.bbox(territory);
  const PAD = 3;
  const gx0 = bx0 - PAD * CELL, gy1 = by1 + PAD * CELL;
  const w = Math.ceil((bx1 - bx0) / CELL) + 2 * PAD, h = Math.ceil((by1 - by0) / CELL) + 2 * PAD;
  const N = w * h;
  const mask = rasterize(territory, gx0, gy1, w, h);
  const river = rasterizeRivers(gx0, gy1, w, h);
  const elev = new Float32Array(N);
  for (let r = 0; r < h; r++) {
    const lat = gy1 - (r + 0.5) * CELL;
    for (let c = 0; c < w; c++) elev[r * w + c] = Math.max(0, elevAt(gx0 + (c + 0.5) * CELL, lat));
  }
  const kmY = CELL * 111.2;
  const kmX = new Float32Array(h);
  for (let r = 0; r < h; r++) kmX[r] = kmY * Math.cos(((gy1 - (r + 0.5) * CELL) * Math.PI) / 180);

  // 多源 Dijkstra（二叉堆）
  const dist = new Float64Array(N).fill(Infinity);
  const label = new Int32Array(N).fill(-1);
  const heap = []; // [cost, idx]
  const push = (cost, i) => {
    heap.push([cost, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  seats.forEach((s, si) => {
    let c = Math.floor((s.lon - gx0) / CELL), r = Math.floor((gy1 - s.lat) / CELL);
    c = Math.max(0, Math.min(w - 1, c)); r = Math.max(0, Math.min(h - 1, r));
    // 治所常在海岸或疆界边上：挪到最近的疆域内网格
    let best = r * w + c;
    if (!mask[best]) {
      let bd = Infinity;
      for (let dr = -6; dr <= 6; dr++) for (let dc = -6; dc <= 6; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w || !mask[rr * w + cc]) continue;
        const d = dr * dr + dc * dc;
        if (d < bd) { bd = d; best = rr * w + cc; }
      }
    }
    if (dist[best] > 0) { dist[best] = 0; label[best] = si; push(0, best); }
  });
  // 16 邻域（含「马步」），减少 8 邻域带来的八边形锯齿
  const NB = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
    [-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]];
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    const r = (i / w) | 0, c = i - r * w;
    for (const [dr, dc] of NB) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const j = rr * w + cc;
      const dx = dc * (kmX[r] + kmX[rr]) / 2, dy = dr * kmY;
      const km = Math.hypot(dx, dy);
      const climb = Math.abs(elev[j] - elev[i]) / (km * 1000);
      const high = 1 + Math.max(0, (Math.max(elev[i], elev[j]) - HIGH_START) / HIGH_SPAN);
      let step = km * (1 + SLOPE_W * climb) * high;
      if (!mask[j] || !mask[i]) step *= OUTSIDE_W;
      if (river[j] && !river[i]) step += RIVER_KM;
      const nd = d + step;
      if (nd < dist[j]) { dist[j] = nd; label[j] = label[i]; push(nd, j); }
    }
  }

  // 逐个标号描出轮廓，再与疆域求交（贴合真实海岸与国界）
  const out = [];
  const contour = d3.contours().size([w, h]).thresholds([0.5]);
  const toGeo = ([x, y]) => [gx0 + x * CELL, gy1 - y * CELL];
  const values = new Float64Array(N);
  seats.forEach((seat, si) => {
    let any = false;
    for (let i = 0; i < N; i++) { values[i] = label[i] === si ? 1 : 0; any ||= values[i] === 1 && mask[i] === 1; }
    if (!any) return;
    const [mp] = contour(values);
    if (!mp.coordinates.length) return;
    const geom = { type: "MultiPolygon", coordinates: mp.coordinates.map((p) => p.map((ring) => ring.map(toGeo))) };
    const part = turf.intersect(turf.featureCollection([turf.feature(geom), turf.feature(territory)]));
    if (part) out.push({ seat, geometry: part.geometry });
  });
  return out;
}

const features = [];

// ---------- 真实边界（本地 CHGIS 州府多边形，可选） ----------
// 有真实边界的州府直接用它：归属看州境内一点落在哪国，并从各国疆域里挖掉这块，
// 剩下的部分再按治所 Voronoi 划分。这样藩镇与唐的分界也会沿着真实州界。
const PGN = `data-local/chgis_pgn_${year}.json`;
let realUnion = null;
if (USE_LOCAL && fs.existsSync(PGN)) {
  const land = merge(baseProvinces.map((_, i) => i));
  const real = [];
  for (const f of JSON.parse(fs.readFileSync(PGN, "utf8")).features) {
    if (!f.geometry) continue;
    const [lon, lat] = turf.pointOnFeature(f).geometry.coordinates;
    const i = seatProvince(lon, lat);
    const o = i < 0 ? -1 : owners.owner[i];
    if (o < 0) continue;
    const clipped = turf.intersect(turf.featureCollection([f, turf.feature(land)]));
    if (!clipped) continue;
    // 治所：同名且落在州界内的治所点
    const seat = allSeats.find((t) => t.name === f.properties.NAME_CH && turf.booleanPointInPolygon([t.lon, t.lat], f));
    const props = { label: f.properties.NAME_CH, o };
    if (seat) Object.assign(props, { seatLon: seat.lon, seatLat: seat.lat });
    real.push({ type: "Feature", properties: props, geometry: clipped.geometry });
  }
  realUnion = turf.union(turf.featureCollection(real));
  features.push(...real);
  console.log(`  使用本地真实州界 ${PGN}：${real.length} 个`);
}

const insideReal = (s) => realUnion && turf.booleanPointInPolygon([s.lon, s.lat], realUnion);

for (const [key, ids] of byOwner) {
  let territory = merge(ids);
  if (realUnion) {
    const rest = turf.difference(turf.featureCollection([turf.feature(territory), realUnion]));
    if (!rest) continue; // 整个疆域都被真实州界覆盖
    territory = rest.geometry;
  }
  const o = typeof key === "number" ? key : -1;
  const ownerName = o >= 0 ? owners.countries[o].name : null;
  const seats = (seatsByOwner.get(o) ?? []).filter((s) => !insideReal(s));
  if (o >= 0 && seats.length >= 2) {
    const useCost = demCovers(turf.bbox(territory)) && !process.env.NO_TERRAIN;
    const parts = useCost ? costSplit(territory, seats) : voronoiSplit(territory, seats);
    if (useCost) console.log(`  ${ownerName}：按地形划分 ${parts.length}/${seats.length}`);
    for (const { seat, geometry } of parts) {
      features.push({ type: "Feature", properties: { label: seat.name, o, seatLon: seat.lon, seatLat: seat.lat }, geometry });
    }
  } else {
    features.push({
      type: "Feature",
      properties: { label: ownerName ?? "", o, whole: true },
      geometry: territory,
    });
  }
}

// ---------- 输出：修拓扑后转成 TopoJSON ----------

const rawPath = `data-src/provinces_${year}_raw.geojson`;
fs.mkdirSync("data-src", { recursive: true });
fs.writeFileSync(rawPath, JSON.stringify({ type: "FeatureCollection", features }));
const outFile = `provinces_${year}.json`;
execFileSync("npx", [
  "mapshaper", "-i", rawPath,
  "snap", "snap-interval=0.0005",
  "-clean",
  "-o", `public/data/${outFile}`, "format=topojson", "quantization=1e5",
], { stdio: ["ignore", "ignore", "inherit"] });

const topo = JSON.parse(fs.readFileSync(`public/data/${outFile}`, "utf8"));
const geoms = Object.values(topo.objects)[0].geometries;
const out = {
  year: owners.year,
  provinces: outFile,
  countries: owners.countries,
  owner: geoms.map((g) => g.properties.o),
};
for (const g of geoms) delete g.properties.o;
fs.writeFileSync(`public/data/${outFile}`, JSON.stringify(topo));
fs.writeFileSync(`public/data/owners_${year}.json`, JSON.stringify(out));

const split = [...seatsByOwner.values()].filter((s) => s.length >= 2).length;
console.log(`${year}: ${geoms.length} 个省份（${split} 个国家按行政区划细分，其余整体一块），${lost} 个治所未落入任何国家`);
