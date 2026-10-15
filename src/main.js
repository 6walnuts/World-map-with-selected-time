import * as d3 from "d3";
import * as topojson from "topojson-client";
import { presimplify, simplify, quantile } from "topojson-simplify";
import {
  BOOKMARKS,
  DEFAULT_YEAR,
  FIXED_COLORS,
  ZH_NAMES,
  UNORGANIZED_RE,
  NEW_WORLD_MAX_LON,
  NOMINAL_OVERLORDS,
} from "./config.js";
import { createChina } from "./china.js";
import "./style.css";

const DATA = import.meta.env.BASE_URL + "data/";
const EARTH_RADIUS_KM = 6371;
const LAT_TOP = 83;
const LAT_BOTTOM = -58;

// ---------- 颜色 ----------

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// P 社风格：中低饱和度、偏暖的色块
function hashColor(name) {
  const h = hashString(name);
  const hue = h % 360;
  const sat = 0.32 + ((h >> 9) % 25) / 100;
  const light = 0.5 + ((h >> 17) % 18) / 100;
  return d3.hsl(hue, sat, light).formatHex();
}

function baseColor(name) {
  return FIXED_COLORS[name] ?? hashColor(name);
}

// 附庸、殖民地、共主邦联用宗主色的近似色，类似 P 社的殖民国家和附庸：
// 同一宗主下的几个附庸按顺序各偏一点色相和明度，彼此仍能分清；
// 共主邦联比附庸更接近宗主色。神圣罗马帝国这类名义宗主不染色。
const isRealOverlord = (c) => c.overlord && !NOMINAL_OVERLORDS.has(c.overlord);

function assignColors(countries) {
  const byName = new Map(countries.map((c) => [c.name, c]));
  const siblings = new Map();
  for (const c of countries) {
    if (!isRealOverlord(c) || c.unorganized) continue;
    if (!siblings.has(c.overlord)) siblings.set(c.overlord, []);
    siblings.get(c.overlord).push(c);
  }
  for (const list of siblings.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((c, i) => (c.siblingIndex = i));
  }

  const colorOf = (c, depth = 0) => {
    if (c.color) return c.color;
    if (c.unorganized) return (c.color = "#cdbf98");
    if (isRealOverlord(c) && depth < 4) {
      const lord = byName.get(c.overlord);
      const base = d3.hsl(lord ? colorOf(lord, depth + 1) : baseColor(c.overlord));
      const i = c.siblingIndex ?? 0;
      if (c.relation === "union") {
        // 共主邦联：几乎同色，只轻微偏一点色相、提亮一点
        base.h += i % 2 ? 5 : -5;
        base.l = Math.min(0.82, base.l + 0.05);
      } else {
        // 附庸：色相在 ±14° 内交替偏移，明度分三档递增
        base.h += ((i % 5) - 2) * 7;
        base.l = Math.min(0.82, base.l + 0.1 + (Math.floor(i / 5) % 3) * 0.06);
        base.s *= 0.85;
      }
      return (c.color = base.formatHex());
    }
    return (c.color = FIXED_COLORS[c.name] ?? hashColor(c.name));
  };
  for (const c of countries) colorOf(c);
}

const relationText = (p) =>
  p.relation === "union" ? `与${zhName(p.overlord)}共主` : `附属于${zhName(p.overlord)}`;

// ---------- 名称 ----------

// "Cuba (Spain)" 这类殖民地名显示为"古巴（西属）"
const COLONIAL = { Spain: "西", France: "法", Portugal: "葡", Italy: "意", "United Kingdom": "英", UK: "英", Netherlands: "荷", Belgium: "比", Dutch: "荷", Denmark: "丹", Danemark: "丹", GB: "英" };
function zhName(name) {
  if (ZH_NAMES[name]) return ZH_NAMES[name];
  const m = name?.match(/^(.+?) \(([^()]+)\)$/);
  if (m && COLONIAL[m[2]]) return `${ZH_NAMES[m[1]] ?? m[1]}（${COLONIAL[m[2]]}属）`;
  return name;
}

// 估算文字宽度（以 em 计）：中文约 1em，拉丁字母约 0.62em
function textEm(s) {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.62;
  return w;
}

// ---------- 省份底图 ----------
//
// 默认所有年份共用 provinces.json；归属表里写了 "provinces" 字段的年份
// （例如按 800 年行政区划生成的 provinces_800.json）使用自己的省份底图。

const provinceSets = new Map();

function loadProvinceSet(file) {
  if (!provinceSets.has(file)) provinceSets.set(file, d3.json(`${DATA}${file}`).then(buildProvinceSet));
  return provinceSets.get(file);
}

// 细节层级（LOD）：远看用大幅简化的边界，拉近才用全精度。
// 每级保留的顶点比例，以及切换到下一级的缩放倍数。
const LOD_KEEP = [0.12, 0.4, 1];
const LOD_ZOOM = [2.5, 7];
const PROVINCE_LINE_ZOOM = 1.6; // 省界开始显现的缩放倍数
const levelFor = (k) => (k < LOD_ZOOM[0] ? 0 : k < LOD_ZOOM[1] ? 1 : 2);

