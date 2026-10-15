// 中国视图（800 年）：点击大唐或其藩镇后放大进入。
// 内容：地形晕渲底图、河流湖泊与运河、山川名称、按方镇着色的州、城墙图标、飘动的云，
// 以及显示方镇类型、节度使、与朝廷关系和对外关系的侧边栏。
import * as d3 from "d3";
import * as topojson from "topojson-client";

// 属于"唐朝体系"的势力：唐廷直辖与名义上臣属的藩镇
const FAMILY = new Set(["Tang Empire", "Lulong Circuit", "Chengde Circuit", "Weibo Circuit", "Pinglu Circuit", "Huaixi Circuit"]);
// 原数据里单独成国的藩镇 → 对应的方镇 id（州名匹配不上时兜底）
const COUNTRY_CIRCUIT = {
  "Lulong Circuit": "lulong", "Chengde Circuit": "chengde", "Weibo Circuit": "weibo",
  "Pinglu Circuit": "ziqing", "Huaixi Circuit": "huaixi",
};
const CHINA_VIEW = [[99, 19], [124, 42]]; // 进入时取景的经纬度范围
const MAJOR_RIVERS = new Set(["长江", "黄河", "金沙江", "通天河"]);
const PREFECTURE_ZOOM_FACTOR = 1.8; // 放大到进入时缩放倍数的 1.8 倍后，普通州城才出现

