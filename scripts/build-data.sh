#!/usr/bin/env bash
# 一键重建全部地图数据
# 用法：bash scripts/build-data.sh [年份...]
#   不带参数：重建省份底图 + 所有年份的归属表
#   带年份：只重建这些年份的归属表（改了 data/overrides.json 之后用这个）
set -euo pipefail
cd "$(dirname "$0")/.."

ALL_YEARS=(1279 1492 1600 1715 1815 1914 1938)
BASE=https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson
mkdir -p data-src

if [ $# -eq 0 ]; then
  bash scripts/build-provinces.sh
  YEARS=("${ALL_YEARS[@]}")
else
  YEARS=("$@")
fi

for y in "${YEARS[@]}"; do
  [ -f "data-src/world_$y.geojson" ] || curl -fsSL -o "data-src/world_$y.geojson" "$BASE/world_$y.geojson"
done

node scripts/build-owners.mjs "${YEARS[@]}"
