// 「升级 → 自己重启 → 新版本真的在跑」这条链路的**真机演练**（v1.11.0）。
//
//   node scripts/verify-upgrade-restart.mjs
//
// 为什么单独有这个脚本：check-alleyu.mjs 全程带 ALLEYU_NO_RESTART=1（它跑在仓库上，不能真让进程换掉），
// render-alleyu.mjs 更是只预检、绝不应用。所以「detached 子进程到底能不能在 Windows 上接管端口」
// 这件事，两个自检都覆盖不到 —— 而它恰恰是这套升级里唯一没法靠读代码放心的地方。
//
// 它做的事：在仓库内造一个「旧版部署目录」.upgrade-manual-test（dist 更旧、版本更老、启动横幅带 [OLD-CODE] 标记）
// → 用真包在 9611 上走一遍 预检 → 应用 → 自动重启 → 断言新版本/新前端/新代码真的在跑 → 删掉演练目录。
// 演练目录放在仓库内是为了蹭仓库的 node_modules（Node 会往上找），跑完会删干净。
//
// ⚠️ 它会真的杀进程，但**只杀自己拉起来的那个 pid**（从日志里认出接替进程的 pid 再收掉）。
//    绝不 taskkill /IM node.exe —— 那会连用户其它的 node 一起带走。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEP = path.join(ROOT, '.upgrade-manual-test');
const PORT = Number(process.env.ALLEYU_VERIFY_PORT) || 9611;
const BASE = `http://127.0.0.1:${PORT}`;
const OLD_DIST = '202610150000';
const OLD_VERSION = '1.10.2';
const NEW_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PACK = path.join(ROOT, `游巷-${NEW_VERSION}-upgrade.zip`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
let pass = 0; let fail = 0;
const ok = (c, m, extra = '') => { console.log((c ? '  ✅ ' : '  ❌ ') + m + (c ? '' : ' — ' + extra)); c ? pass++ : fail++; };
const die = (m) => { console.error('\n❌ ' + m + '\n'); process.exit(1); };

// ---- 0) 前置检查 ----
if (!fs.existsSync(PACK)) die(`没有升级包 ${PACK}：先跑 node scripts/build-upgrade-pack.mjs`);
const portFree = await new Promise((resolve) => {
  const s = net.connect(PORT, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(true));
});
if (!portFree) die(`${PORT} 端口被占用：演练要独占它（先 netstat -ano | grep ':${PORT}' 找到 PID 再按 pid 收掉）`);
rmrf(DEP);

const distOnDisk = fs.readdirSync(path.join(ROOT, 'web', 'dist'))
  .filter((n) => /^\d{8,}$/.test(n)).sort().pop();
if (!distOnDisk) die('web/dist 下没有前端产物：先 cd web && npm run build');
if (distOnDisk <= OLD_DIST) die(`现役 dist ${distOnDisk} 不比演练用的 ${OLD_DIST} 新——把 OLD_DIST 改小一点再跑`);

// ---- 1) 造「旧版部署目录」 ----
console.log(`演练目录 ${DEP}\n  旧版：dist=${OLD_DIST}  version=${OLD_VERSION}  server/index.js 带 [OLD-CODE] 标记\n  升级包：${path.basename(PACK)} → v${NEW_VERSION}\n`);
fs.mkdirSync(DEP, { recursive: true });
fs.cpSync(path.join(ROOT, 'server'), path.join(DEP, 'server'), { recursive: true });
fs.mkdirSync(path.join(DEP, 'web', 'dist'), { recursive: true });
fs.cpSync(path.join(ROOT, 'web', 'dist', distOnDisk), path.join(DEP, 'web', 'dist', OLD_DIST), { recursive: true });
fs.writeFileSync(path.join(DEP, 'web', 'dist', '.latest'), OLD_DIST);
// 旧 dist 的 index.html 盖个标记：升级后「首页回的是新前端」就能逐字节证出来
const idxPath = path.join(DEP, 'web', 'dist', OLD_DIST, 'index.html');
fs.writeFileSync(idxPath, fs.readFileSync(idxPath, 'utf8').replace('</body>', '<!-- OLD-DIST --></body>'));
const oldPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
oldPkg.version = OLD_VERSION;
fs.writeFileSync(path.join(DEP, 'package.json'), JSON.stringify(oldPkg, null, 2));
// 旧 server 代码也盖个标记（改启动横幅）：升级后日志里还出现它就说明跑的还是老代码
const srvIdx = path.join(DEP, 'server', 'index.js');
const srvIdxOld = fs.readFileSync(srvIdx, 'utf8');
if (!srvIdxOld.includes('[游巷 Alleyu] http://localhost:')) die('指数 index.js 的启动横幅没找到，[OLD-CODE] 标记打不上（改过横幅就要同步改这里）');
fs.writeFileSync(srvIdx, srvIdxOld.replace('[游巷 Alleyu] http://localhost:', '[游巷 Alleyu][OLD-CODE] http://localhost:'));

// ---- 2) 起「旧版」服务（真进程，**不要** ALLEYU_NO_RESTART） ----
const out = [];
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: DEP,
  env: { ...process.env, PORT: String(PORT), ALLEYU_AI_STUB: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => { out.push('[old] ' + d); });
srv.stderr.on('data', (d) => { out.push('[old!] ' + d); });
let exited = null;
srv.on('exit', (code) => { exited = code; });
const up = async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch { return false; } };
for (let i = 0; i < 80 && !(await up()); i++) await sleep(250);
if (!(await up())) die('旧版服务没起来（看上面的 [old] 输出）');

