// 展示前清洗 markdown（GuideView / ShareView 共用）：
// ①去掉桩模式横幅（老数据存过整行提示）②去掉内部桩标记（披露交给生成来源页脚，不进正文）
// ③正文从第一个 markdown 标题起（框架标题之前的 AI 客套不显示）
export function cleanMd(raw) {
  let t = String(raw || '');
  t = t.replace(/^>?\s*⚠?️?\s*这是\s*ALLEYU_AI_STUB=1\s*的本地桩输出[^\n]*\n?/gm, '');
  t = t.replace(/<!--\s*alleyu:stub[^\n]*?-->\n?/g, '');
  const lines = t.split('\n');
  const isHeading = (s) => /^#{1,6}\s/.test(s);
  if (lines.length && !isHeading(lines[0])) {
    const hi = lines.findIndex(isHeading);
    if (hi > 0) t = lines.slice(hi).join('\n');
  }
  return t;
}
