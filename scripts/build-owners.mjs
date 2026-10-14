// 生成每个年份的"省份 → 国家"归属表。
// 用法：node scripts/build-owners.mjs <年份...>
//   年份可以写成"开局年份:数据源年份"，例如 769:800 表示用 800 年的边界数据做底，
//   再用 overrides.json 里 "769" 的规则修正成 769 年的样子
//
// 对每个省份在内部撒若干采样点，看每个点落在 historical-basemaps 的哪个国家里，
// 得票最多的国家就是该省的主人。没有落进任何国家的点算"无主"。
// 之后再用 data/overrides.json 里的手工修正覆盖自动结果。
//
// overrides.json：按年份列出修正规则，按顺序执行，后面的覆盖前面的。
// 规则按"现代国家代码 / 省份名 / 大区名 / 当前归属"匹配，省份重新生成后依然有效：
//   { "owner": "Naples", "adm0": "ITA", "regions": ["Campania", "Calabria"] }
//   { "owner": "Bohemia", "from": "Holy Roman Empire", "adm0": ["CZE", "POL"] }
//   { "rename": "Manchu Empire", "to": "Republic of China" }
//   { "owner": "Tibetan Empire", "adm0": "CHN", "bbox": [92, 34, 106, 41] }   // 省份质心落在 [西, 南, 东, 北] 内
// owner 为 null 表示改为无主；overlord 可指定宗主国；note 写依据，脚本不读。
import fs from "node:fs";
import * as d3 from "d3";
import * as topojson from "topojson-client";
import * as turf from "@turf/turf";

const SAMPLES = 24;
const years = process.argv.slice(2);

const provTopo = JSON.parse(fs.readFileSync("public/data/provinces.json", "utf8"));
const provObj = Object.values(provTopo.objects)[0];
const provinces = topojson.feature(provTopo, provObj).features;

const overrides = fs.existsSync("data/overrides.json")
  ? JSON.parse(fs.readFileSync("data/overrides.json", "utf8"))
  : {};

const asList = (v) => (v == null ? null : Array.isArray(v) ? v : [v]);

function matches(rule, props, ownerName) {
  const adm0 = asList(rule.adm0);
  const names = asList(rule.names);
  const regions = asList(rule.regions);
  const from = asList(rule.from);
  const bb = rule.bbox;
  if (!adm0 && !names && !regions && !from && !bb) return false;
  if (bb) {
    const [x, y] = props.centroid;
    if (x < bb[0] || y < bb[1] || x > bb[2] || y > bb[3]) return false;
  }
  if (adm0 && !adm0.includes(props.adm0_a3)) return false;
  if (names && !names.includes(props.name) && !names.includes(props.name_zh)) return false;
  if (regions && !regions.includes(props.region)) return false;
  if (from && !from.includes(ownerName)) return false;
  return true;
}

function fixWinding(geometry) {
  const fix = (rings) =>
    d3.geoArea({ type: "Polygon", coordinates: rings }) > 2 * Math.PI ? rings.map((r) => r.slice().reverse()) : rings;
  if (geometry.type === "Polygon") geometry.coordinates = fix(geometry.coordinates);
  if (geometry.type === "MultiPolygon") geometry.coordinates = geometry.coordinates.map(fix);
}

function bbox(geometry) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
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

for (const f of provinces) f.properties.centroid = d3.geoCentroid(f);

// 省份内部的采样点：与年份无关，只算一次
console.log("计算采样点…");
const samples = provinces.map((f, i) => {
  const rand = mulberry32(7 + i);
  const [x0, y0, x1, y1] = bbox(f.geometry);
  const pts = [turf.pointOnFeature(f).geometry.coordinates];
  for (let tries = 0; pts.length < SAMPLES && tries < SAMPLES * 40; tries++) {
    const p = [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)];
    if (d3.geoContains(f, p)) pts.push(p);
  }
  return pts;
});

for (const arg of years) {
  const [year, source = year] = arg.split(":");
  const hist = JSON.parse(fs.readFileSync(`data-src/world_${source}.geojson`, "utf8"));
  const polys = hist.features
    .map((f) => {
      // 有的多边形 NAME 是空白，但 SUBJECTO 写了主权国，用它兜底
      const name = f.properties.NAME?.trim() || f.properties.SUBJECTO?.trim();
      return { f, name, overlord: f.properties.SUBJECTO?.trim() };
    })
    .filter((p) => p.f.geometry && p.name)
    .map((p) => {
      fixWinding(p.f.geometry);
      return { ...p, bbox: bbox(p.f.geometry) };
    });

  const countryIndex = new Map();
  const countries = [];
  const idOf = (name, overlord) => {
    if (!countryIndex.has(name)) {
      countryIndex.set(name, countries.length);
      countries.push({ name });
    }
    const c = countries[countryIndex.get(name)];
    if (!c.overlord && overlord && overlord !== name && !overlord.startsWith("(")) c.overlord = overlord;
    return countryIndex.get(name);
  };

  const owner = samples.map((pts) => {
    const votes = new Map();
    for (const [x, y] of pts) {
      let hit = -1;
      for (const p of polys) {
        const b = p.bbox;
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        if (d3.geoContains(p.f, [x, y])) {
          hit = idOf(p.name, p.overlord);
          break;
        }
      }
      votes.set(hit, (votes.get(hit) ?? 0) + 1);
    }
    let best = -1;
    let bestN = -1;
    for (const [id, n] of votes) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    return best;
  });

  // 手工修正，后面的规则覆盖前面的
  let fixed = 0;
  for (const rule of overrides[year] ?? []) {
    if (rule.rename) {
      const c = countries.find((c) => c.name === rule.rename);
      if (!c) console.warn(`  ${year}: 找不到要改名的国家 ${rule.rename}`);
      else {
        countryIndex.delete(c.name);
        countryIndex.set(rule.to, countries.indexOf(c));
        c.name = rule.to;
      }
      continue;
    }
    let n = 0;
    provinces.forEach((f, i) => {
      const ownerName = owner[i] < 0 ? null : countries[owner[i]].name;
      if (!matches(rule, f.properties, ownerName)) return;
      owner[i] = rule.owner === null ? -1 : idOf(rule.owner, rule.overlord);
      n++;
    });
    if (!n) console.warn(`  ${year}: 规则没有匹配到任何省份 ${JSON.stringify(rule)}`);
    fixed += n;
  }

  // 被修正规则清空的国家不再输出
  const used = new Set(owner);
  const remap = new Map();
  const kept = countries.filter((c, i) => used.has(i) && remap.set(i, remap.size));
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0) owner[i] = remap.get(owner[i]);

  const out = { year: Number(year), countries: kept, owner };
  fs.writeFileSync(`public/data/owners_${year}.json`, JSON.stringify(out));
  const claimed = owner.filter((o) => o >= 0).length;
  console.log(`${year}: ${kept.length} 个国家，${claimed}/${owner.length} 个省份有主，手工修正 ${fixed} 个`);
}
