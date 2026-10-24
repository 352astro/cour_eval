export const PHASES = { early: '前中期吐槽', final: '完结吐槽' };
export const SEASON_MONTHS = { 1: 'WINTER', 4: 'SPRING', 7: 'SUMMER', 10: 'AUTUMN' };
export const SEASON_MONTH_LABELS = { 1: '一月', 4: '四月', 7: '七月', 10: '十月' };
export function seasonStamp(season) {
  return season ? `${season.year} · ${SEASON_MONTHS[season.month] || ''}` : '';
}
export function reviewKey(animeId, phase) { return `${animeId}:${phase}`; }
export function hasContent(review) {
  return review && (review.score !== null && review.score !== undefined || Boolean(review.comment?.trim()));
}
export function validateScore(value) {
  if (value === '' || value === null || value === undefined) return null;
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 5 || Math.abs(score * 10 - Math.round(score * 10)) > 1e-8) {
    throw new Error('评分请填写 0～5 之间的数字，最多一位小数。');
  }
  return score;
}
export function validateProfile(cn, qq) {
  if (!cn.trim() || cn.trim().length > 40) throw new Error('CN 请输入 1～40 个字。');
  if (!/^[1-9]\d{4,19}$/.test(qq.trim())) throw new Error('QQ 号请填写 5～20 位数字，首位不能为 0。');
  return { cn: cn.trim(), qq: qq.trim() };
}
export function isOpen(season) {
  return Boolean(season?.is_open);
}
export function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Prevent spreadsheet formula execution when opening user-written text in Excel.
  // A leading minus is only dangerous when it is not a plain number (e.g. -1+2).
  const trimmed = text.trimStart();
  if (/^[=+@]/.test(trimmed) || (/^-/.test(trimmed) && !Number.isFinite(Number(trimmed)))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function toCSV(rows) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'); }
export function buildExport(anime, reviews, profiles, format = 'long') {
  const people = new Map(profiles.map(p => [p.id, { cn: p.cn || '未命名', qq: p.qq || '' }]));
  const nameOf = id => people.get(id)?.cn || '未命名';
  const qqOf = id => people.get(id)?.qq || '';
  // 汇总表把 QQ 写进评分人列名；个人明细则单独列出 QQ 列。
  const labelOf = id => {
    const person = people.get(id);
    return person?.qq ? `${person.cn}（${person.qq}）` : nameOf(id);
  };
  if (format === 'summary') {
    const users = [...new Set(reviews.filter(hasContent).map(r => r.user_id))]
      .sort((a, b) => labelOf(a).localeCompare(labelOf(b), 'zh-CN'));
    const header = ['番剧', '项目', '前中期均分', '完结均分', '分差', ...users.flatMap(id => [`${labelOf(id)} / 前中期`, `${labelOf(id)} / 完结`])];
    const rows = [header];
    const averageOf = (relevant, phase) => {
      const rated = relevant.filter(r => r.phase === phase && r.score !== null && r.score !== undefined);
      return rated.length ? rated.reduce((sum, r) => sum + Number(r.score), 0) / rated.length : null;
    };
    const round = value => typeof value === 'number' ? +value.toFixed(2) : '';
    for (const a of anime) {
      const relevant = reviews.filter(r => r.anime_id === a.id);
      const early = round(averageOf(relevant, 'early'));
      const final = round(averageOf(relevant, 'final'));
      const diff = early === '' || final === '' ? '' : +(final - early).toFixed(2);
      // 一部番剧两行：评分行放均分、分差和每人的分数，吐槽行放每人的原文。
      rows.push([a.title, '评分', early, final, diff, ...users.flatMap(id => ['early', 'final'].map(phase => {
        const review = relevant.find(r => r.user_id === id && r.phase === phase);
        return review?.score ?? '';
      }))]);
      rows.push([a.title, '吐槽', '', '', '', ...users.flatMap(id => ['early', 'final'].map(phase => {
        const review = relevant.find(r => r.user_id === id && r.phase === phase);
        return review?.comment ?? '';
      }))]);
    }
    return toCSV(rows);
  }
  const titles = new Map(anime.map(a => [a.id, a.title]));
  return toCSV([['番剧', '阶段', 'CN', 'QQ', '评分（满分5）', '吐槽', '更新时间'], ...reviews.filter(hasContent).map(r => [titles.get(r.anime_id) || '', PHASES[r.phase], nameOf(r.user_id), qqOf(r.user_id), r.score, r.comment, r.updated_at])]);
}