function buildProvinceSet(topo) {
  const obj = Object.values(topo.objects)[0];
  const pre = presimplify(topo);
  // 简化后的拓扑与原拓扑共享 objects（同一批几何对象），只是弧线的顶点更少
  const levels = LOD_KEEP.map((keep) => (keep >= 1 ? topo : simplify(pre, quantile(pre, 1 - keep))));
  const set = {
    topo,
    levels,
    geoms: obj.geometries, // TopoJSON 里的省份几何对象
    provinces: topojson.feature(topo, obj).features, // GeoJSON features（全精度）
    neighbors: topojson.neighbors(obj.geometries),
    labels: null, // 省份名标签，依赖投影，resize 后重算
  };
  set.geoms.forEach((g, i) => (g.index = i));
  set.provinces.forEach((f, i) => {
    const p = f.properties;
    p.index = i;
    p.label = p.label || p.name_zh || p.name || p.admin || "";
    p.areaKm2 = d3.geoArea(f) * EARTH_RADIUS_KM ** 2;
    p.newWorld = d3.geoCentroid(f)[0] < NEW_WORLD_MAX_LON;
    p.bbox = d3.geoBounds(f);
  });
  return set;
}

// ---------- 每个年份的归属表 ----------

const cache = new Map();
const citiesPromise = d3.json(`${DATA}cities.json`);

async function loadYear(bm) {
  if (cache.has(bm.year)) return cache.get(bm.year);
  const raw = await d3.json(`${DATA}owners_${bm.year}.json`);
  const base = await loadProvinceSet(raw.provinces ?? "provinces.json");

  const countries = raw.countries.map((c, id) => {
    const p = {
      id,
      name: c.name,
      overlord: c.overlord ?? null,
      relation: c.relation ?? null,
      unorganized: UNORGANIZED_RE.test(c.name),
      provinces: [],
      areaKm2: 0,
    };
    return p;
  });
  assignColors(countries);

  // 新大陆隐藏时，那些省份一律视为"未知之地"
  const owner = raw.owner.map((o, i) =>
    bm.hideNewWorld && base.provinces[i].properties.newWorld ? -2 : o
  );

  const unclaimed = [];
  const unknown = [];
  owner.forEach((o, i) => {
    if (o === -1) unclaimed.push(i);
    else if (o === -2) unknown.push(i);
    else {
      countries[o].provinces.push(i);
      countries[o].areaKm2 += base.provinces[i].properties.areaKm2;
    }
  });

  const merge = (ids, lvl = 2) => topojson.merge(base.levels[lvl], ids.map((i) => base.geoms[i]));

  const features = countries
    .filter((c) => c.provinces.length)
    .map((c) => {
      const nb = new Set();
      for (const i of c.provinces) {
        for (const j of base.neighbors[i]) if (owner[j] >= 0 && owner[j] !== c.id) nb.add(owner[j]);
      }
      c.neighbors = [...nb].map((j) => countries[j].name);
      return { type: "Feature", properties: c, geometry: merge(c.provinces) };
    });

  const ranked = features.filter((f) => !f.properties.unorganized)
    .sort((a, b) => b.properties.areaKm2 - a.properties.areaKm2);
  ranked.forEach((f, i) => (f.properties.rank = i + 1));

  // 首都与重要城市：按所在省份判断属于哪国
  const cityData = (await citiesPromise)[bm.year] ?? { capitals: [], cities: [] };
  const provinceOf = (lon, lat) => {
    for (const f of base.provinces) {
      const [[w, so], [e, n]] = f.properties.bbox;
      if (lat < so || lat > n || lon < w || lon > e) continue;
      if (d3.geoContains(f, [lon, lat])) return f.properties.index;
    }
    return -1;
  };
  const cities = [];
  for (const [kind, list] of [["capital", cityData.capitals], ["city", cityData.cities]]) {
    for (const [name, lon, lat] of list) {
      const i = provinceOf(lon, lat);
      const o = i < 0 ? -1 : owner[i];
      if (o === -2) continue; // 未知之地
      const country = o >= 0 ? countries[o] : null;
      cities.push({ name, lon, lat, capital: kind === "capital", country: country?.name ?? null });
      if (kind === "capital" && country && !country.capital) country.capital = name;
    }
  }

  const result = {
    year: bm.year,
    set: base,
    cities,
    owner,
    countries: features,
    byName: new Map(features.map((f) => [f.properties.name, f])),
    total: ranked.length,
    unclaimed: merge(unclaimed),
    unknown: unknown.length ? merge(unknown) : null,
    unclaimedIds: unclaimed,
    unknownIds: unknown,
    lod: new Map(), // 各级简化几何的缓存，按需生成
    merge,
    // 同一国家内部的省界（细线）
    provinceLines: (lvl) => topojson.mesh(base.levels[lvl], { type: "GeometryCollection", geometries: base.geoms },
      (a, b) => a !== b && owner[a.index] === owner[b.index]),
  };
  cache.set(bm.year, result);
  return result;
}

// ---------- 地图搭建 ----------

const svg = d3.select("#map");
const stage = document.getElementById("stage");
const tooltip = document.getElementById("tooltip");

const defs = svg.append("defs");

