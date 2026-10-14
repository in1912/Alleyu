// AI 通道：OpenAI 兼容 /chat/completions（流式）。
// Key 解析优先级（用户需求）：个人 Key（自己配置的）> 管理员总配置的 Key；两边都没配 → 明确报错。
// 密钥 AES-GCM 落库；任何接口不回明文，只回 has_key 布尔。
const { db, getSetting } = require('../db');
const { encrypt, decrypt } = require('../crypto');

function personalConfig(userId) {
  const u = db.prepare('SELECT ai_base_url, ai_model, ai_key FROM users WHERE id=?').get(userId);
  if (!u) return null;
  const key = decrypt(u.ai_key || '');
  if (u.ai_base_url && u.ai_model && key) {
    return { source: 'personal', baseUrl: u.ai_base_url, model: u.ai_model, key };
  }
  return null;
}

function globalConfig() {
  const baseUrl = getSetting('ai_base_url');
  const model = getSetting('ai_model');
  const key = decrypt(getSetting('ai_key') || '');
  if (baseUrl && model && key) return { source: 'global', baseUrl, model, key };
  return null;
}

// 解析当前用户可用的 AI 配置：personal 优先；都不完整 → null
function resolveConfig(userId) {
  return personalConfig(userId) || globalConfig() || null;
}

// 接口地址归一：只填域名/IP:端口 → 自动补 /v1/chat/completions；带路径的智能拼接。
// （工作台 v1.9.32 同款教训：裸 base 直接拼 /chat/completions 在多数网关上 404）
function chatUrl(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  if (/(^|\/)chat\/completions$/.test(b)) return b;
  const u = new URL(b);
  const hasPath = u.pathname && u.pathname !== '/';
  return b + (hasPath ? '' : '/v1') + '/chat/completions';
}

// 连通测试：GET {base}/models（带 Key）。多数兼容网关都实现。
async function testConnection(cfg) {
  const base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未填写接口地址');
  const b = /^https?:\/\//i.test(base) ? base : 'https://' + base;
  const modelsUrl = /(\/v1|\/api)$/.test(b) ? b + '/models' : b + '/v1/models';
  try {
    const res = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}（检查地址/Key/模型名是否匹配该服务商）`);
    }
    const j = await res.json().catch(() => ({}));
    const models = Array.isArray(j.data) ? j.data.map((m) => m.id || '').filter(Boolean) : [];
    return { ok: true, models: models.slice(0, 50) };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('连接超时（10s）——地址不可达或网络受限');
    throw e;
  }
}

// 流式对话：async generator，逐段 yield 文本增量。
// ALLEYU_AI_STUB=1 是「无 Key 环境的兜底」而非强制覆盖：只要解析出了真实配置
// （个人或全局），一律走真接口——否则用户配了 Key 仍出桩文案，纯属坑人。
async function* streamChat(cfg, messages, { maxTokens = 8000, temperature = 0.5 } = {}) {
  if (!cfg || cfg.source === 'stub') {
    yield* stubStream(messages);
    return;
  }
  const url = chatUrl(cfg.baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens, temperature, stream: true }),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI 接口错误 HTTP ${res.status}：${text.slice(0, 300) || '（无更多信息）'}`);
  }
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (delta) yield delta;
      } catch { /* SSE 半行/心跳行，忽略 */ }
    }
  }
}

// ---- 本地桩 ----
function stubGuideText(messages) {
  const sys = messages.find((m) => m.role === 'system') || {};
  const user = messages.find((m) => m.role === 'user') || {};
  const mentioned = (k) => (user.content && user.content.includes(k)) ? k : '';
  // 把「必去景点：A、B」解析出来撒进日程，让图文增强链路（定位/路线图/照片）在桩下也可验
  const m = user.content && user.content.match(/必去景点：(.+)/);
  const pois = m ? m[1].trim().split(/[、,，]/).filter((s) => s && s !== '由你推荐') : [];
  const day1 = pois.slice(0, 2), day2 = pois.slice(2, 4), day3 = pois.slice(4, 6);
  const spot = (arr, i) => (arr[i] || '城市地标广场');
  return `# 【目的地】3日游完整攻略（AI 桩输出）

<!-- alleyu:stub 本篇为 ALLEYU_AI_STUB 本地桩输出（无 Key 环境的测试与演示），非真实攻略 -->

## 一、旅行总览
1.旅行主题：${mentioned('出行人群') || '休闲'}慢游
2.最佳出行月份、天气提醒：见下方天气表（桩）
3.总预算参考（拆分：交通、住宿、吃饭、门票、其他）：舒适档
4.路线逻辑说明（不走回头路原则）：Day1 城西 → Day2 城中 → Day3 城东

## 二、交通指南
1.大交通：抵达站点、往返建议
2.当地内部交通：地铁/公交/打车/自驾要点，景点之间车程、耗时
3.省钱交通小技巧

## 三、住宿建议
1.推荐住宿片区（优势+适合人群）
2.避坑片区
3.选房小贴士、预订时机

## 四、每日详细行程（Day1-Day 3）
### Day 1｜老城开场
-上午：${spot(day1, 0)}｜2小时｜需预约｜看点提示
-午餐：美食街区
-下午：${spot(day1, 1)}｜3小时｜门票60｜看点提示
-晚餐：本地特色美食推荐
-晚上：夜景
-✅当日小贴士：走路约1万步、提前预约、雨天备选方案

### Day 2｜山水与人文
-上午：${spot(day2, 0)}｜半天｜免费｜看点提示
-下午：${spot(day2, 1)}｜2小时｜门票45
-晚上：夜市

### Day 3｜收尾与返程
-上午：${spot(day3, 0)}｜2小时
-下午：返程

## 五、美食清单
必吃本地菜、特色小吃；推荐区域；避雷餐饮；饮食注意

## 六、门票&预约提醒
哪些景点必须提前预约；购票渠道；优惠证件；闭馆时间

## 七、行前准备清单
证件、衣物、随身物品；手机APP；必备工具

## 八、避坑&安全贴士
常见套路、消费坑；出行安全；本地习俗提醒

## 九、可选拓展（自由加1-2个备选点位）
时间多可以去哪里；时间紧张可以砍掉哪些景点`;
}
async function* stubStream(messages) {
  const text = stubGuideText(messages);
  const lines = text.split('\n');
  for (const line of lines) {
    yield line + '\n';
    await new Promise((r) => setTimeout(r, 5));
  }
}

module.exports = { resolveConfig, personalConfig, globalConfig, chatUrl, testConnection, streamChat, encrypt };
