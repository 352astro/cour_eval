export const TABLES = { seasons: 'club_seasons', anime: 'club_anime', profiles: 'club_profiles', reviews: 'club_reviews', admins: 'club_admins', feedback: 'club_feedback' };
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
  let userTask = null;
  let profileId = null;
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
      if (!user) {
        // 同一页面可能同时触发“保存资料”和“读取评价”，只创建一次匿名身份。
        userTask ||= (async () => {
          user = checked(await client.auth.signInAnonymously()).user;
          return user;
        })().finally(() => { userTask = null; });
        await userTask;
      }
      if (!user) throw new Error('无法创建匿名身份，请检查是否已启用 Anonymous Sign-Ins。');
      return user;
    },
    async profile() {
      if (!user) { profileId = null; return null; }
      const profile = checked(await client.from(TABLES.profiles).select('id,cn,qq,updated_at').maybeSingle());
      profileId = profile?.id || null;
      return profile;
    },
    async loginProfile(data) {
      await this.ensureUser();
      const attempt = () => client.rpc('club_login', { p_cn: data.cn, p_qq: data.qq });
      let result;
      try {
        result = checked(await attempt());
      } catch (error) {
        if (error?.code !== '23503') throw error;
        // 匿名会话已被删除（例如管理员清理账号后旧浏览器仍留着 token）。
        // 丢掉旧会话，新建匿名身份后重试一次。
        try { await client.auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
        user = null; profileId = null;
        await this.ensureUser();
        result = checked(await attempt());
      }
      const profile = Array.isArray(result) ? result[0] : result;
      profileId = profile?.id || null;
      return profile;
    },
    async reviews() {
      if (!profileId) return [];
      return allRows(() => client.from(TABLES.reviews).select('*').eq('user_id', profileId).order('anime_id').order('phase'));
    },
    async animeReviews(animeId) {
      return checked(await client.rpc('club_anime_reviews', { p_anime: animeId }));
    },
    async submitFeedback(data) {
      if (!profileId) throw new Error('请先登录后再提交反馈。');
      return checked(await client.rpc('club_submit_feedback', {
        p_kind: data.kind,
        p_content: data.content,
        p_page: `${location.origin}${location.pathname}`,
        p_user_agent: navigator.userAgent,
      }));
    },
    async saveReview(data) {
      if (!profileId) throw new Error('请先填写 CN 和 QQ。');
      return checked(await client.from(TABLES.reviews).upsert({ user_id: profileId, anime_id: data.anime_id, phase: data.phase, score: data.score, comment: data.comment }, { onConflict: 'user_id,anime_id,phase' }).select().single());
    },
    async addAnime(title, seasonId) {
      if (scope !== 'admin' || !await this.isAdmin()) throw new Error('只有管理员可以新增番剧。');
      return checked(await client.from(TABLES.anime).insert({ id: crypto.randomUUID(), season_id: seasonId, title, is_approved: true, created_by: user.id }).select().single());
    },
    async login(email, password) { user = checked(await client.auth.signInWithPassword({ email, password })).user; profileId = null; },
    async isAdmin() { return Boolean(user && checked(await client.from(TABLES.admins).select('user_id').eq('user_id', user.id).maybeSingle())); },
    async adminData(seasonId) {
      const [season, anime, profiles, feedback] = await Promise.all([
        client.from(TABLES.seasons).select('*').eq('id', seasonId).single(),
        animeOfSeason(seasonId),
        allRows(() => client.from(TABLES.profiles).select('id,cn,qq,updated_at').order('id')),
        allRows(() => client.from(TABLES.feedback).select('*').order('created_at', { ascending: false })),
      ]);
      const ids = anime.map(a => a.id);
      const reviews = ids.length
        ? await allRows(() => client.from(TABLES.reviews).select('*').in('anime_id', ids).order('user_id').order('anime_id').order('phase'))
        : [];
      return { season: checked(season), anime, reviews, profiles, feedback };
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
    async resolveFeedback(id, resolved) {
      return checked(await client.from(TABLES.feedback).update({
        status: resolved ? 'resolved' : 'open',
        resolved_at: resolved ? new Date().toISOString() : null,
      }).eq('id', id).select().single());
    },
    async logout() { checked(await client.auth.signOut()); user = null; profileId = null; },
  };
}