export function createChina(ctx) {
  const { svg, world, stage, stageSel, zoom, projection, path, tooltip, zhName, textEm, DATA } = ctx;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let active = false;
  let built = null; // 针对某一年数据构建好的图层数据
  let selectedCircuit = null;
  let highlightType = null;
  let assets = null;
  let entryK = 14; // 进入中国视图时的缩放倍数

  // ---------- 图层 ----------
  const gUnder = world.insert("g", ".year-layer").attr("class", "china-under").style("display", "none");
  const terrain = gUnder.append("image").attr("class", "china-terrain").attr("preserveAspectRatio", "none");
  const gOver = world.insert("g", ".hover-province").attr("class", "china-over").style("display", "none");
  const gProv = gOver.append("g").attr("class", "china-provinces");
  const gWater = gOver.append("g").attr("class", "china-water");
  const borders = gOver.append("path").attr("class", "circuit-borders");
  const selectedOutline = gOver.append("path").attr("class", "circuit-selected");
  const hoverPath = gOver.append("path").attr("class", "china-hover");
  const gScreen = svg.insert("g", ".cities").attr("class", "china-screen").style("display", "none");
  const gGeoLabels = gScreen.append("g").attr("class", "china-geo-labels");
  const gWalls = gScreen.append("g").attr("class", "china-walls");

  // 云：画在不随地图缩放的画布上，放在地图之上、纸纹之下
  const clouds = document.createElement("canvas");
  clouds.className = "china-clouds";
  clouds.hidden = true;
  stage.insertBefore(clouds, stage.querySelector(".paper-overlay"));

  const panel = document.getElementById("panel-china");

  async function loadAssets() {
    if (!assets) {
      assets = Promise.all([
        d3.json(`${DATA}tang_800.json`),
        d3.json(`${DATA}china_geo.json`),
        d3.json(`${DATA}terrain_china.json`),
      ]).then(([tang, geo, terrainBounds]) => ({ tang, geo, terrainBounds }));
    }
    return assets;
  }

  // ---------- 数据：州 → 方镇 ----------
  function build(current, a) {
    const set = current.set;
    const nameOfId = new Map(current.countries.map((f) => [f.properties.id, f.properties.name]));
    const owner = (i) => (current.owner[i] >= 0 ? nameOfId.get(current.owner[i]) : null);
    const provs = set.provinces;
    const family = provs.filter((f) => FAMILY.has(owner(f.properties.index)));
    const centroid = new Map(family.map((f) => [f.properties.index, d3.geoCentroid(f)]));

    const circuits = a.tang.circuits.map((c) => ({ ...c, provinces: [] }));
    const byId = new Map(circuits.map((c) => [c.id, c]));
    const byName = new Map();
    for (const c of circuits) for (const p of c.prefectures) {
      if (!byName.has(p)) byName.set(p, []);
      byName.get(p).push(c);
    }
    // 方镇治所所在州的位置，用来消解同名州（如浙东明州与西南羁縻明州）
    const seatPos = new Map();
    for (const c of circuits) {
      const f = family.find((p) => p.properties.label === c.seat);
      if (f) seatPos.set(c.id, centroid.get(f.properties.index));
    }
    const dist = (p, q) => d3.geoDistance(p, q) * 6371;

    const circuitOf = new Map();
    for (const f of family) {
      const i = f.properties.index;
      const here = centroid.get(i);
      let cand = (byName.get(f.properties.label) ?? []).filter((c) => !seatPos.has(c.id) || dist(here, seatPos.get(c.id)) < 900);
      if (cand.length > 1) cand.sort((x, y) => dist(here, seatPos.get(x.id) ?? here) - dist(here, seatPos.get(y.id) ?? here));
      let c = cand[0] ?? byId.get(COUNTRY_CIRCUIT[owner(i)]);
      if (!c) {
        // 还是匹配不上：归入最近的方镇
        let best = null;
        for (const [id, pos] of seatPos) if (!best || dist(here, pos) < best.d) best = { id, d: dist(here, pos) };
        c = best ? byId.get(best.id) : null;
      }
      if (!c) continue;
      circuitOf.set(i, c);
      c.provinces.push(i);
    }

    // 配色：同类型的方镇用同一色系，依次偏一点色相和明度
    const sameType = d3.group(circuits.filter((c) => c.provinces.length), (c) => c.type);
    for (const [type, list] of sameType) {
      const base = d3.hsl(a.tang.types[type].color);
      list.forEach((c, k) => {
        const col = d3.hsl(base);
        col.h += ((k % 5) - 2) * 6;
        col.l = Math.max(0.25, Math.min(0.78, col.l + ((Math.floor(k / 5) % 3) - 1) * 0.07 + (k % 2 ? 0.04 : -0.02)));
        c.color = col.formatHex();
      });
    }

    const geoms = set.geoms;
    for (const c of circuits) {
      if (!c.provinces.length) continue;
      c.geometry = topojson.merge(set.topo, c.provinces.map((i) => geoms[i]));
    }
    const familyGeoms = family.map((f) => geoms[f.properties.index]);
    const borderMesh = topojson.mesh(set.topo, { type: "GeometryCollection", geometries: familyGeoms },
      (x, y) => x === y || circuitOf.get(x.index) !== circuitOf.get(y.index));

    return { current, family, circuits: circuits.filter((c) => c.provinces.length), byId, circuitOf, borderMesh, owner };
  }

  // ---------- 绘制（地图坐标，随缩放） ----------
  function draw() {
    if (!built) return;
    // 切换年份会重建国家图层（插在 .hover-province 之前），这里重新排好层级：
    // 地形在国家图层之下，方镇着色与山川在国家图层之上
    const yearLayer = world.selectAll(".year-layer").nodes().at(-1);
    world.node().insertBefore(gUnder.node(), world.select(".year-layer").node());
    world.node().insertBefore(gOver.node(), yearLayer.nextSibling);
    const a = assetsSync;
    const tb = a.terrainBounds;
    const [x0, y0] = projection([tb.west, tb.north]);
    const [x1, y1] = projection([tb.east, tb.south]);
    terrain.attr("href", `${DATA}terrain_china.png`).attr("x", x0).attr("y", y0).attr("width", x1 - x0).attr("height", y1 - y0);

    gProv.selectAll("path")
      .data(built.family, (f) => f.properties.index)
      .join("path")
      .attr("class", "china-prov")
      .attr("d", path)
      .attr("fill", (f) => built.circuitOf.get(f.properties.index)?.color ?? "#bba")
      .on("mousemove", (event, f) => showTip(event, f))
      .on("mouseleave", () => {
        tooltip.hidden = true;
        hoverPath.attr("d", null);
      })
      .on("click", (event, f) => {
        event.stopPropagation();
        const c = built.circuitOf.get(f.properties.index);
        if (c) selectCircuit(c.id);
      });
    applyHighlight();

    borders.attr("d", path(built.borderMesh));
    gWater.selectAll("*").remove();
    gWater.selectAll("path.lake").data(a.geo.lakes.features).join("path").attr("class", "lake").attr("d", path);
    gWater.selectAll("path.river").data(a.geo.rivers.features).join("path")
      .attr("class", (f) => "river" + (MAJOR_RIVERS.has(f.properties.name) ? " major" : ""))
      .attr("d", path);
    gWater.selectAll("path.canal").data(a.geo.canals).join("path")
      .attr("class", "canal")
      .attr("d", (c) => path({ type: "LineString", coordinates: c.coords }));
    drawSelected();
  }

  function drawSelected() {
    const c = selectedCircuit && built?.byId.get(selectedCircuit);
    selectedOutline.attr("d", c?.geometry ? path(c.geometry) : null);
  }

  function applyHighlight() {
    gProv.selectAll("path.china-prov").classed("dimmed", (f) => {
      if (!highlightType) return false;
      return built.circuitOf.get(f.properties.index)?.type !== highlightType;
    });
  }

  function showTip(event, f) {
    const c = built.circuitOf.get(f.properties.index);
    hoverPath.attr("d", path(f));
    const type = c ? assetsSync.tang.types[c.type].label : "";
    tooltip.innerHTML =
      `<span class="prov">${f.properties.label}</span>` +
      (c ? `<strong>${c.name}</strong><span class="sub">${type} · ${c.title}：${c.holder ?? "待考"}</span>` : "");
    const rect = stage.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - rect.left + 14}px`;
    tooltip.style.top = `${event.clientY - rect.top + 14}px`;
    tooltip.hidden = false;
  }

  // ---------- 屏幕坐标的图层：城墙、山川名（每次缩放停下后重画） ----------
  function render(shownBoxes) {
    if (!active || !built) return [];
    const { width, height } = ctx.getSize();
    const t = d3.zoomTransform(stage);
    const k = t.k;
    const placed = shownBoxes.map((b) => [t.applyX(b[0]), t.applyY(b[1]), t.applyX(b[2]), t.applyY(b[3])]);
    const overlaps = (box) => placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    const toScreen = (lon, lat) => {
      const [x, y] = projection([lon, lat]);
      return [t.applyX(x), t.applyY(y)];
    };
    const onScreen = ([x, y]) => x > -30 && x < width + 30 && y > -30 && y < height + 30;
    const boxesForProvinceLabels = [];

    // 城墙：都城（长安、洛阳）最大，方镇治所次之，普通州城放大后才出现
    const seats = new Set(built.circuits.map((c) => c.seat));
    const walls = [];
    for (const f of built.family) {
      const p = f.properties;
      if (p.seatLon == null) continue;
      const tier = p.label === "京兆府" || p.label === "河南府" ? "capital" : seats.has(p.label) ? "seat" : "town";
      if (tier === "town" && k < entryK * PREFECTURE_ZOOM_FACTOR) continue;
      const [x, y] = toScreen(p.seatLon, p.seatLat);
      if (!onScreen([x, y])) continue;
      const name = p.label === "京兆府" ? "长安" : p.label === "河南府" ? "洛阳" : null;
      walls.push({ id: p.index, tier, x, y, name });
      if (name) {
        const box = [x - 14, y - 14, x + 16 + textEm(name) * 13, y + 14];
        placed.push(box);
        boxesForProvinceLabels.push([t.invertX(box[0]), t.invertY(box[1]), t.invertX(box[2]), t.invertY(box[3])]);
      }
    }
    const wg = gWalls.selectAll("g.wall").data(walls, (d) => d.id).join((enter) => {
      const g = enter.append("g").attr("class", (d) => `wall ${d.tier}`);
      g.each(function (d) {
        const s = d.tier === "capital" ? 11 : d.tier === "seat" ? 6.5 : 4;
        const el = d3.select(this);
        // 外城（带垛口效果的描边）、城门，都城再加一圈内城
        el.append("rect").attr("class", "wall-outer").attr("x", -s).attr("y", -s).attr("width", 2 * s).attr("height", 2 * s);
        if (d.tier !== "town") el.append("rect").attr("class", "wall-gate").attr("x", -s * 0.22).attr("y", s - s * 0.45).attr("width", s * 0.44).attr("height", s * 0.45);
        if (d.tier === "capital") {
          el.append("rect").attr("class", "wall-inner").attr("x", -s * 0.45).attr("y", -s * 0.85).attr("width", s * 0.9).attr("height", s * 0.6);
          el.append("text").attr("class", "wall-name").attr("x", s + 5).attr("dy", "0.35em").text(d.name);
        }
      });
      return g;
    });
    wg.attr("transform", (d) => `translate(${d.x},${d.y})`);

    // 山川名：山脉、高原盆地、河流、运河
    const a = assetsSync;
    const labels = [];
    const tryPlace = (item, fs, kind) => {
      const w = textEm(item.text) * fs * (kind === "mountain" ? 1.3 : 1);
      const box = [item.x - w / 2, item.y - fs * 0.7, item.x + w / 2, item.y + fs * 0.7];
      if (!onScreen([item.x, item.y]) || overlaps(box)) return;
      placed.push(box);
      boxesForProvinceLabels.push([t.invertX(box[0]), t.invertY(box[1]), t.invertX(box[2]), t.invertY(box[3])]);
      labels.push({ ...item, fs, kind });
    };
    for (const r of [...a.geo.regions].sort((x, y) => x.rank - y.rank)) {
      if (k < entryK * (r.rank <= 3 ? 0.5 : 0.9)) continue;
      const [x, y] = toScreen(r.lon, r.lat);
      tryPlace({ key: "r" + r.name, text: r.name, x, y }, r.kind === "mountain" ? 13 : 12, r.kind);
    }
    if (k >= entryK * 0.9) {
      const seen = new Set();
      const rivers = [...a.geo.rivers.features].sort((x, y) => (x.properties.rank ?? 9) - (y.properties.rank ?? 9));
      for (const f of rivers) {
        const name = f.properties.name;
        if (seen.has(name)) continue;
        const line = f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates.flat();
        const mid = line[Math.floor(line.length / 2)];
        const [x, y] = toScreen(mid[0], mid[1]);
        if (!onScreen([x, y])) continue;
        seen.add(name);
        tryPlace({ key: "v" + name, text: name, x, y: y - 8 }, 11, "river");
      }
      for (const c of a.geo.canals) {
        const mid = c.coords[Math.floor(c.coords.length / 2)];
        const [x, y] = toScreen(mid[0], mid[1]);
        tryPlace({ key: "c" + c.name, text: c.name, x: x + 22, y }, 11, "river");
      }
    }
    gGeoLabels.selectAll("text").data(labels, (d) => d.key).join("text")
      .attr("class", (d) => `geo-label ${d.kind}`)
      .attr("x", (d) => d.x)
      .attr("y", (d) => d.y)
      .attr("font-size", (d) => d.fs)
      .text((d) => d.text);

    return boxesForProvinceLabels;
  }

  // 方镇名标签交给主程序的国名标签系统排版（地图坐标）
  function labelEntries() {
    if (!active || !built) return [];
    return built.circuits.filter((c) => c.geometry).map((c) => {
      const poly = largestPolygon(c.geometry);
      const [x, y] = path.centroid(poly);
      const text = c.name.replace(/（.*）/, "");
      const size = Math.min(14, (Math.sqrt(path.area(poly)) * 0.9) / Math.max(textEm(text), 2.5));
      return { name: `circuit:${c.id}`, text, x, y, size, circuit: true, maxPx: 26 };
    }).filter((l) => Number.isFinite(l.x));
  }

  function largestPolygon(g) {
    if (g.type !== "MultiPolygon") return g;
    let best = null;
    let bestArea = -1;
    for (const coords of g.coordinates) {
      const poly = { type: "Polygon", coordinates: coords };
      const raw = d3.geoArea(poly);
      const ar = raw > 2 * Math.PI ? 4 * Math.PI - raw : raw;
      if (ar > bestArea) {
        bestArea = ar;
        best = poly;
      }
    }
    return best;
  }

  // ---------- 云 ----------
  let cloudState = null;
  let cloudFrame = 0;

  function makeCloudSprite(seed) {
    const rand = d3.randomLcg(seed);
    const w = 420;
    const h = 200;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    for (let i = 0; i < 26; i++) {
      const x = w * (0.18 + rand() * 0.64);
      const y = h * (0.35 + rand() * 0.35);
      const r = 30 + rand() * 60;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(255,253,245,0.5)");
      grad.addColorStop(1, "rgba(255,253,245,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  }

  function startClouds() {
    const { width, height } = ctx.getSize();
    // 云本来就是柔边的，用半分辨率画再由 CSS 放大，省下大半填充开销
    const dpr = 0.5;
    clouds.width = width * dpr;
    clouds.height = height * dpr;
    clouds.style.width = `${width}px`;
    clouds.style.height = `${height}px`;
    clouds.hidden = false;
    const rand = d3.randomLcg(42);
    const sprites = [1, 2, 3, 4].map(makeCloudSprite);
    cloudState = {
      dpr,
      items: d3.range(7).map((i) => ({
        sprite: sprites[i % sprites.length],
        x: rand() * (width + 400) - 200,
        y: rand() * height * 0.9,
        scale: 0.7 + rand() * 1.1,
        speed: 6 + rand() * 10, // 像素/秒
        alpha: 0.14 + rand() * 0.16,
      })),
      last: performance.now(),
    };
    const mapWrap = document.getElementById("map-wrap");
    const tick = (now) => {
      if (!reduceMotion && active) cloudFrame = requestAnimationFrame(tick);
      // 每秒最多 30 帧；地图缩放平移手势进行中暂停，把算力留给地图
      if (now - cloudState.last < 33 || mapWrap.style.transform) return;
      const dt = Math.min(0.1, (now - cloudState.last) / 1000);
      cloudState.last = now;
      const g = clouds.getContext("2d");
      const { width: w, height: h } = ctx.getSize();
      g.setTransform(cloudState.dpr, 0, 0, cloudState.dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      for (const c of cloudState.items) {
        if (!reduceMotion) c.x += c.speed * dt;
        const sw = 420 * c.scale;
        if (c.x > w + 40) c.x = -sw - 40;
        g.globalAlpha = c.alpha;
        g.drawImage(c.sprite, c.x, c.y, sw, 200 * c.scale);
      }
      g.globalAlpha = 1;
    };
    cancelAnimationFrame(cloudFrame);
    cloudFrame = requestAnimationFrame(tick);
  }

  function stopClouds() {
    cancelAnimationFrame(cloudFrame);
    clouds.hidden = true;
  }

  // ---------- 侧边栏 ----------
  const RELATION_CLASS = { 归附: "good", 册封: "good", 同盟: "good", 遣唐使: "good", 通商: "neutral", 羁縻: "neutral", 敌对: "bad" };

  function renderPanel() {
    const a = assetsSync;
    const court = a.tang.court;
    const c = selectedCircuit && built.byId.get(selectedCircuit);
    const types = Object.entries(a.tang.types).map(([key, t]) => {
      const n = built.circuits.filter((x) => x.type === key).length;
      return n ? `<li class="type-item${highlightType === key ? " on" : ""}" data-type="${key}"><span class="swatch" style="background:${t.color}"></span>${t.label}<span class="count">${n}</span></li>` : "";
    }).join("");

    let detail = `<p class="hint">点击地图上的州，查看所属方镇；点击类型可在地图上突出显示。</p>`;
    if (c) {
      const t = a.tang.types[c.type];
      const prefs = c.provinces
        .map((i) => built.current.set.provinces[i].properties.label)
        .filter((v, i, arr) => arr.indexOf(v) === i);
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
          <ul class="chips">${prefs.map((p) => `<li>${p}</li>`).join("")}</ul>
        </div>`;
    }

    const foreign = a.tang.foreign.map((f) => `
      <li class="foreign" data-name="${f.name}">
        <span class="rel ${RELATION_CLASS[f.relation] ?? "neutral"}">${f.relation}</span>
        <strong>${zhName(f.name)}</strong>
        <span class="ruler">${a.tang.rulers[f.name] ?? ""}</span>
        <p>${f.desc}</p>
      </li>`).join("");

    panel.innerHTML = `
      <div class="china-head">
        <div class="era-year">800</div>
        <div class="era-title">大唐 · 贞元十六年</div>
        <div class="ruler-line">${court.ruler}</div>
        <p class="era-desc">${court.note}</p>
      </div>
      <h3>方镇类型</h3>
      <ul class="type-legend">${types}</ul>
      ${detail}
      <h3>四夷与邻国</h3>
      <ul class="foreign-list">${foreign}</ul>
      <button id="china-exit" class="ghost">返回世界地图</button>`;

    panel.querySelectorAll(".type-item").forEach((el) => {
      el.onclick = () => {
        highlightType = highlightType === el.dataset.type ? null : el.dataset.type;
        applyHighlight();
        renderPanel();
      };
    });
    panel.querySelector("#china-exit").onclick = () => exit();
  }

  function selectCircuit(id) {
    selectedCircuit = id;
    drawSelected();
    renderPanel();
  }

  function showForeign(name) {
    selectedCircuit = null;
    drawSelected();
    renderPanel();
    const el = panel.querySelector(`.foreign[data-name="${CSS.escape(name)}"]`);
    if (el) {
      el.classList.add("flash");
      el.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    }
  }

  // ---------- 进入 / 退出 ----------
  let assetsSync = null;

  async function enter() {
    const current = ctx.getCurrent();
    if (active || !current || current.year !== 800) return;
    active = true;
    assetsSync = await loadAssets();
    if (!built || built.current !== current) built = build(current, assetsSync);
    ctx.clearCountrySelection();
    svg.classed("china-mode", true);
    gUnder.style("display", null);
    gOver.style("display", null);
    gScreen.style("display", null);
    document.getElementById("panel-empty").hidden = true;
    document.getElementById("panel-country").hidden = true;
    panel.hidden = false;
    draw();
    renderPanel();
    startClouds();

    const { width, height } = ctx.getSize();
    const [[x0, y0], [x1, y1]] = [projection(CHINA_VIEW[0]), projection(CHINA_VIEW[1])];
    const kk = Math.min(width / Math.abs(x1 - x0), height / Math.abs(y1 - y0)) * 0.95;
    entryK = kk;
    const tr = d3.zoomIdentity.translate(width / 2, height / 2).scale(kk).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    stageSel.transition().duration(reduceMotion ? 0 : 1200).ease(d3.easeCubicInOut).call(zoom.transform, tr);
  }

  function exit({ animate = true } = {}) {
    if (!active) return;
    active = false;
    selectedCircuit = null;
    highlightType = null;
    svg.classed("china-mode", false);
    gUnder.style("display", "none");
    gOver.style("display", "none");
    gScreen.style("display", "none");
    panel.hidden = true;
    stopClouds();
    ctx.clearCountrySelection();
    if (animate) stageSel.transition().duration(reduceMotion ? 0 : 900).ease(d3.easeCubicInOut).call(zoom.transform, d3.zoomIdentity);
    ctx.scheduleLabelUpdate();
  }

  return {
    get active() {
      return active;
    },
    enter,
    exit,
    render,
    labelEntries,
    // 中国视图里，唐朝体系的国名改由方镇名代替
    hidesLabel: (name) => active && FAMILY.has(name),
    // 中国视图里，唐朝体系内的城市改由城墙图标表示
    hidesCity: (country) => active && FAMILY.has(country),
    // 主程序点击国家时先问这里；返回 true 表示已处理
    onCountryClick(name) {
      const current = ctx.getCurrent();
      if (!active) {
        if (current?.year === 800 && FAMILY.has(name)) {
          enter();
          return true;
        }
        return false;
      }
      if (!FAMILY.has(name)) showForeign(name);
      return true;
    },
    onBackgroundClick() {
      if (!active) return false;
      selectedCircuit = null;
      highlightType = null;
      drawSelected();
      applyHighlight();
      renderPanel();
      return true;
    },
    onEscape() {
      if (!active) return false;
      if (selectedCircuit || highlightType) this.onBackgroundClick();
      else exit();
      return true;
    },
    onYearChange(year) {
      if (active && year !== 800) exit({ animate: false });
      built = null;
    },
    onResize() {
      if (active) {
        draw();
        startClouds();
      }
    },
  };
}
