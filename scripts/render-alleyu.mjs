// 渲染自检（Playwright，借用工作台的 node_modules）：
//   NODE_PATH=D:\cc\personal-workbench\node_modules node scripts/render-alleyu.mjs
// 默认自起确定性桩服务器（ALLEYU_AI_FORCE_STUB=1，共享 data/ 的城市库与高德 Key（v1.6.3 起
// Key 不内置，库里有才产地图，没有走无图降级断言），独占 9610 端口）——起因 v1.5.0：本机
// data/ 存着用户真 Key，过去 render 的「现场生成」一直在打真实 DeepSeek（首字 20s+、偶发空流），
// 直播流断言随机红。
// 设 ALLEYU_URL 可改打外部已运行的服务器（不自起、不强制桩）。
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const URL_BASE = process.env.ALLEYU_URL || 'http://localhost:9610';
// PDF 下载断言的前提：服务器端有中文字体可出 PDF（无字体时端点回 400，跳过下载事件断言）
let FONTS_OK = false;
try { FONTS_OK = !!require(path.join(ROOT, 'server', 'services', 'pdfService.js')).findFonts(); } catch { /* 依赖缺失当没字体 */ }

let server = null;
if (!process.env.ALLEYU_URL) {
  const portFree = await new Promise((resolve) => {
    const s = net.connect(9610, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(true));
  });
  if (!portFree) {
    console.error('❌ 9610 端口被占用：render 需独占端口自起确定性桩服务器。先停掉现有服务，或设 ALLEYU_URL 指向它。');
    process.exit(1);
  }
  server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, ALLEYU_AI_FORCE_STUB: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {}); // 必须消费，防管道写满阻塞子进程
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  process.on('exit', () => server.kill());
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(URL_BASE + '/api/health'); if (r.ok) { up = true; break; } } catch { /* 未就绪 */ }
    await new Promise((r2) => setTimeout(r2, 200));
  }
  if (!up) { console.error('❌ 自起服务器 10s 内未就绪'); process.exit(1); }
  console.log('已自起确定性桩服务器（FORCE_STUB，pid=' + server.pid + '）');
}
const IMG_DIR = path.join(ROOT, 'img');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// 登录页（先查占位提示已去掉，再走 SPA 登录——全程不整页刷新）
await page.goto(URL_BASE + '/#/login');
const noPlaceholder = await page.locator('input[placeholder="用户名"], input[placeholder="密码"]').count();
ok(noPlaceholder === 0, '登录框无用户名/密码占位提示');
await page.fill('input[aria-label="用户名"]', 'admin');
await page.fill('input[aria-label="密码"]', 'admin123');
await page.click('button.btn');
await page.waitForURL('**/#/', { timeout: 8000 });
ok(true, '登录成功跳首页');

// 首页场景
await page.waitForSelector('.scene-box svg #bikerRoot', { timeout: 8000 });
ok(true, '骑手场景渲染');
const svgCount = await page.locator('.scene-box svg #riderHeadGroup').count();
ok(svgCount === 1, '兔子+自行车 SVG 结构存在');
const earCount = await page.locator('.scene-box svg #rabbitFrontEar').count();
ok(earCount === 1, '兔耳朵存在');
// v1.6.2：两只眼睛（riderEyeOpen 组内 2 颗深色眼球 + 笑眼 path 两段弧）
const eyeBalls = await page.locator('.scene-box svg #riderEyeOpen circle[fill="#1e293b"]').count();
ok(eyeBalls === 2, '兔子两只眼睛（前眼+后眼）');
const happyArcs = (await page.locator('.scene-box svg #riderEyeHappy').getAttribute('d')) || '';
ok(happyArcs.split('M').length - 1 === 2, '笑眼弧线两段（两只眼都笑）');
const furGrad = await page.locator('.scene-box svg #furGrad').count();
ok(furGrad === 1 && (await page.locator('.scene-box svg #pigSkinGrad').count()) === 0, '乳白毛色渐变（旧猪皮渐变已除）');
const hasSky = await page.locator('.scene-box svg rect[fill="url(#skyGrad)"]').count();
ok(hasSky === 0, '天空已移除（透明融入页面）');
const btns = await page.locator('.scene-box button').count();
ok(btns === 0, '场景内无按钮');

