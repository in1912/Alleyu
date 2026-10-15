// build-dist-packages.mjs —— 生成三端分发压缩包（Windows / macOS / Docker），全部不含个人数据。
// 产物落在仓库根目录：游巷-<版本>-windows.zip / -macos.zip / -docker.zip（*.zip 已在 .gitignore 里，不入库）
// 原则：只带「能跑起来的最小运行集」——data/ 一律空壳（里面有 alleyu.sqlite/.secret/AI Key/高德 Key）、
//       Logs/ 与 img/ 不带、scripts/ 不带（check/render 是开发自检，要 playwright）、web/dist 只带最新一份。
// 用法：node scripts/build-dist-packages.mjs [--out <目录>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : ROOT;
const STAGE_ROOT = process.env.DIST_STAGE || path.join(os.tmpdir(), 'alleyu-dist');

const A = (...p) => path.join(...p);

// 最新前端构建产物（web/dist 下按时间戳累积，只带最新的那份）
const distParent = A(ROOT, 'web', 'dist');
const latestDist = fs.readdirSync(distParent).filter((d) => /^\d{8,}$/.test(d) && fs.statSync(A(distParent, d)).isDirectory()).sort().pop();
if (!latestDist) throw new Error('web/dist 下没有版本目录，请先 npm run build:web');

function copy(relSrc, dst, filter) {
  const src = A(ROOT, relSrc);
  if (!fs.existsSync(src)) { console.log(`   · 跳过（不存在）${relSrc}`); return; }
  const dest = A(dst, relSrc);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter });
}
function cpFile(relSrc, dst) { copy(relSrc, dst); }
const noJunk = (s) => !/(\.DS_Store|Thumbs\.db|desktop\.ini)$/.test(s);

// ---------- 生产依赖（node_modules 只装 dependencies，不带 playwright 这些 devDependencies） ----------
function buildProdModules() {
  const dir = A(STAGE_ROOT, '_prod_modules');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(A(ROOT, 'package.json'), A(dir, 'package.json'));
  fs.copyFileSync(A(ROOT, 'package-lock.json'), A(dir, 'package-lock.json'));
  console.log('── 安装生产依赖（npm ci --omit=dev）');
  for (const extra of [['--prefer-offline'], []]) {
    const r = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', ...extra], { cwd: dir, stdio: 'inherit', shell: true });
    if (r.status === 0) { console.log(`   ✅ 依赖就绪 ${A(dir, 'node_modules')}\n`); return A(dir, 'node_modules'); }
    console.log(`   · 重试（去掉 ${extra.join(' ') || '无附加参数'}）`);
  }
  throw new Error('npm ci --omit=dev 失败——分发包需要能跑起来的 node_modules，先修网络后重跑');
}

