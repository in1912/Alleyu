// v1.8.0 游记整理：问答式游记的提示词、AI 调用（体验配文/标题/正文）与生成管线。
// 与 guideService 同一套习惯：AI 走 aiService（全局唯一 Key，未配走桩）、内容写库 +
// SSE 轮询推增量、阶段写 stage 列、过短自动重试。游记是「事后记录」，攻略是「事前计划」，
// 提示词风格完全不同——重体验与叙事、轻攻略框架；合并模式才把攻略数据带进来。
const { db } = require('../db');
const ai = require('./aiService');

// ---------- 副标题（基础信息一行字：目的地·N天·人数·季节·出行方式） ----------
function buildSubtitle(j) {
  const m = j.meta_json ? JSON.parse(j.meta_json) : {};
  const parts = [j.destination || m.destination || '旅行记录'];
  if (m.days) parts.push(m.days + '天');
  if (m.people) parts.push(m.people);
  if (m.season) parts.push(m.season);
  if (m.transport) parts.push(m.transport);
  return parts.filter(Boolean).join(' · ');
}

// ---------- 生成正文的消息 ----------
function buildMessages(j, photos, mergeGuide) {
  const m = j.meta_json ? JSON.parse(j.meta_json) : {};
  const spots = j.spots_json ? JSON.parse(j.spots_json) : [];
  const lines = [];
  lines.push(`目的地：${j.destination || m.destination || '（未填）'}`);
  if (m.origin) lines.push(`出发地：${m.origin}`);
  if (m.days) lines.push(`天数：${m.days} 天`);
  if (m.people) lines.push(`人数：${m.people}`);
  if (m.transport) lines.push(`出发交通方式：${m.transport}`);
  if (m.local_transport) lines.push(`目的地出行方式：${m.local_transport}`);
  if (m.prefs && m.prefs.length) lines.push(`旅行偏好：${m.prefs.join('、')}`);
  if (m.budget) lines.push(`总费用：${m.budget}`);
  if (m.hotel) lines.push(`住宿档次：${m.hotel}`);
  if (m.season) lines.push(`季节：${m.season}`);
  if (spots.length) lines.push(`所到景点：${spots.map((s) => s.name).join('、')}`);
  if (photos.length) {
    lines.push('照片与体验说明（按景点分组，写作时把对应照片的体验自然融进该景点的段落）：');
    for (const p of photos) {
      lines.push(`- [${p.spot || '行程'}] 图${p.sort}：${p.caption || '（无说明）'}`);
    }
  }
  const system = '你是一位擅长写旅行游记的作者，文风真实自然、有画面感，避免空洞抒情和流水账。'
    + '用中文写作，输出 Markdown。'
    + (mergeGuide
      ? '用户选择合并攻略：把下方「实用攻略要点」的实用信息（交通/住宿/美食/门票）有机融进游记相应段落，并在文末加一节「## 附：实用攻略速查」用列表浓缩这些要点，方便读者带走。'
      : '用户选择纯旅行记录：只写所见所感，不要输出攻略式的交通/住宿/门票建议段落。');
  const user = `请根据以下素材写一篇完整的旅行游记：\n${lines.join('\n')}\n\n`
    + '结构要求：\n'
    + '1. 开头：一小段引入（为什么出发/总体印象），不要用「## 前言」这种标题，直接写。\n'
    + '2. 主体：按时间或景点顺序分节，每节用「## 景点名/主题」标题；提到的照片体验自然融入对应段落，配图位置用 Markdown 图片语法 `![体验说明](photo:<照片序号>)` 占位（前端会替换成真实照片）。\n'
    + '3. 结尾：一节「## 后记」收束感受，可以给想去的人一两句实在的话。\n'
    + '4. 全文 1200 字以上；门票价格、排队时间这类实用细节如实写（用户素材里有就用，没有不编造）。'
    + (mergeGuide ? '\n5. 实用攻略要点（来自用户的历史攻略）：\n' + mergeGuide.slice(0, 6000) : '');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ---------- 体验配文（单图）：~30 字文学润色 / 参考用户草稿不限字数 ----------
function captionMessages(spot, userText) {
  const sys = '你是旅行随笔作者，为游记照片写一句体验说明，文学润色但不做作，中文输出。';
  const user = userText
    ? `景点：${spot || '旅途中'}\n用户已写了一版：${userText}\n请参考用户文字与所在景点，重新润色成更完整的体验说明，不限字数，只输出这段说明本身。`
    : `景点：${spot || '旅途中'}\n请为这张在「${spot || '旅途中'}」拍的照片写一句体验说明，30 字左右，有画面感，只输出这句话本身。`;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

// ---------- 标题：≤20 字、文学性、压在封面图上 ----------
function titleMessages(j) {
  const m = j.meta_json ? JSON.parse(j.meta_json) : {};
  const bits = [j.destination, m.season, m.prefs && m.prefs[0], m.days && m.days + '天'].filter(Boolean).join('、');
  return [
    { role: 'system', content: '你是旅行杂志的标题作者。中文输出，只输出标题本身，不要书名号、不要引号、不要解释。' },
    { role: 'user', content: `为游记起一个标题，不超过 20 个字，要有文学性（比喻/意象/留白都行），不要流水账式拼接地名。参考信息：${bits || j.destination || '一次旅行'}。` },
  ];
}

// ---------- 桩（无 Key / FORCE_STUB 时的确定性输出，check/render 靠它） ----------
function stubJournalText(messages) {
  const user = messages.find((x) => x.role === 'user') || {};
  const c = user.content || '';
  const dest = (c.match(/目的地：(.+)/) || [])[1] || '远方';
  const spots = ((c.match(/所到景点：(.+)/) || [])[1] || '').split('、').filter(Boolean);
  const s1 = spots[0] || '老街';
  const s2 = spots[1] || '湖边';
  const pics = [...c.matchAll(/- \[([^\]]*)\] 图(\d+)：([^\n]*)/g)].map((mm) => ({ spot: mm[1], n: mm[2], cap: mm[3] }));
  const photoMd = pics.length
    ? pics.map((p) => `![${p.cap}](photo:${p.n})`).join('\n\n')
    : '';
  return `<!-- alleyu:stub 本篇为本地桩输出（无 Key 环境的测试与演示），非真实游记 -->

到${dest}的第一天，风比想象里软。${s1}的人不多，光从檐角斜下来，落在石板路上像旧照片。我们到得早，店铺一半还没开门，老板娘在门口摆弄一盆茉莉，见了人就笑。行李箱的轮子在石板上响，惊起两只麻雀，这就算正式抵达了。同行的伙伴一开始还在惦记工作消息，到了下午也终于把手机扣在桌上，开始认真研究地图上那些念不出名字的小巷——旅行的开关，从来不是出发，而是肯把日常放下的那一刻。

## ${s1}

${s1}值得慢慢走。我们停在一个小摊前，摊主阿姨话不多，东西却实在。${pics[0] ? '这张照片就是那时候拍的——' + (pics[0].cap || '值得记下的一刻') : '举起手机拍了一张，回来翻看，那束光还在。'}后来在长椅上坐了很久，看人来人往，谁也不赶时间。旅行最好的部分，大概就是理直气壮地无所事事。

${photoMd}

## ${s2}

第二天去了${s2}。${s2}和${s1}是两种性格：一个热闹在明处，一个安静在深处。坐下来什么都不做的半小时，是这趟旅行里最奢侈的。风把水面吹皱又抚平，像有人在耐心地熨一件旧衬衫。我们没按攻略走，跟着一条巷子越走越深，最后在一家没有招牌的小店里吃了碗当地的面——好不好吃其实记不清了，只记得老板添汤时手很稳。

## 后记

${dest}这趟，最大的收获不是打卡了多少地方，而是终于把日子过成了「可以慢下来」的样子。想去的话，挑一个淡季的工作日，人少，风也刚好。带回的东西不多：几张票根、一包茶叶、还有手机里那几张舍不得删的照片。回来之后偶尔翻出来看看，还是会有「那就再走一趟吧」的念头——大概这就是一次好旅行的后遗症。`;
}
function stubCaption(spot, userText) {
  return userText ? `[润色] ${userText}（${spot || '旅途中'}的风把这行字吹得更轻了）` : `${spot || '旅途'}的这一刻，光与风都刚好。`;
}
function stubTitle(j) {
  const m = j.meta_json ? JSON.parse(j.meta_json) : {};
  const w = { 春: '风起', 夏: '蝉鸣', 秋: '叶落', 冬: '落雪' }[(m.season || '')[0]] || '拾光';
  return `${w}·${j.destination || '旅途'}慢记`;
}

// ---------- AI 小调用（配文/标题）：收齐流再回，短文本不值得落库直播 ----------
async function aiText(messages, maxTokens = 300) {
  const cfg = ai.resolveConfig();
  if (!cfg || cfg.source === 'stub') return null; // 桩由调用方处理（要知道上下文）
  let out = '';
  for await (const delta of ai.streamChat(cfg, messages, { maxTokens, temperature: 0.8 })) out += delta;
  return out.trim();
}

// ---------- 生成管线（与 guideService.run 同构：写库 + 节流 + 过短重试 + 阶段） ----------
const WRITE_THROTTLE_MS = 600;
function setStage(id, stage) {
  db.prepare("UPDATE journals SET stage=?, updated_at=datetime('now','localtime') WHERE id=?").run(stage, id);
}

async function run(journalId) {
  const j0 = db.prepare('SELECT * FROM journals WHERE id=?').get(journalId);
  if (!j0) return;
  db.prepare("UPDATE journals SET status='pending', content='', error='', stage='write', model='', updated_at=datetime('now','localtime') WHERE id=?").run(journalId);
  try {
    const photos = db.prepare('SELECT * FROM journal_photos WHERE journal_id=? ORDER BY sort, id').all(journalId);
    let mergeGuide = null;
    if (j0.merge_guide_id) {
      const g = db.prepare('SELECT title, content FROM guides WHERE id=? AND user_id=?').get(j0.merge_guide_id, j0.user_id);
      if (g) mergeGuide = `《${g.title || g.destination}》：${g.content}`;
    }
    const messages = buildMessages(j0, photos, mergeGuide);
    db.prepare('UPDATE journals SET prompt=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
      .run(JSON.stringify(messages, null, 2), journalId);

    const cfg = ai.resolveConfig();
    const minChars = 600; // 游记比攻略轻，600 字起判
    let content = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      let acc = '';
      let lastFlush = 0;
      const gen = (!cfg || cfg.source === 'stub')
        ? stubJournalStream(messages)
        : ai.streamChat(cfg, messages, { maxTokens: 8000, temperature: 0.7 });
      for await (const delta of gen) {
        acc += delta;
        if (Date.now() - lastFlush > WRITE_THROTTLE_MS) {
          lastFlush = Date.now();
          db.prepare("UPDATE journals SET content=?, updated_at=datetime('now','localtime') WHERE id=?").run(acc, journalId);
        }
      }
      if (acc.trim().length >= minChars) { content = acc; break; }
      if (attempt < 3) setStage(journalId, `retry${attempt}`);
    }
    if (!content) throw new Error(`生成内容过短（3 次尝试均不足 ${minChars} 字），请点重新生成`);

    // 标题：AI ≤20 字（已有用户手填标题则不覆盖）
    if (!j0.title) {
      setStage(journalId, 'title');
      let t = '';
      if (cfg && cfg.source !== 'stub') {
        try { t = await aiText(titleMessages(j0), 120); } catch { /* 标题失败不拦正文 */ }
      }
      if (!t) t = stubTitle(j0);
      t = t.replace(/["「」《》\s]/g, '').slice(0, 20);
      db.prepare("UPDATE journals SET title=? WHERE id=?").run(t || '旅行游记', journalId);
    }
    // 副标题 + 默认封面（未选图随机挑一张）
    const subtitle = buildSubtitle({ ...j0, destination: j0.destination });
    let coverId = j0.cover_photo_id;
    if (!coverId && photos.length) {
      coverId = photos[Math.floor(Math.random() * photos.length)].id;
      db.prepare('UPDATE journals SET cover_photo_id=? WHERE id=?').run(coverId, journalId);
    }
    db.prepare("UPDATE journals SET content=?, subtitle=?, status='done', stage='', model=?, updated_at=datetime('now','localtime') WHERE id=?")
      .run(content, subtitle, cfg && cfg.model || 'stub', journalId);
  } catch (e) {
    db.prepare("UPDATE journals SET status='error', error=?, stage='', updated_at=datetime('now','localtime') WHERE id=?").run(e.message, journalId);
  }
}

async function* stubJournalStream(messages) {
  const lines = stubJournalText(messages).split('\n');
  for (const line of lines) {
    yield line + '\n';
    await new Promise((r) => setTimeout(r, 25)); // 同 guideService 桩节奏：跨过 600ms 节流窗
  }
}

// 导出 run（fire-and-forget 由路由触发）
module.exports = { run, buildMessages, buildSubtitle, captionMessages, titleMessages, stubJournalText, stubCaption, stubTitle, aiText };