// 羊皮纸噪点：启动时用 canvas 生成一小块，平铺在地图上方
(function paintPaper() {
  const c = document.createElement("canvas");
  c.width = c.height = 180;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random();
    img.data[i] = 115;
    img.data[i + 1] = 90;
    img.data[i + 2] = 50;
    img.data[i + 3] = v * v * 110;
  }
  ctx.putImageData(img, 0, 0);
  document.querySelector(".paper-overlay").style.backgroundImage = `url(${c.toDataURL()})`;
})();

// 海岸浅水的柔光
const glow = defs.append("filter").attr("id", "coast-glow").attr("x", "-5%").attr("y", "-5%").attr("width", "110%").attr("height", "110%");
glow.append("feGaussianBlur").attr("stdDeviation", 2.5);

// 未知之地：斜线阴影
const fog = defs.append("pattern").attr("id", "terra-incognita").attr("width", 6).attr("height", 6)
  .attr("patternUnits", "userSpaceOnUse").attr("patternTransform", "rotate(35)");
fog.append("rect").attr("width", 6).attr("height", 6).attr("fill", "#3e3527");
fog.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 6).attr("stroke", "#4b402f").attr("stroke-width", 2);

const world = svg.append("g").attr("class", "world");
const gGraticule = world.append("path").attr("class", "graticule");
const gCoast = world.append("path").attr("class", "coast-glow").attr("filter", "url(#coast-glow)");
let gLayer = world.append("g").attr("class", "year-layer");
const gHoverProv = world.append("path").attr("class", "hover-province");
// 标签不放在缩放的 <g> 里：SVG 文字在缩放变化时要重新排版字形，几百个中文标签
// 一次就要几百毫秒。改为每次缩放停下后，按屏幕坐标只画当前可见的那些。
const gProvLabels = svg.append("g").attr("class", "province-labels");
const gLabels = svg.append("g").attr("class", "labels");
const gCities = svg.append("g").attr("class", "cities");

const projection = d3.geoMercator();
const path = d3.geoPath(projection);

let width = 0;
let height = 0;
let current = null; // 当前年份的数据
let selected = null; // 选中的国家名
let zoomK = 1;

function resize() {
  width = stage.clientWidth;
  height = stage.clientHeight;
  svg.attr("width", width).attr("height", height);

  const corners = { type: "MultiPoint", coordinates: [[-180, LAT_TOP], [180, LAT_BOTTOM]] };
  projection.clipExtent(null).fitSize([width, height], corners);
  const [x0, y0] = projection([-180, LAT_TOP]);
  const [x1, y1] = projection([180, LAT_BOTTOM]);
  projection.clipExtent([[x0, y0], [x1, y1]]);

  zoom.translateExtent([[x0, y0], [x1, y1]]);
  gGraticule.attr("d", path(d3.geoGraticule10()));
  for (const set of provinceSets.values()) set.then((s) => (s.labels = null));
  if (current) {
    if (coastGlow) gCoast.attr("d", path(coastGlow));
    drawLayer(gLayer, current);
    drawLabels(current);
  }
  china.onResize();
}

// ---------- 缩放平移 ----------
//
// 仿 P 社的手感：滚轮带缓动、以鼠标为中心缩放；WASD / 方向键平移，+/- 缩放。
// 远看只有国家色块和国名，拉近后逐渐出现省界和省份名。

const MAX_ZOOM = 60; // 中国视图需要放得更大
const PROVINCE_LABEL_ZOOM = 4; // 从这个倍数开始显示省份名

// 性能关键：直接改 <g> 的 transform 会让浏览器对几百万字符的路径重新排版，
// 每帧上百毫秒。所以手势进行中只给整张 <svg> 加 CSS 变换（GPU 合成，不重排），
// 手势停下约 150ms 后再把变换真正写进 <g> 并更新标签、省界。
// 缩放行为挂在不会被变换的容器 #stage 上，鼠标坐标才不会被 CSS 变换带偏。
const stageSel = d3.select(stage);
const mapWrap = document.getElementById("map-wrap");
let committed = d3.zoomIdentity; // 已经真正绘制到 <g> 上的变换
let commitTimer = null;

function commitTransform() {
  commitTimer = null;
  const t = d3.zoomTransform(stage);
  committed = t;
  world.attr("transform", t);
  mapWrap.style.transform = "";
  zoomK = t.k;
  const lvl = levelFor(t.k);
  const linesOn = t.k >= PROVINCE_LINE_ZOOM;
  if (current && (lvl !== currentLevel || linesOn !== !!gLayer.select(".province-lines").attr("d"))) {
    currentLevel = lvl;
    applyLevel(gLayer, current, lvl);
  }
  if (current) cullToView(gLayer);
  // 放大后才显示省界，避免全图时一片细线
  svg.style("--prov-opacity", Math.max(0, Math.min(1, (zoomK - PROVINCE_LINE_ZOOM) / 2.5)));
  scheduleLabelUpdate();
}

const zoom = d3.zoom()
  .scaleExtent([1, MAX_ZOOM])
  .filter((event) => !event.target.closest?.(".zoom-ctl") && (!event.ctrlKey || event.type === "wheel") && !event.button)
  .on("zoom", (event) => {
    const t = event.transform;
    const k = t.k / committed.k;
    mapWrap.style.transform = `translate(${t.x - committed.x * k}px, ${t.y - committed.y * k}px) scale(${k})`;
    tooltip.hidden = true;
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commitTransform, 150);
  });