const login = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'wpqadmin', password: 'admin123' }),
}).then((r) => r.json());
const ah = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
ok(await up(), `旧版服务起来了（${PORT}）`);
ok(!!login.token, '演练目录是空库 → 默认管理员 wpqadmin/admin123 能登录（不碰真实库）', JSON.stringify(login).slice(0, 120));

let st = await fetch(BASE + '/api/upgrade/status', { headers: ah }).then((r) => r.json());
const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
ok(norm(st.upgrade_root) === norm(DEP), `升级根 = 演练目录（${st.upgrade_root}）`);
ok(st.current_version === OLD_VERSION, `旧版进程报的版本是 v${OLD_VERSION}`, String(st.current_version));
const oldHtml = await fetch(BASE + '/').then((r) => r.text());
ok(oldHtml.includes('OLD-DIST'), '旧版前端在服务（首页 HTML 带演练标记）');

// ---- 3) 上传真包 → 预检 ----
const zip = fs.readFileSync(PACK);
let r = await fetch(BASE + '/api/upgrade/plan', { method: 'POST', headers: { ...ah, 'Content-Type': 'application/octet-stream' }, body: zip });
let j = await r.json();
ok(r.status === 200 && j.plan && j.plan.version.incoming === NEW_VERSION, '上传真包预检通过', (j.error || '') + JSON.stringify(j).slice(0, 160));
const planToken = j.token;
const planAdd = j.plan.summary.add;
const planOverwrite = j.plan.summary.overwrite;
const planSkip = j.plan.summary.skip;
ok(!!planToken && j.plan.restart_required === true, '预检说：这个包需要重启');
console.log(`     预检：新增 ${planAdd} / 覆盖 ${planOverwrite} / 跳过 ${planSkip}，dist=${j.plan.summary.dist_dir}`);

// ---- 4) 应用 → 自己重启 ----
const t0 = Date.now();
r = await fetch(BASE + '/api/upgrade/apply', { method: 'POST', headers: ah, body: JSON.stringify({ token: planToken }) });
j = await r.json();
ok(r.status === 200 && j.applied === true && j.restart === 'scheduled', '应用成功，回包说「已拉起接替进程」', JSON.stringify(j).slice(0, 240));
console.log(`     回包：${JSON.stringify({ backup_dir: j.backup_dir, dist_dir: j.dist_dir, restart: j.restart, wrote: j.files_written && j.files_written.total, skipped: (j.files_written && j.files_written.skipped || []).length })}`);
// 预检说「新增 X / 覆盖 Y / 跳过 Z」，应用就必须**照着做**——预检和应用不能是两套说法。
// 唯一的差 1 是 manifest.json：预检的文件表把它算作一条 action=skip（为的是让管理员看见「包里有什么」），
// 而应用永远不写它（只做校验）——所以跳过的条数正好比预检少一条。
ok(j.files_written.add.length === planAdd && j.files_written.overwrite.length === planOverwrite
  && (j.files_written.skipped || []).length === planSkip - 1,
  `应用实际写的条数与预检说的完全一致（${planAdd} 新增 / ${planOverwrite} 覆盖 / ${planSkip - 1} 跳过，另 1 条 manifest 只校验不落盘）`,
  JSON.stringify({ plan: [planAdd, planOverwrite, planSkip], apply: [j.files_written.add.length, j.files_written.overwrite.length, (j.files_written.skipped || []).length] }));

