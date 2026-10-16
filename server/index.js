// 入口：Express + 静态前端 + API。架构仿工作台 index.js：
//  - EXEMPT 免登录前缀（login/health/系统信息/图片直链）
//  - 其余走 resolveUser → 页/tab 三层权限（401 未登录 / 403 无权限，均为 JSON）
//  - 前端走 web/dist 最新时间戳目录 + SPA 兜底
const express = require('express');
const path = require('path');
const fs = require('fs');
const { resolveUser, pageForPath, tabForPath, canAccess, initAdmin } = require('./auth');

const app = express();
app.disable('x-powered-by');
// 上限 12mb：游记照片走 base64 JSON 上传（8MB 照片 base64 后 ~10.7mb，route 级再按真实字节数卡 8MB/张；
// 全局 parser 先跑，限太低会在到达 route 校验前就 413——journalRoutes 里的 40mb 解析器实际是兜底）
app.use(express.json({ limit: '12mb' }));

// 免登录通道（前缀匹配，相对 /api 挂载点的路径）：登录、注册、健康检查、系统信息、图片直链（<img>/EventSource 带不了头）、分享公开读
// 注意 'auth/register' 必须写全：写成 'auth' 会把 logout/me/password 一起放行，
// 那些 handler 直接用 req.user（EXEMPT 分支没赋值）→ 500 或静默越权。
// 'auth/register-open' 也要单独写：前缀匹配只认 `pre` 本身和 `pre + '/'`，
// 所以 'auth/register' **不会**顺带放行 register-open（自检抓到的真 bug：注册页拿不到 open 状态，恒 401）。
const EXEMPT = ['auth/login', 'auth/register', 'auth/register-open', 'health', 'system-info', 'amap/mapimg', 'amap/photo', 'share'];

// /api/system-info 挂在根上（免登录的版本探针）
app.get('/api/system-info', require('./routes/settingsRoutes').systemInfo);

app.use('/api', (req, res, next) => {
  const rel = req.path.replace(/^\/+/, '');
  if (EXEMPT.some((pre) => rel === pre || rel.startsWith(pre + '/'))) return next();

  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
  req.user = user;

  const page = pageForPath(req.path);
  const tab = page ? tabForPath(page, req.path) : null;
  if (page && !canAccess(user, page, tab)) return res.status(403).json({ error: '没有该页面的访问权限' });
  next();
});

// 路由挂载（需登录；顺序无讲究，路径不重叠）
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/invites', require('./routes/inviteRoutes')); // v1.10.0 邀请码（router 内再做一次 admin 闸）
app.use('/api/ai', require('./routes/aiRoutes'));
app.use('/api', require('./routes/cityRoutes'));      // /api/cities /api/attractions /api/poi /api/import-poi
app.use('/api/guides', require('./routes/guideRoutes'));
app.use('/api/journals', require('./routes/journalRoutes')); // v1.8.0 游记整理
app.use('/api/share', require('./routes/shareRoutes')); // 公开分享读（EXEMPT：token 即凭证）
app.use('/api/amap', require('./routes/amapRoutes'));
app.use('/api/weather', require('./routes/weatherRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api/upgrade', require('./routes/upgradeRoutes')); // v1.11.0 在线升级（router 内再做一次 admin 闸）

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// 兼容挂载在子路径（如 NAS 反代 /alleyu/）
app.set('trust proxy', true);

// ---------- 前端静态 ----------
// ALLEYU_WEB_ROOT：自检把前端根指到临时仓库副本，避免在真实 web/dist 上做升级自测
const webRoot = process.env.ALLEYU_WEB_ROOT || path.join(__dirname, '..', 'web');
function latestDist() {
  const dir = path.join(webRoot, 'dist');
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir).filter((n) => /^\d{8,}$/.test(n) && fs.statSync(path.join(dir, n)).isDirectory())
    .sort();
  return entries.length ? path.join(dir, entries[entries.length - 1]) : null;
}

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  const dist = latestDist();
  if (!dist) return next();
  if (req.path === '/' || req.path === '/index.html') {
    return res.sendFile(path.join(dist, 'index.html'));
  }
  const file = path.join(dist, req.path.replace(/^\/+/, ''));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    return res.sendFile(file);
  }
  res.sendFile(path.join(dist, 'index.html')); // SPA 兜底
});