stageSel.call(zoom)
// 标签更新比较重，合并到每帧最多一次
let labelFrame = 0;
function scheduleLabelUpdate() {
  if (labelFrame) return;
  labelFrame = requestAnimationFrame(() => {
    labelFrame = 0;
    renderLabels();
    const chinaBoxes = china.render(shownLabels.map((d) => {
      const hw = (textEm(d.text) * d.size) / 2;
      return [d.x - hw, d.y - d.size / 2, d.x + hw, d.y + d.size / 2];
    }));
    renderCities();
    cityBoxes.push(...chinaBoxes);
    updateProvinceLabels();
  });
}

// 平滑滚轮缩放：滚轮只改变目标倍数，每帧向目标逼近一段
const smooth = { target: 1, anchor: null, timer: null };

stageSel.on("wheel", (event) => {
  event.preventDefault();
  const k = d3.zoomTransform(stage).k;
  if (!smooth.timer) smooth.target = k;
  // 触控板的 deltaY 很小、鼠标滚轮很大，统一换算成倍数
  const delta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002);
  smooth.target = Math.max(1, Math.min(MAX_ZOOM, smooth.target * Math.pow(2, Math.max(-0.6, Math.min(0.6, delta)))));
  smooth.anchor = d3.pointer(event, stage);
  if (!smooth.timer) {
    smooth.timer = d3.timer(() => {
      const cur = d3.zoomTransform(stage).k;
      const next = cur + (smooth.target - cur) * 0.22;
      if (Math.abs(smooth.target - cur) < 0.002 * cur) {
        zoom.scaleTo(stageSel, smooth.target, smooth.anchor);
        smooth.timer.stop();
        smooth.timer = null;
        return;
      }
      zoom.scaleTo(stageSel, next, smooth.anchor);
    });
  }
}, { passive: false });

function stopSmoothZoom() {
  if (smooth.timer) {
    smooth.timer.stop();
    smooth.timer = null;
  }
}

const zoomBy = (factor) => {
  stopSmoothZoom();
  stageSel.transition().duration(350).ease(d3.easeCubicOut).call(zoom.scaleBy, factor);
};
document.getElementById("zoom-in").onclick = () => zoomBy(1.8);
document.getElementById("zoom-out").onclick = () => zoomBy(1 / 1.8);
document.getElementById("zoom-reset").onclick = () => {
  stopSmoothZoom();
  stageSel.transition().duration(600).ease(d3.easeCubicInOut).call(zoom.transform, d3.zoomIdentity);
};

// 键盘：WASD / 方向键平移（按住持续移动），+ / - 缩放
const held = new Set();
const PAN_KEYS = {
  w: [0, 1], a: [1, 0], s: [0, -1], d: [-1, 0],
  arrowup: [0, 1], arrowleft: [1, 0], arrowdown: [0, -1], arrowright: [-1, 0],
};
let panTimer = null;

window.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea")) return;
  const key = e.key.toLowerCase();
  if (key === "escape") {
    if (!china.onEscape()) select(null);
    return;
  }
  if (key === "+" || key === "=") return zoomBy(1.5);
  if (key === "-" || key === "_") return zoomBy(1 / 1.5);
  if (!PAN_KEYS[key]) return;
  e.preventDefault();
  held.add(key);
  if (!panTimer) {
    let last = performance.now();
    panTimer = d3.timer(() => {
      const now = performance.now();
      const step = (now - last) * 0.9; // 屏幕像素/毫秒
      last = now;
      let dx = 0;
      let dy = 0;
      for (const k of held) {
        dx += PAN_KEYS[k][0];
        dy += PAN_KEYS[k][1];
      }
      const t = d3.zoomTransform(stage);
      zoom.translateBy(stageSel, (dx * step) / t.k, (dy * step) / t.k);
    });
  }
});
window.addEventListener("keyup", (e) => {
  held.delete(e.key.toLowerCase());
  if (!held.size && panTimer) {
    panTimer.stop();
    panTimer = null;
  }
});
window.addEventListener("blur", () => {
  held.clear();
  panTimer?.stop();
  panTimer = null;
});

// ---------- 中国视图（800 年，点击大唐或其藩镇进入） ----------
const china = createChina({
  svg, world, stage, stageSel, zoom, projection, path, tooltip, zhName, textEm, DATA,
  getSize: () => ({ width, height }),
  getCurrent: () => current,
  clearCountrySelection: () => select(null),
  scheduleLabelUpdate: () => scheduleLabelUpdate(),
});

function zoomToCountry(f) {
  const [[x0, y0], [x1, y1]] = path.bounds(largestPolygon(f.geometry));
  const k = Math.min(10, 0.5 / Math.max((x1 - x0) / width, (y1 - y0) / height));
  const t = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(Math.max(1, k))
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  stageSel.transition().duration(750).call(zoom.transform, t);
}

// ---------- 国家、省份与标签 ----------

