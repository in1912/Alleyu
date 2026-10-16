<template>
  <div class="share-page">
    <!-- 顶部工具条（不打印） -->
    <div class="share-top no-print">
      <b>🌍 游巷 · 攻略分享</b>
      <span v-if="sh" class="badge" :class="sh.mode === 'dynamic' ? 'blue' : 'gray'">
        {{ sh.mode === 'dynamic' ? '动态更新' : '静态快照' }}
      </span>
      <span v-if="sh" class="hint">更新于 {{ sh.updated_at }}</span>
      <span style="flex: 1"></span>
      <button v-if="sh" class="btn ghost sm" @click="copy">复制全文</button>
      <button v-if="sh" class="btn sm" :disabled="pdfBusy" @click="pdf">{{ pdfBusy ? '生成中…' : '导出 PDF' }}</button>
    </div>

    <div v-if="err" class="card" style="max-width: 640px; margin: 60px auto; text-align: center">
      <p class="err-text" style="font-size: 15px">❌ {{ err }}</p>
      <p class="hint">链接可能已过期或被作者撤销</p>
    </div>

    <template v-if="sh">
      <div class="card md share-body">
        <div class="share-titlebox">
          <h1>{{ sh.title }}</h1>
        </div>
        <div v-html="html"></div>
      </div>
      <p class="hint no-print" style="text-align: center; margin: 14px 0 0">
        {{ sh.mode === 'dynamic' ? '此链接为动态分享：作者更新攻略后这里自动跟随。' : '此链接为静态快照：内容冻结在作者最近一次刷新快照之时。' }}
      </p>
    </template>
  </div>
</template>

<script setup>
// 公开分享页（免登录）：#/s/<token> → GET /api/share/:token（服务端 EXEMPT，只回标题/模式/正文/更新时间）
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import { api, downloadPdfFile } from '../api/index.js';
import { cleanMd } from '../md.js';
import { copyText } from '../clipboard.js';

const route = useRoute();
const sh = ref(null);
const err = ref('');

marked.setOptions({ breaks: true, gfm: true });
const html = computed(() => marked.parse(cleanMd(sh.value?.content || '')));

// 导出 PDF（v1.6.1）：公开端点生成文件直接下载（免登录同分享页本身）；
// 服务器没中文字体回 NO_FONT → 问一句回落浏览器打印
const pdfBusy = ref(false);
async function pdf() {
  if (pdfBusy.value) return;
  pdfBusy.value = true;
  try {
    await downloadPdfFile('/api/share/' + route.params.token + '/pdf', (sh.value?.title || '攻略') + '.pdf');
  } catch (e) {
    if (e.code === 'NO_FONT') {
      if (confirm(e.message + '\n\n点「确定」改用浏览器打印导出（打印对话框里选「另存为 PDF」）。')) {
        const t = document.title;
        document.title = (sh.value?.title || '攻略') + ' - 游巷';
        window.print();
        document.title = t;
      }
    } else alert(e.message);
  } finally {
    pdfBusy.value = false;
  }
}
function copy() {
  // v1.10.2：分享页多半是裸 HTTP 打开的，navigator.clipboard 不存在——统一走 copyText（内置回落）
  copyText(cleanMd(sh.value?.content || '')).then(
    () => alert('已复制全文'),
    (e) => alert(e.message),
  );
}

(async () => {
  try {
    const j = await api('/share/' + route.params.token);
    sh.value = j;
    document.title = (j.title || '攻略') + ' - 游巷分享';
  } catch (e) {
    err.value = e.message;
  }
})();
</script>

<style scoped>
.share-page { max-width: 900px; margin: 0 auto; padding: 18px 4px 60px; }
.share-top {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 4px; margin-bottom: 12px; border-bottom: 1px solid var(--line);
}
.share-top b { color: var(--acc-d); letter-spacing: 1px; }
/* 标题进卡片顶部（打印时标题随正文一起印出来，不标 no-print） */
.share-titlebox h1 { margin: 0 0 6px; font-size: 24px; color: var(--acc-d); }
</style>
