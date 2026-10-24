export const TABLES = { seasons: 'club_seasons', anime: 'club_anime', profiles: 'club_profiles', reviews: 'club_reviews', admins: 'club_admins' };
function checked(result) { if (result.error) throw result.error; return result.data; }
async function allRows(query) {
  let output = [];
  for (let start = 0; ; start += 1000) {
    const rows = checked(await query().range(start, start + 999));
    output.push(...rows);
    if (rows.length < 1000) return output;
  }
}
export async function createCloudStore(config, scope = 'member') {
  if (!window.supabase) await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './vendor/supabase.js'; script.onload = resolve;
    script.onerror = () => reject(new Error('Supabase 客户端加载失败，请刷新页面。'));
    document.head.append(script);
  });
  const client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: `anime-club-${scope}-${new URL(config.supabaseUrl).hostname}` },
    global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) }) },
  });
  let user = checked(await client.auth.getSession())?.session?.user || null;
  return {
    mode: 'cloud', client,
    get user() { return user; },
    async publicData() {
      const [season, anime] = await Promise.all([
        client.from(TABLES.seasons).select('*').eq('id', config.seasonId).single(),
        allRows(() => client.from(TABLES.anime).select('*').eq('season_id', config.seasonId).order('sort_order').order('id')),
      ]);
      return { season: checked(season), anime };
    },
    async ensureUser() {
      if (!user) user = checked(await client.auth.signInAnonymously()).user;
      if (!user) throw new Error('无法创建匿名身份，请检查是否已启用 Anonymous Sign-Ins。');
      return user;
    },
    async profile() { return user ? checked(await client.from(TABLES.profiles).select('id,cn,qq,updated_at').eq('id', user.id).maybeSingle()) : null; },
    async saveProfile(data) {
      await this.ensureUser();
      return checked(await client.from(TABLES.profiles).upsert({ id: user.id, cn: data.cn, qq: data.qq }).select('id,cn,qq,updated_at').single());
    },
    async reviews() {
      if (!user) return [];
      return allRows(() => client.from(TABLES.reviews).select('*').eq('user_id', user.id).order('anime_id').order('phase'));
    },
    async saveReview(data) {
      if (!user) throw new Error('请先填写资料。');
      return checked(await client.from(TABLES.reviews).upsert({ user_id: user.id, anime_id: data.anime_id, phase: data.phase, score: data.score, comment: data.comment }, { onConflict: 'user_id,anime_id,phase' }).select().single());
    },
    async addAnime(title) {
      if (scope !== 'admin' || !await this.isAdmin()) throw new Error('只有管理员可以新增番剧。');
      return checked(await client.from(TABLES.anime).insert({ id: crypto.randomUUID(), season_id: config.seasonId, title, is_approved: true, created_by: user.id }).select().single());
    },
    async login(email, password) { user = checked(await client.auth.signInWithPassword({ email, password })).user; },
    async isAdmin() { return Boolean(user && checked(await client.from(TABLES.admins).select('user_id').eq('user_id', user.id).maybeSingle())); },
    async adminData() {
      const [reviews, profiles, anime] = await Promise.all([
        allRows(() => client.from(TABLES.reviews).select('*').order('user_id').order('anime_id').order('phase')),
        allRows(() => client.from(TABLES.profiles).select('id,cn,qq,updated_at').order('id')),
        allRows(() => client.from(TABLES.anime).select('*').eq('season_id', config.seasonId).order('sort_order').order('id')),
      ]);
      const ids = new Set(anime.map(a => a.id));
      return { reviews: reviews.filter(r => ids.has(r.anime_id)), profiles, anime };
    },
    async updateSeason(patch) { return checked(await client.from(TABLES.seasons).update(patch).eq('id', config.seasonId).select().single()); },
    async approve(id,approved=true) { return checked(await client.from(TABLES.anime).update({ is_approved: approved }).eq('id', id).select().single()); },
    async logout() { checked(await client.auth.signOut()); user = null; },
  };
}

export function createDemoStore(catalog) {
  const key = 'anime-club-demo-v1';
  const stored = JSON.parse(localStorage.getItem(key) || 'null');
  let data = { profile: stored?.profile ? { id: 'local-member', cn: stored.profile.cn, qq: stored.profile.qq || null } : null, reviews: stored?.reviews || [] };
  const persist = () => localStorage.setItem(key, JSON.stringify(data));
  return {
    mode: 'demo',
    get user() { return data.profile ? { id: 'local-member' } : null; },
    async publicData() { return { season: { id: '2026-07', title: '2026 七月新番', current_phase: 'final', is_open: true }, anime: catalog }; },
    async profile() { return data.profile; },
    async saveProfile(profile) { data.profile = { id: 'local-member', cn: profile.cn, qq: profile.qq }; persist(); return data.profile; },
    async reviews() { return data.reviews; },
    async saveReview(review) {
      const row = { ...review, user_id: 'local-member', updated_at: new Date().toISOString() };
      const index = data.reviews.findIndex(r => r.anime_id === row.anime_id && r.phase === row.phase);
      if (index < 0) data.reviews.push(row); else data.reviews[index] = row;
      persist(); return row;
    },
    reset() { localStorage.removeItem(key); data = { profile: null, reviews: [] }; },
  };
}
