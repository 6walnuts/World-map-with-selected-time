// 大唐（800 年）地图界面：MapLibre GL 引擎。
//   - 地形：Terrarium 高程瓦片（AWS 开放数据）做三维地形与山体阴影，拉近时自动加载更细的瓦片
//   - 底图：Sentinel-2 无云卫星影像（EOX，2016 版，CC BY 4.0），加做旧调色；
//           自绘的写实 / 青绿地表（terrain-art.js）垫在下面，卫星图取不到时也有底色，青绿模式只用它
//   - 方镇、州、他国、河湖、运河、城池（立体拉伸）为矢量图层
//   - 河流流动、漕船、季风、番舶、云画在上方的透明画布上（tang-fx.js）
// 做旧调色与山影参数参考 MapStage（https://github.com/hopechen067/MapStage，MIT）的 antique-default 预设。
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as d3 from "d3";
import { analyzeTerrain, paintTerrainArt } from "./terrain-art.js";
import { createFx, SEA_ROUTE_LINES } from "./tang-fx.js";

const CAPITALS = { 京兆府: "长安", 河南府: "洛阳" };
const DEM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const SAT_TILES = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg";
const OVERVIEW = { center: [111, 32.6], zoom: 4.35, pitch: 42, bearing: 0 };

// 地图模式：卫星图、自绘底图、方镇色块、山影的强度与整体调色
const MODES = {
  political: { sat: 0.72, pref: 0.38, foreign: 0.2, hill: 0.42, art: "real", filter: "sepia(0.08) saturate(0.98) contrast(1.03)" },
  terrain: { sat: 0.92, pref: 0.07, foreign: 0, hill: 0.5, art: "real", filter: "sepia(0.06) saturate(1.02) contrast(1.04)" },
  qinglv: { sat: 0, pref: 0.05, foreign: 0, hill: 0.22, art: "qinglv", filter: "sepia(0.16) saturate(0.95) contrast(1.02)" },
};

