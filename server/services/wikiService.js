// 维基系介绍抓取（v1.7.0 景点信息扩容）：zh.wikivoyage（维基旅行，旅行向）优先，
// zh.wikipedia（维基百科，百科向）兜底。两者都是 MediaWiki API、免 Key。
// 协议 CC BY-SA：返回值必须带 source/url，落库时署名、生成攻略时在「生成来源」致谢——
// 调用方不许丢掉署名信息只存文本。
// ALLEYU_WIKI_OFFLINE=1 时直接抛错（离线自检用，防止「离线测试偷偷打真网」——v1.6.3 高德的教训）。
//
// v1.11.1（「一键补全卡着不动」根因修复）：
//  - **超时值下调 8000→6000，且「连不上」和「没这条」分开报**（fetchIntroEx 的 netFail）。
//    旧实现里两者都只回 null，调用方无法区分——于是网络不通时界面会说「暂无条目」，是假话。
//  - **网络层失败就不再试 `generator=search` 兜底那条 URL**：同一张网，再试一遍只是把
//    等待时间翻倍。单条景点的最坏耗时因此从 4×8s=32s 降到 2×6s=12s。国内访问不到
//    zh.wikipedia / zh.wikivoyage 时每次都卡满超时，这就是「40 条景点 = 21 分钟」的由来。
//  - 期望：调用方**必须**自己加时间预算（见 services/introBackfill.js），本模块不设总预算。

const DEFAULT_SITES = [
  { label: '维基旅行', origin: 'https://zh.wikivoyage.org' },
  { label: '维基百科', origin: 'https://zh.wikipedia.org' },
];

// 站点表与超时可由 env 覆盖。**这两个 env 是自检/排障钩子，不是给日常用的功能开关**：
// 自检要把站点指向本地「只连不答」的桩、把超时压到几百毫秒，才能在没有外网的情况下
// 确定性地测「连不上会立刻停」。默认值就是原来那两家官方站点。
// 格式：ALLEYU_WIKI_ORIGINS='维基旅行|https://zh.wikivoyage.org,维基百科|https://zh.wikipedia.org'
function parseOrigins(v) {
  const out = [];
  for (const one of String(v || '').split(',')) {
    const s = one.trim();
    if (!s) continue;
    const i = s.indexOf('|');
    const label = i >= 0 ? s.slice(0, i).trim() : '';
    const origin = (i >= 0 ? s.slice(i + 1) : s).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(origin)) continue;
    out.push({ label: label || '维基', origin });
  }
  return out;
}
const ENV_ORIGINS = parseOrigins(process.env.ALLEYU_WIKI_ORIGINS);
if (process.env.ALLEYU_WIKI_ORIGINS && !ENV_ORIGINS.length) {
  console.warn('[wiki] ALLEYU_WIKI_ORIGINS 解析不出任何站点，已回落官方站点。格式应如「维基百科|https://zh.wikipedia.org」');
}
const SITES = ENV_ORIGINS.length ? ENV_ORIGINS : DEFAULT_SITES;
const TIMEOUT_MS = Number(process.env.ALLEYU_WIKI_TIMEOUT_MS) || 6000;

// 串行节流（对 wiki 服务器客气点，200ms 足够）
let _lastCall = 0;
async function throttle() {
  const wait = _lastCall + 200 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastCall = Date.now();
}

const UA = 'Alleyu/1.7 (self-hosted travel-guide generator; node-fetch)';

