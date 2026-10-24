// Local CLI only. Management credentials are never part of the website.
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { initializeProject, projectFromURL } from './initialize.mjs';

const root = new URL('../', import.meta.url);
const [command, ...args] = process.argv.slice(2);

async function main() {
  if (!['init', 'query', 'sql'].includes(command) || args.includes('--help')) {
    console.log('初始化／升级：npm run db:init\n只读查询：npm run db:query -- "select ..."\n执行 SQL 文件：npm run db:sql -- ./修改.sql');
    if (!args.includes('--help')) process.exitCode = 1;
    return;
  }
  try { loadEnvFile(new URL('.env.local', root)); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取 .env.local，请检查文件权限。'); }

  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (!/^sbp_[A-Za-z0-9_-]{10,}$/.test(token || '')) throw new Error('请在项目 .env.local 中填写 SUPABASE_ACCESS_TOKEN（sbp_ 开头的管理 Token）。');
  let saved = {};
  try {
    const source = await readFile(new URL('config.js', root), 'utf8');
    const content = source.match(/Object\.freeze\(([\s\S]*?)\);?\s*$/)?.[1];
    if (content) saved = JSON.parse(content);
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取 config.js，请检查公开连接配置。'); }
  const { ref, url } = projectFromURL(process.env.SUPABASE_URL?.trim() || saved.supabaseUrl);

  if (command === 'init') {
    if (args.length) throw new Error('db:init 不接收 SQL 参数；执行文件请使用 db:sql。');
    await initializeProject({
      projectUrl: url, accessToken: token,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || (url === saved.supabaseUrl ? saved.supabasePublishableKey : ''),
      adminUserId: process.env.SUPABASE_ADMIN_USER_ID?.trim() || '',
    }, { root, onProgress: ({ message }) => console.log(message) });
    console.log('数据库初始化／升级完成，公开配置已写入 config.js。');
    return;
  }

  let query;
  if (command === 'sql') {
    if (args.length !== 1) throw new Error('请指定一个 SQL 文件，例如 npm run db:sql -- ./修改.sql');
    query = await readFile(resolve(args[0]), 'utf8').catch(() => { throw new Error('SQL 文件读取失败，请检查路径和权限。'); });
  } else query = args.join(' ');
  if (!query.trim()) throw new Error('SQL 不能为空。');

  let response;
  try {
    response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, read_only: command === 'query' }),
    });
  } catch { throw new Error('连接 Supabase 超时或网络中断，请检查网络。写入结果不确定时先查询确认，再决定是否重试。'); }
  if (!response.ok) throw new Error(`数据库操作失败（HTTP ${response.status}），请检查 SQL、项目状态和管理 Token 的 Database 权限。`);
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  console.log(command === 'query' ? '查询完成。' : 'SQL 执行完成。');
}

main().catch(error => {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const message = error.message || '操作失败。';
  console.error(token ? message.replaceAll(token, '[管理凭证已隐藏]') : message);
  process.exitCode = 1;
});
