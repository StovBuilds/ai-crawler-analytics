// Pull AI crawler activity for one Cloudflare zone from the GraphQL Analytics API and shape it
// into the JSON the dashboard reads. Uses global fetch, so it runs unchanged in Node 18+ and in a
// Cloudflare Worker. Read-only: the token needs Zone > Analytics > Read and nothing else.

import { matchCrawler, isProbePath } from './classify.js';
import { verdictFor } from './verify.js';

const API = 'https://api.cloudflare.com/client/v4';
export const TIERS = ['training', 'retrieval', 'user'];

async function gql(token, query, variables, fetchImpl) {
  const res = await fetchImpl(`${API}/graphql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.errors?.length) {
    const e = new Error(j.errors.map((x) => x.message).join('; '));
    e.authz = j.errors.some((x) => x.extensions?.code === 'authz');
    throw e;
  }
  if (!res.ok || !j.data) throw new Error(`Cloudflare GraphQL HTTP ${res.status}`);
  return j.data;
}

/** Look a zone id up by domain name (needs Zone > Zone > Read; optional, you can pass the id). */
export async function zoneIdFor(token, name, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/zones?name=${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (!j.success || !j.result?.length) throw new Error(`zone ${name} not found for this token (${j.errors?.[0]?.message ?? 'no result'})`);
  return j.result[0].id;
}

const aiQuery = (withIp) => `query ($zone: String!, $date: Date!, $or: [ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!], $notIps: [string!]) {
  viewer { zones(filter: { zoneTag: $zone }) {
    total: httpRequestsAdaptiveGroups(limit: 1, filter: { date: $date }) { count }
    ai: httpRequestsAdaptiveGroups(limit: 10000, orderBy: [count_DESC],
        filter: { date: $date, requestSource: "eyeball", clientIP_notin: $notIps, OR: $or }) {
      count dimensions { userAgent clientRequestPath verifiedBotCategory edgeResponseStatus${withIp ? ' clientIP' : ''} }
    }
  } }
}`;

// Referer and query-string dimensions are not available on the Free plan; tried once, skipped on authz.
const REF_QUERY = `query ($zone: String!, $date: Date!, $hosts: [string!]) {
  viewer { zones(filter: { zoneTag: $zone }) {
    ref: httpRequestsAdaptiveGroups(limit: 1000, filter: { date: $date, requestSource: "eyeball", clientRefererHost_in: $hosts }) {
      count dimensions { clientRefererHost }
    }
  } }
}`;

function statusClass(s) {
  if (s >= 200 && s < 400) return 'ok';
  if (s === 404 || s === 410) return 'notFound';
  if (s === 401 || s === 403 || s === 429) return 'blocked';
  return 'other';
}

function emptyDay(date) {
  return {
    date,
    totalRequests: 0,
    tiers: { training: 0, retrieval: 0, user: 0 },
    verified: { training: 0, retrieval: 0, user: 0 },
    status: { ok: 0, blocked: 0, notFound: 0, other: 0 },
    bots: {},
    excluded: { probePaths: 0, ownTraffic: 0, notAPage: 0, offSitemap: 0 },
    referrals: null,
    truncated: false,
  };
}

/** YYYY-MM-DD for `n` days before today (UTC). Today is incomplete, so day 1 is yesterday. */
export function daysBack(n, now = new Date()) {
  const out = [];
  for (let i = n; i >= 1; i--) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)).toISOString().slice(0, 10));
  return out;
}

// Files a crawler may legitimately read that will not be in a sitemap.
const ALWAYS_REAL = new Set(['/robots.txt', '/llms.txt', '/llms-full.txt', '/sitemap.xml', '/ai.txt']);
// Coding agents that fetch pages as Claude-User / ChatGPT-User etc. Still a person at the keyboard,
// but often the site owner's own agents: shown as a separate row so they can be discounted.
const AGENT_TOOLS = [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor']];

export function normalisePath(p) {
  const x = String(p || '/').split(/[?#]/)[0] || '/';
  return x.length > 1 ? x.replace(/\/+$/, '') : x;
}

/**
 * Collect one day. Options:
 *   excludeIps  - your own server / office IPs (exact match), dropped in the query
 *   excludeUa   - substrings marking your own monitors (e.g. a tag you add to probe UAs)
 *   ipRanges    - optional result of loadRanges() (src/verify.js). Adds the clientIP dimension (more
 *                 rows per day) and checks each read against the vendor's published IP ranges. Only the
 *                 verdict is kept (`ipVerdicts` per bot); the IP itself is never stored.
 *   pagePaths   - optional Set of your real page paths (e.g. from the sitemap). When given, reads of
 *                 anything else are excluded as `offSitemap` instead of counted.
 *
 * A read only counts towards a tier when it is a real page that was served (2xx/3xx). Refusals
 * (401/403/429) are counted per bot as `blocked` but not as reads; 404s and errors are dropped as
 * `notAPage`. Scanners mostly ask for files that do not exist, so this is the strongest filter.
 */
export async function collectDay({ token, zoneId, date, crawlers, referrers, excludeIps = [], excludeUa = [], pagePaths = null, fetchImpl = fetch, tryReferrals = true, ipRanges = null }) {
  const day = emptyDay(date);
  const or = crawlers.map((c) => ({ userAgent_like: `%${c.match}%` }));
  const d = await gql(token, aiQuery(!!ipRanges), { zone: zoneId, date, or, notIps: excludeIps.length ? excludeIps : ['0.0.0.0'] }, fetchImpl);
  const z = d.viewer.zones[0] ?? { total: [], ai: [] };
  day.totalRequests = z.total?.[0]?.count ?? 0;
  day.truncated = (z.ai?.length ?? 0) >= 10000;
  const own = excludeUa.map((s) => s.toLowerCase()).filter(Boolean);
  const paths = {};
  const userReads = {};
  for (const g of z.ai ?? []) {
    const ua = g.dimensions.userAgent || '';
    const c = matchCrawler(ua, crawlers);
    if (!c) continue; // LIKE is broader than our match rules; ignore anything that is not a listed crawler
    const path = normalisePath(g.dimensions.clientRequestPath);
    const sc = statusClass(g.dimensions.edgeResponseStatus);
    day.status[sc] += g.count;
    if (own.some((s) => ua.toLowerCase().includes(s))) { day.excluded.ownTraffic += g.count; continue; }
    if (isProbePath(path)) { day.excluded.probePaths += g.count; continue; }
    if (sc === 'notFound' || sc === 'other') { day.excluded.notAPage += g.count; continue; }
    if (pagePaths && !pagePaths.has(path) && !ALWAYS_REAL.has(path)) { day.excluded.offSitemap += g.count; continue; }
    const tool = AGENT_TOOLS.find(([t]) => ua.toLowerCase().includes(t));
    const name = tool ? `${c.name} via ${tool[1]}` : c.name;
    const b = (day.bots[name] ??= { vendor: c.vendor, tier: c.tier, count: 0, verified: 0, blocked: 0, agentTool: tool ? tool[1] : undefined });
    if (sc === 'blocked') { b.blocked += g.count; continue; }
    const v = /^AI /.test(g.dimensions.verifiedBotCategory || '');
    day.tiers[c.tier] += g.count;
    b.count += g.count;
    if (v) { day.verified[c.tier] += g.count; b.verified += g.count; }
    if (ipRanges) {
      const verdict = verdictFor(g.dimensions.clientIP, c.name, ipRanges);
      const iv = (b.ipVerdicts ??= {});
      iv[verdict] = (iv[verdict] ?? 0) + g.count;
    }
    if (c.tier === 'user') {
      paths[path] = (paths[path] ?? 0) + g.count;
      userReads[`${name}\t${path}`] = (userReads[`${name}\t${path}`] ?? 0) + g.count;
    }
  }
  day.userPaths = paths;
  day.userReads = userReads;
  if (tryReferrals && referrers?.length) {
    try {
      const hosts = referrers.flatMap((r) => r.hosts.flatMap((h) => [h, `www.${h}`]));
      const r = await gql(token, REF_QUERY, { zone: zoneId, date, hosts }, fetchImpl);
      const by = {};
      for (const g of r.viewer.zones[0]?.ref ?? []) {
        const host = g.dimensions.clientRefererHost.replace(/^www\./, '');
        const ref = referrers.find((x) => x.hosts.includes(host));
        if (ref) by[ref.name] = (by[ref.name] ?? 0) + g.count;
      }
      day.referrals = { source: 'cloudflare-referer', byAssistant: by, total: Object.values(by).reduce((a, b) => a + b, 0) };
    } catch (e) {
      if (!e.authz) throw e;
      day.referrals = null; // plan has no Referer dimension: use dashboard/referral.js + the Worker instead
    }
  }
  return day;
}

/**
 * Collect `days` days plus the same number before them for the "vs prior period" comparison.
 * Cloudflare keeps adaptive data for a limited time (about two weeks on Free); days it no longer
 * holds come back empty and are marked `missing`.
 */
export async function collect({ token, zoneId, zoneName = '', days = 7, crawlers, referrers, excludeIps = [], excludeUa = [], pagePaths = null, fetchImpl = fetch, now = new Date(), log = () => {}, ipRanges = null }) {
  const dates = daysBack(days * 2, now);
  const out = [];
  let referralsAvailable = true;
  for (const date of dates) {
    log(`fetching ${date}`);
    try {
      const day = await collectDay({ token, zoneId, date, crawlers, referrers, excludeIps, excludeUa, pagePaths, fetchImpl, tryReferrals: referralsAvailable, ipRanges });
      if (day.referrals === null) referralsAvailable = false;
      out.push(day);
    } catch (e) {
      if (/limit|retention|too old|out of range|cannot request data older/i.test(e.message)) { out.push({ ...emptyDay(date), missing: true }); continue; }
      throw e;
    }
  }
  return summarise({ zoneName, days, data: out, referralsAvailable, sitemapFiltered: !!pagePaths });
}

function sumDays(ds) {
  const t = { training: 0, retrieval: 0, user: 0, verified: 0, blocked: 0, referrals: 0, probePaths: 0, ownTraffic: 0, notAPage: 0, offSitemap: 0 };
  for (const d of ds) {
    for (const k of TIERS) { t[k] += d.tiers[k]; t.verified += d.verified[k]; }
    t.blocked += Object.values(d.bots ?? {}).reduce((a, b) => a + (b.blocked || 0), 0);
    t.referrals += d.referrals?.total ?? 0;
    for (const k of ['probePaths', 'ownTraffic', 'notAPage', 'offSitemap']) t[k] += d.excluded[k] ?? 0;
  }
  return t;
}

/**
 * "Clockwork" readers: a user-asked bot fetching the same path on (nearly) every day of the window,
 * a couple of times at most each day. That is a scheduled monitor or someone's agent on a timer, not
 * people asking questions. Flagged and subtracted from the user-asked headline, never hidden.
 */
export function findClockwork(current) {
  const seen = {};
  const n = current.filter((d) => !d.missing).length;
  for (const d of current) for (const [k, c] of Object.entries(d.userReads ?? {})) {
    const x = (seen[k] ??= { days: 0, max: 0, total: 0 });
    x.days += 1; x.max = Math.max(x.max, c); x.total += c;
  }
  const need = Math.max(4, n - 1);
  return Object.entries(seen)
    .filter(([, x]) => n >= 4 && x.days >= need && x.max <= 2)
    .map(([k, x]) => { const [bot, path] = k.split('\t'); return { bot, path, days: x.days, reads: x.total }; })
    .sort((a, b) => b.reads - a.reads);
}

/** Turn the per-day rows into the dashboard's data file. Also used by the Worker on stored days. */
export function summarise({ zoneName, days, data, referralsAvailable, referralTracker = null, sitemapFiltered = false }) {
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));
  const current = sorted.slice(-days);
  const prior = sorted.slice(-days * 2, -days);
  const bots = {};
  const paths = {};
  for (const d of current) {
    for (const [name, b] of Object.entries(d.bots)) {
      const x = (bots[name] ??= { vendor: b.vendor, tier: b.tier, count: 0, verified: 0, blocked: 0, ...(b.agentTool ? { agentTool: b.agentTool } : {}) });
      x.count += b.count; x.verified += b.verified; x.blocked += b.blocked;
      for (const [k, n] of Object.entries(b.ipVerdicts ?? {})) { x.ipVerdicts ??= {}; x.ipVerdicts[k] = (x.ipVerdicts[k] ?? 0) + n; }
    }
    for (const [p, n] of Object.entries(d.userPaths ?? {})) paths[p] = (paths[p] ?? 0) + n;
  }
  const clockwork = findClockwork(current);
  const totals = sumDays(current);
  totals.userClockwork = clockwork.reduce((a, c) => a + c.reads, 0);
  totals.userAgentTools = Object.values(bots).filter((b) => b.agentTool && b.tier === 'user').reduce((a, b) => a + b.count, 0);
  return {
    schema: 'ai-crawler-analytics/1',
    site: zoneName,
    generated: new Date().toISOString(),
    window: { days, from: current[0]?.date ?? null, to: current.at(-1)?.date ?? null },
    referralsSource: referralTracker ? 'tracker' : referralsAvailable ? 'cloudflare-referer' : 'unavailable',
    sitemapFiltered,
    totals,
    priorTotals: prior.length === days && !prior.some((d) => d.missing) ? sumDays(prior) : null,
    daily: current.map(({ date, tiers, verified, status, excluded, referrals, missing, truncated, totalRequests }) => ({ date, totalRequests, tiers, verified, status, excluded, referrals: referrals?.total ?? null, missing: !!missing, truncated })),
    bots: Object.entries(bots).map(([name, b]) => ({ name, ...b })).filter((b) => b.count || b.blocked).sort((a, b) => b.count - a.count),
    clockwork,
    topUserAskedPaths: Object.entries(paths).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([path, count]) => ({ path, count })),
  };
}
