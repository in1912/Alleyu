<template>
  <div>
    <h2 style="margin: 0 0 14px">🌤️ 天气</h2>
    <div class="card">
      <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center">
        <input v-model="q" class="input" style="max-width: 240px" placeholder="城市名，回车查询" @keydown.enter.prevent="load" />
        <button class="btn sm" @click="load">查询</button>
        <span class="seg" style="margin-left: 8px">
          <span class="opt" :class="{ on: mode === 'forecast' }" @click="mode = 'forecast'">未来 16 天预报</span>
          <span class="opt" :class="{ on: mode === 'history' }" @click="mode = 'history'">历史推演</span>
        </span>
        <select v-if="mode === 'history'" v-model="month" class="input" style="max-width: 120px">
          <option v-for="m in 12" :key="m" :value="String(m)">{{ m }}月</option>
        </select>
      </div>
      <p v-if="err" class="err-text">{{ err }}</p>
    </div>

    <div v-if="data && data.mode === 'forecast'" class="card" style="margin-top: 14px">
      <h3 style="margin: 0 0 4px">{{ data.city }} · 逐日预报</h3>
      <p class="hint">来源 Open-Meteo；「研判」为对预报数据的规则提示，非气象台官方预警</p>
      <table class="tb">
        <thead><tr><th>日期</th><th>天气</th><th>气温</th><th>降水概率</th><th>风速</th></tr></thead>
        <tbody>
          <tr v-for="d in data.daily" :key="d.date">
            <td>{{ d.date }}</td>
            <td>{{ d.emoji }} {{ d.text }}</td>
            <td>{{ d.tmin }} ~ {{ d.tmax }}℃</td>
            <td>{{ d.rainProb == null ? '-' : d.rainProb + '%' }}</td>
            <td>{{ d.wind }} km/h</td>
          </tr>
        </tbody>
      </table>
      <div v-if="data.advisories && data.advisories.length" style="margin-top: 12px">
        <b style="color: var(--warn)">⚠️ 天气研判</b>
        <ul><li v-for="(a, i) in data.advisories" :key="i" style="font-size: 13.5px">{{ a.text }}</li></ul>
      </div>
    </div>

    <div v-if="data && data.mode === 'history' && data.stats && data.stats.source === 'archive-month'" class="card" style="margin-top: 14px">
      <h3 style="margin: 0 0 4px">{{ data.city }} · {{ month }}月历史推演</h3>
      <p class="hint">近 {{ data.stats.years }} 年同月统计（样本 {{ data.stats.sampleDays }} 天），临近出行请再看实时预报</p>
      <div class="grid3" style="margin-top: 10px">
        <div class="stat"><b>{{ data.stats.tminAvg }} ~ {{ data.stats.tmaxAvg }}℃</b><span>平均气温</span></div>
        <div class="stat"><b>{{ Math.round((data.stats.rainDays / Math.max(data.stats.sampleDays, 1)) * 100) }}%</b><span>降雨日占比（≥1mm）</span></div>
        <div class="stat"><b>{{ data.stats.extremes.tminMin }} / {{ data.stats.extremes.tmaxMax }}℃</b><span>历史极值 低/高</span></div>
        <div class="stat"><b>{{ data.stats.extremes.rainMax }}mm</b><span>单日最大降水</span></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { api } from '../api/index.js';

const q = ref('');
const mode = ref('forecast');
const month = ref(String(new Date().getMonth() + 1));
const data = ref(null);
const err = ref('');

async function load() {
  err.value = '';
  data.value = null;
  if (!q.value.trim()) { err.value = '请输入城市名'; return; }
  try {
    data.value = await api(`/weather?q=${encodeURIComponent(q.value.trim())}&mode=${mode.value}&month=${month.value}`);
  } catch (e) {
    err.value = e.message;
  }
}
</script>

<style scoped>
.stat { background: var(--card2); border-radius: 10px; padding: 14px; text-align: center; }
.stat b { display: block; font-size: 18px; color: var(--acc-d); }
.stat span { font-size: 12px; color: var(--mut); }
</style>
