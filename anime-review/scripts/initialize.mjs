// LOCAL CLI provisioning. Never import this module into the public web app.
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MANAGEMENT_ORIGIN = 'https://api.supabase.com';
const DEFAULT_ROOT = new URL('../', import.meta.url);

export function projectFromURL(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请填写完整的 Project URL，例如 https://项目编号.supabase.co。'); }
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname);
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请填写 Supabase 项目首页的 https://项目编号.supabase.co 地址。');
  }
  return { ref:match[1], url:url.origin };
}
export function publicKeyOnly(value) {
  const key = String(value || '').trim();
  if (/^sb_publishable_[a-zA-Z0-9_-]{10,}$/.test(key)) return key;
  // Existing projects may still have an anon JWT. Only accept the anon role.
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    try { if (JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'anon') return key; } catch { /* reject */ }
  }
  throw new Error('请填写 Publishable key（sb_publishable_ 开头），不能填写 Secret / service_role / 管理 Token。');
}
function withoutTransaction(sql) { return sql.replace(/^\s*(?:begin|commit);[\t ]*$/gmi, ''); }
export function initializationSQL(schema, seed, adminUserId='') {
  if (adminUserId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(adminUserId)) throw new Error('管理员 UUID 格式不正确。');
  const adminSQL=adminUserId ? `insert into public.club_admins(user_id) values ('${adminUserId}'::uuid) on conflict do nothing;\n` : '';
  // One transaction and one lock: safe to retry after timeout, no partial schema/seed.
  return `begin;\nselect pg_advisory_xact_lock(hashtext('anime-club-initialize-v1'));\n${withoutTransaction(schema)}\n${withoutTransaction(seed)}\n${adminSQL}select pg_notify('pgrst', 'reload schema');\ncommit;\n`;
}
function accessError(status, stage) {
  if (status === 401) return new Error(`${stage}失败：Access Token 无效或已过期，请重新生成。`);
  if (status === 403) return new Error(`${stage}失败：Token 权限不足。请检查本项目的 Database、Auth Config、Project Settings 权限；自动获取公开密钥还需要 API Keys 读取权限。`);
  if (status === 429) return new Error(`${stage}失败：Supabase 请求过于频繁，请稍后重试。`);
  return new Error(`${stage}失败（HTTP ${status}）。请确认项目正常运行且 Token 已授权此项目，再重试。`);
}
async function safeJSON(response) { try { return await response.json(); } catch { return null; } }
export async function initializeProject(input, {
  root = DEFAULT_ROOT, fetchImpl = fetch, onProgress = () => {},
  wait = ms => new Promise(done => setTimeout(done, ms)),
} = {}) {
  const { ref, url } = projectFromURL(input.projectUrl);
  let accessToken = String(input.accessToken || '').trim();
  if (!/^sbp_[A-Za-z0-9_-]{10,}$/.test(accessToken)) throw new Error('请填写 Supabase 账号的 Personal Access Token（sbp_ 开头）。它不是项目的 API Key。');
  const adminUserId=String(input.adminUserId || '').trim();
  if (adminUserId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(adminUserId)) throw new Error('请填写 Authentication → Users 中的管理员 UUID，或者留空。');
  const stage = (name, message) => onProgress({ stage:name, message });
  const management = async (path, { method='GET', body, label='连接 Supabase', timeout=30000 } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${MANAGEMENT_ORIGIN}/v1/projects/${ref}${path}`, {
        method, headers:{ Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json' },
        ...(body ? { body:JSON.stringify(body) } : {}), signal:AbortSignal.timeout(timeout), redirect:'error',
      });
    } catch { throw new Error(`${label}时网络中断或超时。可以再次初始化，已导入的数据不会重复。`); }
    if (!response.ok) throw accessError(response.status,label);
    return safeJSON(response);
  };
  try {
    stage('connect','正在检查项目授权与公开密钥…');
    let publicKey;
    if (String(input.publishableKey || '').trim()) publicKey = publicKeyOnly(input.publishableKey);
    else {
      const keys = await management('/api-keys?reveal=false', { label:'读取公开密钥' });
      for (const entry of Array.isArray(keys) ? keys : []) {
        if (entry.type === 'secret' || entry.name === 'service_role') continue;
        try { publicKey = publicKeyOnly(entry.api_key); break; } catch { /* not a usable public key */ }
      }
      if (!publicKey) throw new Error('未找到可用的 Publishable key。请在 .env.local 中填写 SUPABASE_PUBLISHABLE_KEY 后重试。');
    }
    // Check auth permission BEFORE changing the database, and preserve all other settings.
    await management('/config/auth', { label:'检查匿名登录配置权限' });
    const base = root instanceof URL ? root : resolve(root);
    const file = name => base instanceof URL ? new URL(name,base) : resolve(base,name);
    const [schema,seed,catalogRaw] = await Promise.all([
      readFile(file('supabase/schema.sql'),'utf8'), readFile(file('supabase/seed.sql'),'utf8'), readFile(file('catalog.json'),'utf8'),
    ]);
    const catalog = JSON.parse(catalogRaw);
    stage('database','正在创建或升级数据表、设置权限并导入片单…');
    await management('/database/query', {
      method:'POST', body:{ query:initializationSQL(schema,seed,adminUserId), read_only:false }, label:adminUserId ? '初始化数据库或授权管理员（请确认 UUID 对应已有用户）' : '初始化数据库', timeout:120000,
    });
    stage('auth','正在启用匿名登录…');
    await management('/config/auth', { method:'PATCH', body:{ external_anonymous_users_enabled:true }, label:'启用匿名登录' });
    stage('verify','正在检查网页能否读取云端片单…');
    let verified = false;
    for (let attempt=0; attempt<8; attempt++) {
      try {
        const response = await fetchImpl(`${url}/rest/v1/club_anime?select=id&season_id=eq.2026-07&limit=1000`, {
          headers:{ apikey:publicKey }, signal:AbortSignal.timeout(10000), redirect:'error',
        });
        if (response.ok) {
          const rows = await safeJSON(response), ids = new Set(Array.isArray(rows) ? rows.map(row => row.id) : []);
          if (catalog.every(anime => ids.has(anime.id))) { verified=true; break; }
        }
      } catch { /* schema cache and project API may take a moment to become ready */ }
      if (attempt < 7) await wait(1200);
    }
    if (!verified) throw new Error('数据库和匿名登录已配置，但网页片单验证暂未通过。请检查公开密钥及项目的 Data API 是否启用，然后重试；现有数据会保留。');
    stage('config','正在保存网页连接配置…');
    const config = { supabaseUrl:url, supabasePublishableKey:publicKey, seasonId:'2026-07' };
    const content = '// 自动初始化生成。仅含可公开的网页连接信息，不包含管理凭证。\nwindow.ANIME_CONFIG = Object.freeze(' + JSON.stringify(config,null,2) + ');\n';
    const temp = file(`.config.init-${randomUUID()}.tmp`);
    try { await writeFile(temp,content,{ mode:0o600, flag:'wx' }); await rename(temp,file('config.js')); }
    catch { await rm(temp,{force:true}).catch(() => {}); throw new Error('云端初始化已完成，但本地 config.js 写入失败。请检查应用目录的写入权限后重试。'); }
    const result = { ok:true, projectUrl:url, catalogCount:catalog.length, ...(adminUserId ? {adminConfigured:true} : {}) };
    stage('done',`已连接云端，${catalog.length} 部番剧已就绪。`);
    return result;
  } finally {
    // This module never writes the management credential to public files or logs.
    accessToken = ''; input.accessToken = '';
  }
}