function largestPolygon(g) {
  if (g.type !== "MultiPolygon") return g;
  let best = null;
  let bestArea = -1;
  for (const coords of g.coordinates) {
    const poly = { type: "Polygon", coordinates: coords };
    // 绕向反了的小多边形会被算成"整个地球减去它"，取补
    const raw = d3.geoArea(poly);
    const a = raw > 2 * Math.PI ? 4 * Math.PI - raw : raw;
    if (a > bestArea) {
      bestArea = a;
      best = poly;
    }
  }
  return best;
}

// 鼠标下的省份：先用经纬度包围盒粗筛，再精确判断
function provinceAt(event, country) {
  const [x, y] = d3.pointer(event, world.node());
  const ll = projection.invert([x, y]);
  if (!ll) return null;
  for (const i of country.provinces) {
    const f = current.set.provinces[i];
    const [[w, s], [e, n]] = f.properties.bbox;
    if (ll[1] < s || ll[1] > n) continue;
    if (w <= e ? ll[0] < w || ll[0] > e : ll[0] < w && ll[0] > e) continue;
    if (d3.geoContains(f, ll)) return f;
  }
  return null;
}

// 某一级简化程度下的几何，首次用到时生成并缓存
function geomAt(data, key, lvl) {
  const id = `${lvl}|${key}`;
  if (!data.lod.has(id)) {
    let g;
    if (key === "#unclaimed") g = data.merge(data.unclaimedIds, lvl);
    else if (key === "#unknown") g = data.unknownIds.length ? data.merge(data.unknownIds, lvl) : null;
    else if (key === "#lines") g = data.provinceLines(lvl);
    else g = lvl === 2 ? data.byName.get(key).geometry : data.merge(data.byName.get(key).properties.provinces, lvl);
    data.lod.set(id, g);
  }
  return data.lod.get(id);
}

let currentLevel = 0;

// 把图层里所有路径换成指定简化级别的几何
function applyLevel(g, data, lvl) {
  g.select(".unclaimed").attr("d", path(geomAt(data, "#unclaimed", lvl)));
  const unknown = geomAt(data, "#unknown", lvl);
  g.select(".terra-incognita").attr("d", unknown ? path(unknown) : null);
  g.selectAll(".country").attr("d", (d) => path(geomAt(data, d.properties.name, lvl)));
  // 省界只在放大后可见；看不见时不生成路径，免得白白参与排版
  const showLines = d3.zoomTransform(stage).k >= PROVINCE_LINE_ZOOM;
  g.select(".province-lines").attr("d", showLines ? path(geomAt(data, "#lines", lvl)) : null);
}

// 海岸光晕是模糊的，用一份大幅简化的海岸线就够了（全精度海岸线要多排版几十万字符）
let coastGlow = null;
d3.json(`${DATA}coast.json`).then((t) => {
  coastGlow = topojson.mesh(t, Object.values(t.objects)[0]);
  gCoast.attr("d", path(coastGlow));
});

// 拉近后只保留视口附近的国家参与绘制（display:none 的元素不参与排版）
function cullToView(g) {
  const t = d3.zoomTransform(stage);
  if (t.k < LOD_ZOOM[0]) {
    g.selectAll(".country").style("display", null);
    return;
  }
  const mx = width / t.k / 2;
  const my = height / t.k / 2;
  const x0 = t.invertX(0) - mx;
  const x1 = t.invertX(width) + mx;
  const y0 = t.invertY(0) - my;
  const y1 = t.invertY(height) + my;
  g.selectAll(".country").style("display", (d) => {
    const [[a, b], [c, e]] = d.properties.screenBounds;
    return c < x0 || a > x1 || e < y0 || b > y1 ? "none" : null;
  });
}

function drawLayer(g, data) {
  g.selectAll("*").remove();
  for (const f of data.countries) f.properties.screenBounds = path.bounds(f);

  g.append("path").attr("class", "unclaimed");
  if (data.unknown) g.append("path").attr("class", "terra-incognita");

  g.append("g")
    .attr("class", "countries")
    .selectAll("path")
    .data(data.countries, (d) => d.properties.name)
    .join("path")
    .attr("class", (d) => "country" + (d.properties.unorganized ? " unorganized" : ""))
    .classed("selected", (d) => d.properties.name === selected)
    .attr("fill", (d) => d.properties.color)
    .on("mouseenter", (event) => d3.select(event.currentTarget).classed("hover", true))
    .on("mousemove", (event, d) => showTooltip(event, d))
    .on("mouseleave", (event) => {
      d3.select(event.currentTarget).classed("hover", false);
      tooltip.hidden = true;
      gHoverProv.attr("d", null);
    })
    .on("click", (event, d) => {
      event.stopPropagation();
      if (china.onCountryClick(d.properties.name)) return;
      select(d.properties.name);
    });

  g.append("path").attr("class", "province-lines");
  g.select(".countries").selectAll("path.selected").raise();
  applyLevel(g, data, currentLevel);
  cullToView(g);
}

let labelData = []; // 当前年份的国名标签（地图坐标）
let shownLabels = []; // 当前屏幕上显示的国名标签

