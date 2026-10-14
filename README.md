# 历史开局地图

模仿 P 社游戏（EU4 / HOI4 等）开局选国界面的世界地图 Web App：选一个历史时间点，在地图上点选国家。

## 运行

```bash
npm install
npm run dev      # 本地开发 http://localhost:5173
npm run build    # 打包到 dist/，可直接部署到任意静态托管
```

## 功能

- 顶部书签切换 7 个时间点：1279 / 1492 / 1600 / 1715 / 1815 / 1914 / 1938
- 悬停高亮 + 提示框，点击选中后右侧面板显示国旗盾徽、面积、排名和可点击的邻国列表
- 缩放平移（滚轮 / 拖拽 / 右下角按钮），国名标签按字号和碰撞自动显隐
- 附庸和殖民地用宗主国颜色的浅色版显示，部落和文化区显示为淡色"未开化地区"
- URL 会记住当前状态，例如 `#1815/Austrian%20Empire`，可以直接分享

## 目录

```
src/config.js        时间点书签、国家固定配色、中文译名
src/main.js          地图渲染与交互（D3 + TopoJSON）
src/style.css        样式
public/data/         预处理后的 TopoJSON 数据
scripts/build-data.sh 下载并重新生成数据
```

## 添加时间点

1. 在 [historical-basemaps 的 geojson 目录](https://github.com/aourednik/historical-basemaps/tree/master/geojson) 找到对应年份（如 `world_1880.geojson`）
2. 运行 `bash scripts/build-data.sh 1880`
3. 在 `src/config.js` 的 `BOOKMARKS` 里加上这一项

## 数据与许可

- 历史边界：[aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps)，GPL-3.0（见 `public/data/LICENSE`）。数据的精度和史实性参差不齐，仅供参考。
- 陆地底图：[Natural Earth](https://www.naturalearthdata.com/)（公有领域），来自 `world-atlas`。
