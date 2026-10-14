// 诊断工具：列出某个年份里，各现代国家的省份分别归属于哪些历史国家。
// 用法：node scripts/inspect-owners.mjs <年份> [现代国家代码...]
import fs from "node:fs";
import * as topojson from "topojson-client";

const [, , year, ...codes] = process.argv;
const topo = JSON.parse(fs.readFileSync("public/data/provinces.json", "utf8"));
const provinces = topojson.feature(topo, Object.values(topo.objects)[0]).features;
const { countries, owner } = JSON.parse(fs.readFileSync(`public/data/owners_${year}.json`, "utf8"));

const byAdm0 = new Map();
provinces.forEach((f, i) => {
  const a = f.properties.adm0_a3;
  if (codes.length && !codes.includes(a)) return;
  const m = byAdm0.get(a) ?? new Map();
  const o = owner[i] < 0 ? "（无主）" : countries[owner[i]].name;
  m.set(o, (m.get(o) ?? 0) + 1);
  byAdm0.set(a, m);
});
for (const [a, m] of byAdm0) {
  const parts = [...m].sort((x, y) => y[1] - x[1]).map(([o, n]) => `${o}×${n}`);
  console.log(`${a}: ${parts.join(", ")}`);
}
