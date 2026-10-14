// AES-256-GCM 落库加密（工作台同款思路）：密文带版本前缀，密钥存 data/.secret（首启自动生成）。
// 用途：AI Key / 高德 Key 这类不希望随 DB 备份裸奔的凭证。GET 接口只回 has_key 布尔，永不回明文。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const secretPath = path.join(dataDir, '.secret');

function loadSecret() {
  try {
    const s = fs.readFileSync(secretPath, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(s)) return Buffer.from(s, 'hex');
  } catch { /* 首启无文件 */ }
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const buf = crypto.randomBytes(32);
  fs.writeFileSync(secretPath, buf.toString('hex') + '\n', { mode: 0o600 });
  return buf;
}
const SECRET = loadSecret();

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(stored) {
  if (!stored) return '';
  if (!String(stored).startsWith('enc:v1:')) return String(stored); // 容忍历史明文（如 env 导入）
  try {
    const [, , ivB, tagB, dataB] = String(stored).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', SECRET, Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8');
  } catch {
    return ''; // 密钥对不上（换了 data 目录）→ 视为未配置，绝不抛崩业务
  }
}

module.exports = { encrypt, decrypt };
