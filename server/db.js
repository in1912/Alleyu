// 数据层：node:sqlite 单库（alleyu.sqlite）。架构仿工作台 db.js：
//  - PRAGMA DELETE 日志模式 + busy_timeout + transaction 包装（better-sqlite3 兼容写法）
//  - addCol 幂等加列（新版本加列必须走这里，旧库重启即升级）
//  - 种子数据（城市库/景点库）只在空表时写入，可被管理员随意改
// 多租户取舍：工作台是「每用户一个租户库」，本应用数据量小、共享一份城市/景点库，
// 采用单库 + user_id 列隔离（guides 按人读写，cities/attractions 全局共享）。
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const defaultDataDir = path.join(__dirname, '..', 'data');
const dataDir = process.env.DATA_DIR || defaultDataDir;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// v1.6.3 起不内置任何高德 Key（历史内置值已作废清除）：Key 由管理员在设置页自行配置，
// 或部署时用 env AMAP_KEY 注入（只在首次空库种子时生效）

const dbFile = process.env.DB_FILE || 'alleyu.sqlite';
const dbPath = path.join(dataDir, dbFile);

function openDatabase(file) {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = DELETE');
  d.exec('PRAGMA foreign_keys = ON');
  d.exec('PRAGMA busy_timeout = 5000');
  d.transaction = (fn) => (...args) => {
    d.exec('BEGIN');
    try {
      const r = fn(...args);
      d.exec('COMMIT');
      return r;
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  };
  return d;
}
const db = openDatabase(dbPath);

// ---------- 表结构 ----------
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  display_name TEXT NOT NULL DEFAULT '',
  allowed_pages TEXT NOT NULL DEFAULT '[]',
  allowed_tabs TEXT NOT NULL DEFAULT '{}',
  can_use_ai INTEGER NOT NULL DEFAULT 0,
  ai_base_url TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT '',
  ai_key TEXT NOT NULL DEFAULT '',
  -- v1.10.0：注册/配额/用量（老库由下面 addCol 幂等补列）
  --  quota_*: -1=跟随系统默认 / -2=不限次数 / >=0=指定总额
  --  tokens_*: 累计消耗（只在服务商回包带 usage 时累加，桩模式不记）
  email TEXT NOT NULL DEFAULT '',
  quota_guide INTEGER NOT NULL DEFAULT -1,
  quota_journal INTEGER NOT NULL DEFAULT -1,
  guide_used INTEGER NOT NULL DEFAULT 0,
  journal_used INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS cities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  province TEXT NOT NULL DEFAULT '',
  adcode TEXT NOT NULL DEFAULT '',
  lng REAL,
  lat REAL,
  hot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS attractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '景点',
  level TEXT NOT NULL DEFAULT '',
  ticket TEXT NOT NULL DEFAULT '',
  hours TEXT NOT NULL DEFAULT '',
  must INTEGER NOT NULL DEFAULT 0,
  lng REAL,
  lat REAL,
  amap_poi_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_attractions_city ON attractions(city_id);

CREATE TABLE IF NOT EXISTS guides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL,
  city_id INTEGER,
  days INTEGER NOT NULL DEFAULT 3,
  params_json TEXT NOT NULL DEFAULT '{}',
  content TEXT NOT NULL DEFAULT '',
  images_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_guides_user ON guides(user_id, id DESC);

CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guide_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'dynamic',
  snapshot TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_shares_guide ON shares(guide_id);

-- v1.8.0 游记整理：问答式录入的旅行游记（与攻略并行的另一类内容，同样按 user_id 隔离）。
-- meta_json=问答答案（出发地/天数/人数/出行方式/当地交通/偏好/总费用/住宿档次/季节，均可空=跳过）；
-- spots_json=所到景点 [{name,attraction_id,note}]（城市景点库备选 + 用户自输）；
-- photos 单独一张表（journal_photos），文件落 data/journal_photos/<journal_id>/。
CREATE TABLE IF NOT EXISTS journals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  city_id INTEGER,
  destination TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  spots_json TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  error TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  cover_photo_id INTEGER,
  palette INTEGER NOT NULL DEFAULT 1,
  merge_guide_id INTEGER,
  prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_journals_user ON journals(user_id, id DESC);

CREATE TABLE IF NOT EXISTS journal_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id INTEGER NOT NULL,
  spot TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  caption_by TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_jphotos_journal ON journal_photos(journal_id);

-- v1.10.0 邀请码：注册恒定要码。max_uses=1 即一次性码；used_count 由注册时的条件 UPDATE 原子累加。
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- v1.11.0 升级日志：管理员在「设置 → 升级」上传升级包后每次应用/失败都记一行。
-- 被覆盖文件的备份在 data/upgrades/backup_<ts>/（不在库里），这里只存路径与摘要。
CREATE TABLE IF NOT EXISTS upgrade_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  actor TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  from_version TEXT NOT NULL DEFAULT '',
  to_version TEXT NOT NULL DEFAULT '',
  files_added INTEGER NOT NULL DEFAULT 0,
  files_overwritten INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  backup_dir TEXT NOT NULL DEFAULT '',
  dist_dir TEXT NOT NULL DEFAULT '',
  restarted INTEGER NOT NULL DEFAULT 0,
  restart_suppressed INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  sha256 TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);

-- v1.13.0 社区：用户把攻略/游记发布成公开快照。正文入库前先归一化成 Markdown 再重建 HTML
-- （公开页面，必须比私有游记的黑名单净化更严）。游记照片只存快照文件名，封面复制到
-- data/community/<post_id>/cover.<ext>；原文章删除时由路由级联手删这一行。
CREATE TABLE IF NOT EXISTS community_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  cover_file TEXT NOT NULL DEFAULT '',
  content_html TEXT NOT NULL DEFAULT '',
  photos_json TEXT NOT NULL DEFAULT '[]',
  published_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_community_feed ON community_posts(id DESC);
CREATE INDEX IF NOT EXISTS idx_community_user ON community_posts(user_id, id DESC);

