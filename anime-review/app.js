import { PHASES, seasonStamp, reviewKey, hasContent, validateScore, validateProfile, isOpen, escapeHTML as esc, buildExport } from './core.js';
import { createCloudStore } from './store.js';

const $ = selector => document.querySelector(selector);
const config = window.ANIME_CONFIG || {};
const configured = Boolean(config.supabaseUrl && config.supabasePublishableKey);
const state = { anime: [], loading: true, reviews: new Map(), profile: null, season: null, phase: 'final', filter: 'all', query: '', store: null, admin: null, adminData: null, adminSeasons: [], adminSeasonId: null, adminLoadRequest: 0, dirty: new Map(), timers: new Map(), saving: new Map(), errors: new Map(), revisions: new Map(), view: 'member', community: new Map(), communitySeq: 0 };
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4500); }
function confirmAction(title,description,confirmLabel='确认') {
  const dialog=$('#confirm-dialog');
  $('#confirm-title').textContent=title; $('#confirm-description').textContent=description;
  $('#confirm-submit').textContent=confirmLabel;
  dialog.returnValue='cancel';
  return new Promise(resolve=>{ dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}); dialog.showModal(); });
}
function profileReady() { return Boolean(state.profile?.qq); }
function message(error) {
  if (error?.code === 'NO_CURRENT_SEASON') return error.message;
  if (error?.code === 'PGRST205' || error?.code === '42P01') return '云端尚未完成配置，请联系管理员。';
  if (error?.code === 'PGRST202') return '云端评价功能需要升级，请管理员运行 db:init。';
  if (error?.code === '23505') return '这部番剧已经在片单中，请不要重复添加。';
  if (error?.code === 'PGRST116') return '找不到这个番季，请刷新后重试。';
  if (error?.code === 'P0002') return error.message || '找不到这个番季，请刷新后重试。';
  if (['42703','PGRST204'].includes(error?.code) && /qq/i.test(error.message || '')) return '云端资料结构需要升级，请联系管理员。';
  if (['42703','PGRST204'].includes(error?.code) && /(year|month|is_current|cover_url)/i.test(error.message || '')) return '云端番季结构需要升级，请管理员运行 db:init。';
  if (error?.code === '42501') return '数据库未允许此操作。征集可能已关闭、账号无权操作，或云端结构需要升级，请刷新并重试。';
  if (/anonymous.*disabled/i.test(error?.message || '')) return '无密码身份尚未启用，请联系管理员完成配置。';
  if (/Failed to fetch|NetworkError|Load failed|timeout|timed out|aborted/i.test(error?.message || '')) return '网络连接暂时不可用，请检查网络后重试。';
  return error?.message || '操作未完成，请稍后重试。';
}
function draftKey() { return `anime-club-draft:${state.store?.mode}:${config.supabaseUrl || 'local'}:${state.season?.id || 'no-season'}:${state.profile?.id || 'visitor'}`; }
function stashDrafts() {
  if (!state.profile) return;
  try { localStorage.setItem(draftKey(), JSON.stringify(Object.fromEntries(state.dirty))); }
  catch { toast('浏览器无法保存草稿，请保持页面打开并确认保存成功。'); }
}
function restoreDrafts() {
  if (!state.profile) return;
  try {
    const drafts = JSON.parse(localStorage.getItem(draftKey()) || '{}');
    for (const [key, row] of Object.entries(drafts)) {
      if (!state.anime.some(a => a.id === row.anime_id) || !PHASES[row.phase]) continue;
      state.reviews.set(key, row); state.dirty.set(key, row); state.revisions.set(key, 1);
    }
  } catch { toast('本地草稿读取失败，已保留云端记录。'); }
}
function setConnection() {
  const mode = state.store?.mode;
  $('#connection-badge').className = `connection ${mode || ''}`;
  $('#connection-badge').innerHTML = `<span></span> ${mode === 'cloud' ? '云端已连接' : '尚未连接'}`;
  $('#storage-label').textContent = mode === 'cloud' ? '云端自动保存' : '等待连接';
  $('#connection-notice').hidden = configured;
}
function setLoading(loading) {
  state.loading = loading;
  $('#loading-state').hidden = !loading;
  if (loading) {
    $('#list-caption').textContent = '正在读取当期番季…';
    $('#anime-count').textContent = '—';
    $('#total-count').textContent = '—';
    $('#done-count').textContent = '00';
    $('#phase-label').textContent = '—';
    $('#global-save').textContent = '正在连接云端…';
    $('#global-save').classList.remove('error');
    $('#empty-state').hidden = true;
  } else if (!state.store) {
    $('#list-caption').textContent = '等待连接云端';
    $('#global-save').textContent = '等待连接';
  }
}
function setUnavailable(status) {
  $('#collection-status').textContent = status;
  $('#collection-status').classList.add('closed');
}
function renderSeason() {
  const season = state.season;
  if (season) {
    $('#season-title').innerHTML = `${esc(season.title)}<span>你看的番，你来说。</span>`;
    $('#season-stamp').textContent = seasonStamp(season);
    document.title = `${season.title} · 番外话`;
  } else {
    $('#season-title').innerHTML = '新番季<span>等待管理员开启下一季。</span>';
    $('#season-stamp').textContent = 'NO SEASON';
    document.title = '番外话 · 新番评价收集';
  }
  const open = season ? isOpen(season) : false;
  $('#collection-status').textContent = !season ? '等待管理员开启' : open ? '评价征集中' : '征集已关闭 · 可以查看';
  $('#collection-status').classList.toggle('closed', !open);
}
function updateProgress() {
  const done = state.anime.filter(a => hasContent(state.reviews.get(reviewKey(a.id, state.phase)))).length;
  $('#done-count').textContent = String(done).padStart(2, '0');
  $('#total-count').textContent = state.anime.length;
  $('#anime-count').textContent = state.anime.length;
  $('#progress-bar').style.width = `${state.anime.length ? done / state.anime.length * 100 : 0}%`;
  $('#progress-caption').textContent = done ? `已经为 ${done} 部番剧留下了你的声音。` : '看过多少，聊多少。';
  $('#phase-label').textContent = PHASES[state.phase];
  document.querySelectorAll('[data-phase]').forEach(button => { button.classList.toggle('active', button.dataset.phase === state.phase); button.setAttribute('aria-pressed', String(button.dataset.phase === state.phase)); });
  $('#identity-button').innerHTML = state.profile ? `${esc(state.profile.cn)}${profileReady() ? '' : ' · 补充QQ号'} <span aria-hidden="true">↗</span>` : '填写我的资料 <span aria-hidden="true">↗</span>';
  let status = !state.store ? '尚未连接云端' : !state.season ? '等待管理员开启番季' : !profileReady() ? '填写 CN 和 QQ 号后即可保存' : state.dirty.size ? `有 ${state.dirty.size} 条尚未保存` : '所有更改已保存到云端';
  if (state.saving.size) status = '正在保存…';
  if (state.errors.size) status = '保存未完成 · 请重试';
  $('#global-save').textContent = status;
  $('#global-save').classList.toggle('error', Boolean(state.errors.size));
}
function emptyReview(id) { return { anime_id: id, phase: state.phase, score: null, comment: '' }; }
const COMMUNITY_PAGE_SIZE = 4;
function communityHTML(id) {
  const data = state.community.get(id);
  if (!data) return '';
  if (data.status === 'loading') return '<div class="community-loading">正在读取大家的评价…</div>';
  if (data.status === 'error') return `<div class="community-error">${esc(data.error || '评价读取失败。')} <button type="button" class="text-button" data-community-retry>重试 ↗</button></div>`;
  const items = data.items || [];
  const head = `<div class="community-head"><h4>大家的评价</h4><div class="community-head-meta"><span>共 ${items.length} 条</span><button type="button" class="text-button" data-community-retry>刷新 ↻</button></div></div>`;
  if (!items.length) return `${head}<div class="community-empty">还没有人写评价，来当第一个。</div>`;
  const pages = Math.max(1, Math.ceil(items.length / COMMUNITY_PAGE_SIZE));
  const page = Math.min(data.page || 0, pages - 1);
  const cards = items.slice(page * COMMUNITY_PAGE_SIZE, (page + 1) * COMMUNITY_PAGE_SIZE).map(item => {
    const score = item.score === null || item.score === undefined ? '未打分' : `${item.score} / 5`;
    const comment = item.comment?.trim() ? esc(item.comment) : '<span class="community-muted">仅评分，没有写吐槽。</span>';
    const time = item.updated_at ? new Date(item.updated_at).toLocaleDateString('zh-CN', { month:'numeric', day:'numeric' }) : '';
    return `<article class="community-review"><header><strong>${esc(item.cn || '未命名')}</strong>${item.is_mine ? '<span class="community-mine">我</span>' : ''}<span class="community-badge ${item.phase}">${item.phase === 'early' ? '前中期' : '完结'}</span><span class="community-score">${score}</span>${time ? `<time>${esc(time)}</time>` : ''}</header><p>${comment}</p></article>`;
  }).join('');
  const pager = pages > 1 ? `<div class="community-pager"><button type="button" data-community-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>上一页</button><span>第 ${page + 1} / ${pages} 页</span><button type="button" data-community-page="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''}>下一页</button></div>` : '';
  return `${head}<div class="community-list">${cards}</div>${pager}`;
}
function renderCommunity(id) {
  const card = document.querySelector(`.anime-card[data-id="${CSS.escape(id)}"]`);
  const host = card?.querySelector('[data-community]');
  if (host) host.innerHTML = communityHTML(id);
}
async function loadCommunity(id, force = false) {
  if (!state.store) return;
  const current = state.community.get(id);
  if (!force && current && (current.status === 'loading' || current.status === 'ready' || current.status === 'error')) return;
  const seq = ++state.communitySeq;
  state.community.set(id, { status:'loading', items:[], page:0, seq });
  renderCommunity(id);
  try {
    const items = await state.store.animeReviews(id);
    if (state.community.get(id)?.seq !== seq) return;
    state.community.set(id, { status:'ready', items, page:0, seq });
  } catch (error) {
    if (state.community.get(id)?.seq !== seq) return;
    state.community.set(id, { status:'error', items:[], page:0, error: message(error), seq });
  }
  renderCommunity(id);
}
function syncCommunityReview(review) {
  const data = state.community.get(review.anime_id);
  if (!data || data.status !== 'ready') return;
  const index = data.items.findIndex(item => item.is_mine && item.phase === review.phase);
  const hasContent = review.score !== null && review.score !== undefined || Boolean(review.comment?.trim());
  if (!hasContent) {
    if (index >= 0) data.items.splice(index, 1);
  } else {
    const item = { phase: review.phase, score: review.score, comment: review.comment, updated_at: review.updated_at, cn: state.profile?.cn || '未命名', is_mine: true };
    if (index >= 0) data.items[index] = item; else data.items.push(item);
    data.items.sort((a, b) => a.phase.localeCompare(b.phase) || (a.cn || '').localeCompare(b.cn || '', 'zh-CN'));
  }
  renderCommunity(review.anime_id);
}
function changeCommunityPage(id, page) {
  const data = state.community.get(id);
  if (!data || data.status !== 'ready') return;
  const pages = Math.max(1, Math.ceil(data.items.length / COMMUNITY_PAGE_SIZE));
  data.page = Math.min(Math.max(0, page), pages - 1);
  renderCommunity(id);
}