function drawLabels(data) {
  labelData = data.countries
    .filter((f) => !f.properties.unorganized)
    .map((f) => {
      const poly = largestPolygon(f.geometry);
      const [cx, cy] = path.centroid(poly);
      const area = path.area(poly);
      const text = zhName(f.properties.name);
      // 字号（地图坐标系）：让文字宽度大致等于国土的特征宽度
      const size = Math.min(26, (Math.sqrt(area) * 1.15) / Math.max(textEm(text), 2.5));
      return { name: f.properties.name, text, x: cx, y: cy, size };
    })
    .filter((l) => Number.isFinite(l.x) && l.size > 0.3);
  renderLabels();
}

// 国名标签：字号太小（拥挤）的不画，太大的封顶；按字号从大到小贪心放置，重叠就不画。
// 放大后国家中心常常在屏幕外，此时把国名放到该国在屏幕内可见部分的中间（类似 P 社）。
const LABEL_MIN_PX = 9;
const LABEL_MAX_PX = 56;
const LABEL_FALLBACK_PX = 22;

function renderLabels() {
  const t = d3.zoomTransform(stage);
  const k = t.k;
  const [x0, x1] = [t.invertX(0), t.invertX(width)];
  const [y0, y1] = [t.invertY(0), t.invertY(height)];
  const overlaps = (box, list) => list.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
  const boxOf = (d) => {
    const hw = (textEm(d.text) * d.size) / 2 + 2 / k;
    return [d.x - hw, d.y - d.size / 2, d.x + hw, d.y + d.size / 2];
  };

  const candidates = [...labelData.filter((d) => !china.hidesLabel(d.name)), ...china.labelEntries()]
    .filter((d) => d.size * k >= LABEL_MIN_PX && d.x > x0 && d.x < x1 && d.y > y0 && d.y < y1)
    .map((d) => ({ ...d, size: Math.min(d.size, (d.maxPx ?? LABEL_MAX_PX) / k) }))
    .sort((a, b) => b.size - a.size);

  const placed = [];
  shownLabels = [];
  const shown = new Set();
  for (const d of candidates) {
    const box = boxOf(d);
    if (overlaps(box, placed)) continue;
    placed.push(box);
    shownLabels.push(d);
    shown.add(d.name);
  }

  // 补位：屏幕里看得见、但国名锚点不在屏幕内的国家（含部落等未建制地区）
  if (current && k >= 2) {
    const size = LABEL_FALLBACK_PX / k;
    for (const f of current.countries) {
      const p = f.properties;
      if (shown.has(p.name) || china.hidesLabel(p.name)) continue;
      const [[bx0, by0], [bx1, by1]] = p.screenBounds;
      const rx0 = Math.max(bx0, x0), rx1 = Math.min(bx1, x1);
      const ry0 = Math.max(by0, y0), ry1 = Math.min(by1, y1);
      if (rx1 - rx0 < 80 / k || ry1 - ry0 < 30 / k) continue; // 露出的部分太小
      // 在可见矩形里由中心向外找一个落在该国境内的点
      let spot = null;
      for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.3, 0.3], [0.7, 0.7], [0.3, 0.7], [0.7, 0.3]]) {
        const x = rx0 + (rx1 - rx0) * fx;
        const y = ry0 + (ry1 - ry0) * fy;
        const ll = projection.invert([x, y]);
        if (ll && d3.geoContains(f, ll)) {
          spot = [x, y];
          break;
        }
      }
      if (!spot) continue;
      const d = { name: p.name, text: zhName(p.name), x: spot[0], y: spot[1], size, unorganized: p.unorganized };
      const box = boxOf(d);
      if (overlaps(box, placed)) continue;
      placed.push(box);
      shownLabels.push(d);
    }
  }

  gLabels.selectAll("text")
    .data(shownLabels, (d) => d.name)
    .join("text")
    .attr("class", (d) => "label" + (d.unorganized ? " unorganized" : "") + (d.circuit ? " circuit" : ""))
    .attr("x", (d) => t.applyX(d.x))
    .attr("y", (d) => t.applyY(d.y))
    .attr("font-size", (d) => d.size * k)
    .text((d) => d.text);
}

// ---------- 首都与城市 ----------
//
// 首都（金色菱形）任何缩放都画，放大后显示名字；普通城市（圆点）放大后才出现。
// 名字避开国名，避不开就只画标记。
const CAPITAL_NAME_ZOOM = 1.8;
const CITY_ZOOM = 2.5;
const CITY_NAME_ZOOM = 3.5;
let cityBoxes = []; // 城市名占用的区域（地图坐标），省份名要避开

