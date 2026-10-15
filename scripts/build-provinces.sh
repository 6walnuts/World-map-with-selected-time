#!/usr/bin/env bash
# 生成省份底图 public/data/provinces.json
# 流程：下载 Natural Earth 一级行政区 → 合并过碎的 → 简化 → 切分过大的 → 修拓扑
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=data-src/ne
mkdir -p "$SRC"
[ -f "$SRC/admin1.geojson" ] || curl -fsSL -o "$SRC/admin1.geojson" \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson

node scripts/group-admin1.mjs "$SRC/admin1.geojson" "$SRC/admin1_g.geojson"
npx mapshaper -i "$SRC/admin1_g.geojson" \
  -filter 'adm0_a3 != "ATA"' \
  -dissolve grp copy-fields=name,name_zh,region,admin,adm0_a3 \
  -simplify 8% keep-shapes \
  -clean \
  -o "$SRC/admin1_s.geojson"
node scripts/split-provinces.mjs "$SRC/admin1_s.geojson" "$SRC/provinces_raw.geojson"
npx mapshaper -i "$SRC/provinces_raw.geojson" \
  snap snap-interval=0.0005 \
  -clean \
  -o public/data/provinces.json format=topojson quantization=2e5

# 海岸光晕用的低精度海岸线（光晕是模糊的，不需要全精度）
npx mapshaper -i public/data/provinces.json \
  -dissolve \
  -simplify 6% keep-shapes \
  -filter-slivers min-area=200km2 \
  -o public/data/coast.json format=topojson quantization=1e5
