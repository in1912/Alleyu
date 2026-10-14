// 天气：Open-Meteo（免 Key、全球、无需注册）双通道：
//  - forecast：未来 16 天逐日预报（出行日期落在窗口内 → 真实预报 + 规则研判预警）
//  - archive：历史存档（出行日期超出窗口 → 用近 5 年同月份统计做「推演」参考）
// 诚实边界：预警不是气象台官方预警，是对预报数据的规则研判（暴雨/高温/寒潮/大风/降雪），界面与提示词都如实标注。
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

const DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max', 'wind_speed_10m_max'];

// WMO weather code → 中文 + emoji（覆盖常见段）
const CODE_MAP = {
  0: ['晴', '☀️'], 1: ['大致晴', '🌤️'], 2: ['多云', '⛅'], 3: ['阴', '☁️'],
  45: ['雾', '🌫️'], 48: ['雾凇', '🌫️'],
  51: ['毛毛雨', '🌦️'], 53: ['毛毛雨', '🌦️'], 55: ['浓毛毛雨', '🌦️'],
  56: ['冻毛毛雨', '🌧️'], 57: ['冻毛毛雨', '🌧️'],
  61: ['小雨', '🌧️'], 63: ['中雨', '🌧️'], 65: ['大雨', '🌧️'],
  66: ['冻雨', '🌧️'], 67: ['冻雨', '🌧️'],
  71: ['小雪', '🌨️'], 73: ['中雪', '🌨️'], 75: ['大雪', '❄️'], 77: ['雪粒', '🌨️'],
  80: ['阵雨', '🌦️'], 81: ['强阵雨', '🌧️'], 82: ['暴雨', '⛈️'],
  85: ['阵雪', '🌨️'], 86: ['强阵雪', '❄️'],
  95: ['雷暴', '⛈️'], 96: ['雷暴伴冰雹', '⛈️'], 99: ['强雷暴伴冰雹', '⛈️'],
};
function codeText(code) {
  return CODE_MAP[code] || ['未知天气', '🌡️'];
}

async function fetchJson(url, timeoutMs = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`天气接口 HTTP ${res.status}`);
  return res.json();
}

function dailyUrl(base, lat, lng, extra) {
  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lng),
    daily: DAILY.join(','), timezone: 'Asia/Shanghai', ...extra,
  });
  return `${base}?${params}`;
}

function normalizeDaily(j) {
  const d = j.daily || {};
  const out = [];
  for (let i = 0; i < (d.time || []).length; i++) {
    const [text, emoji] = codeText(d.weather_code ? d.weather_code[i] : 0);
    out.push({
      date: d.time[i], text, emoji, code: d.weather_code ? d.weather_code[i] : 0,
      tmax: Math.round(d.temperature_2m_max ? d.temperature_2m_max[i] : 0),
      tmin: Math.round(d.temperature_2m_min ? d.temperature_2m_min[i] : 0),
      rain: d.precipitation_sum ? +(d.precipitation_sum[i] || 0).toFixed(1) : 0,
      rainProb: d.precipitation_probability_max ? Math.round(d.precipitation_probability_max[i] || 0) : null,
      wind: d.wind_speed_10m_max ? Math.round(d.wind_speed_10m_max[i] || 0) : 0,
    });
  }
  return out;
}

// 未来 N 天预报（默认 16，Open-Meteo 上限）
async function forecast(lat, lng, days = 16) {
  const j = await fetchJson(dailyUrl(FORECAST_URL, lat, lng, { forecast_days: String(Math.min(Math.max(days, 1), 16)) }));
  return { source: 'forecast', daily: normalizeDaily(j) };
}

// 历史区间（含端点）
async function archive(lat, lng, startDate, endDate) {
  const j = await fetchJson(dailyUrl(ARCHIVE_URL, lat, lng, { start_date: startDate, end_date: endDate }));
  return { source: 'archive', daily: normalizeDaily(j) };
}

// 规则研判「预警」：对一段逐日数据给出提示清单
function advise(days) {
  const out = [];
  for (const d of days) {
    if (d.code >= 82 || (d.code >= 61 && d.rain >= 25)) out.push({ level: 'warn', date: d.date, text: `${d.date} ${d.text}（日降水 ${d.rain}mm）：雨具必备，山区/户外项目建议留室内备选` });
    else if (d.code >= 65) out.push({ level: 'warn', date: d.date, text: `${d.date} ${d.text}：安排室内或备选路线` });
    if (d.tmax >= 35) out.push({ level: 'warn', date: d.date, text: `${d.date} 高温 ${d.tmax}℃：避开午间暴晒，补水防晒` });
    if (d.tmin <= -5) out.push({ level: 'warn', date: d.date, text: `${d.date} 低温 ${d.tmin}℃：防寒装备、注意路面结冰` });
    if (d.wind >= 40) out.push({ level: 'warn', date: d.date, text: `${d.date} 大风 ${d.wind}km/h：索道/游船/高空项目可能停开` });
    if (d.code >= 71 && d.code <= 86 && d.code !== 80) out.push({ level: 'info', date: d.date, text: `${d.date} ${d.text}：雪天路滑，保暖鞋服` });
  }
  return out;
}

