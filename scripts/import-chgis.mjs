// 从 CHGIS V6 的州府时间序列点（Time Series Prefecture Points）提取某一年存在的州府治所。
// 用法：node scripts/import-chgis.mjs <v6_time_pref_pts_utf_wgs84.shp> <年份> [<v6_time_pref_pgn_utf_wgs84.shp>]
//   第三个参数是可选的州府边界多边形（Time Series Prefecture Polygons）。CHGIS 的唐代边界
//   只覆盖部分州府（800 年约 130 个），有边界的州府直接用真实边界，其余仍按治所划分。
//
// CHGIS 仅限学术、非商业使用，且不得再分发，所以输出写到被 git 忽略的
// data-local/chgis_seats_<年份>.json。build-admin-provinces.mjs 发现它就优先使用。
// 数据来源：CHGIS, Version: 6. © Fairbank Center for Chinese Studies of Harvard University
// and the Center for Historical Geographical Studies at Fudan University, 2016.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const [, , shp, yearArg] = process.argv;
const year = Number(yearArg);
fs.mkdirSync("data-local", { recursive: true });
const tmp = `data-local/chgis_tmp_${year}.json`;
execFileSync("npx", [
  "mapshaper", "-i", shp, "encoding=utf8",
  "-filter", `BEG_YR <= ${year} && END_YR >= ${year}`,
  "-o", tmp, "format=geojson",
], { stdio: ["ignore", "ignore", "inherit"] });

const src = JSON.parse(fs.readFileSync(tmp, "utf8"));
fs.unlinkSync(tmp);
const seats = src.features.map((f) => {
  const p = f.properties;
  return [p.NAME_CH, Number(p.X_COOR.toFixed(4)), Number(p.Y_COOR.toFixed(4)), `CHGIS:${p.SYS_ID}`, p.PRES_LOC];
});

const out = `data-local/chgis_seats_${year}.json`;
fs.writeFileSync(out, JSON.stringify({
  polity: "中国诸政权（CHGIS）",
  unit: `CHGIS V6 州府时间序列点中 ${year} 年存在的单位`,
  source: "CHGIS, Version 6, Harvard University & Fudan University, 2016（仅限学术非商业使用，不得再分发）",
  seats,
}, null, 1));
console.log(`${year} 年：${seats.length} 个州府治所 → ${out}`);

const [, , , , pgn] = process.argv;
if (pgn) {
  const pgnOut = `data-local/chgis_pgn_${year}.json`;
  execFileSync("npx", [
    "mapshaper", "-i", pgn, "encoding=utf8",
    "-filter", `BEG_YR <= ${year} && END_YR >= ${year}`,
    "-filter-fields", "NAME_CH,SYS_ID",
    "-simplify", "8%", "keep-shapes",
    "-clean",
    "-o", pgnOut, "format=geojson", "precision=0.0001",
  ], { stdio: ["ignore", "ignore", "inherit"] });
  const n = JSON.parse(fs.readFileSync(pgnOut, "utf8")).features.length;
  console.log(`${year} 年：${n} 个州府边界 → ${pgnOut}`);
}
