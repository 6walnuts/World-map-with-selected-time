# 历史开局地图

模仿 P 社游戏（EU4 / HOI4 等）开局选国界面的世界地图 Web App：选一个历史时间点，在地图上点选国家。

## 运行

```bash
npm install
npm run dev      # 本地开发 http://localhost:5173
npm run build    # 打包到 dist/，可直接部署到任意静态托管
```

## 功能

- 8 个开局时间点：800 / 1279 / 1492 / 1600 / 1715 / 1815 / 1914 / 1938
- **省份制地图**：全球约 7600 个省份，国界由"每个省归谁"拼出来。放大后显示省界，悬停时高亮鼠标下的省份
- **P 社式缩放**：滚轮平滑缩放（以鼠标为中心），拖拽 / WASD / 方向键平移，+/- 缩放。远看只显示国家，拉近后逐渐出现省界和省份名
- 800、1279 年隐藏美洲（地理大发现之前的未知之地）（地理大发现之前的未知之地）
- 点击国家后，右侧面板显示宗主、省份数、面积、排名和可点击的邻国
- 附庸、殖民地、共主邦联用宗主色的近似色（同一宗主下的附庸各偏一点，彼此可分辨）；神圣罗马帝国这类名义宗主不染色。面板里列出本国的附庸与共主邦联
- 首都（金色菱形）与重要城市（圆点）标记，数据在 `public/data/cities.json`，按年份整理
- URL 记住当前状态，例如 `#1815/Austrian%20Empire`

## 数据是怎么来的

和 P 社一样，把**几何**和**归属**分开存：

| 文件 | 内容 |
|---|---|
| `public/data/provinces.json` | 省份几何，所有年份共用 |
| `public/data/owners_<年份>.json` | 该年份每个省份属于哪个国家 |
| `data/overrides.json` | 手工修正规则（带史实依据注释） |
| `data/admin_<年份>.json` | 某年各国行政区划的治所，用来生成该年专用省份 |
| `public/data/provinces_<年份>.json` | 按当时行政区划生成的该年专用省份 |

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
  ],
  "1600": [
    { "union": "Portugal", "with": "Spain" },
    { "vassal": "Naples", "of": "Spain" }
  ]
}
```

`union` 表示共主邦联，`vassal` 只改从属关系、不动领土。

也可以按经纬度范围匹配（省份质心落在 `[西, 南, 东, 北]` 内），用来切分省名相同的大省：

```json
{ "owner": "Tibetan Empire", "adm0": "CHN", "names": "Gansu", "bbox": [97, 30, 106.2, 43] }
```

改完运行 `bash scripts/build-data.sh 1492`，只重建对应年份。

### 按当时的行政区划划分省份（目前用于 800 年）

`data/admin_<年份>.json` 列出该年各国一级行政区的治所（名称 + 经纬度），例如唐朝的州府、法兰克的伯爵领、拜占庭的军区、阿拔斯的行省、日本的令制国。`scripts/build-admin-provinces.mjs` 会：

1. 用该年的归属表把通用省份合并成各国疆域；
2. 每个治所落在哪国疆域，就是哪国的一个省；
3. 有两个以上治所的国家，按“离哪个治所最近”（Voronoi）划分辖区；
4. 没有列治所的国家（芬兰、东欧斯拉夫诸部、草原游牧等史料中没有明确区划的）整体算一个省。

伊斯兰世界部分（阿拔斯、安达卢斯、马格里布等 143 个区府）导入自开源地名辞典 [al-Ṯurayyā](https://github.com/althurayya/althurayya.github.io)（CC BY 4.0，坐标源自 Cornu《古典时期阿拉伯-伊斯兰世界地图集》），用 `node scripts/import-althurayya.mjs <places.geojson>` 重新导入；其余国家的治所为手工整理。

辖区的**名称和治所是史实**，**边界是近似的**。生成的 `provinces_<年份>.json` 只给这一年用，归属表里的 `"provinces"` 字段告诉前端用哪份底图。`build-data.sh` 遇到有治所表的年份会自动执行这一步。

### 用 CHGIS 替换 800 年的唐朝州府（可选，仅本地）

[CHGIS](https://chgis.fas.harvard.edu/data/chgis/v6/) 的州府时间序列点能提供 800 年存在的全部 321 个州府治所（手工整理的约 260 个）。CHGIS 仅限学术非商业使用、不得再分发，所以仓库里不含它的数据和由它生成的地图，需要自己下载后在本地生成：

1. 从 Harvard Dataverse 下载 **V6 Time Series Prefecture Points**，解压出 `v6_time_pref_pts_utf_wgs84.shp`
2. `node scripts/import-chgis.mjs path/to/v6_time_pref_pts_utf_wgs84.shp 800`（输出到被 git 忽略的 `data-local/`）
3. `bash scripts/build-data.sh 800`：发现 `data-local/chgis_seats_800.json` 就优先使用它，手工治所里与之相距 40 公里内的自动去掉

注意第 3 步会改写 `public/data/provinces_800.json` 与 `owners_800.json`，这两个文件此时含 CHGIS 派生数据，不要提交到公开仓库。

### historical-basemaps 没有的年份

可以用相近年份的数据做底，再用规则修正：`bash scripts/build-data.sh 769:800` 表示开局年份 769、用 800 年的边界数据，规则写在 `overrides.json` 的 `"769"` 下。

### 添加时间点

1. 在 historical-basemaps 的 geojson 目录找到对应年份（如 `world_1880.geojson`）
2. `bash scripts/build-data.sh 1880`
3. 在 `src/config.js` 的 `BOOKMARKS` 里加上这一项；新国家可以在同一文件里补中文名和配色

## 数据与许可

- 历史边界：[aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps)，GPL-3.0（见 `public/data/LICENSE`）。归属表由它派生。
- 省份底图：[Natural Earth](https://www.naturalearthdata.com/)，公有领域。
- 800 年伊斯兰世界区府：al-Ṯurayyā Gazetteer Project, https://github.com/althurayya/althurayya.github.io ，CC BY 4.0（已翻译地名并筛去 800 年尚不存在的城市）。
- 省份是现代行政区切出来的，形状并非历史上的真实省份；归属精度参差不齐，仅供参考。