-- v1.13.0 客服留言：登录用户按 user_id 归属；游客用 32 位 guest_key（浏览器 localStorage 里的凭证）。
-- body/reply 一律当纯文本存，前端只做插值，绝不 v-html。
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  guest_key TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  reply TEXT NOT NULL DEFAULT '',
  replied_at TEXT,
  replied_by TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_guest ON feedback(guest_key, id DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(id DESC);
`;
db.exec(DDL);

// ---------- 幂等加列（以后版本新增列只改这里） ----------
function addCol(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
// 示例：addCol('guides', 'shared', 'INTEGER NOT NULL DEFAULT 0');
// v1.3.0：城市归属线路（国内 / 欧洲线 / 中亚线 / 东亚线 / 北美线 / 南美线）
addCol('cities', 'line', "TEXT NOT NULL DEFAULT '国内'");
// v1.4.0：生成阶段（weather/connect/write/retryN/enrich:子步骤），SSE 推给前端做进度条
addCol('guides', 'stage', "TEXT NOT NULL DEFAULT ''");
// v1.5.0：完整提示词（buildMessages 的 JSON 快照，详情页生成来源下方折叠框展示+复制）
addCol('guides', 'prompt', "TEXT NOT NULL DEFAULT ''");
// v1.6.0 分享表在 DDL 里建（shares：token 能力链接，dynamic=跟随原文 / static=快照）
// v1.7.0：景点信息扩容——介绍文本（维基旅行/维基百科）、来源署名与条目链接（CC BY-SA 署名要求）、
// 高德补充字段（地址/评分）。intro_source 空串=暂无介绍；来源值：维基旅行 / 维基百科。
addCol('attractions', 'intro', "TEXT NOT NULL DEFAULT ''");
addCol('attractions', 'intro_source', "TEXT NOT NULL DEFAULT ''");
addCol('attractions', 'intro_url', "TEXT NOT NULL DEFAULT ''");
addCol('attractions', 'address', "TEXT NOT NULL DEFAULT ''");
addCol('attractions', 'rating', "TEXT NOT NULL DEFAULT ''");
// v1.9.0 游记三套文本 + 路线图：
//  content       = 实时版（编辑时自动保存的那份，永远是当前正文）
//  content_original = 系统自动生成版（首次生成完成时写入一次，之后不被覆盖，供「恢复原版」）
//  content_manual   = 手动版（点「保存一版」时把实时版拷进来，供「恢复一版」）
//  route_json    = 景点连线路线图缓存 {ok,url,summary,points,km,by_road,reason,at}
addCol('journals', 'content_original', "TEXT NOT NULL DEFAULT ''");
addCol('journals', 'content_manual', "TEXT NOT NULL DEFAULT ''");
addCol('journals', 'route_json', "TEXT NOT NULL DEFAULT ''");
// v1.12.0 照片尺寸/体积：编辑页要「看到图片的大小」。上传时从文件头读出来落库；
// 历史照片在首次打开该游记时懒补（GET /:id 里逐张算，不扫全库）。
addCol('journal_photos', 'width', 'INTEGER NOT NULL DEFAULT 0');
addCol('journal_photos', 'height', 'INTEGER NOT NULL DEFAULT 0');
addCol('journal_photos', 'bytes', 'INTEGER NOT NULL DEFAULT 0');
// v1.10.0：注册（邮箱）+ 生成配额 + 用量记账。users 表此前从没加过列，这组是第一次。
//  配额语义：-1=跟随系统默认（settings 的 quota_default_*）/ -2=不限 / >=0=指定总额；已用只增不减（管理员可清零）。
addCol('users', 'email', "TEXT NOT NULL DEFAULT ''");
addCol('users', 'quota_guide', 'INTEGER NOT NULL DEFAULT -1');
addCol('users', 'quota_journal', 'INTEGER NOT NULL DEFAULT -1');
addCol('users', 'guide_used', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'journal_used', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'tokens_in', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'tokens_out', 'INTEGER NOT NULL DEFAULT 0');

// ---------- settings 读写 ----------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : '';
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value ?? ''));
}

// ---------- 启动时清理被掐断的生成任务（v1.11.0） ----------
// 生成是 fire-and-forget 的流式任务：进程一退出（升级自动重启 / 手工重启 / 崩溃），
// 库里那行就永远停在 pending/generating，前端进度条卡死、连「重新生成」都点不了。
// 启动这一刻没有任何生成在跑，所以这两个状态的行**必然**是被中断的，不需要时间窗判断。
// 已流式落库的正文保留在 content 里（用户至少能看到半成品），只是不再继续写。
function sweepInterrupted() {
  const msg = '服务在生成过程中重启（升级或手工重启），本篇已中断，请点「重新生成」';
  const g = db.prepare("UPDATE guides SET status='error', error=?, stage='', updated_at=datetime('now','localtime') WHERE status IN ('pending','generating')").run(msg);
  const j = db.prepare("UPDATE journals SET status='error', error=?, stage='', updated_at=datetime('now','localtime') WHERE status IN ('pending','generating')").run(msg);
  return g.changes + j.changes;
}

// ---------- 种子：城市库（adcode/坐标为市中心近似值，供天气与静态地图定位） ----------
// 坐标来源：公开地理常识值，精度到市级足够（天气/地图中心）；景点坐标不造数，
// 首次使用时由高德 POI 检索现场解析并回填（见 amapService.resolveAttraction）。
const SEED_CITIES = [
  ['北京', '北京市', '110000', 116.407, 39.904, 1],
  ['上海', '上海市', '310000', 121.473, 31.230, 1],
  ['杭州', '浙江省', '330100', 120.155, 30.274, 1],
  ['成都', '四川省', '510100', 104.066, 30.572, 1],
  ['重庆', '重庆市', '500100', 106.550, 29.563, 1],
  ['西安', '陕西省', '610100', 108.940, 34.341, 1],
  ['苏州', '江苏省', '320500', 120.585, 31.299, 1],
  ['厦门', '福建省', '350200', 118.089, 24.479, 1],
  ['广州', '广东省', '440100', 113.264, 23.129, 1],
  ['深圳', '广东省', '440300', 114.058, 22.543, 0],
  ['南京', '江苏省', '320100', 118.796, 32.060, 1],
  ['青岛', '山东省', '370200', 120.382, 36.067, 1],
  ['长沙', '湖南省', '430100', 112.938, 28.228, 0],
  ['武汉', '湖北省', '420100', 114.305, 30.593, 0],
  ['昆明', '云南省', '530100', 102.833, 24.880, 1],
  ['大理', '云南省', '532900', 100.268, 25.606, 1],
  ['丽江', '云南省', '530700', 100.229, 26.856, 1],
  ['桂林', '广西壮族自治区', '450300', 110.290, 25.273, 1],
  ['三亚', '海南省', '460200', 109.508, 18.247, 1],
  ['海口', '海南省', '460100', 110.350, 20.017, 0],
  ['哈尔滨', '黑龙江省', '230100', 126.534, 45.801, 0],
  ['沈阳', '辽宁省', '210100', 123.431, 41.805, 0],
  ['大连', '辽宁省', '210200', 121.614, 38.904, 0],
  ['天津', '天津市', '120000', 117.190, 39.085, 0],
  ['洛阳', '河南省', '410300', 112.454, 34.619, 0],
  ['郑州', '河南省', '410100', 113.625, 34.746, 0],
  ['济南', '山东省', '370100', 117.120, 36.651, 0],
  ['福州', '福建省', '350100', 119.296, 26.074, 0],
  ['泉州', '福建省', '350500', 118.675, 24.874, 0],
  ['南昌', '江西省', '360100', 115.858, 28.682, 0],
  ['合肥', '安徽省', '340100', 117.227, 31.820, 0],
  ['黄山', '安徽省', '341000', 118.337, 29.714, 1],
  ['张家界', '湖南省', '430800', 110.478, 29.127, 0],
  ['兰州', '甘肃省', '620100', 103.834, 36.061, 0],
  ['西宁', '青海省', '630100', 101.778, 36.623, 0],
  ['银川', '宁夏回族自治区', '640100', 106.232, 38.487, 0],
  ['呼和浩特', '内蒙古自治区', '150100', 111.752, 40.842, 0],
  ['乌鲁木齐', '新疆维吾尔自治区', '650100', 87.617, 43.793, 0],
  ['拉萨', '西藏自治区', '540100', 91.114, 29.646, 0],
  ['珠海', '广东省', '440400', 113.576, 22.270, 0],
  ['绍兴', '浙江省', '330600', 120.582, 30.030, 0],
  ['嘉兴', '浙江省', '330400', 120.756, 30.746, 0],
];

// 景点种子：只给 8 座热门城市各一小批「维护性示例」（门票/时长为参考值，界面可改；
// 坐标留空 → 生成攻略前自动经高德 POI 检索解析回填）。
const SEED_ATTRACTIONS = {
  北京: [
    ['故宫博物院', '人文', '5A', '旺季60 淡季40（提前7天预约）', '3-4小时', 1],
    ['天坛公园', '人文', '5A', '旺季15 淡季10', '1-2小时', 0],
    ['颐和园', '自然风光', '5A', '旺季30 淡季20', '2-3小时', 1],
    ['八达岭长城', '人文', '5A', '旺季40 淡季35', '3-4小时', 1],
    ['南锣鼓巷', '逛街', '-', '免费', '1-2小时', 0],
    ['什刹海', '休闲', '-', '免费', '2小时', 0],
    ['国家博物馆', '人文', '-', '免费（预约）', '2-3小时', 0],
  ],
  上海: [
    ['外滩', '逛街', '-', '免费', '1-2小时', 1],
    ['豫园', '人文', '4A', '40', '1-2小时', 0],
    ['南京路步行街', '逛街', '-', '免费', '1-2小时', 0],
    ['上海迪士尼乐园', '亲子', '5A', '约475起', '1天', 1],
    ['武康路', '逛街', '-', '免费', '1-2小时', 0],
    ['上海博物馆', '人文', '-', '免费（预约）', '2-3小时', 0],
  ],
  杭州: [
    ['西湖', '自然风光', '5A', '免费（雷峰塔等单收）', '半天', 1],
    ['灵隐寺', '人文', '5A', '飞来峰45+香花券30', '2-3小时', 1],
    ['西溪湿地', '自然风光', '5A', '80', '3-4小时', 0],
    ['河坊街', '逛街', '-', '免费', '1-2小时', 0],
    ['龙井村', '休闲', '-', '免费', '2小时', 0],
    ['京杭大运河拱宸桥', '人文', '-', '免费', '1小时', 0],
  ],
  成都: [
    ['大熊猫繁育研究基地', '亲子', '5A', '55', '3-4小时', 1],
    ['宽窄巷子', '逛街', '-', '免费', '2小时', 1],
    ['武侯祠', '人文', '4A', '50', '2小时', 0],
    ['锦里', '逛街', '-', '免费', '1-2小时', 0],
    ['都江堰', '人文', '5A', '80', '3小时', 0],
    ['人民公园', '休闲', '-', '免费', '1-2小时', 0],
  ],
  西安: [
    ['秦始皇兵马俑博物馆', '人文', '5A', '120', '3小时', 1],
    ['西安城墙', '人文', '4A', '54', '2小时', 1],
    ['大唐不夜城', '逛街', '-', '免费', '2-3小时(夜)', 1],
    ['陕西历史博物馆', '人文', '4A', '免费（预约）', '2-3小时', 0],
    ['回民街', '美食', '-', '免费', '1-2小时', 0],
    ['华清宫', '人文', '5A', '120', '2-3小时', 0],
  ],
  重庆: [
    ['洪崖洞', '逛街', '4A', '免费', '2小时(夜)', 1],
    ['磁器口古镇', '逛街', '-', '免费', '2小时', 0],
    ['长江索道', '休闲', '4A', '单程20往返30', '1小时', 1],
    ['李子坝轻轨穿楼', '拍照打卡', '-', '免费', '30分钟', 0],
    ['南山一棵树观景台', '拍照打卡', '-', '30', '1-2小时(夜)', 0],
  ],
  苏州: [
    ['拙政园', '人文', '5A', '旺季80 淡季70（预约）', '2-3小时', 1],
    ['苏州博物馆', '人文', '4A', '免费（预约）', '2小时', 1],
    ['平江路', '逛街', '-', '免费', '2小时', 0],
    ['虎丘', '人文', '5A', '旺季70 淡季60', '2小时', 0],
    ['山塘街', '逛街', '-', '免费', '1-2小时', 0],
  ],
  厦门: [
    ['鼓浪屿', '自然风光', '5A', '轮渡35起（船票预约）', '1天', 1],
    ['厦门大学', '人文', '-', '免费（预约）', '2小时', 0],
    ['南普陀寺', '人文', '-', '免费', '1-2小时', 0],
    ['环岛路', '休闲', '-', '免费', '2-3小时', 0],
    ['曾厝垵', '美食', '-', '免费', '2小时', 0],
  ],
};

// ---------- v1.3.0 国际线路种子（参考站 tabiji.ai 的目的地覆盖挑选城市） ----------
// 结构：线路 → [城市名, 国家(province), ISO2(adcode), lng, lat, [景点…]]
// 景点行沿用国内种子格式 [名称, 类型, 等级, 门票, 建议时长, 必去]；门票为「约」参考值，界面可改。
// 坐标 WGS-84 市中心近似值，仅供 Open-Meteo 天气定位；高德无海外底图，国际线不插图（guideService 有护栏）。
const SEED_INTL = {
  欧洲线: [
    ['巴黎', '法国', 'FR', 2.3522, 48.8566, [
      ['卢浮宫', '人文', '世界遗产', '约22欧元（时段预约）', '3-4小时', 1],
      ['埃菲尔铁塔', '拍照打卡', '-', '登顶约29欧元起', '1-2小时', 1],
      ['凯旋门与香榭丽舍大街', '逛街', '-', '登顶约16欧元', '2小时', 0],
      ['塞纳河游船', '休闲', '-', '约15欧元', '1小时', 0],
      ['凡尔赛宫', '人文', '世界遗产', '约21欧元（近郊，RER C线）', '半天', 0],
      ['蒙马特高地·圣心堂', '拍照打卡', '-', '教堂免费', '2小时', 0],
    ]],
    ['伦敦', '英国', 'GB', -0.1276, 51.5072, [
      ['大英博物馆', '人文', '-', '免费（特展另收）', '3小时', 1],
      ['伦敦塔', '人文', '世界遗产', '约35英镑', '2-3小时', 1],
      ['塔桥', '拍照打卡', '-', '桥面免费/登塔约13英镑', '1小时', 0],
      ['白金汉宫卫兵交接', '人文', '-', '外围免费', '1小时', 0],
      ['威斯敏斯特教堂', '人文', '世界遗产', '约30英镑', '1-2小时', 0],
      ['伦敦眼', '拍照打卡', '-', '约33英镑', '1小时', 0],
    ]],
    ['罗马', '意大利', 'IT', 12.4964, 41.9028, [
      ['斗兽场', '人文', '世界遗产', '约18欧元（联票，强预约）', '2小时', 1],
      ['梵蒂冈博物馆与西斯廷礼拜堂', '人文', '世界遗产', '约20欧元（周五夜场人少）', '3小时', 1],
      ['圣彼得大教堂', '人文', '世界遗产', '免费（登顶另收）', '2小时', 0],
      ['特雷维喷泉', '拍照打卡', '-', '免费', '30分钟', 0],
      ['万神殿', '人文', '-', '约5欧元', '1小时', 0],
      ['古罗马广场', '人文', '世界遗产', '与斗兽场联票', '1-2小时', 0],
    ]],
    ['威尼斯', '意大利', 'IT', 12.3155, 45.4408, [
      ['圣马可广场与大教堂', '人文', '世界遗产', '教堂约3欧元', '2小时', 1],
      ['总督府', '人文', '-', '约30欧元', '2小时', 0],
      ['贡多拉游船', '休闲', '-', '白天约90欧元/船', '40分钟', 1],
      ['里亚托桥', '逛街', '-', '免费', '1小时', 0],
      ['彩色岛（布拉诺）', '拍照打卡', '-', '船票约10欧元往返', '半天', 0],
    ]],
    ['佛罗伦萨', '意大利', 'IT', 11.2558, 43.7696, [
      ['乌菲兹美术馆', '人文', '-', '约25欧元（强预约）', '3小时', 1],
      ['圣母百花大教堂', '人文', '世界遗产', '穹顶约30欧元（预约）', '2小时', 1],
      ['老桥（庞特韦基奥）', '逛街', '-', '免费', '1小时', 0],
      ['米开朗基罗广场', '拍照打卡', '-', '免费（日落最好）', '1小时', 0],
      ['学院美术馆（大卫像）', '人文', '-', '约16欧元', '1-2小时', 0],
    ]],
    ['巴塞罗那', '西班牙', 'ES', 2.1734, 41.3851, [
      ['圣家堂', '人文', '世界遗产', '约26欧元（强预约）', '2-3小时', 1],
      ['奎尔公园', '人文', '世界遗产', '约10欧元', '2小时', 1],
      ['巴特罗之家', '人文', '世界遗产', '约35欧元', '1-2小时', 0],
      ['兰布拉大道', '逛街', '-', '免费', '2小时', 0],
      ['哥特区', '逛街', '-', '免费', '2小时', 0],
    ]],
    ['马德里', '西班牙', 'ES', -3.7038, 40.4168, [
      ['普拉多博物馆', '人文', '-', '约15欧元', '3小时', 1],
      ['马德里王宫', '人文', '-', '约15欧元', '2小时', 1],
      ['丽池公园', '休闲', '-', '免费', '2小时', 0],
      ['圣米格尔市场', '美食', '-', '按消费', '1小时', 0],
      ['索菲亚王后艺术中心', '人文', '-', '约10欧元', '2小时', 0],
    ]],
    ['柏林', '德国', 'DE', 13.4050, 52.5200, [
      ['勃兰登堡门', '人文', '-', '免费', '1小时', 1],
      ['博物馆岛', '人文', '世界遗产', '通票约24欧元', '半天', 1],
      ['柏林墙东边画廊', '人文', '-', '免费', '1-2小时', 0],
      ['国会大厦穹顶', '人文', '-', '免费（需预约）', '1-2小时', 0],
      ['查理检查哨', '人文', '-', '免费', '30分钟', 0],
    ]],
    ['慕尼黑', '德国', 'DE', 11.5820, 48.1351, [
      ['玛利亚广场与新市政厅', '人文', '-', '免费', '1小时', 1],
      ['新天鹅堡', '人文', '-', '约15欧元（近郊，火车2小时）', '半天', 1],
      ['英国花园', '休闲', '-', '免费', '2小时', 0],
      ['宝马博物馆', '人文', '-', '约10欧元', '2小时', 0],
      ['皇家啤酒馆', '美食', '-', '按消费', '2小时', 0],
    ]],
    ['阿姆斯特丹', '荷兰', 'NL', 4.9041, 52.3676, [
      ['荷兰国家博物馆', '人文', '-', '约22.5欧元', '3小时', 1],
      ['梵高美术馆', '人文', '-', '约22欧元（强预约）', '2小时', 1],
      ['运河游船', '休闲', '世界遗产', '约18欧元', '1小时', 0],
      ['安妮之家', '人文', '-', '约16欧元（提前数周预约）', '1-2小时', 0],
      ['约旦区九街', '逛街', '-', '免费', '2小时', 0],
    ]],
    ['维也纳', '奥地利', 'AT', 16.3738, 48.2082, [
      ['美泉宫', '人文', '世界遗产', '约24欧元', '3小时', 1],
      ['霍夫堡宫', '人文', '世界遗产', '约20欧元', '2-3小时', 0],
      ['圣斯特凡大教堂', '人文', '-', '免费（登塔另收）', '1小时', 0],
      ['金色大厅', '人文', '-', '演出票30欧元起', '2小时', 0],
      ['中央咖啡馆', '美食', '-', '按消费', '1小时', 0],
    ]],
    ['布拉格', '捷克', 'CZ', 14.4378, 50.0755, [
      ['布拉格城堡', '人文', '世界遗产', '联票约450克朗', '3小时', 1],
      ['查理大桥', '拍照打卡', '-', '免费（清晨人少）', '1小时', 1],
      ['老城广场与天文钟', '人文', '世界遗产', '免费', '1-2小时', 0],
      ['犹太区', '人文', '-', '联票约600克朗', '2小时', 0],
    ]],
    ['里斯本', '葡萄牙', 'PT', -9.1393, 38.7223, [
      ['贝伦塔', '人文', '世界遗产', '约8欧元', '1-2小时', 1],
      ['热罗尼莫斯修道院', '人文', '世界遗产', '约10欧元', '2小时', 1],
      ['28路有轨电车', '休闲', '-', '3欧元单程', '1小时', 0],
      ['圣若热城堡', '人文', '-', '约10欧元', '2小时', 0],
      ['Time Out 市场', '美食', '-', '按消费', '1-2小时', 0],
    ]],
    ['雅典', '希腊', 'GR', 23.7275, 37.9838, [
      ['卫城（帕特农神庙）', '人文', '世界遗产', '约20欧元（避开正午）', '2-3小时', 1],
      ['卫城博物馆', '人文', '-', '约10欧元', '2小时', 1],
      ['宪法广场换岗', '人文', '-', '免费', '30分钟', 0],
      ['普拉卡老城区', '逛街', '-', '免费', '2小时', 0],
    ]],
    ['伊斯坦布尔', '土耳其', 'TR', 28.9784, 41.0082, [
      ['圣索菲亚大教堂', '人文', '世界遗产', '约25欧元', '2小时', 1],
      ['蓝色清真寺', '人文', '世界遗产', '免费（女士备头巾）', '1-2小时', 1],
      ['大巴扎', '逛街', '-', '免费', '2小时', 0],
      ['博斯普鲁斯海峡游船', '休闲', '-', '约15欧元', '2-3小时', 0],
      ['托普卡帕宫', '人文', '世界遗产', '约25欧元', '3小时', 0],
    ]],
  ],
  中亚线: [
    ['阿拉木图', '哈萨克斯坦', 'KZ', 76.8897, 43.2380, [
      ['升天大教堂', '人文', '-', '免费', '1小时', 1],
      ['琼布拉克滑雪场', '自然风光', '-', '缆车约1万坚戈起', '半天', 0],
      ['大阿拉木图湖', '自然风光', '-', '包车前往', '半天', 1],
      ['绿色巴扎', '美食', '-', '按消费', '2小时', 0],
      ['潘菲洛夫公园', '休闲', '-', '免费', '1小时', 0],
    ]],
    ['阿斯塔纳', '哈萨克斯坦', 'KZ', 71.4304, 51.1282, [
      ['巴伊杰列克观景塔', '拍照打卡', '-', '约2000坚戈', '1-2小时', 1],
      ['哈兹拉特苏丹清真寺', '人文', '-', '免费', '1小时', 0],
      ['和平金字塔', '人文', '-', '免费', '1小时', 0],
      ['可汗之帐购物中心', '逛街', '-', '免费', '2小时', 0],
    ]],
    ['塔什干', '乌兹别克斯坦', 'UZ', 69.2401, 41.2995, [
      ['帖木儿广场', '人文', '-', '免费', '1小时', 1],
      ['哈兹拉提伊玛目广场', '人文', '-', '免费', '1-2小时', 1],
      ['琼苏巴扎', '美食', '-', '按消费', '2小时', 0],
      ['塔什干地铁', '拍照打卡', '-', '按乘车费', '1-2小时', 0],
    ]],
    ['撒马尔罕', '乌兹别克斯坦', 'UZ', 66.9597, 39.6547, [
      ['雷吉斯坦广场', '人文', '世界遗产', '联票约10万苏姆', '2-3小时', 1],
      ['比比哈尼姆清真寺', '人文', '世界遗产', '联票内', '1小时', 0],
      ['沙赫静达陵', '人文', '世界遗产', '联票内', '1-2小时', 1],
      ['古里·阿米尔陵', '人文', '世界遗产', '联票内', '1小时', 0],
      ['锡亚布巴扎', '美食', '-', '按消费', '1小时', 0],
    ]],
    ['布哈拉', '乌兹别克斯坦', 'UZ', 64.4231, 39.7676, [
      ['波伊卡扬建筑群', '人文', '世界遗产', '联票约5万苏姆', '2小时', 1],
      ['雅克城堡', '人文', '世界遗产', '联票内', '1-2小时', 0],
      ['利亚比豪兹广场', '休闲', '世界遗产', '免费', '1小时', 0],
      ['贸易穹顶巴扎', '逛街', '世界遗产', '免费', '2小时', 0],
    ]],
    ['希瓦', '乌兹别克斯坦', 'UZ', 60.3639, 41.3775, [
      ['伊钦卡拉内城', '人文', '世界遗产', '联票约15万苏姆', '半天', 1],
      ['卡尔塔米诺尔宣礼塔', '拍照打卡', '世界遗产', '联票内', '30分钟', 0],
      ['库希纳堡', '人文', '世界遗产', '联票内', '1小时', 0],
    ]],
    ['比什凯克', '吉尔吉斯斯坦', 'KG', 74.5660, 42.8746, [
      ['阿拉套广场', '人文', '-', '免费', '1小时', 1],
      ['奥什巴扎', '美食', '-', '按消费', '2小时', 0],
      ['阿拉阿尔恰国家公园', '自然风光', '-', '免费（包车前往）', '半天', 1],
      ['胜利广场', '人文', '-', '免费', '30分钟', 0],
    ]],
    ['杜尚别', '塔吉克斯坦', 'TJ', 68.7884, 38.5598, [
      ['鲁达基大道', '逛街', '-', '免费', '2小时', 1],
      ['国旗公园', '人文', '-', '免费', '1小时', 0],
      ['独立与自由塔', '拍照打卡', '-', '免费', '30分钟', 0],
      ['瓦尔佐布山谷', '自然风光', '-', '包车前往', '半天', 0],
    ]],
    ['阿什哈巴德', '土库曼斯坦', 'TM', 58.3800, 37.9600, [
      ['中立门', '拍照打卡', '-', '免费', '30分钟', 1],
      ['大理石城区', '拍照打卡', '-', '免费', '2小时', 0],
      ['地狱之门（达尔瓦扎）', '自然风光', '-', '需跟团/包车（近郊250km）', '1天', 1],
      ['土库曼巴扎', '美食', '-', '按消费', '2小时', 0],
    ]],
  ],
  东亚线: [
    ['东京', '日本', 'JP', 139.6917, 35.6895, [
      ['浅草寺', '人文', '-', '免费', '2小时', 1],
      ['东京晴空塔', '拍照打卡', '-', '约2100日元起', '2小时', 0],
      ['涩谷十字路口', '逛街', '-', '免费', '1小时', 1],
      ['明治神宫', '人文', '-', '免费', '1-2小时', 0],
      ['上野公园与博物馆群', '人文', '-', '公园免费/博物馆约600日元', '半天', 0],
      ['筑地场外市场', '美食', '-', '按消费', '2小时', 0],
      ['秋叶原', '逛街', '-', '免费', '2-3小时', 0],
    ]],
    ['京都', '日本', 'JP', 135.7681, 35.0116, [
      ['清水寺', '人文', '世界遗产', '约400日元', '2小时', 1],
      ['伏见稻荷大社', '人文', '-', '免费（清晨人少）', '2-3小时', 1],
      ['金阁寺', '人文', '世界遗产', '约400日元', '1-2小时', 1],
      ['岚山竹林', '自然风光', '-', '免费', '2-3小时', 0],
      ['二条城', '人文', '世界遗产', '约800日元', '1-2小时', 0],
      ['祇园花见小路', '逛街', '-', '免费', '1-2小时', 0],
    ]],
    ['大阪', '日本', 'JP', 135.5023, 34.6937, [
      ['大阪城公园', '人文', '-', '天守阁约600日元', '2-3小时', 1],
      ['道顿堀', '美食', '-', '按消费', '2小时', 1],
      ['心斋桥', '逛街', '-', '免费', '2-3小时', 0],
      ['日本环球影城', '亲子', '-', '约8600日元起', '1天', 0],
      ['通天阁·新世界', '美食', '-', '登塔约900日元', '2小时', 0],
    ]],
    ['札幌', '日本', 'JP', 141.3469, 43.0618, [
      ['大通公园', '休闲', '-', '免费', '1小时', 0],
      ['札幌电视塔', '拍照打卡', '-', '约720日元', '1小时', 0],
      ['白色恋人公园', '亲子', '-', '约800日元', '2小时', 0],
      ['狸小路商店街', '逛街', '-', '免费', '2小时', 0],
      ['藻岩山夜景', '拍照打卡', '-', '缆车约2100日元', '2小时', 1],
    ]],
    ['首尔', '韩国', 'KR', 126.9780, 37.5665, [
      ['景福宫', '人文', '-', '约3000韩元（穿韩服免费）', '2小时', 1],
      ['北村韩屋村', '拍照打卡', '-', '免费', '2小时', 1],
      ['明洞', '逛街', '-', '免费', '2-3小时', 0],
      ['N首尔塔', '拍照打卡', '-', '约21000韩元', '2小时', 0],
      ['弘大商圈', '逛街', '-', '免费', '2-3小时', 0],
    ]],
    ['釜山', '韩国', 'KR', 129.0756, 35.1796, [
      ['海云台海滩', '自然风光', '-', '免费', '2小时', 1],
      ['甘川文化村', '拍照打卡', '-', '免费', '2小时', 1],
      ['札嘎其市场', '美食', '-', '按消费', '2小时', 0],
      ['太宗台', '自然风光', '-', '免费（小火车另收）', '2-3小时', 0],
    ]],
    ['台北', '中国台湾', 'TW', 121.5654, 25.0330, [
      ['台北101观景台', '拍照打卡', '-', '约600新台币', '1-2小时', 1],
      ['台北故宫博物院', '人文', '-', '约350新台币', '3小时', 1],
      ['士林夜市', '美食', '-', '按消费', '2小时', 0],
      ['九份老街', '逛街', '-', '免费（台铁+巴士约1.5小时）', '半天', 0],
      ['西门町', '逛街', '-', '免费', '2-3小时', 0],
    ]],
    ['香港', '中国香港', 'HK', 114.1694, 22.3193, [
      ['太平山顶', '拍照打卡', '-', '缆车+观景台约148港币', '2-3小时', 1],
      ['星光大道', '逛街', '-', '免费', '1-2小时', 1],
      ['天坛大佛与昂坪360', '人文', '-', '缆车约270港币往返', '半天', 0],
      ['庙街夜市', '美食', '-', '按消费', '2小时', 0],
      ['香港迪士尼乐园', '亲子', '-', '约639港币起', '1天', 0],
    ]],
    ['澳门', '中国澳门', 'MO', 113.5491, 22.1987, [
      ['大三巴牌坊', '人文', '世界遗产', '免费', '1小时', 1],
      ['官也街', '美食', '-', '按消费', '2小时', 1],
      ['威尼斯人度假村', '逛街', '-', '免费', '2-3小时', 0],
      ['妈阁庙', '人文', '世界遗产', '免费', '1小时', 0],
      ['东望洋灯塔', '拍照打卡', '世界遗产', '免费', '1小时', 0],
    ]],
  ],
  北美线: [
    ['纽约', '美国', 'US', -74.0060, 40.7128, [
      ['自由女神像', '人文', '世界遗产', '渡轮约25美元（登冠冕需预约）', '半天', 1],
      ['中央公园', '休闲', '-', '免费', '2-3小时', 1],
      ['大都会博物馆', '人文', '-', '建议捐赠30美元', '3小时', 1],
      ['时代广场', '逛街', '-', '免费', '1小时', 0],
      ['帝国大厦观景台', '拍照打卡', '-', '约44美元起', '1-2小时', 0],
      ['布鲁克林大桥', '拍照打卡', '-', '免费', '1-2小时', 0],
    ]],
    ['洛杉矶', '美国', 'US', -118.2437, 34.0522, [
      ['好莱坞星光大道', '逛街', '-', '免费', '2小时', 1],
      ['环球影城', '亲子', '-', '约110美元起', '1天', 1],
      ['圣莫尼卡海滩与码头', '自然风光', '-', '免费', '半天', 0],
      ['格里菲斯天文台', '拍照打卡', '-', '免费（夜景最好）', '2小时', 0],
      ['迪士尼乐园（安纳海姆）', '亲子', '-', '约104美元起', '1天', 0],
    ]],
    ['旧金山', '美国', 'US', -122.4194, 37.7749, [
      ['金门大桥', '拍照打卡', '-', '免费（骑车过桥最佳）', '2小时', 1],
      ['渔人码头与39号码头', '逛街', '-', '免费', '2-3小时', 0],
      ['恶魔岛', '人文', '-', '约42美元（提前数周预约）', '半天', 1],
      ['九曲花街', '拍照打卡', '-', '免费', '30分钟', 0],
      ['旧金山唐人街', '逛街', '-', '免费', '1-2小时', 0],
    ]],
    ['拉斯维加斯', '美国', 'US', -115.1398, 36.1699, [
      ['拉斯维加斯大道', '逛街', '-', '免费', '半天(夜)', 1],
      ['百乐宫音乐喷泉', '拍照打卡', '-', '免费', '1小时', 1],
      ['弗里蒙特街天幕', '拍照打卡', '-', '免费', '1-2小时(夜)', 0],
      ['大峡谷西缘/南缘一日游', '自然风光', '世界遗产', '约100-200美元', '1天', 0],
    ]],
    ['火奴鲁鲁（夏威夷）', '美国', 'US', -157.8583, 21.3069, [
      ['威基基海滩', '自然风光', '-', '免费', '半天', 1],
      ['珍珠港（亚利桑那号纪念馆）', '人文', '-', '免费（预约1美元手续费）', '半天', 1],
      ['钻石头山', '自然风光', '-', '约5美元（预约）', '2-3小时', 0],
      ['恐龙湾浮潜', '自然风光', '-', '约25美元（提前预约）', '半天', 0],
    ]],
    ['西雅图', '美国', 'US', -122.3321, 47.6062, [
      ['太空针塔', '拍照打卡', '-', '约35美元', '1-2小时', 1],
      ['派克市场', '美食', '-', '免费', '2小时', 1],
      ['奇胡利玻璃艺术园', '人文', '-', '约35美元', '1-2小时', 0],
      ['华盛顿大学', '人文', '-', '免费', '2小时', 0],
    ]],
    ['芝加哥', '美国', 'US', -87.6298, 41.8781, [
      ['千禧公园·云门（豆子）', '拍照打卡', '-', '免费', '1小时', 1],
      ['威利斯大厦天空甲板', '拍照打卡', '-', '约30美元', '1-2小时', 0],
      ['芝加哥艺术博物馆', '人文', '-', '约32美元', '3小时', 1],
      ['海军码头', '休闲', '-', '免费', '2-3小时', 0],
    ]],
    ['波士顿', '美国', 'US', -71.0589, 42.3601, [
      ['自由之路', '人文', '-', '步道免费（沿线场馆另收）', '半天', 1],
      ['哈佛大学', '人文', '-', '免费', '2小时', 1],
      ['麻省理工学院', '人文', '-', '免费', '2小时', 0],
      ['昆西市场', '美食', '-', '按消费', '2小时', 0],
    ]],
    ['华盛顿', '美国', 'US', -77.0369, 38.9072, [
      ['白宫', '人文', '-', '外观免费（入内需国会议员预约）', '1小时', 1],
      ['国会山', '人文', '-', '免费（预约）', '2小时', 0],
      ['林肯纪念堂', '人文', '-', '免费（24小时）', '1小时', 1],
      ['史密森尼博物馆群', '人文', '-', '免费', '1-2天', 0],
    ]],
    ['迈阿密', '美国', 'US', -80.1918, 25.7617, [
      ['南海滩', '自然风光', '-', '免费', '半天', 1],
      ['温伍德墙', '拍照打卡', '-', '免费', '2小时', 0],
      ['大沼泽地国家公园', '自然风光', '世界遗产', '约35美元', '半天-1天', 0],
      ['小哈瓦那', '逛街', '-', '免费', '2小时', 0],
    ]],
    ['奥兰多', '美国', 'US', -81.3792, 28.5384, [
      ['迪士尼世界', '亲子', '-', '约109美元起/园', '1-2天', 1],
      ['环球影城与哈利波特园区', '亲子', '-', '约109美元起', '1-2天', 1],
      ['海洋世界', '亲子', '-', '约90美元起', '1天', 0],
    ]],
    ['多伦多', '加拿大', 'CA', -79.3832, 43.6532, [
      ['CN塔', '拍照打卡', '-', '约43加元', '1-2小时', 1],
      ['皇家安大略博物馆', '人文', '-', '约23加元', '3小时', 0],
      ['湖心岛', '休闲', '-', '渡轮约9加元往返', '半天', 0],
      ['尼亚加拉大瀑布', '自然风光', '-', '免费（近郊130km，巴士/火车1天游）', '1天', 1],
    ]],
    ['温哥华', '加拿大', 'CA', -123.1216, 49.2827, [
      ['斯坦利公园', '自然风光', '-', '免费（骑行环线最佳）', '半天', 1],
      ['格兰维尔岛', '美食', '-', '免费', '2-3小时', 0],
      ['卡皮拉诺吊桥公园', '自然风光', '-', '约66加元', '2-3小时', 0],
      ['煤气镇', '逛街', '-', '免费', '1-2小时', 0],
    ]],
    ['墨西哥城', '墨西哥', 'MX', -99.1332, 19.4326, [
      ['宪法广场与大教堂', '人文', '-', '免费', '2小时', 1],
      ['国家人类学博物馆', '人文', '-', '约90比索', '3小时', 1],
      ['特奥蒂瓦坎金字塔', '人文', '世界遗产', '约85比索（东北50km）', '半天', 1],
      ['弗里达·卡罗故居（蓝房子）', '人文', '-', '约320比索（强预约）', '2小时', 0],
    ]],
    ['坎昆', '墨西哥', 'MX', -86.8515, 21.1619, [
      ['奇琴伊察', '人文', '世界遗产', '约600比索（跟团一日游最方便）', '1天', 1],
      ['图卢姆遗址', '人文', '-', '约100比索', '半天', 0],
      ['Xcaret生态公园', '亲子', '-', '约130美元', '1天', 0],
      ['女人岛', '自然风光', '-', '渡轮约25美元往返', '1天', 0],
    ]],
  ],
  南美线: [
    ['里约热内卢', '巴西', 'BR', -43.1729, -22.9068, [
      ['基督救世主像', '人文', '世界遗产', '约115雷亚尔（小火车上山）', '半天', 1],
      ['面包山', '拍照打卡', '-', '约120雷亚尔缆车', '2-3小时', 1],
      ['科帕卡巴纳海滩', '自然风光', '-', '免费', '半天', 0],
      ['塞勒隆阶梯', '拍照打卡', '-', '免费', '30分钟', 0],
      ['马拉卡纳球场', '人文', '-', '参观约60雷亚尔', '1-2小时', 0],
    ]],
    ['圣保罗', '巴西', 'BR', -46.6333, -23.5505, [
      ['圣保罗大教堂与广场', '人文', '-', '免费', '1小时', 0],
      ['保利斯塔大道', '逛街', '-', '免费（周日封街步行）', '2-3小时', 1],
      ['伊比拉普埃拉公园', '休闲', '-', '免费', '2小时', 0],
      ['东方街', '美食', '-', '按消费', '2小时', 0],
    ]],
    ['布宜诺斯艾利斯', '阿根廷', 'AR', -58.3816, -34.6037, [
      ['博卡区彩色房子（卡米尼托）', '拍照打卡', '-', '免费', '2小时', 1],
      ['雷科莱塔公墓', '人文', '-', '免费', '1-2小时', 0],
      ['五月广场与总统府', '人文', '-', '免费', '1小时', 0],
      ['雅典人书店', '人文', '-', '免费（原剧院书店）', '1小时', 0],
      ['探戈舞会', '休闲', '-', '约20-50美元', '1晚', 1],
    ]],
    ['利马', '秘鲁', 'PE', -77.0428, -12.0464, [
      ['武器广场', '人文', '世界遗产', '免费', '1-2小时', 0],
      ['拉尔科博物馆', '人文', '-', '约35索尔', '2小时', 1],
      ['米拉弗洛雷斯海岸步道', '自然风光', '-', '免费', '2小时', 1],
      ['圣弗朗西斯科修道院地下墓穴', '人文', '世界遗产', '约15索尔', '1-2小时', 0],
    ]],
    ['库斯科', '秘鲁', 'PE', -71.9675, -13.5320, [
      ['马丘比丘', '人文', '世界遗产', '约152索尔+火车/巴士（强预约）', '1天', 1],
      ['库斯科武器广场', '人文', '世界遗产', '免费', '2小时', 0],
      ['圣谷（皮萨克集市与梯田）', '自然风光', '-', '联票约70索尔', '1天', 0],
      ['萨克塞瓦曼遗址', '人文', '世界遗产', '联票内', '1-2小时', 0],
    ]],
    ['圣地亚哥', '智利', 'CL', -70.6693, -33.4489, [
      ['圣克里斯托瓦尔山', '拍照打卡', '-', '缆车约4000比索', '半天', 1],
      ['武器广场与大教堂', '人文', '-', '免费', '1-2小时', 0],
      ['天空谷酒庄', '休闲', '-', '品酒约20000比索起', '半天', 0],
    ]],
    ['波哥大', '哥伦比亚', 'CO', -74.0721, 4.7110, [
      ['黄金博物馆', '人文', '-', '约5000比索', '2小时', 1],
      ['蒙塞拉特山', '拍照打卡', '-', '缆车约27000比索往返', '半天', 1],
      ['坎德拉里亚老城区', '逛街', '-', '免费', '2-3小时', 0],
    ]],
    ['麦德林', '哥伦比亚', 'CO', -75.5636, 6.2518, [
      ['康姆纳13区涂鸦与电扶梯', '拍照打卡', '-', '免费（建议跟导览）', '2-3小时', 1],
      ['空中缆车观光线', '拍照打卡', '-', '按乘车费', '1-2小时', 1],
      ['麦德林植物园', '自然风光', '-', '免费', '2小时', 0],
    ]],
    ['卡塔赫纳', '哥伦比亚', 'CO', -75.5144, 10.3910, [
      ['老城墙与老城区', '人文', '世界遗产', '免费', '半天', 1],
      ['圣费利佩城堡', '人文', '世界遗产', '约29000比索', '2小时', 0],
      ['罗萨里奥群岛', '自然风光', '-', '船票约20万比索起', '1天', 1],
    ]],
    ['伊瓜苏', '巴西/阿根廷', 'BR', -54.4393, -25.6953, [
      ['伊瓜苏瀑布（阿根廷侧）', '自然风光', '世界遗产', '约40000阿根廷比索', '1天', 1],
      ['伊瓜苏瀑布（巴西侧）', '自然风光', '世界遗产', '约107雷亚尔', '半天', 1],
      ['鸟园（巴西侧）', '亲子', '-', '约85雷亚尔', '2小时', 0],
    ]],
  ],
};

// v1.3.0 迁移：国际线路一次性入库。settings 标记只写一次——之后管理员删改不复活。
function seedIntlLines() {
  if (getSetting('seed_intl_v1')) return;
  const getCity = db.prepare('SELECT id FROM cities WHERE name=?');
  const insCity = db.prepare('INSERT INTO cities(name,province,adcode,lng,lat,hot,line) VALUES(?,?,?,?,?,?,?)');
  const hasAttr = db.prepare('SELECT id FROM attractions WHERE city_id=? AND name=?');
  const insAttr = db.prepare('INSERT INTO attractions(city_id,name,type,level,ticket,hours,must) VALUES(?,?,?,?,?,?,?)');
  for (const [line, list] of Object.entries(SEED_INTL)) {
    for (const [name, country, iso2, lng, lat, attrs] of list) {
      let c = getCity.get(name);
      if (!c) {
        insCity.run(name, country, iso2, lng, lat, 0, line);
        c = getCity.get(name);
      }
      for (const [an, type, level, ticket, hours, must] of attrs) {
        if (!hasAttr.get(c.id, an)) insAttr.run(c.id, an, type, level, ticket, hours, must);
      }
    }
  }
  setSetting('seed_intl_v1', '1');
}

function seedIfEmpty() {
  const cityCount = db.prepare('SELECT COUNT(*) c FROM cities').get().c;
  if (cityCount === 0) {
    const ins = db.prepare('INSERT INTO cities(name,province,adcode,lng,lat,hot) VALUES(?,?,?,?,?,?)');
    for (const [name, province, adcode, lng, lat, hot] of SEED_CITIES) ins.run(name, province, adcode, lng, lat, hot);
    // v1.10.0：只有全新库才写默认配额。老库升级刻意不写——「未设置」按不限算，
    // 否则一升级所有人（含已在用的普通用户）立刻被 0 次卡死。
    setSetting('quota_default_guide', '3');
    setSetting('quota_default_journal', '3');
  }
  const attrCount = db.prepare('SELECT COUNT(*) c FROM attractions').get().c;
  if (attrCount === 0) {
    const cityId = db.prepare('SELECT id FROM cities WHERE name=?');
    const ins = db.prepare('INSERT INTO attractions(city_id,name,type,level,ticket,hours,must) VALUES(?,?,?,?,?,?,?)');
    for (const [city, list] of Object.entries(SEED_ATTRACTIONS)) {
      const c = cityId.get(city);
      if (!c) continue;
      for (const [name, type, level, ticket, hours, must] of list) ins.run(c.id, name, type, level, ticket, hours, must);
    }
  }
  // 高德 Key 种子：只在 env AMAP_KEY 注入且库内为空时落一次（之后以库内为准）
  if (!getSetting('amap_key') && process.env.AMAP_KEY) setSetting('amap_key', process.env.AMAP_KEY);
}
seedIfEmpty();
seedIntlLines(); // v1.3.0 国际线路（幂等标记，见函数注释）

// ---------- v1.10.1：按线路「拉取旅游城市」 ----------
// 种子清单是唯一的外部来源：国内=SEED_CITIES，国际五线=SEED_INTL[线路]。
// 库里已有的城市一律跳过（**不改动任何现有行**——省份/坐标/线路是管理员可能手改过的）；
// 只补进来的新城市连同它的种子景点一起入库，否则补完还是空壳城市、还得再点一次「一键补全」。
function seedCitiesOf(line) {
  const ln = String(line || '国内').trim() || '国内';
  if (ln === '国内') {
    return SEED_CITIES.map(([name, province, adcode, lng, lat, hot]) =>
      ({ name, province, adcode, lng, lat, hot, attrs: SEED_ATTRACTIONS[name] || [] }));
  }
  return (SEED_INTL[ln] || []).map(([name, country, iso2, lng, lat, attrs]) =>
    ({ name, province: country, adcode: iso2, lng, lat, hot: 0, attrs: attrs || [] }));
}
// 有种子清单的线路（= 能拉取的那些；用户在库里自建的「中线」之类没有种子，拉取会如实回 0）
function seedLines() {
  return ['国内', ...Object.keys(SEED_INTL)];
}
// 各路线的种子城市统计：total=种子里有几座 / have=库里已有几座 / missing=还缺几座（前端按钮显示 +N）
function seedCityStats() {
  const has = db.prepare('SELECT 1 FROM cities WHERE name=?');
  return seedLines().map((ln) => {
    const list = seedCitiesOf(ln);
    const have = list.filter((c) => has.get(c.name)).length;
    return { line: ln, total: list.length, have, missing: list.length - have };
  });
}
// 拉取一条线路：把种子里库中没有的城市补进来（连带种子景点，景点同名跳过）
function pullSeedCities(line) {
  const ln = String(line || '国内').trim() || '国内';
  const list = seedCitiesOf(ln);
  const getCity = db.prepare('SELECT id FROM cities WHERE name=?');
  const insCity = db.prepare('INSERT INTO cities(name,province,adcode,lng,lat,hot,line) VALUES(?,?,?,?,?,?,?)');
  const hasAttr = db.prepare('SELECT id FROM attractions WHERE city_id=? AND name=?');
  const insAttr = db.prepare('INSERT INTO attractions(city_id,name,type,level,ticket,hours,must) VALUES(?,?,?,?,?,?,?)');
  const addedNames = [];
  let attrs = 0;
  for (const c of list) {
    if (getCity.get(c.name)) continue; // 已有 → 跳过，绝不覆盖
    insCity.run(c.name, c.province, c.adcode, c.lng, c.lat, c.hot, ln);
    const row = getCity.get(c.name);
    addedNames.push(c.name);
    for (const [an, type, level, ticket, hours, must] of c.attrs) {
      if (!hasAttr.get(row.id, an)) { insAttr.run(row.id, an, type, level, ticket, hours, must); attrs++; }
    }
  }
  return { line: ln, total: list.length, added: addedNames.length, skipped: list.length - addedNames.length, attrs, added_names: addedNames };
}

module.exports = { db, dataDir, getSetting, setSetting, addCol, sweepInterrupted, pullSeedCities, seedCityStats, seedLines };
