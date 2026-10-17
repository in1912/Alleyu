// v1.12.0 维基分站开关 + 补全阈值。
// 这里是**唯一**碰 db 的一层——server/services/wikiService.js 必须保持零 db 依赖
// （check-alleyu.mjs 会在进程内直接 require 它跑纯函数断言）。
//
// 语义（与设置页文案一致）：
//  - wiki_voyage_enabled / wiki_pedia_enabled：存 '1' 或 ''，**缺省 = 关**。
//    未勾选的站点一个请求都不会发（不是「勾了才优先」，是「不勾就完全不连」）。
//  - backfill_max_attrs：批量补全的阈值 N，缺省/非法 = 6。前端用它挑「景点数 < N」的国内城市。
const { getSetting } = require('../db');

const KINDS = [
  { kind: 'voyage', key: 'wiki_voyage_enabled' },
  { kind: 'pedia', key: 'wiki_pedia_enabled' },
];

const DEFAULT_MAX_ATTRS = 6;
const MAX_ATTRS_LIMIT = 100;

function parseBoolSetting(raw) {
  return raw === true || raw === 1 || raw === '1' || raw === 'true';
}

// PUT 校验用：只收布尔语义的值（null/undefined = 没传，由调用方判断）
function isBoolInput(raw) {
  return raw === true || raw === false || raw === 1 || raw === 0 || raw === '1' || raw === '0';
}

function enabledKinds() {
  return KINDS.filter((k) => parseBoolSetting(getSetting(k.key))).map((k) => k.kind);
}

function backfillMaxAttrs() {
  const s = String(getSetting('backfill_max_attrs') || '').trim();
  if (!s) return DEFAULT_MAX_ATTRS;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > MAX_ATTRS_LIMIT) return DEFAULT_MAX_ATTRS;
  return n;
}

function wikiSettingsJson() {
  return {
    wiki_voyage_enabled: parseBoolSetting(getSetting('wiki_voyage_enabled')),
    wiki_pedia_enabled: parseBoolSetting(getSetting('wiki_pedia_enabled')),
    backfill_max_attrs: backfillMaxAttrs(),
  };
}

module.exports = {
  KINDS, DEFAULT_MAX_ATTRS, MAX_ATTRS_LIMIT,
  parseBoolSetting, isBoolInput, enabledKinds, backfillMaxAttrs, wikiSettingsJson,
};
