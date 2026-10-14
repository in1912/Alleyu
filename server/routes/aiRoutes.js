// AI 配置：v1.6.0 起只有全局一份（admin 配置，Key 只写不读——接口只回 has_key）。
// 个人配置已删（用户拍板「只保留管理员设置的 apikey」）：砍掉个人/全局分叉的排查成本。
const express = require('express');
const { getSetting, setSetting } = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { globalConfig, testConnection } = require('../services/aiService');

const r = express.Router();

// 当前用户视角的可用状态（用于界面提示）
r.get('/status', (req, res) => {
  const g = globalConfig();
  res.json({
    can_use_ai: req.user.role === 'admin' || !!req.user.can_use_ai,
    effective_source: g ? 'global' : 'none',
  });
});

// ---- 全局配置（admin）----
r.get('/global', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  res.json({
    base_url: getSetting('ai_base_url') || '', model: getSetting('ai_model') || '',
    has_key: !!decrypt(getSetting('ai_key') || ''),
  });
});

// Key 归一化：去全部空白（不只是首尾——剪贴板带换行的粘贴 trim 救不了）
const cleanKey = (k) => String(k || '').replace(/\s+/g, '');

r.put('/global', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const { base_url, model, key } = req.body || {};
  if (base_url !== undefined) setSetting('ai_base_url', String(base_url || '').trim());
  if (model !== undefined) setSetting('ai_model', String(model || '').trim());
  if (key !== undefined) setSetting('ai_key', key === '' ? '' : encrypt(cleanKey(key)));
  res.json({ ok: true });
});

r.post('/global/test', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const b = req.body || {};
  const cfg = {
    baseUrl: String(b.base_url || getSetting('ai_base_url') || ''),
    model: String(b.model || getSetting('ai_model') || ''),
    key: b.key ? cleanKey(b.key) : decrypt(getSetting('ai_key') || ''),
  };
  if (!cfg.baseUrl || !cfg.key) return res.status(400).json({ error: '地址或 Key 为空，无法测试' });
  try {
    const out = await testConnection(cfg);
    res.json({ ok: true, models: out.models });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = r;
