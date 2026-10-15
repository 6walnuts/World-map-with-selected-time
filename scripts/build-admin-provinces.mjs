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
    for (const { seat, geometry } of voronoiSplit(territory, seats)) {
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
