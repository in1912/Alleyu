// 把升级包推到一台**已经在跑**的游巷站点上（走它自己的 /api/upgrade 模块），
// 并在最后做一次「硬验证」——版本号证明不了服务端代码，入口 chunk 名才能。
//
//   ALLEYU_URL=http://alleyu.in1912.cn \
//   ALLEYU_ADMIN_USER=<管理员用户名> ALLEYU_ADMIN_PASS=<密码> \
//   node scripts/push-upgrade.mjs --pack 游巷-1.12.0-upgrade.zip --apply
//
// 参数：
//   --pack <路径>        升级包（默认取仓库根最新的 游巷-<版本>-upgrade.zip）
//   --url  <地址>        目标站点（默认 env ALLEYU_URL，再默认 http://alleyu.in1912.cn）
//   --apply              真的应用（不带就是只预检，一个字节都不写）
//   --allow-dep-change   依赖表变了也放行（服务端默认拒绝，要求显式确认）
//   --timeout <秒>       等重启上线的时间，默认 120
//
// 凭证只从环境变量读：**不落盘、不打印、不进 git**。脚本自己也不会回显密码或 token。
//
// 为什么要有它：站点是独立部署（腾讯云 Windows + nginx + 裸 node），本仓库改完不会自动上线；
// 有了升级模块之后，「发一版」= 打一个包 → 推过去 → 看它自己重启 → 核对入口 chunk。
// 这几步人来点容易漏掉最后那步（版本号变了不等于新代码在跑——服务端 /api/system-info 的
// version 是读 package.json 的，包写错了版本号它也会「对」）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
// zipService 是纯函数模块（绝不 require db），这里直接拿来读包内 manifest
const { extractZip } = require(path.join(ROOT, 'server', 'services', 'zipService.js'));

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const URL_BASE = String(arg('--url', process.env.ALLEYU_URL || 'http://alleyu.in1912.cn')).replace(/\/+$/, '');
const APPLY = argv.includes('--apply');
const ALLOW_DEP = argv.includes('--allow-dep-change');
const TIMEOUT_S = Number(arg('--timeout', '120')) || 120;
const USER = process.env.ALLEYU_ADMIN_USER || '';
const PASS = process.env.ALLEYU_ADMIN_PASS || '';

const die = (m) => { console.error('\n❌ ' + m + '\n'); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const okMsg = (m) => console.log('  ✅ ' + m);

function pickPack() {
  const explicit = arg('--pack', '');
  if (explicit) {
    const p = path.isAbsolute(explicit) ? explicit : path.join(ROOT, explicit);
    if (!fs.existsSync(p)) die(`找不到升级包 ${p}`);
    return p;
  }
  const cands = fs.readdirSync(ROOT).filter((n) => /^游巷-.*-upgrade\.zip$/.test(n));
  if (!cands.length) die('仓库根没有 游巷-*-upgrade.zip：先跑 npm run pack:upgrade');
  // 按 mtime 取最新（版本号排序会在 1.9.1 vs 1.10.0 上翻车）
  cands.sort((a, b) => fs.statSync(path.join(ROOT, b)).mtimeMs - fs.statSync(path.join(ROOT, a)).mtimeMs);
  return path.join(ROOT, cands[0]);
}

// 拿首页 HTML 里的入口 chunk 名——「服务端到底在发哪份前端」的铁证
const entryChunk = (html) => (String(html).match(/assets\/index-[A-Za-z0-9_.-]+\.(?:js|css)/g) || []).sort().join(' | ');

async function api(pathname, opts = {}, timeoutMs = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(URL_BASE + pathname, { ...opts, signal: ctl.signal });
  } finally { clearTimeout(t); }
}

// 非 JSON 回包（nginx 413/502 的 HTML）必须说人话，不能甩 Unexpected token '<'
async function readJson(res) {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!ct.includes('json')) {
    return { error: `回包不是 JSON（HTTP ${res.status}，Content-Type: ${ct || '无'}）：多半是反代拒收或出错——`
      + `上传通道要 client_max_body_size ≥ 包体积。回包开头：${text.slice(0, 160).replace(/\s+/g, ' ')}` };
  }
  try { return JSON.parse(text); } catch { return { error: `JSON 解析失败（HTTP ${res.status}）：${text.slice(0, 160)}` }; }
}

// ---- 0) 包与目标站点 ----
const PACK = pickPack();
const zip = fs.readFileSync(PACK);
let manifest = null;
try {
  const entries = extractZip(zip);
  const m = entries.find((e) => e.name === 'manifest.json');
  manifest = m ? JSON.parse(m.data.toString('utf8')) : null;
  // 包内前端入口 chunk（升级成功后要拿它跟线上首页对）
  const idx = entries.find((e) => /^web\/dist\/\d{8,}\/index\.html$/.test(e.name));
  if (idx) manifest.pack_entry = entryChunk(idx.data.toString('utf8'));
} catch (e) { die('读包失败（不是合法 zip？）：' + e.message); }
if (!manifest) die('包里没有 manifest.json');
console.log(`升级包 ${path.basename(PACK)}（${(zip.length / 1024).toFixed(1)}KB）：v${manifest.version}，dist=${manifest.dist}`);
if (manifest.pack_entry) console.log(`  包内前端入口 chunk：${manifest.pack_entry}`);