// 404 JSON（API 未命中）
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// 错误兜底：永远回 JSON（前端按 JSON 解析）
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  // body 解析器超限（express.json / express.raw）：body-parser 自带 413，但我们的兜底会把它盖成 500，
  // 前端只能看到「服务器内部错误」，分不清是包太大还是服务端炸了 → 这里还原成语义明确的 413。
  if (err.type === 'entity.too.large' || err.status === 413) {
    const isUpgrade = req.path.startsWith('/api/upgrade');
    // 上限只有一个来源（upgradeService），免得 index 的文案和 express.raw 的实际限制各说各话
    const limit = isUpgrade ? `${require('./services/upgradeService').MAX_UPLOAD_MB}MB` : '12MB';
    console.warn(`[server] 请求体超限 ${req.path}（上限 ${limit}）`);
    return res.status(413).json({
      error: isUpgrade ? `升级包超过上传上限（${limit}）` : `请求体过大（上限 ${limit}）`,
      code: 'TOO_LARGE',
    });
  }
  console.error('[server]', err.message);
  res.status(500).json({ error: '服务器内部错误：' + err.message });
});

initAdmin();

const PORT = Number(process.env.PORT) || 9610;
const IS_CHILD = process.env.ALLEYU_RESTART_CHILD === '1'; // 本进程是升级后接班的那一个
// 接班场景：先退的是老进程，端口要等它把 socket 放开才能 bind → 500ms × 24 = 12s 的重试窗口
// 普通启动：端口被别的程序占着时重试也没用，只多试一次就明确退出
const RETRY_LEFT = IS_CHILD ? 24 : 2;
const RETRY_EVERY = IS_CHILD ? 500 : 1000;

function boot() {
  let left = RETRY_LEFT;
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && --left > 0) {
      console.log(`[server] ${PORT} 被占用（多半是上一个进程还没退干净），${RETRY_EVERY}ms 后重试，还剩 ${left} 次`);
      return setTimeout(() => { server.listen(PORT); }, RETRY_EVERY);
    }
    console.error('[server] 监听失败：', err.code || '', err.message);
    require('./services/restartService').writeFatal(err); // 把「备份目录在哪」写进 Logs/restart-child.log
    process.exit(3);
  };
  const server = app.listen(PORT, () => {
    server.off('error', onError); // 起来之后就不许再被监听错误带走了
    const rs = require('./services/restartService');
    const pend = rs.readPending();
    // ⚠️ isChild() 这一条不能少：状态里的 restart_pending=true 是**父进程发起交接时写的**，
    //    接班成功的子进程读到的必然是 true（它就是靠这句话知道自己在接班的）。
    //    不加这个判断，每次正常升级都会自己喊「重启没有完成交接」，管理员会真的去拿备份回滚。
    if (pend && pend.restart_pending && !rs.isChild()) {
      // 上次升级发起了重启、但接班进程没起来（现在这个是手工拉起来的）——必须说出来，别让人以为升级成功了
      console.warn(`[server] ⚠️ 上次升级（v${pend.from_version} → v${pend.to_version}）的重启没有完成交接；`
        + `如果行为异常，把 ${pend.backup_dir || 'data/upgrades/backup_*'} 里的文件拷回仓库再重启`);
    }
    rs.clearPending();
    // 重启把正在生成的攻略/游记掐断了 → 置回 error，用户才能点「重新生成」（否则永远卡在运行中）
    try {
      const n = require('./db').sweepInterrupted();
      if (n) console.log(`[server] 启动了 ${n} 个被中断的生成任务（已置为失败，可重新生成）`);
    } catch (e) { console.warn('[server] sweepInterrupted 失败:', e.message); }
    console.log(`[游巷 Alleyu] http://localhost:${PORT}  (admin 初始密码见启动日志)`);
  });
  server.on('error', onError);
}

boot();
