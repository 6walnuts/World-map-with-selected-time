import * as d3 from "d3";
import * as topojson from "topojson-client";
import {
  BOOKMARKS,
  DEFAULT_YEAR,
  FIXED_COLORS,
  ZH_NAMES,
  UNORGANIZED_RE,
  NEW_WORLD_MAX_LON,
  NOMINAL_OVERLORDS,
} from "./config.js";
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

// 附庸 / 殖民地用宗主国颜色的浅色版，类似 P 社的殖民国家
function countryColor(c) {
  if (c.unorganized) return "#cdbf98";
  if (FIXED_COLORS[c.name]) return FIXED_COLORS[c.name];
  if (c.overlord && !NOMINAL_OVERLORDS.has(c.overlord)) return d3.interpolateRgb(baseColor(c.overlord), "#f4ecd8")(0.35);
  return hashColor(c.name);
}

// ---------- 名称 ----------

const zhName = (name) => ZH_NAMES[name] ?? name;

// 估算文字宽度（以 em 计）：中文约 1em，拉丁字母约 0.62em
function textEm(s) {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.62;
  return w;
}

// ---------- 省份底图（与年份无关，只加载一次） ----------

const base = {
  topo: null,
  geoms: null, // TopoJSON 里的省份几何对象
  provinces: null, // GeoJSON features
  neighbors: null,
  coast: null, // 海岸线（省份的外边界）
};

async function loadBase() {
  const topo = await d3.json(`${DATA}provinces.json`);
  const obj = Object.values(topo.objects)[0];
  base.topo = topo;
  base.geoms = obj.geometries;
  base.geoms.forEach((g, i) => (g.index = i));
  base.provinces = topojson.feature(topo, obj).features;
  base.neighbors = topojson.neighbors(obj.geometries);
  base.coast = topojson.mesh(topo, obj, (a, b) => a === b);

  base.provinces.forEach((f, i) => {
    const p = f.properties;
    p.index = i;
    p.label = p.name_zh || p.name;
    p.areaKm2 = d3.geoArea(f) * EARTH_RADIUS_KM ** 2;
    p.newWorld = d3.geoCentroid(f)[0] < NEW_WORLD_MAX_LON;
    p.bbox = d3.geoBounds(f);
  });
}

// ---------- 每个年份的归属表 ----------

const cache = new Map();

