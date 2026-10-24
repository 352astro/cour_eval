// Local-only helpers for importing a scraped season CSV into Supabase.
// This module is never shipped to the browser.
export const SEASON_MONTH_LABELS = { 1: '一月', 4: '四月', 7: '七月', 10: '十月' };

export function seasonIdOf(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function seasonTitleOf(year, month) {
  return `${year} ${SEASON_MONTH_LABELS[month]}新番`;
}

export function validateSeason(year, month) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('年份需为 2000～2100 的整数。');
  if (![1, 4, 7, 10].includes(month)) throw new Error('季度月份只能是 1、4、7、10。');
}

// Minimal RFC 4180 parser: quoted commas, escaped quotes and newlines inside fields.
export function parseCSV(text) {
  const source = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index++; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (quoted) throw new Error('CSV 中存在未闭合的引号。');
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(cells => cells.some(cell => cell.trim() !== ''));
}

export function readItems(text) {
  const rows = parseCSV(text);
  if (!rows.length) throw new Error('CSV 是空的。');
  const header = rows[0].map(cell => cell.trim().toLowerCase());
  const titleIndex = header.indexOf('title');
  const coverIndex = header.indexOf('cover_url');
  if (titleIndex < 0) throw new Error('CSV 缺少 title 列。');
  const items = [];
  const seen = new Set();
  for (let index = 1; index < rows.length; index++) {
    const title = (rows[index][titleIndex] || '').trim();
    const cover = coverIndex >= 0 ? (rows[index][coverIndex] || '').trim() : '';
    if (!title) throw new Error(`CSV 第 ${index + 1} 行缺少番剧名称。`);
    if (title.length > 200) throw new Error(`CSV 第 ${index + 1} 行的番剧名称超过 200 字。`);
    if (cover && !/^https?:\/\//i.test(cover)) throw new Error(`CSV 第 ${index + 1} 行的封面链接不是 http(s) 地址。`);
    const key = title.toLocaleLowerCase();
    if (seen.has(key)) throw new Error(`CSV 中有重复番剧：${title}`);
    seen.add(key);
    items.push({ title, cover_url: cover || null });
  }
  if (!items.length) throw new Error('CSV 中没有可导入的番剧。');
  return items;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildImportSQL({ year, month, items, makeCurrent = false }) {
  validateSeason(year, month);
  if (!Array.isArray(items) || !items.length) throw new Error('没有可导入的番剧。');
  const seasonId = seasonIdOf(year, month);
  const title = seasonTitleOf(year, month);
  const lines = [
    'begin;',
    `insert into public.club_seasons (id, year, month, title, current_phase, is_open, is_current)
values (${sqlString(seasonId)}, ${year}, ${month}, ${sqlString(title)}, 'early', true, false)
on conflict (id) do update set year = excluded.year, month = excluded.month;`,
  ];
  if (makeCurrent) {
    lines.push('update public.club_seasons set is_current = false where is_current;');
    lines.push(`update public.club_seasons set is_current = true where id = ${sqlString(seasonId)};`);
  }
  const values = items.map((item, index) => `(gen_random_uuid()::text, ${sqlString(seasonId)}, ${sqlString(item.title)}, ${item.cover_url ? sqlString(item.cover_url) : 'null'}, ${index + 1}, true)`);
  lines.push(`insert into public.club_anime (id, season_id, title, cover_url, sort_order, is_approved)
values
  ${values.join(',\n  ')}
on conflict (season_id, lower(btrim(title))) do update
  set cover_url = coalesce(excluded.cover_url, public.club_anime.cover_url),
      sort_order = excluded.sort_order;`);
  lines.push("select pg_notify('pgrst', 'reload schema');", 'commit;');
  return lines.join('\n');
}
