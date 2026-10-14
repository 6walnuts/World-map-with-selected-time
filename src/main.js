import * as d3 from "d3";
import * as topojson from "topojson-client";
import { BOOKMARKS, DEFAULT_YEAR, FIXED_COLORS, ZH_NAMES, UNORGANIZED_RE } from "./config.js";
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

function isValidOverlord(name, overlord) {
  const o = overlord?.trim();
  return o && o !== name && !o.startsWith("(");
}

// 附庸 / 殖民地用宗主国颜色的浅色版，类似 P 社的殖民国家
function countryColor(p) {
  if (p.unorganized) return "#cdbf98";
  if (FIXED_COLORS[p.name]) return FIXED_COLORS[p.name];
  if (p.overlord) return d3.interpolateRgb(baseColor(p.overlord), "#f4ecd8")(0.35);
  return hashColor(p.name);
}

// ---------- 名称 ----------

const zhName = (name) => ZH_NAMES[name] ?? name;

// 估算文字宽度（以 em 计）：中文约 1em，拉丁字母约 0.62em
function textEm(s) {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.62;
  return w;
}

// ---------- 数据加载 ----------

// d3-geo 按球面绕向判断多边形内外：绕反了的多边形会被当成"整个地球减去它"。
// 简化工具偶尔会产出这种多边形，这里把面积超过半个球面的多边形反转回来。
function fixWinding(geometry) {
  if (!geometry) return geometry;
  const fixPolygon = (rings) => {
    const area = d3.geoArea({ type: "Polygon", coordinates: rings });
    return area > 2 * Math.PI ? rings.map((r) => r.slice().reverse()) : rings;
  };
  if (geometry.type === "Polygon") geometry.coordinates = fixPolygon(geometry.coordinates);
  if (geometry.type === "MultiPolygon") geometry.coordinates = geometry.coordinates.map(fixPolygon);
  return geometry;
}

const cache = new Map();

async function loadYear(year) {
  if (cache.has(year)) return cache.get(year);
  const topo = await d3.json(`${DATA}world_${year}.json`);
  const obj = Object.values(topo.objects)[0];
  const features = topojson.feature(topo, obj).features;
  const neighbors = topojson.neighbors(obj.geometries);

  const countries = [];
  features.forEach((f, i) => {
    const name = f.properties.NAME?.trim();
    if (!name || !f.geometry) return;
    fixWinding(f.geometry);
    const overlordRaw = f.properties.SUBJECTO?.trim();
    const p = {
      name,
      overlord: isValidOverlord(name, overlordRaw) ? overlordRaw : null,
      unorganized: UNORGANIZED_RE.test(name),
      areaKm2: d3.geoArea(f) * EARTH_RADIUS_KM ** 2,
      index: i,
    };
    p.color = countryColor(p);
    f.properties = p;
    countries.push(f);
  });

  const byIndex = new Map(countries.map((f) => [f.properties.index, f]));
  for (const f of countries) {
    f.properties.neighbors = neighbors[f.properties.index]
      .map((j) => byIndex.get(j))
      .filter(Boolean)
      .map((n) => n.properties.name);
  }

  const ranked = countries.filter((f) => !f.properties.unorganized)
    .sort((a, b) => b.properties.areaKm2 - a.properties.areaKm2);
  ranked.forEach((f, i) => (f.properties.rank = i + 1));

  const result = {
    year,
    countries,
    byName: new Map(countries.map((f) => [f.properties.name, f])),
    total: ranked.length,
  };
  cache.set(year, result);
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

const oceanRect = svg.append("rect").attr("class", "ocean").attr("fill", "url(#ocean-grad)");
const world = svg.append("g").attr("class", "world");
const gGraticule = world.append("path").attr("class", "graticule");
const gCoast = world.append("path").attr("class", "coast-glow").attr("filter", "url(#coast-glow)");
const gLand = world.append("path").attr("class", "land");
let gCountries = world.append("g").attr("class", "countries");
let gLabels = world.append("g").attr("class", "labels");
const paperRect = svg.append("rect").attr("class", "paper").attr("filter", "url(#paper)");
const vignette = svg.append("rect").attr("class", "vignette");

const projection = d3.geoMercator();
const path = d3.geoPath(projection);

let width = 0;
let height = 0;
let land = null;
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
  if (land) {
    gLand.attr("d", path(land));
    gCoast.attr("d", path(land));
  }
  if (current) {
    gCountries.selectAll("path").attr("d", path);
    drawLabels(gLabels, current);
  }
}

// ---------- 缩放平移 ----------

const zoom = d3.zoom()
  .scaleExtent([1, 14])
  .on("zoom", (event) => {
    world.attr("transform", event.transform);
    zoomK = event.transform.k;
    updateLabelVisibility(gLabels);
  });
svg.call(zoom).on("dblclick.zoom", null);

document.getElementById("zoom-in").onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1.6);
document.getElementById("zoom-out").onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.6);
document.getElementById("zoom-reset").onclick = () => svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);

