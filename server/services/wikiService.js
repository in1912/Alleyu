// 维基系介绍抓取（v1.7.0 景点信息扩容）：zh.wikivoyage（维基旅行，旅行向）优先，
// zh.wikipedia（维基百科，百科向）兜底。两者都是 MediaWiki API、免 Key。
// 协议 CC BY-SA：返回值必须带 source/url，落库时署名、生成攻略时在「生成来源」致谢——
// 调用方不许丢掉署名信息只存文本。
// ALLEYU_WIKI_OFFLINE=1 时直接抛错（离线自检用，防止「离线测试偷偷打真网」——v1.6.3 高德的教训）。

const SITES = [
  { label: '维基旅行', origin: 'https://zh.wikivoyage.org' },
  { label: '维基百科', origin: 'https://zh.wikipedia.org' },
];

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
async function querySite(site, title, timeoutMs = 8000) {
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
      if (!res.ok) continue;
      j = await res.json();
    } catch { continue; }
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
        return { text: text.slice(0, 800), url: p.fullurl };
      }
    }
  }
  return null;
}

// 抓「景点/城市」的介绍段。返回 { text, source, url } 或 null（两家都没有可用条目）。
async function fetchIntro(title) {
  const name = String(title || '').trim();
  if (!name) return null;
  if (process.env.ALLEYU_WIKI_OFFLINE === '1') throw new Error('维基介绍抓取已被 ALLEYU_WIKI_OFFLINE 关闭（离线自检模式）');
  for (const site of SITES) {
    try {
      const hit = await querySite(site, name);
      if (hit) return { text: hit.text, source: site.label, url: hit.url };
    } catch (e) {
      console.warn(`[wiki] ${site.label}「${name}」失败:`, e.message);
    }
  }
  return null;
}

module.exports = { fetchIntro };