const sys = await api('/api/system-info', {}, 20000).then(readJson).catch((e) => ({ error: e.message }));
if (sys.error) die(`连不上 ${URL_BASE}：${sys.error}`);
console.log(`目标站点 ${URL_BASE}：当前 v${sys.version}（node ${sys.node} / ${sys.platform}）`);

// 同版本/更旧不用推：服务端也会以 STALE_DIST 拒绝（dist 时间戳不比现役新就白升一次）
if (!APPLY && sys.version === manifest.version) {
  console.log(`\n⚠️ 线上已经是 v${manifest.version} 了。若 dist 时间戳也不比现役新，服务端会在预检阶段回 STALE_DIST（这是设计）。`);
}

if (!USER || !PASS) {
  die('缺管理员凭证：请设 ALLEYU_ADMIN_USER / ALLEYU_ADMIN_PASS 环境变量再跑（凭证只经环境变量，不落盘不打印）。'
    + `\n   例如：ALLEYU_ADMIN_USER=xxx ALLEYU_ADMIN_PASS=yyy node scripts/push-upgrade.mjs --pack ${path.basename(PACK)}${APPLY ? ' --apply' : ''}`);
}

// ---- 1) 登录 ----
const lr = await api('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
}).then(readJson);
if (!lr.token) die('登录失败：' + (lr.error || JSON.stringify(lr).slice(0, 160)));
const auth = { Authorization: 'Bearer ' + lr.token };
okMsg(`已用管理员 ${USER} 登录（token 长度 ${String(lr.token).length}，不回显）`);

// ---- 2) 预检（只读）----
const pr = await api('/api/upgrade/plan', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: zip,
}, 180000).then(readJson);
if (!pr.plan) die('预检被拒：' + (pr.error || JSON.stringify(pr).slice(0, 240)));
const p = pr.plan;
okMsg(`预检通过：v${p.version.current} → v${p.version.incoming}，新增 ${p.summary.add} / 覆盖 ${p.summary.overwrite} / `
  + `跳过 ${p.summary.skip}${p.summary.reject ? ` / 拒绝 ${p.summary.reject}` : ''}，dist=${p.summary.dist_dir}，`
  + `需要重启=${p.restart_required}`);
if (p.warnings && p.warnings.length) {
  console.log('  ⚠️ 预检警告：');
  for (const w of p.warnings) console.log('     - ' + w);
}
if (!APPLY) {
  console.log('\n（未带 --apply：只预检，服务端一个字节都没写。要真升级请加 --apply）\n');
  process.exit(0);
}

// ---- 3) 应用 ----
const ar = await api('/api/upgrade/apply', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: pr.token, ...(ALLOW_DEP ? { allow_dep_change: true } : {}) }),
}, 180000).then(readJson);
if (ar.applied !== true) die('应用失败：' + (ar.error || JSON.stringify(ar).slice(0, 300)));
okMsg(`已应用：写入 ${ar.files_written.total} 个文件（覆盖 ${ar.files_written.overwrite.length} / 新增 `
  + `${ar.files_written.add.length} / 跳过 ${(ar.files_written.skipped || []).length}），备份 ${ar.backup_dir || '（无）'}`);
console.log(`     重启：${ar.restart}${ar.restart_note ? ' — ' + ar.restart_note : ''}`);

// ---- 4) 等它自己重启上线 ----
if (ar.restart === 'scheduled') {
  const t0 = Date.now();
  let up = null;
  while ((Date.now() - t0) / 1000 < TIMEOUT_S) {
    await sleep(1500);
    try {
      const s = await api('/api/system-info', { cache: 'no-store' }, 8000).then(readJson);
      if (s.version === manifest.version) { up = s; break; }
    } catch { /* 重启窗口里连不上是正常的 */ }
  }
  if (!up) {
    console.log(`\n❌ 等了 ${TIMEOUT_S}s 没等到 v${manifest.version} 上线。`);
    console.log('   老进程的日志在服务端 Logs/upgrade.log，接替进程的在 Logs/restart-child.log（Get-Content ... -Wait 看）。');
    console.log(`   回滚：把 ${ar.backup_dir || 'data/upgrades/backup_*'} 里的文件拷回部署目录再重启。`);
    process.exit(1);
  }
  okMsg(`服务已重新上线：v${up.version}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
} else if (ar.restart === 'suppressed') {
  console.log(`\n⚠️ ${ar.restart_note || '文件已落盘但进程没重启'}——去服务端手动重启后新代码才生效。`);
}

// ---- 5) 硬验证：服务端在发的**前端**是不是包里那份 ----
// 版本号只证明 package.json 被换了；入口 chunk 名对得上才证明新前端真的在服务
try {
  const html = await api('/', { cache: 'no-store' }, 15000).then((r) => r.text());
  const live = entryChunk(html);
  if (manifest.pack_entry && live === manifest.pack_entry) {
    okMsg(`硬验证：线上首页入口 chunk 与包内一致（${live}）——新前端真的在服务`);
  } else if (manifest.pack_entry) {
    console.log(`  ❌ 线上首页入口 chunk 是 ${live || '（没找到）'}，包内是 ${manifest.pack_entry}`);
    console.log('     ——版本号变了但前端没换（CDN/反代缓存？look at / 的 Cache-Control）。别当成升级成功。');
    process.exit(1);
  }
} catch (e) { console.log('  ⚠️ 拉首页对比入口 chunk 失败：' + e.message); }

console.log(`\n完成：${URL_BASE} 现在是 v${manifest.version}\n`);