function renderList() {
  if (state.loading) return;
  const expanded = new Set([...document.querySelectorAll('.anime-card[open]')].map(el => el.dataset.id));
  const filtered = state.anime.filter(a => {
    const done = hasContent(state.reviews.get(reviewKey(a.id, state.phase)));
    return a.title.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()) && (state.filter === 'all' || state.filter === 'done' && done || state.filter === 'todo' && !done);
  });
  $('#anime-list').innerHTML = filtered.map(a => {
    const index = state.anime.indexOf(a) + 1, key = reviewKey(a.id, state.phase), row = state.reviews.get(key) || emptyReview(a.id), done = hasContent(row);
    const disabled = !profileReady() || !state.store || !isOpen(state.season);
    return `<details class="anime-card" data-id="${esc(a.id)}" ${expanded.has(a.id) ? 'open' : ''}>
      <summary class="anime-summary"><span class="anime-number">${String(index).padStart(2,'0')}</span><span class="anime-cover" aria-hidden="true">${a.cover_url ? `<img src="${esc(a.cover_url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}<span class="anime-fallback">${['✳','◇','✦','◈'][index % 4]}</span></span><span class="anime-title-wrap"><span class="anime-title">${esc(a.title)}</span><span class="anime-subtitle">${esc(state.season ? `${seasonStamp(state.season)} · ANIME` : 'ANIME')}${a.is_approved ? '' : ' · 管理员暂未公开'}</span></span><span class="review-status ${done ? 'done' : ''}">${done ? row.score === null ? '已写吐槽' : `${row.score} 分` : '未填写'}</span><span class="chevron" aria-hidden="true">›</span></summary>
      <div class="review-editor"><div class="editor-top"><label class="score-label" for="score-${esc(a.id)}">我的评分</label><div class="score-input-wrap"><input id="score-${esc(a.id)}" class="score-input" data-field="score" type="number" min="0" max="5" step="0.1" inputmode="decimal" placeholder="—" value="${esc(row.invalidScore ?? row.score ?? '')}" ${disabled ? 'disabled' : ''}><span class="score-denominator">/ 5</span></div><div class="quick-scores" aria-label="快速评分">${[1,2,3,4,5].map(n => `<button type="button" data-score="${n}" ${disabled ? 'disabled' : ''}>${n}分</button>`).join('')}</div></div>
      <label class="comment-label" for="comment-${esc(a.id)}">${PHASES[state.phase]}<textarea id="comment-${esc(a.id)}" data-field="comment" maxlength="20000" rows="4" placeholder="剧情、角色、作画，或是某个让你记住的瞬间……想说什么都可以。" ${disabled ? 'disabled' : ''}>${esc(row.comment)}</textarea></label>
      <div class="editor-footer"><span class="save-state" data-save-state>${disabled ? !profileReady() ? '先填写 CN 和 QQ 号，就可以开始记录了' : '征集已关闭，记录仍可查看' : '填写后自动保存'}</span><div class="editor-actions">${!profileReady() ? '<button class="text-button" data-login>填写资料 ↗</button>' : '<button class="text-button" data-clear>清空这条</button><button class="text-button" data-save>保存 / 重试 ↗</button>'}</div></div><div class="community" data-community>${communityHTML(a.id)}</div></div></details>`;
  }).join('');
  $('#empty-state').hidden = Boolean(filtered.length);
  $('#list-caption').textContent = state.query || state.filter !== 'all' ? `找到 ${filtered.length} 部番剧` : '选择一部番剧，展开写下你的评价';
  document.querySelectorAll('[data-filter]').forEach(b => { b.classList.toggle('active', b.dataset.filter === state.filter); b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)); });
  for (const a of filtered) {
    updateCard(a.id);
    if (document.querySelector(`.anime-card[data-id="${CSS.escape(a.id)}"]`)?.open) void loadCommunity(a.id);
  }
  updateProgress();
}
function updateCard(id) {
  const card = document.querySelector(`.anime-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const key = reviewKey(id, state.phase), row = state.reviews.get(key), done = hasContent(row);
  const tag = card.querySelector('.review-status');
  tag.className = `review-status ${done ? 'done' : ''} ${state.dirty.has(key) ? 'pending' : ''}`;
  tag.textContent = done ? row.score === null || row.score === undefined ? '已写吐槽' : `${row.score} 分` : '未填写';
  const status = card.querySelector('[data-save-state]');
  status.classList.toggle('error', state.errors.has(key));
  if (state.errors.has(key)) status.textContent = `${state.errors.get(key)} 点击重试。`;
  else if (state.saving.has(key)) status.textContent = '正在保存…';
  else if (state.dirty.has(key)) status.textContent = '草稿已留在本机 · 等待保存';
  else if (row?.updated_at) status.textContent = `已保存到云端 · ${new Date(row.updated_at).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}`;
}
function editReview(id, patch) {
  if (!profileReady() || !isOpen(state.season)) return;
  const key = reviewKey(id, state.phase), row = { ...(state.reviews.get(key) || emptyReview(id)), ...patch };
  state.reviews.set(key, row); state.dirty.set(key, row); state.revisions.set(key, (state.revisions.get(key) || 0) + 1); state.errors.delete(key);
  stashDrafts(); updateCard(id); updateProgress();
  clearTimeout(state.timers.get(key));
  state.timers.set(key, setTimeout(() => flushKey(key), 800));
}
async function flushKey(key) {
  clearTimeout(state.timers.get(key)); state.timers.delete(key);
  if (state.saving.has(key)) return state.saving.get(key);
  if (!state.dirty.has(key) || !profileReady()) return;
  const task = (async () => {
    // Serialise writes per review, so an older request cannot overwrite a newer edit.
    while (state.dirty.has(key)) {
      const revision = state.revisions.get(key), row = { ...state.dirty.get(key) };
      try {
        if (!isOpen(state.season)) throw new Error('征集已关闭，草稿保留在本机。');
        if (row.invalidScore !== undefined) throw new Error('评分需为 0～5，最多一位小数。');
        const saved = await state.store.saveReview(row);
        if (state.revisions.get(key) === revision) { state.reviews.set(key, saved); state.dirty.delete(key); state.errors.delete(key); stashDrafts(); syncCommunityReview(saved); }
      } catch (error) { state.errors.set(key, message(error)); break; }
    }
  })();
  state.saving.set(key, task); updateCard(state.reviews.get(key)?.anime_id); updateProgress();
  await task;
  state.saving.delete(key); updateCard(state.reviews.get(key)?.anime_id); updateProgress();
}
async function flushAll() { await Promise.all([...state.dirty.keys()].map(flushKey)); }
async function activate(store) {
  const data = await store.publicData();
  const profile = await store.profile();
  const reviews = await store.reviews();
  state.store = store; state.season = data.season; state.anime = data.anime; state.profile = profile; state.phase = data.season.current_phase;
  state.reviews = new Map(reviews.map(r => [reviewKey(r.anime_id, r.phase), r]));
  state.dirty.clear(); state.errors.clear();
  state.community.clear(); state.communitySeq++;
  restoreDrafts(); setConnection(); renderSeason(); renderList(); $('#error-notice').hidden = true;
  if (state.profile && !profileReady()) { toast('请补充 QQ 号，原有评价仍会保留。'); openProfile(); }
  else if (state.dirty.size) { toast('已找回上次未完成的草稿，正在尝试保存。'); void flushAll(); }
}
function openProfile() {
  if (!state.store) { toast('云端尚未连接，请检查网络后重试。'); return; }
  $('#profile-cn').value = state.profile?.cn || ''; $('#profile-qq').value = state.profile?.qq || ''; $('#profile-error').textContent = '';
  $('#profile-dialog').showModal();
}
function download(csv, filename) {
  const url = URL.createObjectURL(new Blob([csv], { type:'text/csv;charset=utf-8;' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportMine() {
  if (!profileReady()) { openProfile(); return; }
  if (!state.season) { toast('当前还没有番季，暂时不能导出。'); return; }
  await flushAll();
  if (state.dirty.size) { toast('仍有未保存或无效的内容，请先重试保存，再导出。'); return; }
  const rows = [...state.reviews.values()].filter(r => state.anime.some(a => a.id === r.anime_id));
  download(buildExport(state.anime, rows, [state.profile]), `${state.season.id}-我的评价.csv`);
}
function switchView(view) {
  state.view = view; $('#member-view').hidden = view !== 'member'; $('#admin-view').hidden = view !== 'admin';
  $('#admin-workspace').hidden = !state.admin || view === 'admin';
  if (view === 'admin') $('#admin-view').scrollIntoView({ block:'start', behavior:'smooth' });
}
function renderAdminSeasons() {
  const selected = state.adminData?.season || state.adminSeasons.find(s => s.id === state.adminSeasonId);
  const current = state.adminSeasons.find(s => s.is_current);
  $('#admin-season').innerHTML = state.adminSeasons.map(s => `<option value="${esc(s.id)}" ${s.id === state.adminSeasonId ? 'selected' : ''}>${esc(s.title)}${s.is_current ? ' · 当期' : ''}</option>`).join('');
  $('#admin-current-label').textContent = current
    ? `当前对社员展示：${current.title}（${current.id}）`
    : '还没有设置当期番季；社员端会提示联系管理员。';
  const isCurrent = Boolean(selected?.is_current);
  $('#admin-set-current').disabled = !selected || isCurrent;
  $('#admin-set-current').textContent = isCurrent ? '已是当期' : '设为当期';
}
async function refreshMemberData() {
  if (!state.store) return;
  const data = await state.store.publicData();
  state.season = data.season;
  state.anime = data.anime;
  state.phase = data.season.current_phase;
  state.community.clear(); state.communitySeq++;
  renderSeason(); renderList();
}
async function loadAdmin(seasonId) {
  const request = ++state.adminLoadRequest;
  const seasons = await state.admin.seasons();
  if (request !== state.adminLoadRequest) return;
  state.adminSeasons = seasons;
  if (!seasons.length) {
    state.adminData = null; state.adminSeasonId = null;
    renderAdminSeasons(); renderAdminResults();
    $('#admin-stats').textContent = '还没有番季，请先新建一个番季。';
    $('#admin-anime-count').textContent = '0 部';
    $('#admin-season-anime').innerHTML = '<p class="field-help">先新建番季，再导入或新增番剧。</p>';
    $('#admin-anime').innerHTML = '<p class="field-help">先新建番季，再导入或新增番剧。</p>';
    return;
  }
  const target = seasonId || state.adminSeasonId || seasons.find(s => s.is_current)?.id || seasons[0].id;
  const data = await state.admin.adminData(target);
  if (request !== state.adminLoadRequest) return;
  state.adminSeasonId = target;
  state.adminData = data;
  renderAdminSeasons();
  $('#admin-stats').textContent = `${data.season.title}：已收到 ${new Set(data.reviews.filter(hasContent).map(r => r.user_id)).size} 位社员的 ${data.reviews.filter(hasContent).length} 条评价。`;
  $('#admin-phase').value = data.season.current_phase;
  $('#admin-open').checked = data.season.is_open;
  renderAdminResults();
  const counts = new Map();
  for (const review of data.reviews) if (hasContent(review)) counts.set(review.anime_id, (counts.get(review.anime_id) || 0) + 1);
  $('#admin-anime-count').textContent = `${data.anime.length} 部`;
  $('#admin-season-anime').innerHTML = data.anime.map((anime, index) => `<div class="suggestion-row"><span><span class="anime-number">${String(index + 1).padStart(2, '0')}</span> ${esc(anime.title)}<small class="field-help">${anime.is_approved ? '已公开' : '待确认'}</small></span><span class="review-status ${counts.get(anime.id) ? 'done' : ''}">${counts.get(anime.id) || 0} 条</span></div>`).join('') || '<p class="field-help">这一季还没有番剧，可以用「新增番剧」或命令行导入。</p>';
  $('#admin-anime').innerHTML = data.anime.filter(a => a.created_by || !a.is_approved).map(a => `<div class="suggestion-row"><span>${esc(a.title)}<small class="field-help">${a.is_approved ? ' · 已加入公共片单' : ' · 待确认'}</small></span><button class="button button-small ${a.is_approved ? 'button-outline' : ''}" ${a.is_approved ? 'data-unapprove' : 'data-approve'}="${esc(a.id)}">${a.is_approved ? '撤回公开' : '确认加入片单'}</button></div>`).join('') || '<p class="field-help">暂时没有新增番剧。</p>';
}
function renderAdminResults() {
  if (!state.adminData) { $('#admin-results').innerHTML = '<p class="field-help">选择或新建一个番季后，这里会显示汇总。</p>'; return; }
  const { anime, reviews, profiles } = state.adminData, q = $('#admin-search').value.toLocaleLowerCase().trim();
  const titles = new Map(anime.map(a => [a.id, a.title])), names = new Map(profiles.map(p => [p.id, p.qq ? `${p.cn}（${p.qq}）` : p.cn]));
  const relevant = reviews.filter(hasContent).filter(r => `${titles.get(r.anime_id)} ${names.get(r.user_id)} ${r.comment}`.toLocaleLowerCase().includes(q));
  const summaries = anime.map(a => {
    const stats = ['early','final'].map(phase => {
      const rated = relevant.filter(r => r.anime_id === a.id && r.phase === phase && r.score !== null);
      return rated.length ? `${phase === 'early' ? '前中期' : '完结'}均分 ${(rated.reduce((sum,r) => sum + Number(r.score),0) / rated.length).toFixed(2)}（${rated.length}人）` : '';
    }).filter(Boolean).join(' · ');
    return stats ? `<div class="admin-result"><h4>${esc(a.title)}</h4><small>${esc(stats)}</small></div>` : '';
  }).join('');
  $('#admin-results').innerHTML = `<h3 style="margin-top:20px">评分概览${q ? '（当前筛选）' : ''}</h3>${summaries || '<p class="field-help">暂无有效评分。</p>'}<h3 style="margin-top:20px">评价原文</h3>` + (relevant.map(r => `<article class="admin-result"><h4>${esc(titles.get(r.anime_id))}</h4><div class="result-meta">${esc(names.get(r.user_id) || '未命名')} · ${PHASES[r.phase]} · ${r.score === null ? '未打分' : `${r.score} / 5`}</div><p>${esc(r.comment || '仅评分，未写吐槽')}</p><small>${esc(new Date(r.updated_at).toLocaleString('zh-CN'))}</small></article>`).join('') || '<p class="field-help">暂无符合条件的评价。</p>');
}

$('#identity-button').addEventListener('click', openProfile);
$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('#profile-error').textContent = '';
  try {
    const data = validateProfile($('#profile-cn').value, $('#profile-qq').value);
    state.profile = await state.store.saveProfile(data);
    const reviews = await state.store.reviews();
    for (const r of reviews) if (!state.dirty.has(reviewKey(r.anime_id,r.phase))) state.reviews.set(reviewKey(r.anime_id,r.phase), r);
    state.community.clear(); state.communitySeq++;
    restoreDrafts(); $('#profile-dialog').close(); renderList();
    if (state.dirty.size) void flushAll();
    toast(state.store.mode === 'cloud' ? '资料已保存，可以开始记录啦。' : '体验资料已保存在当前浏览器。');
  } catch(error) { $('#profile-error').textContent = message(error); } finally { button.disabled = false; }
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => { void flushAll(); state.phase = button.dataset.phase; renderList(); }));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; renderList(); }));
$('#search').addEventListener('input', event => { state.query = event.target.value.trim(); renderList(); });
$('#clear-search').addEventListener('click', () => { state.query = ''; state.filter = 'all'; $('#search').value = ''; renderList(); });
document.addEventListener('keydown', event => { if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#search').focus(); } });
$('#anime-list').addEventListener('input', event => {
  const input = event.target, card = input.closest('.anime-card');
  if (!card || !input.dataset.field) return;
  const id = card.dataset.id;
  if (input.dataset.field === 'score') {
    try { editReview(id, { score: validateScore(input.value), invalidScore: undefined }); input.setCustomValidity(''); }
    catch(error) { input.setCustomValidity(message(error)); editReview(id, { score: null, invalidScore: input.value }); state.errors.set(reviewKey(id,state.phase), message(error)); updateCard(id); updateProgress(); }
  } else editReview(id, { comment: input.value });
});
$('#anime-list').addEventListener('toggle', event => {
  const card = event.target.closest('.anime-card');
  if (card?.open) void loadCommunity(card.dataset.id);
}, true);
$('#anime-list').addEventListener('error', event => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.closest('.anime-cover')) image.hidden = true;
}, true);
$('#anime-list').addEventListener('click', async event => {
  const button = event.target.closest('button'), card = button?.closest('.anime-card');
  if (!button || !card) return;
  const id = card.dataset.id;
  if (button.dataset.communityPage !== undefined) { changeCommunityPage(id, Number(button.dataset.communityPage)); return; }
  if (button.hasAttribute('data-community-retry')) { void loadCommunity(id, true); return; }
  if (button.hasAttribute('data-login')) { openProfile(); return; }
  if (button.dataset.score) { card.querySelector('[data-field=score]').value = button.dataset.score; card.querySelector('[data-field=score]').setCustomValidity(''); editReview(id, { score:Number(button.dataset.score), invalidScore:undefined }); }
  if (button.hasAttribute('data-save')) void flushKey(reviewKey(id, state.phase));
  if (button.hasAttribute('data-clear') && state.profile && isOpen(state.season) && await confirmAction('清空这条评价？','将清空这部番剧当前阶段的评分和吐槽。另一阶段的记录会保留。','确认清空')) {
    card.querySelector('[data-field=score]').value = ''; card.querySelector('[data-field=score]').setCustomValidity(''); card.querySelector('textarea').value = ''; editReview(id, { score:null, comment:'', invalidScore:undefined }); void flushKey(reviewKey(id, state.phase));
  }
});
$('#add-anime-button').addEventListener('click', () => {
  if (!state.admin) { toast('只有管理员可以新增番剧。'); return; }
  if (!state.adminSeasonId) { toast('请先新建或选择一个番季。'); return; }
  $('#add-anime-title').value = ''; $('#add-anime-error').textContent = ''; $('#add-anime-dialog').showModal();
});
$('#add-anime-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try {
    if (!state.admin) throw new Error('只有管理员可以新增番剧。');
    if (!state.adminSeasonId) throw new Error('请先新建或选择一个番季。');
    const title = $('#add-anime-title').value.trim();
    if (!title || title.length > 200) throw new Error('请填写 1～200 字的番剧名称。');
    if (state.adminData.anime.some(a => a.title.toLocaleLowerCase() === title.toLocaleLowerCase())) throw new Error('这部番剧已经在片单中了。');
    await state.admin.addAnime(title, state.adminSeasonId);
    await loadAdmin(state.adminSeasonId);
    if (state.adminData.season.is_current) await refreshMemberData();
    $('#add-anime-dialog').close(); toast(`已加入「${state.adminData.season.title}」的片单。`);
  } catch(error) { $('#add-anime-error').textContent = message(error); } finally { event.submitter.disabled = false; }
});
$('#my-export').addEventListener('click', () => void exportMine());
$('#reload-button').addEventListener('click', () => location.reload());
$('#admin-button').addEventListener('click', () => {
  if (!configured) { toast('管理员功能需要先连接 Supabase。'); return; }
  $('#admin-error').textContent = ''; $('#admin-dialog').showModal();
});
$('#admin-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true; $('#admin-error').textContent = '';
  try {
    const admin = state.admin || await createCloudStore(config, 'admin');
    await admin.login($('#admin-email').value.trim(), $('#admin-password').value);
    if (!await admin.isAdmin()) { await admin.logout(); throw new Error('此账号尚未获得管理员权限，请联系项目管理者授权。'); }
    state.admin = admin; await loadAdmin(); $('#admin-dialog').close(); $('#admin-password').value = ''; $('#admin-button').hidden = true; $('#admin-logout').hidden = false; switchView('admin');
  } catch(error) { $('#admin-error').textContent = message(error); } finally { event.submitter.disabled = false; }
});
$('#back-member').addEventListener('click', () => switchView('member'));
$('#admin-workspace').addEventListener('click', async () => { try { await loadAdmin(state.adminSeasonId); switchView('admin'); } catch(error) { toast(message(error)); } });
$('#admin-logout').addEventListener('click', async () => {
  try {
    await state.admin.logout();
    state.admin = null; state.adminData = null; state.adminSeasons = []; state.adminSeasonId = null; state.adminLoadRequest++;
    $('#admin-button').hidden = false; $('#admin-logout').hidden = true;
    switchView('member'); toast('已退出管理员会话，社员身份仍保留。');
  } catch(error) { toast(message(error)); }
});
$('#refresh-admin').addEventListener('click', async () => { try { await loadAdmin(state.adminSeasonId); toast('汇总已刷新。'); } catch(error) { toast(message(error)); } });
$('#admin-search').addEventListener('input', renderAdminResults);
$('#admin-season').addEventListener('change', async event => {
  try { await loadAdmin(event.target.value); } catch(error) { toast(message(error)); }
});
$('#new-season-button').addEventListener('click', () => {
  if (!state.admin) return;
  const now = new Date();
  const month = [1, 4, 7, 10].filter(value => value <= now.getMonth() + 1).pop() || 1;
  $('#season-year').value = now.getFullYear();
  $('#season-month').value = String(month);
  $('#season-create-error').textContent = '';
  $('#season-dialog').showModal();
});
$('#season-create-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try {
    if (!state.admin) throw new Error('只有管理员可以创建番季。');
    const season = await state.admin.createSeason(Number($('#season-year').value), Number($('#season-month').value));
    await loadAdmin(season.id);
    $('#season-dialog').close();
    toast(`「${season.title}」已准备好。确认片单后点「设为当期」。`);
  } catch(error) { $('#season-create-error').textContent = message(error); } finally { event.submitter.disabled = false; }
});
$('#admin-set-current').addEventListener('click', async () => {
  const season = state.adminData?.season;
  if (!season || season.is_current) return;
  if (!await confirmAction('把这一季设为当期？', `设为当期后，普通社员只能看到「${season.title}」。旧番季的评价仍保留，可以在管理台切换查看和导出。`, '设为当期')) return;
  const button = $('#admin-set-current'); button.disabled = true;
  try {
    await state.admin.setCurrentSeason(season.id);
    await loadAdmin(season.id);
    try { await refreshMemberData(); } catch { /* 管理员刷新页面后仍会看到新当期 */ }
    toast(`「${season.title}」已设为当期，社员刷新后生效。`);
  } catch(error) { toast(message(error)); } finally { renderAdminSeasons(); }
});
$('#season-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try {
    if (!state.adminSeasonId) throw new Error('请先新建或选择一个番季。');
    const updated = await state.admin.updateSeason(state.adminSeasonId, { current_phase:$('#admin-phase').value, is_open:$('#admin-open').checked });
    await loadAdmin(state.adminSeasonId);
    if (updated.is_current) await refreshMemberData();
    toast(`「${updated.title}」的设置已更新。`);
  } catch(error) { toast(message(error)); } finally { event.submitter.disabled = false; }
});
$('#admin-anime').addEventListener('click', async event => {
  const button = event.target.closest('[data-approve],[data-unapprove]'); if (!button) return; button.disabled = true;
  const approved=button.hasAttribute('data-approve'), id=approved ? button.dataset.approve : button.dataset.unapprove;
  try {
    await state.admin.approve(id,approved);
    await loadAdmin(state.adminSeasonId);
    if (state.adminData.season.is_current) await refreshMemberData();
    toast(approved ? '已加入公共片单。' : '已撤回公开，原评价仍保留。');
  } catch(error) { button.disabled = false; toast(message(error)); }
});
$('#export-summary').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await loadAdmin(state.adminSeasonId);
    const d = state.adminData;
    if (!d) throw new Error('请先选择番季。');
    download(buildExport(d.anime,d.reviews,d.profiles,'summary'), `${d.season.id}-汇总表.csv`);
  }
  catch(error) { toast(message(error)); } finally { button.disabled = false; }
});
window.addEventListener('beforeunload', event => { if (state.dirty.size) { stashDrafts(); event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('online', () => { if (state.dirty.size) { toast('网络已恢复，正在重试保存。'); void flushAll(); } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { stashDrafts(); void flushAll(); } });


async function init() {
  setLoading(true);
  if (!configured) {
    setLoading(false);
    setConnection();
    setUnavailable('尚未配置');
    $('#season-title').innerHTML = '云端未配置<span>请联系管理员完成连接。</span>';
    $('#season-stamp').textContent = 'NO CONFIG';
    return;
  }
  try {
    const cloud = await createCloudStore(config);
    state.loading = false;
    await activate(cloud);
    setLoading(false);
    try {
      const admin = await createCloudStore(config,'admin');
      if (admin.user && await admin.isAdmin()) { state.admin = admin; $('#admin-button').hidden = true; $('#admin-workspace').hidden = false; $('#admin-logout').hidden = false; }
    } catch { toast('管理员会话暂未恢复，需要管理时可重新登录。'); }
  } catch(error) {
    setLoading(false);
    if (error?.code === 'NO_CURRENT_SEASON') {
      state.season = null; state.anime = []; renderSeason(); renderList();
    } else {
      setUnavailable('读取失败');
      $('#season-title').innerHTML = '暂时无法读取番季<span>请检查网络后重试。</span>';
      $('#season-stamp').textContent = 'OFFLINE';
    }
    $('#error-title').textContent = error?.code === 'NO_CURRENT_SEASON'
      ? '还没有设置当期番季'
      : error?.code === 'PGRST205' || error?.code === '42P01' ? '云端尚未初始化' : '暂时无法加载云端数据';
    $('#error-message').textContent = message(error); $('#error-notice').hidden = false; setConnection();
  }
}
void init();