function renderCities() {
  if (!current) return;
  const t = d3.zoomTransform(stage);
  const k = t.k;
  const placed = shownLabels.map((d) => {
    const hw = (textEm(d.text) * d.size) / 2;
    return [t.applyX(d.x - hw), t.applyY(d.y - d.size / 2), t.applyX(d.x + hw), t.applyY(d.y + d.size / 2)];
  });
  const items = [];
  cityBoxes = [];
  // 首都优先放置名字
  const ordered = [...current.cities].sort((a, b) => b.capital - a.capital);
  for (const c of ordered) {
    if (!c.capital && k < CITY_ZOOM) continue;
    if (china.hidesCity(c.country)) continue;
    const [mx, my] = projection([c.lon, c.lat]);
    const x = t.applyX(mx);
    const y = t.applyY(my);
    if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;
    const item = { ...c, x, y, showName: false };
    if (k >= (c.capital ? CAPITAL_NAME_ZOOM : CITY_NAME_ZOOM)) {
      const fs = c.capital ? 12 : 11;
      const w = textEm(c.name) * fs;
      const box = [x + 6, y - fs * 0.7, x + 8 + w, y + fs * 0.7];
      if (!placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) {
        placed.push(box);
        cityBoxes.push([t.invertX(box[0] - 8), t.invertY(box[1]), t.invertX(box[2]), t.invertY(box[3])]);
        item.showName = true;
      }
    }
    items.push(item);
  }

  const g = gCities.selectAll("g.city")
    .data(items, (d) => d.name + d.lon)
    .join((enter) => {
      const e = enter.append("g").attr("class", (d) => "city" + (d.capital ? " capital" : ""));
      e.append((d) => document.createElementNS("http://www.w3.org/2000/svg", d.capital ? "rect" : "circle"));
      e.append("text").attr("class", "city-name").attr("x", 8).attr("dy", "0.35em").text((d) => d.name);
      return e;
    })
    .attr("transform", (d) => `translate(${d.x},${d.y})`);
  g.select("rect").attr("x", -3.5).attr("y", -3.5).attr("width", 7).attr("height", 7).attr("transform", "rotate(45)");
  g.select("circle").attr("r", 2.6);
  g.select("text").attr("display", (d) => (d.showName ? null : "none"));
}

// ---------- 省份名（放大后显示） ----------

// 同一个行政区切出来的几块省份同名，只在面积最大的那块上标名字；
// 整个国家只有一块的（whole），省份名就是国名，不重复标
function computeProvinceLabels(set) {
  const best = new Map();
  for (const f of set.provinces) {
    const p = f.properties;
    if (p.whole) continue;
    const key = `${p.adm0_a3}|${p.label}`;
    if (!best.has(key) || p.areaKm2 > best.get(key).properties.areaKm2) best.set(key, f);
  }
  set.labels = [...best.values()].map((f) => {
    const [x, y] = path.centroid(largestPolygon(f.geometry));
    const text = f.properties.label;
    const size = Math.min(3.2, (Math.sqrt(path.area(f)) * 0.75) / Math.max(textEm(text), 2));
    return { id: f.properties.index, text, x, y, size };
  }).filter((l) => l.text && Number.isFinite(l.x));
}

// 只渲染视口内、屏幕字号合适且互不重叠的省份名，避免一次插入几千个节点
function updateProvinceLabels() {
  if (zoomK < PROVINCE_LABEL_ZOOM || !current) {
    gProvLabels.selectAll("text").remove();
    return;
  }
  if (!current.set.labels) computeProvinceLabels(current.set);
  const t = d3.zoomTransform(stage);
  const [x0, x1] = [t.invertX(0), t.invertX(width)];
  const [y0, y1] = [t.invertY(0), t.invertY(height)];
  const hidden = (id) => current.owner[id] === -2;

  // 国名占用的区域也要避开
  const placed = [];
  for (const d of shownLabels) {
    const hw = (textEm(d.text) * d.size) / 2;
    placed.push([d.x - hw, d.y - d.size / 2, d.x + hw, d.y + d.size / 2]);
  }
  placed.push(...cityBoxes);

  const visible = [];
  for (const d of current.set.labels) {
    if (d.x < x0 || d.x > x1 || d.y < y0 || d.y > y1 || hidden(d.id)) continue;
    // 字号太小的不画；大省份的字号封顶 18px（而不是不画）
    if (d.size * zoomK < 9) continue;
    const size = Math.min(d.size, 18 / zoomK);
    const hw = (textEm(d.text) * size) / 2 + 1 / zoomK;
    const box = [d.x - hw, d.y - size / 2, d.x + hw, d.y + size / 2];
    if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    visible.push({ ...d, size });
  }

  gProvLabels.selectAll("text")
    .data(visible, (d) => d.id)
    .join("text")
    .attr("class", "province-label")
    .attr("x", (d) => t.applyX(d.x))
    .attr("y", (d) => t.applyY(d.y))
    .attr("font-size", (d) => d.size * zoomK)
    .text((d) => d.text);
}

function showTooltip(event, d) {
  const p = d.properties;
  const zh = zhName(p.name);
  const prov = provinceAt(event, p);
  gHoverProv.attr("d", prov && !prov.properties.whole ? path(prov) : null);
  tooltip.innerHTML =
    (prov && !prov.properties.whole ? `<span class="prov">${prov.properties.label}</span>` : "") +
    `<strong>${zh}</strong>` +
    (zh !== p.name ? `<span class="orig">${p.name}</span>` : "") +
    (p.overlord ? `<span class="sub">${relationText(p)}</span>` : "");
  const rect = stage.getBoundingClientRect();
  tooltip.style.left = `${event.clientX - rect.left + 14}px`;
  tooltip.style.top = `${event.clientY - rect.top + 14}px`;
  tooltip.hidden = false;
}

// ---------- 切换年份 ----------

