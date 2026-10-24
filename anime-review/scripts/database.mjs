// Local CLI only. Management credentials are never part of the website.
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { initializeProject, projectFromURL } from './initialize.mjs';

const root = new URL('../', import.meta.url);
const [command, ...args] = process.argv.slice(2);

function importOptions(values) {
  let file = '', year = 0, month = 0, current = false, dryRun = false;
  for (let index = 0; index < values.length; index++) {
    const arg = values[index];
    if (arg === '--year') year = Number(values[++index]);
    else if (arg === '--month') month = Number(values[++index]);
    else if (arg === '--current') current = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--year=')) year = Number(arg.slice(7));
    else if (arg.startsWith('--month=')) month = Number(arg.slice(8));
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else if (!file) file = arg;
    else throw new Error('一次只能导入一个 CSV 文件。');
  }
  if (!file) throw new Error('请指定 CSV 文件，例如 npm run db:import -- "../获取动漫资源/miluxing_2026_10.csv" --year 2026 --month 10');
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('请用 --year 指定 2000～2100 的年份。');
  if (![1, 4, 7, 10].includes(month)) throw new Error('请用 --month 指定 1、4、7、10 中的季度月份。');
  return { file, year, month, current, dryRun };
}

async function executeSQL(projectRef, accessToken, query, readOnly) {
  let response;
  try {
    response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, read_only: readOnly }),
    });
  } catch { throw new Error('连接 Supabase 超时或网络中断，请检查网络。写入结果不确定时先查询确认，再决定是否重试。'); }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`数据库操作失败（HTTP ${response.status}），请检查 SQL、项目状态和管理 Token 的 Database 权限。${detail ? `\n${detail.slice(0, 500)}` : ''}`);
  }
  return response.json();
}

async function main() {
  if (!['init', 'query', 'sql', 'import'].includes(command) || args.includes('--help')) {
    console.log('初始化／升级：npm run db:init\n只读查询：npm run db:query -- "select ..."\n执行 SQL 文件：npm run db:sql -- ./修改.sql\n导入番季 CSV：npm run db:import -- "../获取动漫资源/miluxing_2026_10.csv" --year 2026 --month 10 [--current] [--dry-run]');
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

  if (command === 'import') {
    const options = importOptions(args);
    const { readItems, buildImportSQL, seasonIdOf } = await import('./import.mjs');
    const source = await readFile(resolve(options.file), 'utf8').catch(() => { throw new Error('CSV 文件读取失败，请检查路径和权限。'); });
    const items = readItems(source);
    const query = buildImportSQL({ year: options.year, month: options.month, items, makeCurrent: options.current });
    const seasonId = seasonIdOf(options.year, options.month);
    if (options.dryRun) {
      console.log(query);
      console.log(`dry-run：${items.length} 部番剧，目标番季 ${seasonId}${options.current ? '（并设为当期）' : ''}。`);
      return;
    }
    const result = await executeSQL(ref, token, query, false);
    console.log(JSON.stringify(result, null, 2));
    console.log(`已将 ${items.length} 部番剧导入 ${seasonId}${options.current ? '，并设为当期' : ''}。`);
    return;
  }

  let query;
  if (command === 'sql') {
    if (args.length !== 1) throw new Error('请指定一个 SQL 文件，例如 npm run db:sql -- ./修改.sql');
    query = await readFile(resolve(args[0]), 'utf8').catch(() => { throw new Error('SQL 文件读取失败，请检查路径和权限。'); });
  } else query = args.join(' ');
  if (!query.trim()) throw new Error('SQL 不能为空。');

  const result = await executeSQL(ref, token, query, command === 'query');
  console.log(JSON.stringify(result, null, 2));
  console.log(command === 'query' ? '查询完成。' : 'SQL 执行完成。');
}

main().catch(error => {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const message = error.message || '操作失败。';
  console.error(token ? message.replaceAll(token, '[管理凭证已隐藏]') : message);
  process.exitCode = 1;
});
