// Local CLI only. Management credentials are never part of the website.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectFromURL } from './initialize.mjs';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const args = process.argv.slice(2);

function usage() {
  console.log(`数据库全量备份：
  npm run db:backup
  npm run db:backup -- --out ./backups/自定义目录

默认写入 anime-review/backups/<本地时间>/。
备份包含 public schema 下的所有表、schema.sql、auth 用户安全字段和 manifest。`);
}

let outArg = '';
try {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help') { usage(); process.exit(0); }
    else if (arg === '--out') {
      outArg = args[++index] || '';
      if (!outArg) throw new Error('--out 后面需要指定目录。');
    } else if (arg.startsWith('--out=')) outArg = arg.slice(6);
    else throw new Error(`未知参数：${arg}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function localStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function createOutputDir() {
  const base = outArg ? resolve(process.cwd(), outArg) : join(rootPath, 'backups', localStamp());
  await mkdir(dirname(base), { recursive: true, mode: 0o700 });
  let dir = base;
  for (let attempt = 2; ; attempt++) {
    try {
      await mkdir(dir, { mode: 0o700 });
      return dir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (outArg) throw new Error(`备份目录已存在，请换一个：${dir}`);
      dir = `${base}-${attempt}`;
    }
  }
}

async function main() {
  try { loadEnvFile(new URL('.env.local', root)); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取 .env.local，请检查文件权限。'); }

  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (!/^sbp_[A-Za-z0-9_-]{10,}$/.test(token || '')) {
    throw new Error('请在项目 .env.local 中填写 SUPABASE_ACCESS_TOKEN（sbp_ 开头的管理 Token）。');
  }

  let saved = {};
  try {
    const source = await readFile(new URL('config.js', root), 'utf8');
    const content = source.match(/Object\.freeze\(([\s\S]*?)\);?\s*$/)?.[1];
    if (content) saved = JSON.parse(content);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取 config.js，请检查公开连接配置。');
  }
  const { ref, url } = projectFromURL(process.env.SUPABASE_URL?.trim() || saved.supabaseUrl);

  async function query(sql) {
    let response;
    try {
      response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql, read_only: true }),
      });
    } catch {
      throw new Error('连接 Supabase 超时或网络中断，请检查网络后重试。');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`数据库读取失败（HTTP ${response.status}），请检查管理 Token 的 Database 权限。${detail ? `\n${detail.slice(0, 500)}` : ''}`);
    }
    return response.json();
  }

  console.log('正在读取数据库结构…');
  const tables = await query(`
    select table_name, quote_ident(table_name) as ident
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `);
  const columns = await query(`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position
  `);
  const database = await query(`
    select current_database() as database,
           pg_size_pretty(pg_database_size(current_database())) as database_size,
           version() as version,
           now() as exported_at
  `);
  const authUsers = await query(`
    select id, email, is_anonymous, created_at, email_confirmed_at, last_sign_in_at
    from auth.users
    order by created_at
  `);

  const data = {};
  const tableSummary = [];
  for (const table of tables) {
    process.stdout.write(`  读取 ${table.table_name} … `);
    const rows = await query(`select coalesce(json_agg(t), '[]'::json) as rows from public.${table.ident} t`);
    data[table.table_name] = rows[0]?.rows || [];
    tableSummary.push({
      name: table.table_name,
      rows: data[table.table_name].length,
      columns: columns.filter(column => column.table_name === table.table_name).map(column => ({
        name: column.column_name,
        type: column.data_type,
        nullable: column.is_nullable === 'YES',
        default: column.column_default,
      })),
    });
    console.log(`${data[table.table_name].length} 行`);
  }

  const outDir = await createOutputDir();
  const createdAt = new Date().toISOString();
  const schema = await readFile(new URL('supabase/schema.sql', root), 'utf8');
  const tableRows = tableSummary.reduce((sum, table) => sum + table.rows, 0);
  const manifest = {
    format: 'anime-review-backup/v1',
    createdAt,
    project: { ref, url },
    database: database[0],
    authUsers: authUsers.length,
    tables: tableSummary,
    files: {
      schema: 'schema.sql',
      data: 'data.json',
      authUsers: 'auth-users.json',
      readme: 'README.txt',
    },
    notes: [
      'public schema 下的所有基础表已导出到 data.json。',
      'auth-users.json 只包含用户安全字段，不含密码、refresh token 或 access token。',
      'schema.sql 来自仓库 supabase/schema.sql，是应用的结构定义。',
      '这是内容备份，不是可直接 pg_restore 的物理备份。',
    ],
  };

  const readme = `Anime Review 数据库备份
========================

创建时间：${createdAt}
项目：${url}

文件
----
schema.sql        仓库中的数据库结构定义
data.json         public schema 下所有表的数据
auth-users.json   auth 用户安全字段（无密码/token）
manifest.json     表、行数、字段和数据库信息
README.txt        本说明

恢复提示
--------
1. 先对新项目执行 npm run db:init，创建结构。
2. 再按 data.json 导入数据；目前没有一键 restore 脚本。
3. auth-users.json 只有账号元数据，密码和 token 不在备份里：
   - 社员可以用 CN + QQ 重新登录并映射到已有 profile；
   - 管理员账号需要在 Supabase Authentication 中重新创建或重置密码。
4. 如果 data.json 里有 auth 用户不存在的 club_profile_sessions 记录，
   这些会话在恢复后是无效的，社员重新登录会生成新的会话映射。

安全提示
--------
备份包含 CN、QQ、反馈内容和管理员邮箱，属于敏感数据。
不要提交到 Git，不要公开分享；建议保存在加密磁盘或私密目录。
`;
  await writeFile(join(outDir, 'schema.sql'), schema, { mode: 0o600 });
  await writeFile(join(outDir, 'data.json'), JSON.stringify({ format: 'anime-review-backup/v1', createdAt, tables: data }, null, 2), { mode: 0o600 });
  await writeFile(join(outDir, 'auth-users.json'), JSON.stringify({ format: 'anime-review-backup/v1', createdAt, users: authUsers }, null, 2), { mode: 0o600 });
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFile(join(outDir, 'README.txt'), readme, { mode: 0o600 });

  console.log('');
  console.log(`备份完成：${outDir}`);
  console.log(`public 表 ${tableSummary.length} 个，共 ${tableRows} 行；auth 用户 ${authUsers.length} 个。`);
  console.log('备份包含 CN/QQ/反馈内容，请勿提交或公开。');
}

main().catch(error => {
  console.error(error.message || '备份失败。');
  process.exitCode = 1;
});
