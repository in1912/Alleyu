// v1.12.0 批量补全的城市筛选（纯函数，自检可直接 import 断言）。
// 语义：「景点数少于 N 的城市」——严格小于 N（N=6 时 0~5 条都会被选中，6 条不选）。
// 阈值来自设置页（设置 → 维基与补全），缺省/非法一律回落到 6。
const DEFAULT_THRESHOLD = 6;
const MAX_THRESHOLD = 100;

export function backfillThreshold(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return DEFAULT_THRESHOLD;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > MAX_THRESHOLD) return DEFAULT_THRESHOLD;
  return n;
}

export function pickBackfillCities(cities, threshold) {
  const t = backfillThreshold(threshold);
  return (cities || []).filter((c) => (c.line || '国内') === '国内' && Number(c.attr_count ?? 0) < t);
}

export const DEFAULT_BACKFILL_THRESHOLD = DEFAULT_THRESHOLD;
