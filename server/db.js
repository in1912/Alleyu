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
`;
db.exec(DDL);

// ---------- 幂等加列（以后版本新增列只改这里） ----------
function addCol(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
// 示例：addCol('guides', 'shared', 'INTEGER NOT NULL DEFAULT 0');

// ---------- settings 读写 ----------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : '';
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value ?? ''));
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

function seedIfEmpty() {
  const cityCount = db.prepare('SELECT COUNT(*) c FROM cities').get().c;
  if (cityCount === 0) {
    const ins = db.prepare('INSERT INTO cities(name,province,adcode,lng,lat,hot) VALUES(?,?,?,?,?,?)');
    for (const [name, province, adcode, lng, lat, hot] of SEED_CITIES) ins.run(name, province, adcode, lng, lat, hot);
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
  // 高德 Key 种子：env 注入优先，否则用随项目交付的默认 key（管理员可在设置里换）
  if (!getSetting('amap_key')) setSetting('amap_key', process.env.AMAP_KEY || 'REMOVED-PRIVATE-AMAP-KEY');
}
seedIfEmpty();

module.exports = { db, getSetting, setSetting, addCol };
