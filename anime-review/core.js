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
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function toCSV(rows) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'); }
export function buildExport(anime, reviews, profiles, format = 'long') {
  const people = new Map(profiles.map(p => [p.id, { cn: p.cn || '未命名', qq: p.qq || '' }]));
  const nameOf = id => people.get(id)?.cn || '未命名';
  const qqOf = id => people.get(id)?.qq || '';
  // 原表布局沿用“CN（QQ）”的表头，明细表则单独列出 QQ 列。
  const labelOf = id => {
    const person = people.get(id);
    return person?.qq ? `${person.cn}（${person.qq}）` : nameOf(id);
  };
  if (format === 'wide') {
    const users = [...new Set(reviews.filter(hasContent).map(r => r.user_id))];
    const header = ['番剧', '项目', '前中期均分', '前中期人数', '完结均分', '完结人数', ...users.flatMap(id => [`${labelOf(id)} / 前中期`, `${labelOf(id)} / 完结`])];
    const rows = [header];
    for (const a of anime) {
      const relevant = reviews.filter(r => r.anime_id === a.id);
      const stats = ['early', 'final'].flatMap(phase => {
        const rated = relevant.filter(r => r.phase === phase && r.score !== null && r.score !== undefined);
        return [rated.length ? +(rated.reduce((sum, r) => sum + Number(r.score), 0) / rated.length).toFixed(2) : '', rated.length];
      });
      for (const field of ['score', 'comment']) rows.push([a.title, field === 'score' ? '评分' : '吐槽', ...(field === 'score' ? stats : ['', '', '', '']), ...users.flatMap(id => ['early', 'final'].map(phase => relevant.find(r => r.user_id === id && r.phase === phase)?.[field] ?? ''))]);
    }
    return toCSV(rows);
  }
  const titles = new Map(anime.map(a => [a.id, a.title]));
  return toCSV([['番剧', '阶段', 'CN', 'QQ', '评分（满分5）', '吐槽', '更新时间'], ...reviews.filter(hasContent).map(r => [titles.get(r.anime_id) || '', PHASES[r.phase], nameOf(r.user_id), qqOf(r.user_id), r.score, r.comment, r.updated_at])]);
}