function zoomToCountry(f) {
  const [[x0, y0], [x1, y1]] = path.bounds(largestPolygon(f));
  const k = Math.min(8, 0.5 / Math.max((x1 - x0) / width, (y1 - y0) / height));
  const t = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(Math.max(1, k))
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  svg.transition().duration(750).call(zoom.transform, t);
}

// ---------- 国家与标签 ----------

function largestPolygon(f) {
  const g = f.geometry;
  if (g.type !== "MultiPolygon") return f;
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

function drawCountries(g, data) {
  g.selectAll("path")
    .data(data.countries, (d) => d.properties.name)
    .join("path")
    .attr("class", (d) => "country" + (d.properties.unorganized ? " unorganized" : ""))
    .attr("d", path)
    .attr("fill", (d) => d.properties.color)
    .on("mouseenter", (event, d) => {
      d3.select(event.currentTarget).classed("hover", true);
      showTooltip(event, d);
    })
    .on("mousemove", (event, d) => showTooltip(event, d))
    .on("mouseleave", (event) => {
      d3.select(event.currentTarget).classed("hover", false);
      tooltip.hidden = true;
    })
    .on("click", (event, d) => {
      event.stopPropagation();
      select(d.properties.name, { zoom: false });
    });
}

function drawLabels(g, data) {
  const labels = data.countries
    .filter((f) => !f.properties.unorganized)
    .map((f) => {
      const poly = largestPolygon(f);
      const [cx, cy] = path.centroid(poly);
      const area = path.area(poly);
      const text = zhName(f.properties.name);
      // 字号（地图坐标系）：让文字宽度大致等于国土的特征宽度
      const size = Math.min(26, (Math.sqrt(area) * 1.15) / Math.max(textEm(text), 2.5));
      return { name: f.properties.name, text, x: cx, y: cy, size };
    })
    .filter((l) => Number.isFinite(l.x) && l.size > 0.4);

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
  tooltip.innerHTML =
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
  const data = await loadYear(bm.year);
  loading.hidden = true;
  if (current === data) return;
  current = data;

  // 新旧两层交叉淡入淡出
  const oldCountries = gCountries;
  const oldLabels = gLabels;
  gCountries = world.insert("g", ".labels").attr("class", "countries").attr("opacity", 0);
  gLabels = world.append("g").attr("class", "labels").attr("opacity", 0);
  drawCountries(gCountries, data);
  drawLabels(gLabels, data);

  const t = d3.transition().duration(450);
  gCountries.transition(t).attr("opacity", 1);
  gLabels.transition(t).attr("opacity", 1);
  oldCountries.transition(t).attr("opacity", 0).remove();
  oldLabels.transition(t).attr("opacity", 0).remove();

  // 如果原来选中的国家在这个年份还存在，就保持选中
  select(selected && data.byName.has(selected) ? selected : null, { zoom: false });
}

// ---------- 选择国家 ----------

function select(name, { zoom: doZoom = false } = {}) {
  selected = name;
  const f = name ? current.byName.get(name) : null;

  svg.classed("has-selection", !!f);
  gCountries.selectAll("path").classed("selected", (d) => d.properties.name === name);
  gCountries.selectAll("path.selected").raise();

  document.getElementById("panel-empty").hidden = !!f;
  document.getElementById("panel-country").hidden = !f;
  updateHash();
  if (!f) return;

  const p = f.properties;
  const zh = zhName(p.name);
  document.getElementById("c-name").textContent = zh;
  document.getElementById("c-orig").textContent = zh !== p.name ? p.name : "";
  document.getElementById("c-overlord").textContent = p.overlord ? zhName(p.overlord) : "独立";
  document.getElementById("c-area").textContent = `${Math.round(p.areaKm2).toLocaleString("zh-CN")} km²`;
  document.getElementById("c-rank").textContent = p.unorganized ? "—" : `第 ${p.rank} / ${current.total}`;

  const shield = document.getElementById("shield");
  shield.style.setProperty("--shield-color", p.color);
  shield.textContent = [...zh][0];

  const ul = d3.select("#c-neighbors");
  const neighbors = p.neighbors.length ? p.neighbors : [];
  ul.selectAll("li")
    .data(neighbors, (d) => d)
    .join("li")
    .html((d) => {
      const nf = current.byName.get(d);
      return `<span class="swatch" style="background:${nf.properties.color}"></span>${zhName(d)}`;
    })
    .on("click", (_, d) => select(d, { zoom: true }));
  if (!neighbors.length) ul.append("li").attr("class", "none").text("无陆上邻国");

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
  const landTopo = await d3.json(`${DATA}land.json`);
  land = topojson.feature(landTopo, landTopo.objects.land);
  for (const f of land.features ?? [land]) fixWinding(f.geometry);
  resize();
  const { year, name } = readHash();
  await setYear(year);
  if (name && current.byName.has(name)) select(name, { zoom: true });
  // 后台预加载其他年份，切换时更顺滑
  BOOKMARKS.forEach((b) => loadYear(b.year));
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 150);
});

init();