// 打字触发兔跳：bikerRoot transform translate(0, 负数)
const jumpBefore = await page.locator('#bikerRoot').getAttribute('transform');
await page.fill('.searchbar input', '杭');
await page.waitForTimeout(120);
const jumpMid = await page.locator('#bikerRoot').getAttribute('transform');
await page.waitForTimeout(2000);
const jumpAfter = await page.locator('#bikerRoot').getAttribute('transform');
const negY = (t) => t && /translate\(0, -\d/.test(t);
ok(negY(jumpMid) || (jumpBefore !== jumpMid), '打一个字触发兔跳（transform 变化/出现负 y）', JSON.stringify({ jumpBefore, jumpMid }));
ok(jumpAfter === 'translate(0, 0)', '跳跃落地回原位');

// 搜索建议 + 跳转攻略页
await page.fill('.searchbar input', '杭州');
await page.waitForTimeout(600);
const sugCount = await page.locator('.sug .s').count();
ok(sugCount >= 1, '边查边搜城市建议');
await page.screenshot({ path: path.join(IMG_DIR, '首页.png'), fullPage: false });
await page.click('.searchbar .go');
await page.waitForURL('**/#/plan**', { timeout: 8000 });
ok(true, '回车/做攻略 → 计划表单');
// 关键回归：SPA 登录后不经整页刷新直达功能页，侧栏菜单必须非空（v1.1.0 修的空菜单 bug）。
// me 是路由 watcher 异步拉的——必须等菜单出现再数，立刻数是竞态（首跑曾假失败）
let navOk = true;
try { await page.waitForSelector('.side .nav-item', { timeout: 8000 }); } catch { navOk = false; }
const navCount = navOk ? await page.locator('.side .nav-item').count() : 0;
ok(navCount >= 5, 'SPA 登录后侧栏菜单非空（修复空菜单）');
// v1.1.1：favicon 与侧栏图标去猪化/单色化
const fav = await page.getAttribute('link[rel="icon"]', 'href');
ok(fav && fav.includes('🐰') && !fav.includes('🐷'), 'favicon=兔子（猪头已换）');
const svgNav = await page.locator('.side .nav-item svg').count();
ok(svgNav === navCount, '侧栏图标=单色 SVG（每项一枚）');
const icTexts = await page.locator('.side .nav-item .ic').allInnerTexts();
ok(icTexts.every((t) => !t.trim()), '侧栏图标槽无残留 emoji 文本');

// 计划表单元素
await page.waitForSelector('input[placeholder="例如：杭州"]', { timeout: 8000 });
await page.screenshot({ path: path.join(IMG_DIR, '生成攻略.png') });
ok(true, '表单渲染');

// v1.2.0：现场生成一篇（桩 AI + 真高德配图）——验证单色封面地图 + 总览连线 + 生成来源页脚
const tk = await page.evaluate(() => localStorage.getItem('alleyu_token') || '');
const genRes = await fetch(URL_BASE + '/api/guides', {
  method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
  body: JSON.stringify({ destination: '杭州', days: 2, mustVisits: ['西湖', '灵隐寺'] }),
}).then((r) => r.json()).catch(() => null);
let done = null;
let genbarOk = false, stageTextOk = false, peekOk = false;
if (genRes && genRes.id) {
  // v1.4.0：趁生成未完先进详情页——进度条 + 阶段说明词必须可见（桩+真高德 enrich 要半分钟，赶得上）
  await page.goto(URL_BASE + '/#/guide/' + genRes.id);
  try {
    await page.waitForSelector('.genbar .fill', { timeout: 8000 });
    genbarOk = true;
    const label = await page.locator('.status-card b').innerText();
    // 「模型已响应，等待首段内容…」也是真阶段说明词（write 已开始、首段还没落库的窗口）
    stageTextOk = /排队|正在|重试|增强|模型已响应/.test(label);
    await page.screenshot({ path: path.join(IMG_DIR, '生成中.png'), fullPage: false });
    // v1.5.0：3 行实时内容小窗——模型开始返回后里面有真文字
    try {
      await page.waitForFunction(() => { const el = document.querySelector('.peek'); return el && el.textContent.trim().length > 20; }, null, { timeout: 20000 });
      peekOk = true;
    } catch { /* 没赶上流式窗口 */ }
  } catch { /* 没赶上生成窗口 */ }
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(1000);
    const g = await fetch(URL_BASE + '/api/guides/' + genRes.id, { headers: { Authorization: 'Bearer ' + tk } }).then((r) => r.json()).catch(() => null);
    if (g && g.guide && (g.guide.status === 'done' || g.guide.status === 'error')) { done = g.guide; break; }
  }
}
ok(genbarOk, '生成中：进度条可见（.genbar）');
ok(stageTextOk, '生成中：阶段说明词显示（排队/正在/重试/增强）');
ok(peekOk, '生成中：3 行实时内容小窗有模型返回的真文字');
ok(done && done.status === 'done', '桩模式现场生成新攻略（≤240s，高德配图限速串行波动大）');
let detailShotDone = false;
if (done && done.status === 'done') {
  // v1.6.3 起高德 Key 不内置：库里有 Key=完整地图断言；没有=降级断言（无图但不伪造，页脚照常）
  const hasCoverMap = (done.images || []).some((x) => x.type === 'cover');
  if (hasCoverMap) {
    ok(done.content.includes('![封面地图](') && done.content.includes('## 生成来源'), '服务端：封面地图在顶部 + 生成来源页脚');
    await page.goto(URL_BASE + '/#/guide/' + genRes.id);
    await page.waitForSelector('.md img', { timeout: 20000 });
    await page.waitForTimeout(600);
    const firstAlt = await page.locator('.md img').first().getAttribute('alt');
    ok(firstAlt === '封面地图', '详情页第一张图=封面地图（不再用随机照片）');
    const filt = await page.evaluate(() => { const el = document.querySelector('.md img[alt="封面地图"]'); return el ? getComputedStyle(el).filter : ''; });
    ok(/sepia/.test(filt) && /hue-rotate/.test(filt), '封面地图偏蓝单色（sepia+hue-rotate 滤镜，非黑白）');
  } else {
    ok(!done.content.includes('![封面地图](') && done.content.includes('## 生成来源'), '无 Key：正文无封面地图、生成来源页脚仍在');
    await page.goto(URL_BASE + '/#/guide/' + genRes.id);
    await page.waitForSelector('.md', { timeout: 20000 });
    await page.waitForTimeout(600);
    const noCover = await page.locator('.md img[alt="封面地图"]').count();
    ok(noCover === 0, '无 Key：详情页不显示封面地图（不伪造）');
    ok(!(done.images || []).length, '无 Key：images 数组不产任何图（地图/照片全跳过）');
  }
  const mdText2 = await page.locator('.md').innerText();
  ok(/生成来源/.test(mdText2) && /高德开放平台/.test(mdText2) && /Open-Meteo/.test(mdText2), '生成来源+链接渲染在攻略底部');
  // v1.5.0：完整提示词折叠框（生成来源之下的最后一块）
  const pbCount = await page.locator('.promptbox').count();
  ok(pbCount === 1, '提示词折叠框存在（生成来源下方）');
  if (pbCount === 1) {
    const isOpen = await page.locator('.promptbox').evaluate((el) => el.open);
    ok(isOpen === false, '提示词框默认折叠');
    await page.locator('.promptbox summary').click();
    await page.waitForTimeout(200);
    const preLen = await page.locator('.promptbox pre').evaluate((el) => el.textContent.length);
    ok(preLen > 500, '展开显示完整提示词（>500 字符）');
    const cpBtn = await page.locator('.promptbox .pb-bar button').count();
    ok(cpBtn === 1, '提示词框内复制按钮');
    const regenBtn = await page.locator('.gv-head button').filter({ hasText: '重新生成' }).count();
    ok(regenBtn === 1, '「重新生成」按钮在复制全文旁（失败/完成都可见）');
  }
  await page.screenshot({ path: path.join(IMG_DIR, '攻略详情.png'), fullPage: false });
  detailShotDone = true;

  // ---- v1.6.0：分享对话框 + 编辑 Markdown + 匿名分享页 ----
  await page.goto(URL_BASE + '/#/guide/' + genRes.id);
  await page.waitForSelector('.gv-head button', { timeout: 8000 });
  await page.locator('.gv-head button').filter({ hasText: '分享' }).click();
  await page.waitForSelector('.dlg', { timeout: 4000 });
  const optTexts = await page.locator('.dlg .seg .opt').allInnerTexts();
  ok(optTexts.length === 2 && optTexts.some((t) => t.includes('动态')) && optTexts.some((t) => t.includes('静态')), '分享对话框：动态更新/静态链接两种模式');
  await page.locator('.dlg button').filter({ hasText: '生成分享链接' }).click();
  await page.waitForSelector('.share-row', { timeout: 4000 });
  const shareUrlText = (await page.locator('.share-row .share-url').first().innerText()).trim();
  ok(/\/#\/s\/[0-9a-f]{32}/.test(shareUrlText), '生成 32hex 分享链接（行内可见完整 URL）');
  await page.screenshot({ path: path.join(IMG_DIR, '分享.png'), fullPage: false });
  await page.locator('.dlg button').filter({ hasText: '关闭' }).click();

  // 编辑模式：改 Markdown 原文并保存
  await page.locator('.gv-head button').filter({ hasText: '编辑' }).click();
  await page.waitForSelector('.editarea', { timeout: 4000 });
  const areaLen = await page.locator('.editarea').evaluate((el) => el.value.length);
  ok(areaLen > 500, '编辑框载入当前 Markdown 原文');
  const marker = '编辑标记段RenderE2E';
  await page.locator('.editarea').evaluate((el, m) => { el.value += '\n\n## ' + m + '\n'; el.dispatchEvent(new Event('input', { bubbles: true })); }, marker);
  await page.locator('.editwrap button').filter({ hasText: '保存修改' }).click();
  await page.waitForTimeout(800);
  const mdAfter = await page.locator('.md').innerText();
  ok(mdAfter.includes(marker), '保存编辑后正文即时更新（含追加段）');

  // v1.6.1：攻略页导出 PDF = 直接下载文件（不再弹打印对话框）
  if (FONTS_OK) {
    const dlP = page.waitForEvent('download', { timeout: 25000 });
    await page.locator('.gv-head button').filter({ hasText: '导出PDF' }).click();
    const dl = await dlP;
    ok((await dl.path()) !== null, '点「导出PDF」直接下载文件（浏览器下载事件）');
    ok(dl.suggestedFilename().endsWith('.pdf'), '下载文件名以 .pdf 结尾（' + dl.suggestedFilename() + '）');
  } else {
    console.log('  ⚠️ 无中文字体，下载事件断言跳过');
  }

  // 匿名新 context（无任何登录态）打开分享链接
  const anon = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const apage = await anon.newPage();
  await apage.goto(shareUrlText);
  await apage.waitForSelector('.share-titlebox h1', { timeout: 8000 });
  ok(apage.url().includes('/#/s/'), '免登录：未被路由守卫弹回登录页');
  const badgeText = await apage.locator('.share-top .badge').innerText();
  ok(badgeText.includes('动态更新'), '分享页模式徽标=动态更新');
  const anonText = await apage.locator('.md').innerText();
  ok(anonText.includes(marker), '动态分享页跟随编辑（匿名读到追加段）');
  ok((await apage.locator('.share-top button').filter({ hasText: '导出 PDF' }).count()) === 1, '分享页有「导出 PDF」按钮');
  ok((await apage.locator('.side').count()) === 0, '分享页无侧栏（整页排版）');
  if (FONTS_OK) {
    const adlP = apage.waitForEvent('download', { timeout: 25000 });
    await apage.locator('.share-top button').filter({ hasText: '导出 PDF' }).click();
    const adl = await adlP;
    ok((await adl.path()) !== null && adl.suggestedFilename().endsWith('.pdf'), '分享页匿名导出 PDF=直接下载文件');
  }
  await apage.screenshot({ path: path.join(IMG_DIR, '分享页.png'), fullPage: false });
  await anon.close();
}

// 其余页面截图（不深度断言，保底可见性）
for (const [hash, sel, name] of [
  ['#/library', '.tabs', '城市景点库'],
  ['#/weather', 'input[placeholder="城市名，回车查询"]', '天气'],
  ['#/settings', '.tabs', '设置'],
  ['#/users', 'table.tb', '用户管理'],
]) {
  await page.goto(URL_BASE + '/' + hash);
  try {
    await page.waitForSelector(sel, { timeout: 6000 });
    await page.screenshot({ path: path.join(IMG_DIR, name + '.png') });
    ok(true, name + ' 页渲染');
  } catch {
    ok(false, name + ' 页渲染（选择器超时）');
  }
}

// v1.6.0：设置页只有三页签（个人 AI 配置已下线，全站唯一全局 Key）
await page.goto(URL_BASE + '/#/settings');
await page.waitForSelector('.tabs .t', { timeout: 6000 });
const setTabs = await page.locator('.tabs .t').allInnerTexts();
ok(setTabs.length === 3 && !setTabs.some((t) => t.includes('我的 AI')), '设置页三页签（AI 全局/密码/系统，个人配置已下线）');

// v1.3.0：国际线路筛选 pill（库页）
await page.goto(URL_BASE + '/#/library');
await page.waitForSelector('.liblines .opt', { timeout: 8000 });
const pillCount = await page.locator('.liblines .opt').count();
ok(pillCount === 6, '库页线路筛选 pill=6（国内+五国际线）');
await page.locator('.liblines .opt').filter({ hasText: '欧洲线' }).click();
await page.waitForTimeout(900);
const parisCell = await page.locator('.tb td').filter({ hasText: '巴黎' }).count();
ok(parisCell >= 1, '欧洲线筛选出巴黎');
await page.screenshot({ path: path.join(IMG_DIR, '城市景点库.png'), fullPage: false });

// v1.7.0：景点页签=先线路后城市 + 分页浏览 + 介绍列
await page.locator('.tabs .t').filter({ hasText: '景点' }).click();
await page.waitForSelector('.liblines .opt', { timeout: 8000 });
const attrPills = await page.locator('.liblines .opt').allInnerTexts();
ok(attrPills[0].includes('全部线路') && attrPills.some((t) => t.includes('国内')) && attrPills.some((t) => t.includes('欧洲线')), '景点页签线路 pill：全部线路+种子线路');
await page.waitForSelector('.tb tbody tr', { timeout: 8000 });
await page.waitForTimeout(600);
const rows1 = await page.locator('.tb tbody tr').count();
ok(rows1 === 10, `未选城市默认每页 10 条（实际 ${rows1}）`);
const pagerText = await page.locator('.pager-row .hint').innerText();
ok(/第 1 \/ \d+ 页 · 共 \d+ 条/.test(pagerText), `分页条自洽（${pagerText.trim()}）`);
const firstPage1 = await page.locator('.tb tbody tr td b').first().innerText();
await page.locator('.pager-row button', { hasText: '下一页' }).click();
await page.waitForTimeout(700);
const firstPage2 = await page.locator('.tb tbody tr td b').first().innerText();
ok(firstPage1 !== firstPage2, '下一页翻页生效（首页行变化）');
await page.locator('select.input').filter({ hasText: '每页' }).first().selectOption('50');
await page.waitForTimeout(700);
const rows50 = await page.locator('.tb tbody tr').count();
ok(rows50 === 50, `每页 50 切换生效（实际 ${rows50}）`);
const introHeads = await page.locator('.tb thead th').allInnerTexts();
ok(introHeads.some((h) => h.includes('介绍')) && introHeads.some((h) => h.includes('城市')), '表格带介绍列与城市列');
await page.screenshot({ path: path.join(IMG_DIR, '城市景点库-景点.png'), fullPage: false });

// 攻略页（桩数据若在）
await page.goto(URL_BASE + '/#/history');
await page.waitForTimeout(800);
const cards = await page.locator('.gcard').count();
if (cards > 0) {
  await page.locator('.gcard').first().click();
  await page.waitForSelector('.md', { timeout: 20000 });
  await page.waitForTimeout(500);
  // 详情截图只认「现场新生成」那篇（旧攻略是照片封面）；生成失败才用历史第一条兜底
  if (!detailShotDone) await page.screenshot({ path: path.join(IMG_DIR, '攻略详情.png'), fullPage: false });
  ok(true, '攻略详情渲染（markdown）');
  const mdText = await page.locator('.md').innerText();
  // 桩模式下「生成来源」页脚如实标注「本地桩输出」是应该的；这里防的是正文顶部的桩横幅
  const mdHtml = await page.locator('.md').innerHTML();
  ok(!mdHtml.includes('alleyu:stub') && !/这是\s*ALLEYU_AI_STUB/.test(mdText), '攻略正文无桩提示横幅（来源页脚的如实标注除外）');
  // 生成中转圈图标：从已加载的 GuideView chunk 里验证是兔不是猪
  const gvUrl = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).find((u) => /GuideView-[\w-]+\.js$/.test(u)));
  if (gvUrl) {
    const txt = await (await page.evaluate((u) => fetch(u).then((r) => r.text()), gvUrl));
    ok(txt.includes('🐰') && !txt.includes('🐷'), '生成中转圈图标=兔子（非猪）');
  }
} else {
  console.log('  ⚠️ 无历史攻略，跳过详情截图');
}