async function loadYear(bm) {
  if (cache.has(bm.year)) return cache.get(bm.year);
  const raw = await d3.json(`${DATA}owners_${bm.year}.json`);

  const countries = raw.countries.map((c, id) => {
    const p = {
      id,
      name: c.name,
      overlord: c.overlord ?? null,
      unorganized: UNORGANIZED_RE.test(c.name),
      provinces: [],
      areaKm2: 0,
    };
    p.color = countryColor(p);
    return p;
  });

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

  const merge = (ids) => topojson.merge(base.topo, ids.map((i) => base.geoms[i]));

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

  const result = {
    year: bm.year,
    owner,
    countries: features,
    byName: new Map(features.map((f) => [f.properties.name, f])),
    total: ranked.length,
    unclaimed: merge(unclaimed),
    unknown: unknown.length ? merge(unknown) : null,
    // 同一国家内部的省界（细线）
    provinceLines: topojson.mesh(base.topo, { type: "GeometryCollection", geometries: base.geoms },
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

const ocean = defs.append("radialGradient").attr("id", "ocean-grad").attr("cx", "50%").attr("cy", "45%").attr("r", "75%");
ocean.append("stop").attr("offset", "0%").attr("stop-color", "#36606f");
ocean.append("stop").attr("offset", "100%").attr("stop-color", "#1a3340");

// 羊皮纸噪点纹理
const paper = defs.append("filter").attr("id", "paper").attr("x", 0).attr("y", 0).attr("width", "100%").attr("height", "100%");
paper.append("feTurbulence").attr("type", "fractalNoise").attr("baseFrequency", 0.85).attr("numOctaves", 3).attr("seed", 7);
paper.append("feColorMatrix").attr("values", "0 0 0 0 0.45  0 0 0 0 0.35  0 0 0 0 0.2  0 0 0 0.55 0");
paper.append("feComposite").attr("in2", "SourceGraphic").attr("operator", "in");

// 海岸浅水的柔光
const glow = defs.append("filter").attr("id", "coast-glow").attr("x", "-5%").attr("y", "-5%").attr("width", "110%").attr("height", "110%");
glow.append("feGaussianBlur").attr("stdDeviation", 2.5);

// 未知之地：斜线阴影
const fog = defs.append("pattern").attr("id", "terra-incognita").attr("width", 6).attr("height", 6)
  .attr("patternUnits", "userSpaceOnUse").attr("patternTransform", "rotate(35)");
fog.append("rect").attr("width", 6).attr("height", 6).attr("fill", "#3e3527");
fog.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 6).attr("stroke", "#4b402f").attr("stroke-width", 2);

const oceanRect = svg.append("rect").attr("class", "ocean").attr("fill", "url(#ocean-grad)");
const world = svg.append("g").attr("class", "world");
const gGraticule = world.append("path").attr("class", "graticule");
const gCoast = world.append("path").attr("class", "coast-glow").attr("filter", "url(#coast-glow)");
let gLayer = world.append("g").attr("class", "year-layer");
const gHoverProv = world.append("path").attr("class", "hover-province");
let gLabels = world.append("g").attr("class", "labels");
const paperRect = svg.append("rect").attr("class", "paper").attr("filter", "url(#paper)");
const vignette = svg.append("rect").attr("class", "vignette");

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
  oceanRect.attr("width", width).attr("height", height);
  paperRect.attr("width", width).attr("height", height);
  vignette.attr("width", width).attr("height", height);

  const corners = { type: "MultiPoint", coordinates: [[-180, LAT_TOP], [180, LAT_BOTTOM]] };
  projection.clipExtent(null).fitSize([width, height], corners);
  const [x0, y0] = projection([-180, LAT_TOP]);
  const [x1, y1] = projection([180, LAT_BOTTOM]);
  projection.clipExtent([[x0, y0], [x1, y1]]);

  zoom.translateExtent([[x0, y0], [x1, y1]]);
  gGraticule.attr("d", path(d3.geoGraticule10()));
  if (base.coast) gCoast.attr("d", path(base.coast));
  if (current) {
    drawLayer(gLayer, current);
    drawLabels(gLabels, current);
  }
}

// ---------- 缩放平移 ----------

const zoom = d3.zoom()
  .scaleExtent([1, 20])
  .on("zoom", (event) => {
    world.attr("transform", event.transform);
    zoomK = event.transform.k;
    // 放大后才显示省界，避免全图时一片细线
    svg.style("--prov-opacity", Math.max(0, Math.min(1, (zoomK - 1.6) / 2.5)));
    updateLabelVisibility(gLabels);
  });
svg.call(zoom).on("dblclick.zoom", null);

document.getElementById("zoom-in").onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1.6);
document.getElementById("zoom-out").onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.6);
document.getElementById("zoom-reset").onclick = () => svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);

function zoomToCountry(f) {
  const [[x0, y0], [x1, y1]] = path.bounds(largestPolygon(f.geometry));
  const k = Math.min(10, 0.5 / Math.max((x1 - x0) / width, (y1 - y0) / height));
  const t = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(Math.max(1, k))
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  svg.transition().duration(750).call(zoom.transform, t);
}

// ---------- 国家、省份与标签 ----------

function largestPolygon(g) {
  if (g.type !== "MultiPolygon") return g;
  let best = null;
  let bestArea = -1;
  for (const coords of g.coordinates) {
    const poly = { type: "Polygon", coordinates: coords };
    const a = d3.geoArea(poly);
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
    const f = base.provinces[i];
    const [[w, s], [e, n]] = f.properties.bbox;
    if (ll[1] < s || ll[1] > n) continue;
    if (w <= e ? ll[0] < w || ll[0] > e : ll[0] < w && ll[0] > e) continue;
    if (d3.geoContains(f, ll)) return f;
  }
  return null;
}