function cleanExtract(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// 单站点查询：先精确标题（带重定向），未命中再搜索取第一名（「八大关」这类短名常需搜索补全）
// 返回 { hit: {text,url} | null, netFail: boolean }——netFail 只在**网络层失败**时为 true。
async function querySite(site, title, timeoutMs = TIMEOUT_MS) {
  const params = (extra) => new URLSearchParams({
    action: 'query', format: 'json', redirects: '1',
    prop: 'extracts|info', inprop: 'url', exintro: '1', explaintext: '1',
    ...extra,
  });
  const urls = [
    `${site.origin}/w/api.php?${params({ titles: title })}`,
    `${site.origin}/w/api.php?${params({ generator: 'search', gsrsearch: title, gsrlimit: '1', gsrnamespace: '0' })}`,
  ];
  for (const u of urls) {
    await throttle();
    let j;
    try {
      const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue; // 站点答了（403/429/5xx）→ 换搜索兜底那条 URL 再试
      try { j = await res.json(); } catch { continue; } // 回的不是 JSON → 也算「答了但没东西」
    } catch {
      // 超时 / DNS 不通 / 连接被拒：换 URL 也是同一张网，再试一遍只是把等待时间翻倍
      return { hit: null, netFail: true };
    }
    const pages = (j.query && j.query.pages) || {};
    for (const p of Object.values(pages)) {
      if (p.missing === '' || p.invalid === '') continue;
      const text = cleanExtract(p.extract);
      if (text && text.length >= 30 && p.fullurl) {
        // 搜索兜底命中时标题可能对不上（搜「故宫」返回别的条目），要求标题互相包含才认
        if (u.includes('generator=search')) {
          const pt = String(p.title || '');
          if (!pt.includes(title) && !title.includes(pt)) continue;
        }
        return { hit: { text: text.slice(0, 800), url: p.fullurl }, netFail: false };
      }
    }
  }
  return { hit: null, netFail: false };
}

// 抓「景点/城市」的介绍段。返回 { hit: {text,source,url} | null, netFail } —— 调用方靠 netFail
// 区分「维基连不上」（网络现实，不该说成没条目）和「两家都没有可用条目」。
// 只有**所有站点都在网络层失败**才 netFail=true；只要有一家真答了「没这条」就是 false。
async function fetchIntroEx(title, opts = {}) {
  const name = String(title || '').trim();
  if (!name) return { hit: null, netFail: false };
  if (process.env.ALLEYU_WIKI_OFFLINE === '1') throw new Error('维基介绍抓取已被 ALLEYU_WIKI_OFFLINE 关闭（离线自检模式）');
  const timeoutMs = Number(opts.timeoutMs) || TIMEOUT_MS;
  let allNetFail = true;
  for (const site of SITES) {
    let got;
    try {
      got = await querySite(site, name, timeoutMs);
    } catch (e) {
      console.warn(`[wiki] ${site.label}「${name}」失败:`, e.message);
      got = { hit: null, netFail: true };
    }
    if (got.hit) return { hit: { text: got.hit.text, source: site.label, url: got.hit.url }, netFail: false };
    if (!got.netFail) allNetFail = false;
  }
  return { hit: null, netFail: allNetFail };
}

// 兼容入口：返回 { text, source, url } 或 null（旧调用方语义不变），连不上与没条目仍都是 null。
async function fetchIntro(title, opts) {
  return (await fetchIntroEx(title, opts)).hit;
}

// 只读连通探针（v1.11.1）：对固定标题逐站点测一次，报告「可达/连不上/耗时」。**绝不写库**。
// 用途：管理员一眼分清「维基连不上」和「这条景点确实没条目」——前者是网络现实，后者才该说「暂无条目」。
// 离线自检模式下不打真网，直接如实回「离线模式」。
async function probeSites(title = '故宫博物院', opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || TIMEOUT_MS;
  if (process.env.ALLEYU_WIKI_OFFLINE === '1') {
    return {
      reachable: false, offline: true, timeout_ms: timeoutMs,
      sites: SITES.map((s) => ({ label: s.label, origin: s.origin, ok: false, ms: 0, error: '离线自检模式（ALLEYU_WIKI_OFFLINE=1），没有打真网' })),
    };
  }
  const sites = [];
  for (const site of SITES) {
    const t0 = Date.now();
    let ok = false;
    let error = '';
    try {
      const got = await querySite(site, String(title).trim(), timeoutMs);
      ok = !got.netFail; // 答了「没这条」也算可达
      if (got.netFail) error = `连不上（${timeoutMs}ms 超时或网络不通）`;
    } catch (e) { error = e.message; }
    sites.push({ label: site.label, origin: site.origin, ok, ms: Date.now() - t0, error });
  }
  return { reachable: sites.some((s) => s.ok), offline: false, timeout_ms: timeoutMs, sites };
}

module.exports = { fetchIntro, fetchIntroEx, probeSites, SITES };
