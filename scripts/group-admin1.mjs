// 给 Natural Earth 一级行政区打上分组键，供 mapshaper 合并。
// 有些国家的"一级行政区"其实是市镇级（斯洛文尼亚 193 个、英国 232 个），
// 平均面积太小的国家按 region 字段合并成更大的单元。
// 用法：node scripts/group-admin1.mjs <输入 geojson> <输出 geojson>
import fs from "node:fs";
import * as turf from "@turf/turf";

const MIN_AVG_KM2 = 2000;
const [, , input, output] = process.argv;
const src = JSON.parse(fs.readFileSync(input, "utf8"));

const stats = new Map();
for (const f of src.features) {
  const p = f.properties;
  const s = stats.get(p.adm0_a3) ?? { n: 0, area: 0 };
  s.n++;
  s.area += turf.area(f) / 1e6; // 原数据的 area_sqkm 字段为空，自己算
  stats.set(p.adm0_a3, s);
}

const dense = new Set([...stats].filter(([, s]) => s.area / s.n < MIN_AVG_KM2).map(([k]) => k));

for (const f of src.features) {
  const p = f.properties;
  const merge = dense.has(p.adm0_a3) && p.region;
  f.properties = {
    grp: merge ? `${p.adm0_a3}|${p.region}` : p.adm1_code,
    name: merge ? p.region : p.name,
    name_zh: merge ? null : p.name_zh,
    region: p.region,
    admin: p.admin,
    adm0_a3: p.adm0_a3,
  };
}

fs.writeFileSync(output, JSON.stringify(src));
console.log(`按 region 合并的国家：${[...dense].join(", ")}`);
