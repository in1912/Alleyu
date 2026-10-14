// AI 配置：个人配置（人人可改自己的）+ 全局配置（admin）。Key 只写不读——接口只回 has_key。
const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { personalConfig, globalConfig, testConnection } = require('../services/aiService');

const r = express.Router();

// 当前用户视角的可用状态（用于界面提示）
r.get('/status', (req, res) => {
  const p = personalConfig(req.user.id);
  const g = req.user.role === 'admin' ? globalConfig() : null;
  res.json({
    can_use_ai: req.user.role === 'admin' || !!req.user.can_use_ai,
    personal: p ? { base_url: p.baseUrl, model: p.model, has_key: true } : null,
    effective_source: p ? 'personal' : (g ? 'global' : (globalConfig() ? 'global' : 'none')),
  });
});

// 自己的配置
r.get('/config', (req, res) => {
  const u = db.prepare('SELECT ai_base_url, ai_model, ai_key FROM users WHERE id=?').get(req.user.id);
  res.json({ base_url: u.ai_base_url || '', model: u.ai_model || '', has_key: !!decrypt(u.ai_key || '') });
});

r.put('/config', (req, res) => {
  const { base_url, model, key } = req.body || {};
  if (key !== undefined && key !== '' && typeof key !== 'string') return res.status(400).json({ error: 'Key 格式错误' });
  const u = db.prepare('SELECT ai_base_url, ai_model, ai_key FROM users WHERE id=?').get(req.user.id);
  db.prepare('UPDATE users SET ai_base_url=?, ai_model=?, ai_key=? WHERE id=?')
    .run(String(base_url || ''), String(model || ''),
      key === undefined ? u.ai_key : (key === '' ? '' : encrypt(String(key).trim())),
      req.user.id);
  res.json({ ok: true });
});

// 连通测试（测自己保存的配置；body 可传待保存值先行验证）
r.post('/test', async (req, res) => {
  const b = req.body || {};
  let cfg;
  if (b.base_url || b.model || b.key) {
    const u = db.prepare('SELECT ai_key FROM users WHERE id=?').get(req.user.id);
    const key = b.key ? String(b.key).trim() : decrypt(u.ai_key || '');
    cfg = { baseUrl: String(b.base_url || ''), model: String(b.model || ''), key };
  } else {
    cfg = personalConfig(req.user.id) || globalConfig();
  }
  if (!cfg || !cfg.baseUrl || !cfg.key) return res.status(400).json({ error: '地址或 Key 为空，无法测试' });
  try {
    const out = await testConnection(cfg);
    res.json({ ok: true, models: out.models, model_hint: cfg.model && !out.models.includes(cfg.model) ? `模型列表里没有「${cfg.model}」，请核对模型名` : '' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- 全局配置（admin）----
r.get('/global', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  res.json({
    base_url: getSetting('ai_base_url') || '', model: getSetting('ai_model') || '',
    has_key: !!decrypt(getSetting('ai_key') || ''),
  });
});

r.put('/global', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const { base_url, model, key } = req.body || {};
  if (base_url !== undefined) setSetting('ai_base_url', String(base_url || ''));
  if (model !== undefined) setSetting('ai_model', String(model || ''));
  if (key !== undefined) setSetting('ai_key', key === '' ? '' : encrypt(String(key).trim()));
  res.json({ ok: true });
});

r.post('/global/test', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const b = req.body || {};
  const cfg = {
    baseUrl: String(b.base_url || getSetting('ai_base_url') || ''),
    model: String(b.model || getSetting('ai_model') || ''),
    key: b.key ? String(b.key).trim() : decrypt(getSetting('ai_key') || ''),
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
