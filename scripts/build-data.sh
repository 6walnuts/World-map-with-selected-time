#!/usr/bin/env bash
# 下载 historical-basemaps 并生成精简后的 TopoJSON 到 public/data/
# 用法：bash scripts/build-data.sh [年份...]
set -euo pipefail
cd "$(dirname "$0")/.."

YEARS=("$@")
[ ${#YEARS[@]} -eq 0 ] && YEARS=(1279 1492 1600 1715 1815 1914 1938)

SRC=data-src
OUT=public/data
BASE=https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson
mkdir -p "$SRC" "$OUT"

for y in "${YEARS[@]}"; do
  [ -f "$SRC/world_$y.geojson" ] || curl -fsSL -o "$SRC/world_$y.geojson" "$BASE/world_$y.geojson"
  # 只保留需要的字段，同名多边形合并为一个国家，简化并清理碎片
  npx mapshaper -i "$SRC/world_$y.geojson" \
    -filter-fields NAME,SUBJECTO \
    -dissolve NAME copy-fields=SUBJECTO \
    -simplify 15% keep-shapes \
    -clean \
    -o "$OUT/world_$y.json" format=topojson quantization=1e5
done

# 陆地底图（Natural Earth 1:50m），用来填补历史数据没有覆盖到的区域
npx mapshaper -i node_modules/world-atlas/land-50m.json \
  -simplify 25% keep-shapes \
  -o "$OUT/land.json" format=topojson quantization=1e5

ls -la "$OUT"