export function createTangMap({ DATA, zhName, textEm, onExit, onEnterCity }) {
  const screen = document.getElementById("tang-screen");
  const view = document.getElementById("tang-view");
  const labelLayer = document.getElementById("tang-labels");
  const tip = document.getElementById("tang-tip");
  const panel = document.getElementById("tang-panel");
  const loading = document.getElementById("tang-loading");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let map = null, fx = null;
  let built = null, tang = null, geo = null;
  let height = null; // { meta, elev, bounds, elevAt }
  let arts = {};
  let open = false, suspended = false, frameId = 0;
  let selectedCircuit = null, selectedPref = null, highlightType = null;
  let hoverId = null;
  let showClouds = true;
  let mapMode = (() => { try { return localStorage.getItem("tang-map-mode") || "political"; } catch { return "political"; } })();
  let cities = [];

  // ---------- 高程：用于自绘底图、河流下游判断、风被山挡 ----------
  async function loadHeight() {
    const meta = await d3.json(`${DATA}height_tang.json`);
    const blob = await (await fetch(`${DATA}height_tang.png`)).blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const elev = new Float32Array(bmp.width * bmp.height);
    for (let i = 0; i < elev.length; i++) elev[i] = px[i * 4] * 256 + px[i * 4 + 1] - 1000;
    const N = 256 * 2 ** meta.z, W = meta.width, H = meta.height;
    const y2lat = (gy) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / N))) * 180) / Math.PI;
    const bounds = { west: (meta.gx0 / N) * 360 - 180, east: ((meta.gx0 + W) / N) * 360 - 180, north: y2lat(meta.gy0), south: y2lat(meta.gy0 + H) };
    const elevAt = (lon, lat) => {
      const r = (lat * Math.PI) / 180;
      const x = ((lon + 180) / 360) * N - meta.gx0;
      const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N - meta.gy0;
      const xi = Math.max(0, Math.min(W - 1, Math.round(x))), yi = Math.max(0, Math.min(H - 1, Math.round(y)));
      return elev[yi * W + xi];
    };
    const analysis = analyzeTerrain({
      elev, W, H,
      lonOf: (x) => ((meta.gx0 + x + 0.5) / N) * 360 - 180,
      latOf: (y) => y2lat(meta.gy0 + y + 0.5),
      metersPerPx: (y) => (156543.03 * Math.cos((y2lat(meta.gy0 + y + 0.5) * Math.PI) / 180)) / 2 ** meta.z,
    });
    return { meta, elev, bounds, elevAt, analysis };
  }
  // 自绘底图四边羽化成透明，和外面的卫星图、山影自然衔接
  function artUrl(style) {
    if (!arts[style]) {
      const c = paintTerrainArt(height.analysis, style);
      const g = c.getContext("2d");
      g.globalCompositeOperation = "destination-in";
      const F = 60;
      for (const [x0, y0, x1, y1] of [[0, 0, F, 0], [c.width, 0, c.width - F, 0], [0, 0, 0, F], [0, c.height, 0, c.height - F]]) {
        const grad = g.createLinearGradient(x0, y0, x1, y1);
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(1, "rgba(0,0,0,1)");
        g.fillStyle = grad;
        g.fillRect(0, 0, c.width, c.height);
      }
      arts[style] = c.toDataURL("image/webp", 0.9);
    }
    return arts[style];
  }

  // ---------- 数据 → GeoJSON ----------
  const foreignCountries = () => built.current.countries.filter((f) => !built.isFamily(f.properties.name) && !f.properties.unorganized);
  function geojson() {
    const prefs = {
      type: "FeatureCollection",
      features: built.family.map((f) => {
        const c = built.circuitOf.get(f.properties.index);
        return { type: "Feature", id: f.properties.index, properties: { index: f.properties.index, label: f.properties.label, circuit: c?.id ?? "", type: c?.type ?? "", color: c?.color ?? "#bbbbaa" }, geometry: f.geometry };
      }),
    };
    const circuits = {
      type: "FeatureCollection",
      features: built.circuits.filter((c) => c.geometry).map((c) => ({ type: "Feature", properties: { id: c.id }, geometry: c.geometry })),
    };
    const foreign = {
      type: "FeatureCollection",
      features: foreignCountries().map((f) => ({ type: "Feature", properties: { name: f.properties.name, color: f.properties.color }, geometry: f.geometry })),
    };
    return { prefs, circuits, foreign, borders: { type: "Feature", properties: {}, geometry: built.borderMesh } };
  }

  // 城池：方形城墙（带门楼）拉伸成立体；都城加宫城
  function cityGeojson() {
    const seats = new Set(built.circuits.map((c) => c.seat));
    cities = [];
    for (const f of built.family) {
      const p = f.properties;
      if (p.seatLon == null) continue;
      const tier = CAPITALS[p.label] ? "capital" : seats.has(p.label) ? "seat" : "town";
      cities.push({ tier, name: CAPITALS[p.label] ?? p.label, lon: p.seatLon, lat: p.seatLat, km: p.label === "京兆府" ? 8 : p.label === "河南府" ? 6.5 : tier === "seat" ? 3.6 : 2 });
    }
    for (const c of built.current.cities) {
      if (!c.capital || built.isFamily(c.country)) continue;
      if (c.lon < height.bounds.west || c.lon > height.bounds.east || c.lat < height.bounds.south || c.lat > height.bounds.north) continue;
      cities.push({ tier: "seat", name: c.name, lon: c.lon, lat: c.lat, km: 3.6, foreign: true });
    }
    const features = [];
    const sq = (lon, lat, hx, hy) => [[lon - hx, lat - hy], [lon + hx, lat - hy], [lon + hx, lat + hy], [lon - hx, lat + hy], [lon - hx, lat - hy]];
    for (const c of cities) {
      const dy = c.km / 111.3, dx = c.km / (111.3 * Math.cos((c.lat * Math.PI) / 180));
      const H = c.tier === "capital" ? 1400 : c.tier === "seat" ? 850 : 550;
      const t = 0.16;
      features.push({ type: "Feature", properties: { h: H, color: "#b8a17a", tier: c.tier }, geometry: { type: "Polygon", coordinates: [sq(c.lon, c.lat, dx, dy), sq(c.lon, c.lat, dx * (1 - t), dy * (1 - t)).reverse()] } });
      const gates = c.tier === "town" ? [[0, -1]] : [[0, -1], [0, 1], [-1, 0], [1, 0]];
      for (const [gx, gy] of gates) {
        features.push({ type: "Feature", properties: { h: H * 1.55, color: "#9a4030", tier: c.tier }, geometry: { type: "Polygon", coordinates: [sq(c.lon + gx * dx * (1 - t / 2), c.lat + gy * dy * (1 - t / 2), dx * 0.16, dy * 0.16)] } });
      }
      if (c.tier === "capital") {
        features.push({ type: "Feature", properties: { h: H * 1.9, color: "#a8342a", tier: c.tier }, geometry: { type: "Polygon", coordinates: [sq(c.lon, c.lat + dy * 0.45, dx * 0.32, dy * 0.22)] } });
        // 里坊：低矮的格子
        for (let i = -3; i <= 3; i++) for (let j = -3; j <= 1; j++) {
          if (i === 0) continue;
          features.push({ type: "Feature", properties: { h: H * 0.35, color: "#cdb98f", tier: c.tier }, geometry: { type: "Polygon", coordinates: [sq(c.lon + i * dx * 0.24, c.lat + j * dy * 0.2 - dy * 0.05, dx * 0.09, dy * 0.07)] } });
        }
      }
    }
    return { type: "FeatureCollection", features };
  }

  // ---------- 地图 ----------
  function buildStyle() {
    const b = height.bounds;
    const g = geojson();
    return {
      version: 8,
      sources: {
        dem: { type: "raster-dem", tiles: [DEM_TILES], tileSize: 256, maxzoom: 14, encoding: "terrarium", attribution: "地形：Mapzen Terrain Tiles（AWS Open Data）" },
        demVisual: { type: "raster-dem", tiles: [DEM_TILES], tileSize: 256, maxzoom: 14, encoding: "terrarium" },
        sat: { type: "raster", tiles: [SAT_TILES], tileSize: 256, maxzoom: 13, attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless 2016</a> by EOX IT Services GmbH（含修改的哥白尼 Sentinel 数据），CC BY 4.0' },
        art: { type: "image", url: artUrl(MODES[mapMode].art), coordinates: [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]] },
        foreign: { type: "geojson", data: g.foreign },
        prefs: { type: "geojson", data: g.prefs },
        circuits: { type: "geojson", data: g.circuits },
        borders: { type: "geojson", data: g.borders },
        lakes: { type: "geojson", data: geo.lakes },
        rivers: { type: "geojson", data: geo.rivers },
        canals: { type: "geojson", data: { type: "FeatureCollection", features: geo.canals.map((c) => ({ type: "Feature", properties: { name: c.name }, geometry: { type: "LineString", coordinates: c.coords } })) } },
        routes: { type: "geojson", data: { type: "FeatureCollection", features: SEA_ROUTE_LINES.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: c } })) } },
        cities: { type: "geojson", data: cityGeojson() },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#c8c2b4" } },
        { id: "art", type: "raster", source: "art", paint: { "raster-fade-duration": 0, "raster-resampling": "linear" } },
        { id: "sat", type: "raster", source: "sat", paint: { "raster-opacity": 0.72, "raster-saturation": -0.08, "raster-contrast": 0.02, "raster-brightness-min": 0.08, "raster-brightness-max": 0.96, "raster-hue-rotate": 12 } },
        { id: "hillshade", type: "hillshade", source: "demVisual", paint: { "hillshade-exaggeration": 0.42, "hillshade-illumination-direction": 315, "hillshade-shadow-color": "#2c2824", "hillshade-highlight-color": "#f0ece4", "hillshade-accent-color": "#6a6458", "hillshade-illumination-anchor": "viewport" } },
        { id: "foreign-fill", type: "fill", source: "foreign", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.2 } },
        { id: "foreign-line", type: "line", source: "foreign", paint: { "line-color": "#3a2410", "line-opacity": 0.6, "line-width": 1.2, "line-dasharray": [3, 2] } },
        { id: "pref-fill", type: "fill", source: "prefs", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.38 } },
        { id: "pref-line", type: "line", source: "prefs", minzoom: 5, paint: { "line-color": "#3a2410", "line-opacity": 0.3, "line-width": 0.6 } },
        { id: "pref-hover", type: "line", source: "prefs", paint: { "line-color": "#fff6da", "line-width": 1.6, "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.95, 0] } },
        { id: "circuit-borders", type: "line", source: "borders", paint: { "line-color": "#2e1a0a", "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.2, 7, 2.2] }, layout: { "line-join": "round" } },
        { id: "lakes", type: "fill", source: "lakes", paint: { "fill-color": "rgba(50,118,138,0.9)", "fill-outline-color": "rgba(90,110,105,0.8)" } },
        { id: "rivers", type: "line", source: "rivers", layout: { "line-cap": "round", "line-join": "round" }, paint: {
          "line-color": ["match", ["get", "name"], "黄河", "#a98c55", "rgba(42,105,120,0.95)"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, ["match", ["get", "name"], ["长江", "黄河", "金沙江"], 2, 1], 8, ["match", ["get", "name"], ["长江", "黄河", "金沙江"], 4.5, 2.2]],
        } },
        { id: "canals", type: "line", source: "canals", paint: { "line-color": "#2c6f8c", "line-width": 1.6, "line-dasharray": [2, 1.2] } },
        { id: "routes", type: "line", source: "routes", paint: { "line-color": "#f3e3b5", "line-width": 1.2, "line-opacity": 0.75, "line-dasharray": [2, 1.6] } },
        { id: "circuit-sel-glow", type: "line", source: "circuits", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#ffd97a", "line-width": 9, "line-blur": 6, "line-opacity": 0.55 } },
        { id: "circuit-sel", type: "line", source: "circuits", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#e3c26d", "line-width": 2.6 } },
        { id: "cities", type: "fill-extrusion", source: "cities", minzoom: 5, filter: ["!=", ["get", "tier"], "town"], paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.95 } },
        { id: "towns", type: "fill-extrusion", source: "cities", minzoom: 6.6, filter: ["==", ["get", "tier"], "town"], paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.95 } },
      ],
      terrain: { source: "dem", exaggeration: 1.8 },
      sky: { "sky-color": "#b9c9cf", "horizon-color": "#e8dcc4", "fog-color": "#e6dcc4", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.75, "atmosphere-blend": 0.4 },
    };
  }

  function initMap() {
    const container = document.createElement("div");
    container.id = "tang-map";
    view.prepend(container);
    const b = height.bounds;
    map = new maplibregl.Map({
      container,
      style: buildStyle(),
      center: OVERVIEW.center,
      zoom: 3.6,
      pitch: 0,
      bearing: 0,
      minZoom: 3.4,
      maxZoom: 12,
      maxPitch: 72,
      maxBounds: [[b.west - 10, b.south - 6], [b.east + 10, b.north + 6]],
      attributionControl: { compact: true },
      fadeDuration: 0,
    });
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    // 叠加层：暖色调、暗角、流动效果画布
    const tint = document.createElement("div");
    tint.className = "tang-tint";
    const fxCanvas = document.createElement("canvas");
    fxCanvas.className = "tang-fx";
    container.after(tint, fxCanvas);
    fx = createFx({ map, canvas: fxCanvas, geo, elevAt: height.elevAt, bounds: b, reduceMotion });
    new ResizeObserver(() => {
      map.resize();
      fx.resize();
      labelsDirty = true;
    }).observe(view);

    map.on("mousemove", onMove);
    map.on("mouseout", () => setHover(null));
    map.on("click", onClick);
    map.on("move", () => (labelsDirty = true));
    return new Promise((r) => (map.isStyleLoaded() ? r() : map.once("style.load", r)));
  }

  function setPaint(layer, prop, value) {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  }

  function applyStyle() {
    const M = MODES[mapMode];
    const base = M.pref;
    let op = base;
    if (highlightType) op = ["case", ["==", ["get", "type"], highlightType], Math.max(base, 0.42), base * 0.25];
    else if (selectedCircuit) op = ["case", ["==", ["get", "circuit"], selectedCircuit], Math.max(base + 0.12, 0.3), base * 0.6];
    setPaint("pref-fill", "fill-opacity", ["case", ["boolean", ["feature-state", "hover"], false], Math.max(base, 0.3) + 0.12, op]);
    setPaint("foreign-fill", "fill-opacity", M.foreign);
    setPaint("sat", "raster-opacity", M.sat);
    setPaint("hillshade", "hillshade-exaggeration", M.hill);
    setPaint("circuit-borders", "line-opacity", mapMode === "political" ? 0.85 : 0.6);
    setPaint("rivers", "line-color", mapMode === "qinglv" ? "#4f7d8a" : ["match", ["get", "name"], "黄河", "#a98c55", "rgba(42,105,120,0.95)"]);
    const f = ["==", ["get", "id"], selectedCircuit ?? ""];
    if (map.getLayer("circuit-sel")) {
      map.setFilter("circuit-sel", f);
      map.setFilter("circuit-sel-glow", f);
    }
    map.getCanvas().style.filter = M.filter;
  }

  function setMapMode(mode) {
    mapMode = mode;
    try { localStorage.setItem("tang-map-mode", mode); } catch {}
    document.querySelectorAll("#tang-mode button").forEach((btn) => btn.classList.toggle("on", btn.dataset.mode === mode));
    if (!map) return;
    map.getSource("art")?.updateImage({ url: artUrl(MODES[mode].art), coordinates: map.getSource("art").coordinates });
    applyStyle();
  }
  document.querySelectorAll("#tang-mode button").forEach((btn) => (btn.onclick = () => setMapMode(btn.dataset.mode)));

  // ---------- 悬停与点击 ----------
  function setHover(id) {
    if (id === hoverId) return;
    if (hoverId != null) map.setFeatureState({ source: "prefs", id: hoverId }, { hover: false });
    hoverId = id;
    if (id != null) map.setFeatureState({ source: "prefs", id }, { hover: true });
    if (id == null) tip.hidden = true;
  }
  function onMove(e) {
    if (suspended) return;
    const feats = map.queryRenderedFeatures(e.point, { layers: ["pref-fill", "foreign-fill"] });
    const f = feats[0];
    map.getCanvas().style.cursor = f ? "pointer" : "";
    if (!f) return setHover(null);
    if (f.layer.id === "pref-fill") {
      setHover(f.id);
      const c = built.byId.get(f.properties.circuit);
      tip.innerHTML = `<span class="prov">${f.properties.label}</span>` + (c ? `<strong>${c.name}</strong><span class="sub">${tang.types[c.type].label} · ${c.title}：${c.holder ?? "待考"}</span>` : "");
    } else {
      setHover(null);
      tip.innerHTML = `<strong>${zhName(f.properties.name)}</strong>${tang.rulers[f.properties.name] ? `<span class="sub">${tang.rulers[f.properties.name]}</span>` : ""}`;
    }
    tip.style.left = `${e.point.x + 14}px`;
    tip.style.top = `${e.point.y + 14}px`;
    tip.hidden = false;
  }
  function onClick(e) {
    if (suspended) return;
    // 点中长安城：进入三维长安
    const ca = cities.find((c) => c.name === "长安");
    if (ca && map.getZoom() >= 5) {
      const p = map.project([ca.lon, ca.lat]);
      const r = Math.max(16, (ca.km * 512 * 2 ** map.getZoom()) / 40075);
      if (Math.hypot(p.x - e.point.x, p.y - e.point.y) < r) return enterChangan();
    }
    const f = map.queryRenderedFeatures(e.point, { layers: ["pref-fill", "foreign-fill"] })[0];
    if (!f) return clearSelection();
    if (f.layer.id === "pref-fill") {
      selectedPref = f.properties.label;
      if (f.properties.circuit) selectCircuit(f.properties.circuit, { fly: false });
    } else showForeign(f.properties.name);
  }

  // ---------- 标签（HTML，随地图投影） ----------
  let labels = [];
  let labelsDirty = true;
  function buildLabels() {
    labelLayer.innerHTML = "";
    labels = [];
    const b = height.bounds;
    const add = (text, lon, lat, cls, prio, opts = {}) => {
      if (lon < b.west || lon > b.east || lat < b.south || lat > b.north) return;
      const el = document.createElement("div");
      el.className = `tl ${cls}`;
      el.textContent = text;
      labelLayer.append(el);
      labels.push({ el, text, prio, lon, lat, fs: opts.fs ?? 13, minZoom: opts.minZoom ?? 0, cls, ...opts });
    };
    const largest = (g) => {
      if (g.type !== "MultiPolygon") return g;
      let best = null, bestA = -1;
      for (const coords of g.coordinates) {
        const poly = { type: "Polygon", coordinates: coords };
        const raw = d3.geoArea(poly);
        const a = raw > 2 * Math.PI ? 4 * Math.PI - raw : raw;
        if (a > bestA) { bestA = a; best = poly; }
      }
      return best;
    };
    for (const c of built.circuits) {
      if (!c.geometry) continue;
      const poly = largest(c.geometry);
      const [lon, lat] = d3.geoCentroid(poly);
      const area = d3.geoArea(poly);
      add(c.name.replace(/（.*）/, ""), lon, lat, "circuit", 50 + Math.sqrt(area) * 2000, { fs: 15 + Math.min(9, Math.sqrt(area) * 260), circuit: c.id, scaleWithZoom: true });
    }
    for (const f of foreignCountries()) {
      if (f.properties.areaKm2 < 40000) continue;
      const [lon, lat] = d3.geoCentroid(largest(f.geometry));
      add(zhName(f.properties.name), lon, lat, "country", 80 + Math.sqrt(f.properties.areaKm2) / 10, { fs: 22, scaleWithZoom: true });
    }
    for (const c of cities) {
      add(c.name, c.lon, c.lat, `city ${c.tier}${c.foreign ? " foreign" : ""}`, c.tier === "capital" ? 200 : c.tier === "seat" ? 40 : 5, {
        fs: c.tier === "capital" ? 15 : c.tier === "seat" ? 12 : 11, minZoom: c.tier === "capital" ? 0 : c.tier === "seat" ? 5.4 : 6.8, city: true,
      });
    }
    for (const r of geo.regions) add(r.name, r.lon, r.lat, `geo ${r.kind}`, 20 - r.rank, { fs: r.kind === "mountain" ? 14 : 13, minZoom: r.rank <= 3 ? 0 : 5 });
    const seen = new Set();
    for (const f of [...geo.rivers.features].sort((a, c) => (a.properties.rank ?? 9) - (c.properties.rank ?? 9))) {
      const name = f.properties.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const line = f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates.flat();
      const mid = line[Math.floor(line.length / 2)];
      add(name, mid[0], mid[1], "geo river", 10 - (f.properties.rank ?? 9), { fs: 12, minZoom: 5.1 });
    }
    for (const cn of geo.canals) {
      const mid = cn.coords[Math.floor(cn.coords.length / 2)];
      add(cn.name, mid[0], mid[1], "geo river", 6, { fs: 12, minZoom: 5.1 });
    }
    labels.sort((a, c) => c.prio - a.prio);
    labelsDirty = true;
  }
  function layoutLabels() {
    const w = view.clientWidth, h = view.clientHeight;
    const zoom = map.getZoom();
    const zoomScale = Math.min(2.2, Math.max(0.75, 2 ** ((zoom - OVERVIEW.zoom) * 0.55)));
    const placed = [];
    for (const l of labels) {
      let show = zoom >= l.minZoom;
      let p;
      if (show) {
        p = map.project([l.lon, l.lat]);
        show = p.x > -40 && p.x < w + 40 && p.y > -20 && p.y < h + 20;
      }
      if (show) {
        const fs = l.scaleWithZoom ? Math.min(l.fs * zoomScale, l.circuit ? 30 : 34) : l.fs;
        const tw = textEm(l.text) * fs * (l.cls.startsWith("circuit") || l.cls.startsWith("country") ? 1.25 : 1.05);
        const box = l.city ? [p.x - 4, p.y - fs - 6, p.x + tw + 10, p.y + 2] : [p.x - tw / 2, p.y - fs * 0.7, p.x + tw / 2, p.y + fs * 0.7];
        if (placed.some((bx) => box[0] < bx[2] && box[2] > bx[0] && box[1] < bx[3] && box[3] > bx[1])) show = false;
        else {
          placed.push(box);
          l.el.style.transform = l.city ? `translate(${p.x}px, ${p.y}px)` : `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
          l.el.style.fontSize = `${fs}px`;
          l.el.classList.toggle("dim", Boolean(highlightType && l.circuit && built.byId.get(l.circuit)?.type !== highlightType));
          l.el.classList.toggle("sel", Boolean(l.circuit && l.circuit === selectedCircuit));
        }
      }
      if (l.shown !== show) {
        l.el.style.display = show ? "" : "none";
        l.shown = show;
      }
    }
  }

  // ---------- 动画循环（流动效果与标签） ----------
  let last = 0;
  function loop(t) {
    if (!open || suspended) return;
    frameId = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (t - (last || t)) / 1000);
    last = t;
    fx.frame(dt);
    if (labelsDirty) {
      labelsDirty = false;
      layoutLabels();
    }
  }

  // ---------- 镜头 ----------
  const overview = (duration = 1600) => map.flyTo({ ...OVERVIEW, duration: reduceMotion ? 0 : duration, essential: true });
  function flyToCircuit(id) {
    const c = built.byId.get(id);
    if (!c?.geometry) return;
    const [[w, s], [e, n]] = d3.geoBounds(c.geometry);
    map.fitBounds([[w, s], [e, n]], { padding: 90, pitch: 50, maxZoom: 7.6, duration: reduceMotion ? 0 : 1600 });
  }
  function flyToCountry(name) {
    const f = built.current.byName.get(name);
    if (f) {
      const [lon, lat] = d3.geoCentroid(f);
      const b = height.bounds;
      if (lon > b.west && lon < b.east && lat > b.south && lat < b.north) map.flyTo({ center: [lon, lat], zoom: 5.2, pitch: 45, duration: reduceMotion ? 0 : 1600 });
    }
    showForeign(name);
  }

  // ---------- 侧边栏 ----------
  const RELATION_CLASS = { 归附: "good", 册封: "good", 同盟: "good", 遣唐使: "good", 通商: "neutral", 羁縻: "neutral", 敌对: "bad" };
  function renderPanel() {
    const court = tang.court;
    const c = selectedCircuit && built.byId.get(selectedCircuit);
    const types = Object.entries(tang.types).map(([key, t]) => {
      const n = built.circuits.filter((x) => x.type === key).length;
      return n ? `<li class="type-item${highlightType === key ? " on" : ""}" data-type="${key}"><span class="swatch" style="background:${t.color}"></span>${t.label}<span class="count">${n}</span></li>` : "";
    }).join("");
    let detail = `<p class="hint">点击地图上的州，查看所属方镇；点击类型可在地图上突出显示。</p>`;
    if (c) {
      const t = tang.types[c.type];
      const prefs = c.provinces.map((i) => built.current.set.provinces[i].properties.label).filter((v, i, arr) => arr.indexOf(v) === i);
      detail = `
        <div class="circuit-card">
          <div class="circuit-head"><span class="swatch big" style="background:${c.color}"></span><h2>${c.name}</h2></div>
          <span class="badge" style="--badge:${t.color}">${t.label}</span>
          <dl class="stats">
            <dt>${c.title}</dt><dd>${c.holder ?? '<span class="unknown">待考</span>'}</dd>
            <dt>治所</dt><dd>${c.seat ?? "—"}</dd>
            <dt>辖州</dt><dd>${prefs.length}</dd>
            <dt>与朝廷</dt><dd>${c.relation}</dd>
          </dl>
          <p class="type-desc">${t.desc}</p>
          <ul class="chips">${prefs.map((p) => `<li${p === selectedPref ? ' class="on"' : ""}>${p}</li>`).join("")}</ul>
          <button class="ghost fly">镜头飞往${c.name.replace(/（.*）/, "")}</button>
        </div>`;
    }
    const foreign = tang.foreign.map((f) => `
      <li class="foreign" data-name="${f.name}">
        <span class="rel ${RELATION_CLASS[f.relation] ?? "neutral"}">${f.relation}</span>
        <strong>${zhName(f.name)}</strong>
        <span class="ruler">${tang.rulers[f.name] ?? ""}</span>
        <p>${f.desc}</p>
      </li>`).join("");
    panel.innerHTML = `
      <div class="china-head">
        <div class="ruler-line">${court.ruler}</div>
        <p class="era-desc">${court.note}</p>
      </div>
      <h3>方镇类型</h3>
      <ul class="type-legend">${types}</ul>
      ${detail}
      <h3>四夷与邻国</h3>
      <ul class="foreign-list">${foreign}</ul>
      <p class="city-credit">底图：Sentinel-2 cloudless 2016（EOX，CC BY 4.0）；地形：Mapzen Terrain Tiles。做旧调色参考 <a href="https://github.com/hopechen067/MapStage" target="_blank" rel="noopener">MapStage</a>（MIT）。</p>`;
    panel.querySelectorAll(".type-item").forEach((el) => {
      el.onclick = () => {
        highlightType = highlightType === el.dataset.type ? null : el.dataset.type;
        applyStyle();
        renderPanel();
        labelsDirty = true;
      };
    });
    panel.querySelector(".fly")?.addEventListener("click", () => flyToCircuit(selectedCircuit));
    panel.querySelectorAll(".foreign").forEach((el) => (el.onclick = () => flyToCountry(el.dataset.name)));
  }
  function selectCircuit(id, { fly = true } = {}) {
    selectedCircuit = id;
    applyStyle();
    renderPanel();
    labelsDirty = true;
    if (fly) flyToCircuit(id);
  }
  function showForeign(name) {
    selectedCircuit = null;
    selectedPref = null;
    applyStyle();
    renderPanel();
    const el = panel.querySelector(`.foreign[data-name="${CSS.escape(name)}"]`);
    if (el) {
      el.classList.add("flash");
      el.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    }
  }
  function clearSelection() {
    if (!selectedCircuit && !highlightType) return;
    selectedCircuit = null;
    selectedPref = null;
    highlightType = null;
    applyStyle();
    renderPanel();
    labelsDirty = true;
  }

  // ---------- 顶栏按钮与键盘 ----------
  document.getElementById("tang-back").onclick = () => close();
  document.getElementById("tang-reset").onclick = () => overview(1200);
  const WIND = {
    off: { next: "summer", label: "🌬 季风", toast: null },
    summer: { next: "winter", label: "🌬 夏季风", toast: "夏季风：东南季风与西南季风自海上吹向大陆，番舶乘风自南海北来，泊广州、泉州、扬州" },
    winter: { next: "off", label: "🌬 冬季风", toast: "冬季风：寒潮自塞北南下，西北季风转为东南沿海的东北季风，番舶乘风扬帆南归" },
  };
  const windBtn = document.getElementById("tang-wind");
  windBtn.onclick = () => {
    const mode = WIND[fx?.windMode ?? "off"].next;
    fx?.setWind(mode);
    windBtn.textContent = WIND[mode].label;
    windBtn.classList.toggle("on", mode !== "off");
    showToast(WIND[mode].toast);
  };
  const toastEl = document.getElementById("tang-toast");
  let toastTimer = 0;
  function showToast(text) {
    clearTimeout(toastTimer);
    toastEl.hidden = !text;
    if (!text) return;
    toastEl.textContent = text;
    toastTimer = setTimeout(() => (toastEl.hidden = true), 6000);
  }
  const cloudBtn = document.getElementById("tang-clouds");
  cloudBtn.onclick = () => {
    showClouds = !showClouds;
    fx?.setClouds(showClouds);
    cloudBtn.classList.toggle("off", !showClouds);
  };
  window.addEventListener("keydown", (e) => {
    if (!open || suspended || e.target.closest?.("input, textarea")) return;
    const k = e.key.toLowerCase();
    if (k === "escape") {
      if (selectedCircuit || highlightType) clearSelection();
      else close();
    } else if (k === "w" || k === "arrowup") map.panBy([0, -120]);
    else if (k === "s" || k === "arrowdown") map.panBy([0, 120]);
    else if (k === "a" || k === "arrowleft") map.panBy([-120, 0]);
    else if (k === "d" || k === "arrowright") map.panBy([120, 0]);
    else if (k === "q") map.easeTo({ bearing: map.getBearing() - 15 });
    else if (k === "e") map.easeTo({ bearing: map.getBearing() + 15 });
  });

  // ---------- 进入长安城 ----------
  function enterChangan() {
    const ca = cities.find((c) => c.name === "长安");
    if (!ca || !onEnterCity) return;
    tip.hidden = true;
    map.flyTo({ center: [ca.lon, ca.lat], zoom: 9.5, pitch: 60, duration: reduceMotion ? 0 : 1300 });
    setTimeout(() => {
      suspended = true;
      cancelAnimationFrame(frameId);
      onEnterCity("长安");
    }, reduceMotion ? 0 : 1250);
  }
  document.getElementById("tang-city").onclick = () => enterChangan();
  function resume() {
    if (!suspended) return;
    suspended = false;
    if (!open) return;
    const ca = cities.find((c) => c.name === "长安");
    if (ca) map.flyTo({ center: [ca.lon, ca.lat], zoom: 6.8, pitch: 50, duration: reduceMotion ? 0 : 1600 });
    last = 0;
    frameId = requestAnimationFrame(loop);
  }

  // ---------- 打开 / 关闭 ----------
  let ready = null;
  async function prepare(assets) {
    tang = assets.tang;
    geo = assets.geo;
    height = await loadHeight();
  }
  async function openScene(b, assets) {
    screen.hidden = false;
    loading.hidden = false;
    requestAnimationFrame(() => screen.classList.add("shown"));
    await new Promise((r) => setTimeout(r, 30));
    ready ??= prepare(assets);
    await ready;
    if (built !== b) {
      built = b;
      if (!map) await initMap();
      else {
        const g = geojson();
        map.getSource("prefs").setData(g.prefs);
        map.getSource("circuits").setData(g.circuits);
        map.getSource("foreign").setData(g.foreign);
        map.getSource("borders").setData(g.borders);
        map.getSource("cities").setData(cityGeojson());
      }
      buildLabels();
    }
    selectedCircuit = selectedPref = highlightType = null;
    setMapMode(mapMode);
    renderPanel();
    map.resize();
    fx.resize();
    loading.hidden = true;
    open = true;
    suspended = false;
    // 开场：从正上方俯视（衔接二维地图）压低成斜视
    map.jumpTo({ center: OVERVIEW.center, zoom: 3.8, pitch: 0, bearing: 0 });
    overview(2400);
    last = 0;
    frameId = requestAnimationFrame(loop);
  }
  function close() {
    if (!open) return;
    open = false;
    cancelAnimationFrame(frameId);
    tip.hidden = true;
    screen.classList.remove("shown");
    setTimeout(() => {
      if (!open) screen.hidden = true;
    }, 450);
    onExit?.();
  }

  return {
    resume,
    open: openScene,
    close,
    get isOpen() {
      return open;
    },
  };
}
