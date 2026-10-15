// AI 通道：OpenAI 兼容 /chat/completions（流式）。
// v1.6.0 起只有管理员全局一份 Key（用户拍板「只保留管理员设置的 apikey」）——
// 个人配置曾与全局分叉出「同 Key 不同命」的排查成本（丢 sk- 前缀肉眼不可见），砍掉。
// 密钥 AES-GCM 落库；任何接口不回明文，只回 has_key 布尔。
const { getSetting } = require('../db');
const { encrypt, decrypt } = require('../crypto');

function globalConfig() {
  const baseUrl = getSetting('ai_base_url');
  const model = getSetting('ai_model');
  const key = decrypt(getSetting('ai_key') || '');
  if (baseUrl && model && key) return { source: 'global', baseUrl, model, key };
  return null;
}

// 解析当前可用的 AI 配置：全局配置；没有 → null。
// ALLEYU_AI_FORCE_STUB=1 是「测试确定性」开关：无视一切已配 Key 强制走桩。
// 起因 v1.5.0：本机 data/ 存着用户真 Key，ALLEYU_AI_STUB=1 兜底语义拦不住它，
// render 自检的「现场生成」一直在打真实 DeepSeek——首字 20s+、偶发空流，断言随机红。
function resolveConfig() {
  if (process.env.ALLEYU_AI_FORCE_STUB === '1') return { source: 'stub', baseUrl: '', model: 'stub', key: '' };
  return globalConfig() || null;
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
      let hint = '';
      // 实测坑（v1.6.0 用户报障）：Key 粘贴丢了 sk- 前缀只剩 32 位十六进制，
      // 服务商报错又把 Key 掩码成 ****xxxx，肉眼看不出和好 Key 的差别——这里点名说出来。
      if (res.status === 401 && cfg.key && /^[0-9a-f]{32}$/i.test(cfg.key.trim())) {
        hint = '；当前 Key 是 32 位十六进制（无 sk- 前缀）——像是粘贴时丢了开头，请重新完整复制';
      }
      throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}（检查地址/Key/模型名是否匹配该服务商）${hint}`);
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
async function* streamChat(cfg, messages, { maxTokens = 8000, temperature = 0.5, onUsage } = {}) {
  if (!cfg || cfg.source === 'stub') {
    yield* stubStream(messages);
    return;
  }
  const url = chatUrl(cfg.baseUrl);
  // thinking:{type:'disabled'}：deepseek-flash 等推理模型会把 max_tokens 全部吃进思考链
  // （实测 200/200 reasoning_tokens、finish=length、content 恒空——「空内容/北京 652 字」的根因），
  // 攻略是纯写作任务不需要思考链，显式关掉。绝大多数 OpenAI 兼容网关忽略未知字段。
  // stream_options.include_usage：让服务商在最后一拍回 usage（v1.10.0 起用于累计 token 记账）。
  // 不支持的网关会忽略该字段 —— 那就没有 usage，记账就什么都不写（见 usageService 的诚实边界）。
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model, messages, max_tokens: maxTokens, temperature, stream: true,
      thinking: { type: 'disabled' }, stream_options: { include_usage: true },
    }),
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
        // usage 通常单独成一拍（choices 为空）。回调只报数，绝不把 usage 当正文。
        if (j.usage && typeof onUsage === 'function') onUsage(j.usage);
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
1.大交通：高铁抵达主站，返程建议错开周日下午高峰；机场进城选轨道交通最稳。
2.当地内部交通：市区以地铁+步行为主，${spot(day1, 0)}到${spot(day1, 1)}约 30 分钟；打车避开早晚高峰。
3.省钱交通小技巧：地铁一日票比单程划算，景区直通车提前在线购票有折扣。

## 三、住宿建议
1.推荐住宿片区：老城地铁沿线（交通便利，适合首次到访）；滨江区（环境安静，适合亲子）。
2.避坑片区：车站周边拉客旅馆、无证民宿。
3.选房小贴士：行程以${spot(day1, 0)}为核心就住老城；旺季提前 2 周预订，看退改政策再下单。

## 四、每日详细行程（Day1-Day 3）
### Day 1｜老城开场
-上午：${spot(day1, 0)}｜2小时｜需预约｜看点：标志景观与历史脉络，建议开园即入避开人流
-午餐：美食街区，本地面食与小炒人均 40 元
-下午：${spot(day1, 1)}｜3小时｜门票60｜看点：核心展区慢慢看，出口处纪念品比外面贵
-晚餐：本地特色美食推荐，老字号排队 20 分钟起
-晚上：夜景，江边步道免费开放
-✅当日小贴士：走路约1万步、提前预约、雨天备选方案为室内展馆

### Day 2｜山水与人文
-上午：${spot(day2, 0)}｜半天｜免费｜看点：清晨光线最好，带水和防晒
-午餐：景区周边简餐，人均 35 元
-下午：${spot(day2, 1)}｜2小时｜门票45｜看点：精华在后半程，别在门口拍太久
-晚上：夜市，小吃人均 50 元吃到扶墙
-✅当日小贴士：两景点间有接驳车，别走路硬扛

### Day 3｜收尾与返程
-上午：${spot(day3, 0)}｜2小时｜看点：收尾轻量逛，行李可寄存前台
-午餐：车站附近连锁快餐，稳妥不踩雷
-下午：返程，预留 1 小时余量取票安检

## 五、美食清单
必吃本地菜：招牌炖菜、时令河鲜、手工点心；特色小吃集中在老城夜市，推荐傍晚五点前到，晚了好吃的都卖完；早市豆浆油条配本地粥品，人均 10 元管饱；避雷景区门口「网红店」与「老字号分店」；肠胃敏感者生冷慎入口，麻辣按微辣起点。

## 六、门票&预约提醒
热门景点（含${spot(day1, 0)}）需提前 1-3 天在官方公众号预约；学生证、老年证半价；博物馆周一闭馆，别白跑。

## 七、行前准备清单
证件：身份证、学生证；衣物：按天气表备外套与雨具；手机APP：地图、打车、景区官方号；必备：充电宝、常用药、防晒。

## 八、避坑&安全贴士
常见套路：黑车喊价（上车前先问计价器）、景区周边「低价一日游」强制购物、扫码送礼品索要个人信息；出行安全：夜间避开无灯河堤与在建路段，贵重物品前背；本地习俗：排队文化严格，插队会被当场制止，公共交通轻声交谈。

## 九、可选拓展（自由加1-2个备选点位）
时间多可以去远郊古镇（往返+4小时）；时间紧张可砍掉 Day 3 上午，直接返程。`;
}
async function* stubStream(messages) {
  const text = stubGuideText(messages);
  const lines = text.split('\n');
  // 25ms/行 ≈ 2.3s 吐完：跨过 guideService 的 600ms 节流落库窗，SSE 才有真 delta
  // 直播事件可测（5ms/行整段落在首个节流窗内，直播流只会看到一次 reset 全文）。
  for (const line of lines) {
    yield line + '\n';
    await new Promise((r) => setTimeout(r, 25));
  }
}

module.exports = { resolveConfig, globalConfig, chatUrl, testConnection, streamChat, encrypt };
