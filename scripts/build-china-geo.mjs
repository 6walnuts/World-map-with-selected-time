// 生成中国视图的山川数据：河流、湖泊、山脉/高原/盆地名称、唐代运河。
// 用法：node scripts/build-china-geo.mjs   → public/data/china_geo.json
// 河流、湖泊、地理区域来自 Natural Earth（公有领域），运河为手绘近似走向。
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as d3 from "d3";

const SRC = "data-src/ne";
const BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";
const BBOX = [72, 14, 136, 54];
fs.mkdirSync(SRC, { recursive: true });
for (const f of ["ne_10m_rivers_lake_centerlines", "ne_10m_lakes", "ne_10m_geography_regions_polys"]) {
  if (!fs.existsSync(`${SRC}/${f}.geojson`)) {
    execFileSync("curl", ["-fsSL", "-o", `${SRC}/${f}.geojson`, `${BASE}/${f}.geojson`]);
  }
}

// 河流用唐代通行的名称；不在表里的河不画
const RIVER_ZH = {
  "Chang Jiang": "长江", Yangtze: "长江", Jinsha: "金沙江", Tongtian: "通天河", Tuotuo: "沱沱河",
  Huang: "黄河", Huai: "淮水", Han: "汉水", Wei: "渭水", Fen: "汾水", Jing: "泾水", Zhang: "漳水",
  Ying: "颍水", Xiang: "湘水", Gan: "赣水", Yuan: "沅水", Zi: "资水", Jialing: "嘉陵江", Min: "岷江",
  Wu: "乌江", Xi: "西江", Bei: "北江", Dong: "东江", Hongshui: "红水河", Yu: "郁水", Xun: "浔江",
  You: "右江", Yong: "邕江", Liao: "辽水", Xiliao: "辽水", Songhua: "粟末水", "Heilong Jiang": "黑水",
  Amur: "黑水", Sanggan: "桑干河", Yongding: "卢沟", Fuchun: "浙江", Ou: "瓯江", Yalong: "若水",
  Dadu: "大渡水", Lancang: "澜沧江", Nu: "怒江", Hong: "红河", Tarim: "塔里木河", Yarlung: "藏布",
  Nanpan: "南盘江", Hai: "海河", Ile: "伊丽水", Kong: "孔雀河",
};

const inBox = ([x, y]) => x >= BBOX[0] && x <= BBOX[2] && y >= BBOX[1] && y <= BBOX[3];
const coordsOf = (g) =>
  g.type === "LineString" ? g.coordinates
    : g.type === "MultiLineString" || g.type === "Polygon" ? g.coordinates.flat()
      : g.coordinates.flat(2); // MultiPolygon
const round = (g) => JSON.parse(JSON.stringify(g, (k, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v)));

const rivers = JSON.parse(fs.readFileSync(`${SRC}/ne_10m_rivers_lake_centerlines.geojson`, "utf8")).features
  .filter((f) => f.geometry && RIVER_ZH[f.properties.name] && coordsOf(f.geometry).some(inBox))
  .map((f) => ({
    type: "Feature",
    properties: { name: RIVER_ZH[f.properties.name], rank: f.properties.scalerank },
    geometry: round(f.geometry),
  }));

const lakes = JSON.parse(fs.readFileSync(`${SRC}/ne_10m_lakes.geojson`, "utf8")).features
  .filter((f) => f.geometry && (f.properties.scalerank ?? 9) <= 6 && coordsOf(f.geometry).some(inBox))
  .map((f) => ({ type: "Feature", properties: { name: f.properties.name_zh || f.properties.name || "" }, geometry: round(f.geometry) }));

const KINDS = new Set(["Range/mtn", "Plateau", "Basin", "Desert", "Plain", "Gorge", "Geoarea"]);
const regions = JSON.parse(fs.readFileSync(`${SRC}/ne_10m_geography_regions_polys.geojson`, "utf8")).features
  .filter((f) => KINDS.has(f.properties.FEATURECLA) && f.properties.NAME_ZH)
  .map((f) => {
    const [lon, lat] = d3.geoCentroid(f);
    return { name: f.properties.NAME_ZH, kind: f.properties.FEATURECLA === "Range/mtn" ? "mountain" : "land", lon: +lon.toFixed(2), lat: +lat.toFixed(2), rank: f.properties.SCALERANK };
  })
  .filter((r) => inBox([r.lon, r.lat]));

// 唐代运河（近似走向）：通济渠（汴河）、邗沟、江南河、永济渠
const canals = [
  { name: "通济渠", coords: [[112.45, 34.62], [113.4, 34.9], [114.31, 34.8], [115.65, 34.41], [116.97, 33.64], [118.5, 33.0]] },
  { name: "邗沟", coords: [[119.15, 33.5], [119.35, 32.9], [119.42, 32.39]] },
  { name: "江南河", coords: [[119.45, 32.2], [119.95, 31.78], [120.62, 31.3], [120.3, 30.75], [120.16, 30.27]] },
  { name: "永济渠", coords: [[114.07, 35.4], [115.25, 36.28], [115.65, 37.05], [116.3, 37.6], [116.9, 38.3], [116.6, 39.0], [116.4, 39.9]] },
];

const out = { rivers: { type: "FeatureCollection", features: rivers }, lakes: { type: "FeatureCollection", features: lakes }, regions, canals };
fs.writeFileSync("public/data/china_geo.json", JSON.stringify(out));
console.log(`河流 ${rivers.length} 段，湖泊 ${lakes.length} 个，地理区域 ${regions.length} 个，运河 ${canals.length} 段`);