// ---- v1.8.0 游记整理：侧栏入口 + 向导 UI 全流程 + 详情（封面/配色/编辑/导出） ----
console.log('== v1.8.0 游记整理 ==');
// 侧栏入口在「我的攻略」下方
const jNav = page.locator('.side .nav-item').filter({ hasText: '游记整理' });
ok((await jNav.count()) === 1, '侧栏「游记整理」入口存在');
await jNav.click();
await page.waitForURL('**/#/journals', { timeout: 8000 });
await page.waitForSelector('.tb', { timeout: 6000 });
ok(true, '游记列表页渲染');
const newBtn = page.locator('button').filter({ hasText: '写游记（引导式）' });
ok((await newBtn.count()) === 1, '列表页「＋写游记」按钮');

// 向导：目的地联想 → 选杭州 → 跳到照片步
await newBtn.click();
await page.waitForURL('**/#/journals/new', { timeout: 8000 });
await page.waitForSelector('.wiz', { timeout: 6000 });
ok((await page.locator('.steps-bar .st').count()) === 14, '向导 14 步步骤条');
await page.fill('.q-area input.input', '杭');
await page.waitForSelector('.dest-hits .chip', { timeout: 6000 });
await page.locator('.dest-hits .chip').first().click();
await page.locator('.nav-row button').filter({ hasText: '下一问' }).click(); // 步1存草稿（POST 建）
await page.waitForTimeout(400);
// 逐问「跳过」直奔景点步（步 2~10 都可跳）
for (let i = 0; i < 9; i++) {
  await page.locator('.nav-row button').filter({ hasText: '跳过' }).click();
}
await page.waitForSelector('.q-area .chip-row .chip', { timeout: 6000 });
const spotChipTxt = await page.locator('.q-area .chip-row .chip').first().innerText();
ok(spotChipTxt.trim().length > 0, `景点步：城市库备选可见（首选 ${spotChipTxt.trim().slice(0, 10)}）`);
await page.locator('.q-area .chip-row .chip').first().click();
ok((await page.locator('.q-area .chip.on').count()) >= 1, '勾选景点高亮');
await page.locator('.nav-row button').filter({ hasText: '下一问' }).click();
// 照片步：真上传一张 1x1 PNG + AI 配文（桩）
await page.waitForSelector('.padd', { timeout: 6000 });
const tmpPng = path.join(require('node:os').tmpdir(), 'alleyu-render-1x1.png');
fs.writeFileSync(tmpPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
await page.locator('.q-area input[type=file]').first().setInputFiles(tmpPng);
await page.waitForSelector('.pbox img', { timeout: 8000 });
ok(true, '照片上传成功渲染');
await page.screenshot({ path: path.join(IMG_DIR, '游记-向导.png'), fullPage: false });
await page.locator('.pbtns button').filter({ hasText: 'AI 写' }).click();
await page.waitForFunction(() => {
  const ta = document.querySelector('.pcap textarea');
  return ta && ta.value.trim().length > 0;
}, null, { timeout: 8000 });
ok(true, 'AI 配文（桩）填入体验说明');
await page.locator('.nav-row button').filter({ hasText: '下一问' }).click();
// 合并步：默认纯旅行记录
await page.waitForSelector('.radio-row input[type=radio]', { timeout: 6000 });
const radioCount = await page.locator('.radio-row input[type=radio]').count();
ok(radioCount >= 1, `合并步：攻略选项渲染（${radioCount} 个）`);
await page.locator('.nav-row button').filter({ hasText: '下一问' }).click();
// 生成 → 详情页 SSE 到 done
await page.locator('.nav-row button').filter({ hasText: '生成游记' }).click();
await page.waitForURL(/#\/journal\/\d+/, { timeout: 8000 });
await page.waitForFunction(() => {
  const t = document.querySelector('.cvr-title');
  return t && t.textContent.trim().length > 0;
}, null, { timeout: 20000 });
ok(true, '生成完成进详情页（封面标题就位）');
const jTitle = (await page.locator('.cvr-title').innerText()).trim();
ok(jTitle.length > 0 && jTitle.length <= 20, `AI 标题 ≤20 字（「${jTitle}」）`);
const jSub = await page.locator('.cvr-sub').innerText();
ok(jSub.includes('杭州'), '封面副标题含目的地');
ok((await page.locator('.pal').count()) === 5, '莫兰迪配色 5 套可选');
await page.locator('.pal').nth(1).click();
await page.waitForTimeout(400);
ok((await page.locator('.pal.on').innerText()).includes('豆沙粉'), '切换配色=豆沙粉');
ok((await page.locator('.thumb.on .cov-badge').count()) === 1, '照片条当前封面有徽标');
await page.waitForSelector('.jr-md img', { timeout: 8000 });
ok(true, '正文 photo:N 占位换成真图');
// 二次编辑
await page.locator('.jd-head button').filter({ hasText: '编辑' }).click();
await page.waitForSelector('.editarea', { timeout: 6000 });
const jMarker = '游记编辑标记RenderE2E';
await page.locator('.editarea').evaluate((el, m) => { el.value += '\n\n## ' + m + '\n'; el.dispatchEvent(new Event('input', { bubbles: true })); }, jMarker);
await page.locator('.pb-bar button').filter({ hasText: '保存修改' }).click();
await page.waitForTimeout(800);
ok((await page.locator('.jr-md').innerText()).includes(jMarker), '二次编辑保存后正文即时更新');
await page.screenshot({ path: path.join(IMG_DIR, '游记-详情.png'), fullPage: false });
// 导出三件：PNG（canvas）+ PDF A4 + PDF 长图
const pngDlP = page.waitForEvent('download', { timeout: 20000 });
await page.locator('.jd-head button').filter({ hasText: '导出PNG' }).click();
const pngDl = await pngDlP;
ok(pngDl.suggestedFilename().endsWith('.png'), '导出 PNG 长图直接下载（' + pngDl.suggestedFilename() + '）');
if (FONTS_OK) {
  const a4DlP = page.waitForEvent('download', { timeout: 25000 });
  await page.locator('.jd-head button').filter({ hasText: 'PDF·A4打印' }).click();
  const a4Dl = await a4DlP;
  ok(a4Dl.suggestedFilename().endsWith('.pdf') && /A4/.test(a4Dl.suggestedFilename()), '导出 PDF·A4（文件名含 A4）');
  const longDlP = page.waitForEvent('download', { timeout: 25000 });
  await page.locator('.jd-head button').filter({ hasText: 'PDF·长图分享' }).click();
  const longDl = await longDlP;
  ok(longDl.suggestedFilename().endsWith('.pdf') && /长图/.test(longDl.suggestedFilename()), '导出 PDF·长图（文件名含 长图）');
}
// 列表回看 + 清理（render 桩服务器共用真实 data/，测完删掉这篇）
await page.goto(URL_BASE + '/#/journals');
await page.waitForTimeout(800);
const jRow = page.locator('.tb td').filter({ hasText: jTitle });
ok((await jRow.count()) >= 1, '游记列表出现刚生成的一篇');
await page.screenshot({ path: path.join(IMG_DIR, '游记-列表.png'), fullPage: false });
const jidM = ((await page.locator('.tb a').first().getAttribute('href')) || '').match(/journal\/(\d+)/);
if (jidM) {
  await fetch(URL_BASE + '/api/journals/' + jidM[1], { method: 'DELETE', headers: { Authorization: 'Bearer ' + tk } });
  console.log('  （已清理 render 生成的游记 #' + jidM[1] + '）');
}

// ---- v1.8.0 游客模式 + 登录页分栏（匿名 context） ----
console.log('== v1.8.0 游客模式与登录页 ==');
const guest = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const gpage = await guest.newPage();
await gpage.goto(URL_BASE + '/#/');
await gpage.waitForSelector('.corner', { timeout: 8000 });
ok(gpage.url().includes('#/'), '游客进首页不被弹回登录页');
const cornerTxt = await gpage.locator('.corner').innerText();
ok(cornerTxt.includes('游客模式'), '右上角游客标识（' + cornerTxt.replace(/\s+/g, ' ').trim() + '）');
ok((await gpage.locator('.corner button').filter({ hasText: '登录' }).count()) === 1, '右上角登录按钮');
ok((await gpage.locator('.quick-links').count()) === 0, '游客不见快捷入口（登录后才有）');
await gpage.locator('.searchbar .journal-go').click();
await gpage.waitForURL('**/#/login', { timeout: 6000 });
ok(true, '游客点「写游记」→ 引导登录');
await gpage.waitForSelector('.split', { timeout: 6000 });
ok((await gpage.locator('.split .left svg').count()) >= 1, '登录页左 2/3 骑车动画');
ok((await gpage.locator('.split .left .brand h1').innerText()).includes('游巷'), '登录页左下品牌字');
ok((await gpage.locator('.split .right .dlg-card').count()) === 1, '登录页右 1/3 登录框');
await gpage.screenshot({ path: path.join(IMG_DIR, '登录页.png'), fullPage: false });
await guest.close();

await browser.close();
if (server) server.kill();
console.log(`\n渲染自检：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
