# 历史开局地图

模仿 P 社游戏（EU4 / HOI4 等）开局选国界面的世界地图 Web App：选一个历史时间点，在地图上点选国家。

## 运行

```bash
npm install
npm run dev      # 本地开发 http://localhost:5173
npm run build    # 打包到 dist/，可直接部署到任意静态托管
```

## 功能

- 7 个开局时间点：1279 / 1492 / 1600 / 1715 / 1815 / 1914 / 1938
- **省份制地图**：全球约 7600 个省份，国界由"每个省归谁"拼出来。放大后显示省界，悬停时高亮鼠标下的省份
- 1279 年隐藏美洲（地理大发现之前的未知之地）
- 点击国家后，右侧面板显示宗主、省份数、面积、排名和可点击的邻国
- 附庸和殖民地用宗主国颜色的浅色版；神圣罗马帝国这类名义宗主不染色
- URL 记住当前状态，例如 `#1815/Austrian%20Empire`

## 数据是怎么来的

和 P 社一样，把**几何**和**归属**分开存：

| 文件 | 内容 |
|---|---|
| `public/data/provinces.json` | 省份几何，所有年份共用 |
| `public/data/owners_<年份>.json` | 该年份每个省份属于哪个国家 |
| `data/overrides.json` | 手工修正规则（带史实依据注释） |

生成流程：

1. **省份**（`scripts/build-provinces.sh`）：以 Natural Earth 1:10m 一级行政区为底，把过碎的（斯洛文尼亚、英国等）按大区合并，把过大的用 k-means + Voronoi 切开。目标面积为欧洲约 9000 km²、东亚和南亚约 16000 km²、其他地区约 30000 km²，高纬度更大。
2. **归属**（`scripts/build-owners.mjs`）：在每个省份内部撒 24 个采样点，看各点落在 [historical-basemaps](https://github.com/aourednik/historical-basemaps) 当年哪个国家里，按多数票决定归属。
3. **修正**：自动结果的精度受限于原数据（比如原数据把 1492 年的整个德意志标成一块"神圣罗马帝国"，把 1815 年的比利时标成奥地利），再用 `data/overrides.json` 里的规则逐条修正。

### 修正规则

规则按"现代国家代码 / 省份名 / 大区名 / 当前归属"匹配，所以重新生成省份后依然有效：

```json
{
  "1492": [
    { "owner": "Naples", "from": "Aragón", "adm0": "ITA", "regions": ["Campania", "Calabria"], "note": "依据……" },
    { "owner": "Bohemia", "overlord": "Holy Roman Empire", "from": "Holy Roman Empire", "adm0": "CZE" }
  ],
  "1914": [
    { "rename": "Manchu Empire", "to": "Republic of China" }
  ]
}
```

改完运行 `bash scripts/build-data.sh 1492`，只重建对应年份。

找该修什么，可以用诊断工具查看某年各现代国家的省份分别归谁：

```bash
node scripts/inspect-owners.mjs 1492 DEU ITA FRA
# DEU: Bavaria×8, Brunswick×5, Saxony×4, ...
```

### 添加时间点

1. 在 historical-basemaps 的 geojson 目录找到对应年份（如 `world_1880.geojson`）
2. `bash scripts/build-data.sh 1880`
3. 在 `src/config.js` 的 `BOOKMARKS` 里加上这一项；新国家可以在同一文件里补中文名和配色

## 数据与许可

- 历史边界：[aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps)，GPL-3.0（见 `public/data/LICENSE`）。归属表由它派生。
- 省份底图：[Natural Earth](https://www.naturalearthdata.com/)，公有领域。
- 省份是现代行政区切出来的，形状并非历史上的真实省份；归属精度参差不齐，仅供参考。
