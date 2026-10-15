// 大唐（800 年）：在世界地图上点击大唐或其藩镇，镜头先推近中国，再切换到独立的 2.5D 场景（tang3d.js）。
// 本文件负责把省份数据整理成「州 → 方镇」并处理进出；立体地形、城池、云与侧边栏都在 tang3d.js。
import * as d3 from "d3";
import * as topojson from "topojson-client";
import { createTang3D } from "./tang3d.js";

// 属于"唐朝体系"的势力：唐廷直辖与名义上臣属的藩镇
const FAMILY = new Set(["Tang Empire", "Lulong Circuit", "Chengde Circuit", "Weibo Circuit", "Pinglu Circuit", "Huaixi Circuit"]);
// 原数据里单独成国的藩镇 → 对应的方镇 id（州名匹配不上时兜底）
const COUNTRY_CIRCUIT = {
  "Lulong Circuit": "lulong", "Chengde Circuit": "chengde", "Weibo Circuit": "weibo",
  "Pinglu Circuit": "ziqing", "Huaixi Circuit": "huaixi",
};
const CHINA_VIEW = [[99, 19], [124, 42]]; // 切换前二维地图推近的经纬度范围

export function createChina(ctx) {
  const { stageSel, zoom, projection, zhName, textEm, DATA } = ctx;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let built = null;
  let assets = null;
  let entering = false;

  const scene3d = createTang3D({
    DATA, zhName, textEm,
    onExit() {
      document.body.classList.remove("tang-open");
      stageSel.transition().duration(reduceMotion ? 0 : 900).ease(d3.easeCubicInOut).call(zoom.transform, d3.zoomIdentity);
      ctx.scheduleLabelUpdate();
    },
  });

  async function loadAssets() {
    if (!assets) {
      assets = Promise.all([
        d3.json(`${DATA}tang_800.json`),
        d3.json(`${DATA}china_geo.json`),
      ]).then(([tang, geo]) => ({ tang, geo }));
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

    return { current, family, circuits: circuits.filter((c) => c.provinces.length), byId, circuitOf, borderMesh, owner, isFamily: (n) => FAMILY.has(n) };
  }

  async function enter() {
    const current = ctx.getCurrent();
    if (entering || scene3d.isOpen || !current || current.year !== 800) return;
    entering = true;
    ctx.clearCountrySelection();
    // 二维地图先推近中国，作为进入立体场景的过场
    const { width, height } = ctx.getSize();
    const [[x0, y0], [x1, y1]] = [projection(CHINA_VIEW[0]), projection(CHINA_VIEW[1])];
    const k = Math.min(width / Math.abs(x1 - x0), height / Math.abs(y1 - y0)) * 0.95;
    const tr = d3.zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    const zoomed = new Promise((r) => stageSel.transition().duration(reduceMotion ? 0 : 900).ease(d3.easeCubicInOut).call(zoom.transform, tr).on("end interrupt", r));
    const a = await loadAssets();
    if (!built || built.current !== current) built = build(current, a);
    await zoomed;
    document.body.classList.add("tang-open");
    try {
      await scene3d.open(built, a);
    } finally {
      entering = false;
    }
  }

  return {
    get active() {
      return scene3d.isOpen;
    },
    enter,
    exit: () => scene3d.close(),
    render: () => [],
    labelEntries: () => [],
    hidesLabel: () => false,
    hidesCity: () => false,
    // 主程序点击国家时先问这里；返回 true 表示已处理
    onCountryClick(name) {
      const current = ctx.getCurrent();
      if (current?.year === 800 && FAMILY.has(name)) {
        enter();
        return true;
      }
      return false;
    },
    onBackgroundClick: () => false,
    onEscape: () => scene3d.isOpen,
    onYearChange(year) {
      if (year !== 800) scene3d.close();
      built = null;
    },
    onResize() {},
  };
}