for (let i = 0; i < 40 && exited === null; i++) await sleep(250);
const oldOut = out.join('');
ok(exited !== null, `发起重启后老进程自己退出了（exit ${exited}，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
ok(/已拉起接替进程 pid \d+/.test(oldOut), '老进程日志里能看到「已拉起接替进程 pid N」');

// ---- 5) 服务重新上线，且版本号是新的 ----
let newSys = null;
for (let i = 0; i < 60; i++) {
  try {
    const s = await fetch(BASE + '/api/system-info', { cache: 'no-store' });
    if (s.ok) { const sj = await s.json(); if (sj.version === NEW_VERSION) { newSys = sj; break; } }
  } catch { /* 还没起来 */ }
  await sleep(500);
}
ok(!!newSys, `/api/system-info 回来时版本已变成 v${NEW_VERSION}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`, JSON.stringify(newSys));
ok(await up(), '服务重新在线（接替进程抢到了同一个端口）');
const newHtml = await fetch(BASE + '/').then((r) => r.text());
ok(!newHtml.includes('OLD-DIST'), '首页返回的 HTML 已经换成新 dist 的内容（旧标记不见了）');

// ---- 6) 落盘证据 ----
const depDists = fs.readdirSync(path.join(DEP, 'web', 'dist')).filter((n) => /^\d{8,}$/.test(n)).sort();
ok(depDists.includes(distOnDisk), `新前端目录落盘（现在有 ${depDists.join('、')}）`);
ok(fs.readFileSync(path.join(DEP, 'web', 'dist', '.latest'), 'utf8').trim() === distOnDisk, '.latest 指向新目录');
ok(JSON.parse(fs.readFileSync(path.join(DEP, 'package.json'), 'utf8')).version === NEW_VERSION, `package.json 已换成 v${NEW_VERSION}`);
const bkBase = path.join(DEP, 'data', 'upgrades');
const bkDir = fs.readdirSync(bkBase).filter((n) => n.startsWith('backup_')).sort().pop();
ok(!!bkDir && fs.readFileSync(path.join(bkBase, bkDir, 'server', 'index.js'), 'utf8').includes('[OLD-CODE]'),
  `被覆盖文件的原文备份在 ${bkDir}（带旧标记 → 真能回滚）`);

// ---- 7) 接班日志与状态 ----
const childLog = fs.readFileSync(path.join(DEP, 'Logs', 'restart-child.log'), 'utf8');
ok(new RegExp(`\\[游巷 Alleyu\\] http://localhost:${PORT}`).test(childLog), '接替进程日志里有启动横幅（新进程真的起来了）');
ok(!childLog.includes('[OLD-CODE]'), '接替进程跑的是**新代码**（横幅里没有演练用的 [OLD-CODE]）');
ok(!childLog.includes('没有完成交接'), '接班成功的进程不会误报「重启没有完成交接」（isChild() 判断生效）');
const state = JSON.parse(fs.readFileSync(path.join(DEP, 'data', 'upgrades', 'state.json'), 'utf8'));
ok(state.restart_pending === false && !!state.handoff_at, 'state.json：restart_pending 已由接替进程清掉，并记下交接时间');

// ---- 8) 升级日志落库 ----
r = await fetch(BASE + '/api/upgrade/logs?limit=3', { headers: ah });
j = await r.json();
ok(r.status === 200 && j.logs[0] && j.logs[0].to_version === NEW_VERSION && j.logs[0].ok === true && j.logs[0].restarted === true,
  'upgrade_logs 记下这次升级（to_version / ok / restarted 都对）', JSON.stringify(j.logs && j.logs[0]));

console.log(`\n演练结果：${pass} 通过，${fail} 失败`);

// ---- 9) 收尾：先收接替进程，再删演练目录 ----
try { srv.kill(); } catch { /* 老进程早退了 */ }
const childPid = (out.join('').match(/已拉起接替进程 pid (\d+)/) || [])[1];
if (childPid) {
  try { execFileSync('taskkill', ['/F', '/PID', childPid], { stdio: 'ignore' }); console.log('已按 pid 收掉接替进程 ' + childPid); }
  catch (e) { console.log(`收接替进程失败（手工 taskkill //F //PID ${childPid}）：` + e.message); }
} else {
  console.log(`⚠️ 没认出接替进程的 pid —— netstat -ano | grep ':${PORT}' 找到后按 pid 收，别用 taskkill /IM node.exe`);
}
for (let i = 0; i < 5; i++) {
  try { rmrf(DEP); break; } catch (e) { if (i === 4) console.log('删演练目录失败（手工删）：' + e.message); else sleepSync(400); }
}
console.log('演练目录已清理：' + !fs.existsSync(DEP));
process.exit(fail ? 1 : 0);
