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
  const animeOfSeason = seasonId => allRows(() => client.from(TABLES.anime).select('*').eq('season_id', seasonId).order('sort_order').order('id'));
  async function currentSeason() {
    const season = checked(await client.from(TABLES.seasons).select('*').eq('is_current', true).maybeSingle());
    if (!season) {
      const error = new Error('当前还没有设置征集的番季，请联系管理员。');
      error.code = 'NO_CURRENT_SEASON';
      throw error;
    }
    return season;
  }
  return {
    mode: 'cloud', client,
    get user() { return user; },
    async publicData() {
      const season = await currentSeason();
      return { season, anime: await animeOfSeason(season.id) };
    },
    async seasonData(seasonId) {
      const season = checked(await client.from(TABLES.seasons).select('*').eq('id', seasonId).single());
      return { season, anime: await animeOfSeason(season.id) };
    },
    async seasons() {
      return allRows(() => client.from(TABLES.seasons).select('*').order('year', { ascending: false }).order('month', { ascending: false }));
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
    async addAnime(title, seasonId) {
      if (scope !== 'admin' || !await this.isAdmin()) throw new Error('只有管理员可以新增番剧。');
      return checked(await client.from(TABLES.anime).insert({ id: crypto.randomUUID(), season_id: seasonId, title, is_approved: true, created_by: user.id }).select().single());
    },
    async login(email, password) { user = checked(await client.auth.signInWithPassword({ email, password })).user; },
    async isAdmin() { return Boolean(user && checked(await client.from(TABLES.admins).select('user_id').eq('user_id', user.id).maybeSingle())); },
    async adminData(seasonId) {
      const [season, anime, profiles] = await Promise.all([
        client.from(TABLES.seasons).select('*').eq('id', seasonId).single(),
        animeOfSeason(seasonId),
        allRows(() => client.from(TABLES.profiles).select('id,cn,qq,updated_at').order('id')),
      ]);
      const ids = anime.map(a => a.id);
      const reviews = ids.length
        ? await allRows(() => client.from(TABLES.reviews).select('*').in('anime_id', ids).order('user_id').order('anime_id').order('phase'))
        : [];
      return { season: checked(season), anime, reviews, profiles };
    },
    async updateSeason(seasonId, patch) {
      return checked(await client.from(TABLES.seasons).update(patch).eq('id', seasonId).select().single());
    },
    async createSeason(year, month) {
      if (scope !== 'admin' || !await this.isAdmin()) throw new Error('只有管理员可以创建番季。');
      const data = checked(await client.rpc('club_create_season', { p_year: year, p_month: month }));
      return Array.isArray(data) ? data[0] : data;
    },
    async setCurrentSeason(seasonId) {
      if (scope !== 'admin' || !await this.isAdmin()) throw new Error('只有管理员可以切换当期番季。');
      const data = checked(await client.rpc('club_set_current_season', { p_season: seasonId }));
      return Array.isArray(data) ? data[0] : data;
    },
    async approve(id, approved = true) { return checked(await client.from(TABLES.anime).update({ is_approved: approved }).eq('id', id).select().single()); },
    async logout() { checked(await client.auth.signOut()); user = null; },
  };
}