function drawLayer(g, data) {
  g.selectAll("*").remove();

  g.append("path").attr("class", "unclaimed").attr("d", path(data.unclaimed));
  if (data.unknown) g.append("path").attr("class", "terra-incognita").attr("d", path(data.unknown));

  g.append("g")
    .attr("class", "countries")
    .selectAll("path")
    .data(data.countries, (d) => d.properties.name)
    .join("path")
    .attr("class", (d) => "country" + (d.properties.unorganized ? " unorganized" : ""))
    .classed("selected", (d) => d.properties.name === selected)
    .attr("d", path)
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
      select(d.properties.name);
    });

  g.append("path").attr("class", "province-lines").attr("d", path(data.provinceLines));
  g.select(".countries").selectAll("path.selected").raise();
}

function drawLabels(g, data) {
  const labels = data.countries
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

  g.selectAll("text")
    .data(labels, (d) => d.name)
    .join("text")
    .attr("class", "label")
    .attr("x", (d) => d.x)
    .attr("y", (d) => d.y)
    .attr("font-size", (d) => d.size)
    .text((d) => d.text);

  updateLabelVisibility(g);
}

// 屏幕上字号太小（拥挤）或太大（喧宾夺主）的标签隐藏；
// 剩下的按字号从大到小贪心放置，和已放置的标签重叠就隐藏
function updateLabelVisibility(g) {
  const texts = g.selectAll("text");
  const candidates = texts.data()
    .filter((d) => {
      const px = d.size * zoomK;
      return px >= 9 && px <= 64;
    })
    .sort((a, b) => b.size - a.size);

  const placed = [];
  const visible = new Set();
  for (const d of candidates) {
    const hw = (textEm(d.text) * d.size) / 2 + 2 / zoomK;
    const hh = d.size / 2;
    const box = [d.x - hw, d.y - hh, d.x + hw, d.y + hh];
    const hit = placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    if (!hit) {
      placed.push(box);
      visible.add(d.name);
    }
  }
  texts.classed("hidden", (d) => !visible.has(d.name));
}

function showTooltip(event, d) {
  const p = d.properties;
  const zh = zhName(p.name);
  const prov = provinceAt(event, p);
  gHoverProv.attr("d", prov ? path(prov) : null);
  tooltip.innerHTML =
    (prov ? `<span class="prov">${prov.properties.label}</span>` : "") +
    `<strong>${zh}</strong>` +
    (zh !== p.name ? `<span class="orig">${p.name}</span>` : "") +
    (p.overlord ? `<span class="sub">附属于 ${zhName(p.overlord)}</span>` : "");
  const rect = stage.getBoundingClientRect();
  tooltip.style.left = `${event.clientX - rect.left + 14}px`;
  tooltip.style.top = `${event.clientY - rect.top + 14}px`;
  tooltip.hidden = false;
}

// ---------- 切换年份 ----------

async function setYear(year) {
  const bm = BOOKMARKS.find((b) => b.year === year) ?? BOOKMARKS[0];
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
  const oldLabels = gLabels;
  gLayer = world.insert("g", ".hover-province").attr("class", "year-layer").attr("opacity", 0);
  gLabels = world.append("g").attr("class", "labels").attr("opacity", 0);
  drawLayer(gLayer, data);
  drawLabels(gLabels, data);

  const t = d3.transition().duration(450);
  gLayer.transition(t).attr("opacity", 1);
  gLabels.transition(t).attr("opacity", 1);
  oldLayer.transition(t).attr("opacity", 0).remove();
  oldLabels.transition(t).attr("opacity", 0).remove();

  select(selected);
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
  document.getElementById("c-overlord").textContent = p.overlord ? zhName(p.overlord) : "独立";
  document.getElementById("c-provinces").textContent = p.provinces.length;
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

svg.on("click", () => select(null));
document.getElementById("deselect").onclick = () => select(null);
document.getElementById("play").onclick = () => {
  const toast = document.getElementById("toast");
  toast.textContent = `你选择了 ${zhName(selected)}，开局时间 ${current.year} 年。`;
  toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toast.hidden = true), 2600);
};

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") select(null);
});

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
  await loadBase();
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