// 分发包里的 README：摘掉所有配图行（img/ 不进包，留着就是一堆裂图）。只改暂存副本，仓库里的 README.md 一字不动。
function stripReadmeImages(STAGE) {
  const p = A(STAGE, 'README.md');
  if (!fs.existsSync(p)) return;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*!\[[^\]]*\]\(img\//.test(lines[i])) { kept.push(lines[i]); continue; }
    // 跳过图片行；若其后（允许隔着空行）紧跟一行「*…*」整行斜体说明，一并摘掉
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && /^\s*\*[^*\n]+\*\s*$/.test(lines[j])) i = j;
  }
  const note = [
    '> **本分发包不含界面截图**——README 里的配图行已摘掉（截图在项目主页看）。',
    '',
  ].join('\n');
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(p, out.replace(/^(#\s[^\n]*\n)/, `$1\n${note}`), 'utf8');
}

function deployNote(variant) {
  const common = [
    `游巷 v${VERSION}（${variant} 版）`,
    '',
    '本包不含任何历史个人数据：data/ 是空目录，首次启动自动建库。',
    '首次登录：admin / admin123 —— 登录后请立刻在「设置 → 用户管理」里改掉。',
    '',
    '原图照片、地图缓存、AI Key 与高德 Key 都在 data/ 里，换机器整个 data/ 拷过去即可。',
    '',
  ];
  const byVariant = {
    windows: [
      '【Windows 部署】',
      '1. 解压到任意目录（路径别太长、别含特殊符号）。',
      '2. 需要 Node.js 22.5 或更高版本（https://nodejs.org 下载 LTS）。',
      '   本应用用 Node 内置的 node:sqlite，22.4 及以下没有这个模块，起不来。',
      '3. 双击 start.bat，浏览器打开 http://localhost:9610 。',
      '4. 依赖（node_modules）已随包附带，无需联网安装。',
    ],
    macos: [
      '【macOS 部署】',
      '1. 解压到任意目录。',
      '2. 需要 Node.js 22.5 或更高版本（https://nodejs.org 或 brew install node）。',
      '3. 首次运行前给启动器加执行权限：',
      '       cd 解压出来的目录 && chmod +x start.command',
      '   然后双击 start.command（或 ./start.command）。首次双击若被拦，右键 →「打开」。',
      '4. 浏览器打开 http://localhost:9610 。',
      '5. 依赖（node_modules）已随包附带，正常无需联网安装；若提示缺依赖，在该目录执行 npm install --omit=dev。',
    ],
    docker: [
      '【Docker 部署】',
      '1. 把整个目录上传到服务器（或群晖 / 飞牛 NAS）。',
      '2. 按需改 docker-compose.yml 里的挂载路径。',
      '3. 在目录里执行：',
      '       docker compose up -d --build',
      '4. 容器 restart: unless-stopped，开机自动启动。',
      '5. 浏览器打开 http://<服务器IP>:9610 。',
      '',
      '【说明】',
      '· 本包不含 node_modules，依赖在 docker build 时安装（要联网）。',
      '· DATA_DIR=/data，数据落在宿主机 ./data 目录（compose 已挂载）。',
      '· .dockerignore 已排除 data/，你的数据库与密钥不会进镜像。',
      '· 高德 Key 可用环境变量 AMAP_KEY 注入（只在首次空库种子生效，之后在设置页维护）。',
    ],
  };
  return [...common, ...byVariant[variant], '', '完整功能说明见 README.md（界面截图见项目主页，本包不含）。', '开发自检脚本（scripts/check-alleyu.mjs、render-alleyu.mjs）与配套的 img/ 截图不随包分发。'].join('\n');
}

const VARIANTS = [
  {
    key: 'windows', label: 'Windows',
    dirs: [['server'], [A('web', 'dist', latestDist)]],
    files: ['package.json', 'package-lock.json', 'README.md', 'start.bat', '.gitignore'],
    withModules: true,
  },
  {
    key: 'macos', label: 'macOS',
    dirs: [['server'], [A('web', 'dist', latestDist)]],
    files: ['package.json', 'package-lock.json', 'README.md', 'start.command', '.gitignore'],
    withModules: true,
  },
  {
    key: 'docker', label: 'Docker',
    dirs: [['server'], [A('web', 'dist', latestDist)]],
    files: ['package.json', 'package-lock.json', 'README.md', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.gitignore'],
    withModules: false,
  },
];

fs.mkdirSync(STAGE_ROOT, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
console.log(`游巷 v${VERSION}｜前端构建产物只带 ${latestDist}\n`);

const prodModules = VARIANTS.some((v) => v.withModules) ? buildProdModules() : null;

const result = [];
for (const v of VARIANTS) {
  const dirName = `游巷-${VERSION}-${v.key}`;
  const STAGE = A(STAGE_ROOT, dirName);
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  console.log(`── ${v.label} → ${dirName}`);

  for (const seg of v.dirs) copy(A(...seg), STAGE, noJunk);
  for (const f of v.files) cpFile(f, STAGE);
  if (v.withModules) fs.cpSync(prodModules, A(STAGE, 'node_modules'), { recursive: true, filter: noJunk }); // 生产依赖随包附带，开箱即跑
  stripReadmeImages(STAGE);

  // 空 data/（让「数据在 data/」一目了然；首启自动建库）
  fs.mkdirSync(A(STAGE, 'data'), { recursive: true });
  fs.writeFileSync(A(STAGE, '部署说明.txt'), deployNote(v.key), 'utf8');

  const zip = A(OUT, `${dirName}.zip`);
  fs.rmSync(zip, { force: true });
  // 必须用 scripts/zip-utf8.py：bsdtar/tar 写 zip 不给中文名打 UTF-8 标志，Windows 解压会乱码
  const z = spawnSync('python', [A(ROOT, 'scripts', 'zip-utf8.py'), STAGE, zip], { stdio: 'inherit', shell: true });
  if (z.status !== 0) throw new Error(`压缩失败 code=${z.status}（${zip}）`);
  const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
  console.log(`   ✅ ${path.basename(zip)}  ${mb} MB\n`);
  result.push({ variant: v.key, zip, mb });
}

console.log('════════ 结果 ════════');
for (const r of result) console.log(`  ${r.variant.padEnd(8)} ${r.mb.padStart(6)} MB  ${r.zip}`);