async function setYear(year) {
  const bm = BOOKMARKS.find((b) => b.year === year) ?? BOOKMARKS[0];
  china.onYearChange(bm.year);
  d3.selectAll("#bookmarks button").classed("active", (d) => d.year === bm.year);
  document.getElementById("era-year").textContent = bm.year;
  document.getElementById("era-title").textContent = bm.title;
  document.getElementById("era-desc").textContent = bm.desc;

  const loading = document.getElementById("loading");
  loading.hidden = false;
  const data = await loadYear(bm);
  loading.hidden = true;
  if (current === data) return;
  current = data;

  // 如果原来选中的国家在这个年份还存在，就保持选中
  if (selected && !data.byName.has(selected)) selected = null;

  // 新旧两层交叉淡入淡出
  const oldLayer = gLayer;
  gLayer = world.insert("g", ".hover-province").attr("class", "year-layer").attr("opacity", 0);
  drawLayer(gLayer, data);
  drawLabels(data);

  const t = d3.transition().duration(450);
  gLayer.transition(t).attr("opacity", 1);
  oldLayer.transition(t).attr("opacity", 0).remove();
  gLabels.attr("opacity", 0).transition(t).attr("opacity", 1);

  select(selected);
  scheduleLabelUpdate();
}

// ---------- 选择国家 ----------

function select(name, { zoom: doZoom = false } = {}) {
  selected = name;
  const f = name ? current.byName.get(name) : null;

  svg.classed("has-selection", !!f);
  const paths = gLayer.selectAll(".country").classed("selected", (d) => d.properties.name === name);
  paths.filter(".selected").raise();

  document.getElementById("panel-empty").hidden = !!f;
  document.getElementById("panel-country").hidden = !f;
  updateHash();
  if (!f) return;

  const p = f.properties;
  const zh = zhName(p.name);
  document.getElementById("c-name").textContent = zh;
  document.getElementById("c-orig").textContent = zh !== p.name ? p.name : "";
  document.getElementById("c-overlord-label").textContent = p.relation === "union" ? "共主邦联" : "宗主";
  document.getElementById("c-overlord").textContent = p.overlord
    ? (p.relation === "union" ? `与${zhName(p.overlord)}共主` : zhName(p.overlord))
    : "独立";

  // 本国的附庸与共主邦联
  const subjects = current.countries
    .map((f) => f.properties)
    .filter((c) => c.overlord === p.name)
    .sort((a, b) => b.areaKm2 - a.areaKm2);
  d3.select("#c-subjects-block").property("hidden", !subjects.length);
  d3.select("#c-subjects")
    .selectAll("li")
    .data(subjects, (d) => d.name)
    .join("li")
    .html((d) => `<span class="swatch" style="background:${d.color}"></span>${zhName(d.name)}${d.relation === "union" ? "（共主）" : ""}`)
    .on("click", (_, d) => select(d.name, { zoom: true }));
  document.getElementById("c-provinces").textContent = p.provinces.length;
  document.getElementById("c-capital").textContent = p.capital ?? "—";
  document.getElementById("c-area").textContent = `${Math.round(p.areaKm2).toLocaleString("zh-CN")} km²`;
  document.getElementById("c-rank").textContent = p.unorganized ? "—" : `第 ${p.rank} / ${current.total}`;

  const shield = document.getElementById("shield");
  shield.style.setProperty("--shield-color", p.color);
  shield.textContent = [...zh][0];

  const ul = d3.select("#c-neighbors");
  ul.selectAll("li").remove();
  ul.selectAll("li")
    .data(p.neighbors)
    .join("li")
    .html((d) => `<span class="swatch" style="background:${current.byName.get(d).properties.color}"></span>${zhName(d)}`)
    .on("click", (_, d) => select(d, { zoom: true }));
  if (!p.neighbors.length) ul.append("li").attr("class", "none").text("无陆上邻国");

  if (doZoom) zoomToCountry(f);
}

svg.on("click", () => {
  if (!china.onBackgroundClick()) select(null);
});
document.getElementById("deselect").onclick = () => select(null);
document.getElementById("play").onclick = () => {
  const toast = document.getElementById("toast");
  toast.textContent = `你选择了 ${zhName(selected)}，开局时间 ${current.year} 年。`;
  toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toast.hidden = true), 2600);
};

// ---------- URL 状态：#1492/Castille ----------

function updateHash() {
  if (!current) return;
  const h = `#${current.year}` + (selected ? `/${encodeURIComponent(selected)}` : "");
  if (location.hash !== h) history.replaceState(null, "", h);
}

function readHash() {
  const [y, n] = location.hash.slice(1).split("/");
  return { year: Number(y) || DEFAULT_YEAR, name: n ? decodeURIComponent(n) : null };
}

// ---------- 启动 ----------

d3.select("#bookmarks")
  .selectAll("button")
  .data(BOOKMARKS)
  .join("button")
  .html((d) => `<span class="y">${d.year}</span><span class="t">${d.title}</span>`)
  .on("click", (_, d) => setYear(d.year));

async function init() {
  resize();
  const { year, name } = readHash();
  await setYear(year);
  if (name && current.byName.has(name)) select(name, { zoom: true });
  // 后台预加载其他年份，切换时更顺滑
  BOOKMARKS.forEach((b) => loadYear(b));
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 150);
});

init();