// 近 N 年同月份统计（推演用）：一次拉足年份区间，再按月过滤出“同月样本”。
async function monthStats(lat, lng, month /* 'MM' 或 'YYYY-MM' */, years = 5) {
  const thisYear = new Date().getFullYear();
  const m = String(month).padStart(2, '0').slice(-2);
  try {
    const r = await archive(lat, lng, `${thisYear - years - 1}-${m}-01`, `${thisYear - 1}-${m}-28`);
    const sample = r.daily.filter((d) => d.date.slice(5, 7) === m);
    if (sample.length >= 20) {
      return {
        source: 'archive-month', years, sampleDays: sample.length,
        tmaxAvg: avg(sample.map((d) => d.tmax)), tminAvg: avg(sample.map((d) => d.tmin)),
        rainDays: sample.filter((d) => d.rain >= 1).length,
        extremes: {
          tmaxMax: Math.max(...sample.map((d) => d.tmax)), tminMin: Math.min(...sample.map((d) => d.tmin)),
          rainMax: Math.max(...sample.map((d) => d.rain)),
        },
      };
    }
  } catch (e) {
    return { source: 'archive-none', errors: [e.message] };
  }
  return { source: 'archive-none', errors: ['历史样本不足'] };
}
function avg(arr) { return arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null; }

// 出行上下文：日期在 16 天窗口内 → 真预报；否则 → 同月历史推演
async function buildWeatherContext({ lat, lng, startDate, endDate, month }) {
  const today = new Date();
  const horizon = new Date(today.getTime() + 16 * 86400000);
  if (startDate) {
    const s = new Date(startDate + 'T00:00:00');
    if (!Number.isNaN(s) && s >= new Date(today.toDateString()) && s <= horizon) {
      try {
        const f = await forecast(lat, lng, 16);
        const inRange = f.daily.filter((d) => (!startDate || d.date >= startDate) && (!endDate || d.date <= endDate));
        if (inRange.length) {
          return { mode: 'forecast', daily: inRange, advisories: advise(inRange) };
        }
      } catch (e) {
        return { mode: 'unavailable', reason: e.message };
      }
    }
  }
  if (month) {
    try {
      const stats = await monthStats(lat, lng, month);
      if (stats.source !== 'archive-none') return { mode: 'history', stats };
    } catch (e) {
      return { mode: 'unavailable', reason: e.message };
    }
  }
  return { mode: 'none' };
}

// 给 AI 提示词用的天气文本块
function weatherTextForPrompt(ctx) {
  if (!ctx || ctx.mode === 'none') return '（天气数据暂缺，请按该城市该月份的普遍气候给建议，并提醒用户出行前复核）';
  if (ctx.mode === 'unavailable') return `（天气数据获取失败：${ctx.reason}；请按普遍气候给建议并提醒复核）`;
  if (ctx.mode === 'forecast') {
    const lines = ctx.daily.map((d) => `${d.date} ${d.text} ${d.tmin}~${d.tmax}℃ 降水概率${d.rainProb == null ? '-' : d.rainProb + '%'} 风${d.wind}km/h`);
    const adv = ctx.advisories.map((a) => `- ${a.text}`).join('\n');
    return `以下是该城市出行日期的真实逐日预报（可直接写进「天气提醒」，预警研判也一并列出）：\n${lines.join('\n')}\n规则研判：\n${adv || '- 无特别预警'}`;
  }
  if (ctx.mode === 'history') {
    const s = ctx.stats;
    return `出行日期超出 16 天预报窗口，以下是近 ${s.years} 年同月历史统计（推演参考，须提醒用户临近出行再核实）：\n平均高温 ${s.tmaxAvg}℃ / 平均低温 ${s.tminAvg}℃；降雨日占比约 ${Math.round((s.rainDays / Math.max(s.sampleDays, 1)) * 100)}%（样本 ${s.sampleDays} 天）${s.extremes ? `；历史极值 高 ${s.extremes.tmaxMax}℃ / 低 ${s.extremes.tminMin}℃ / 单日最大降水 ${s.extremes.rainMax}mm` : ''}`;
  }
  return '（天气数据暂缺，按普遍气候给建议并提醒复核）';
}

module.exports = { forecast, archive, advise, monthStats, buildWeatherContext, weatherTextForPrompt, codeText };
