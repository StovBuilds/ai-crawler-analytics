// Optional Cloudflare Worker: keeps history past Cloudflare's short analytics retention, counts
// AI-assistant referrals on the Free plan, and serves the dashboard.
//
//   cron (daily)       collect any of the last 14 days not yet stored -> KV `day:YYYY-MM-DD`
//   POST /r            referral beacon from dashboard/referral.js -> KV `ref:YYYY-MM-DD`
//   GET  /api/data     dashboard data file (?days=7); add ?key= if you set DASH_KEY
//   everything else    the static dashboard (wrangler `assets`)
//
// Secrets/vars: CF_API_TOKEN (secret, Zone > Analytics > Read), ZONE_ID, ZONE_NAME, SITEMAP_URL,
// optional EXCLUDE_IPS / EXCLUDE_UA (comma lists), optional DASH_KEY, optional ALLOW_ORIGIN.

import crawlerData from '../data/ai-crawlers.json';
import referrerData from '../data/ai-referrers.json';
import { collectDay, daysBack, summarise } from '../src/collect.js';
import { matchReferrer } from '../src/classify.js';
import { sitemapPaths } from '../src/sitemap.js';

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);

async function backfill(env) {
  let pagePaths = null;
  if (env.SITEMAP_URL) {
    try { pagePaths = await sitemapPaths(env.SITEMAP_URL); if (pagePaths.size <= 1) pagePaths = null; } catch (e) { console.log(`sitemap failed: ${e.message}`); }
  }
  for (const date of daysBack(14)) {
    if (await env.STORE.get(`day:${date}`)) continue;
    try {
      const day = await collectDay({
        token: env.CF_API_TOKEN, zoneId: env.ZONE_ID, date,
        crawlers: crawlerData.crawlers, referrers: referrerData.referrers,
        excludeIps: list(env.EXCLUDE_IPS), excludeUa: list(env.EXCLUDE_UA), pagePaths,
        tryReferrals: env.CF_REFERRER !== 'off',
      });
      await env.STORE.put(`day:${date}`, JSON.stringify(day), { expirationTtl: 400 * 86400 });
    } catch (e) {
      console.log(`collect ${date} failed: ${e.message}`);
    }
  }
}

function cors(env, res) {
  res.headers.set('access-control-allow-origin', env.ALLOW_ORIGIN || '*');
  res.headers.set('access-control-allow-headers', 'content-type');
  return res;
}

async function referral(request, env) {
  let b = {};
  try { b = await request.json(); } catch { /* sendBeacon text body */ try { b = JSON.parse(await request.text()); } catch {} }
  const r = matchReferrer({ referer: b.ref, utmSource: b.utm }, referrerData.referrers);
  if (!r) return new Response(null, { status: 204 });
  // Read-modify-write on KV is not atomic: close-together clicks can undercount. Fine for a floor.
  const key = `ref:${today()}`;
  const cur = JSON.parse((await env.STORE.get(key)) || '{}');
  cur[r.name] = (cur[r.name] || 0) + 1;
  await env.STORE.put(key, JSON.stringify(cur), { expirationTtl: 400 * 86400 });
  return new Response(null, { status: 204 });
}

async function data(url, env) {
  if (env.DASH_KEY && url.searchParams.get('key') !== env.DASH_KEY) return new Response('forbidden', { status: 403 });
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 180);
  const dates = daysBack(days * 2);
  const rows = [];
  for (const date of dates) {
    const raw = await env.STORE.get(`day:${date}`);
    const day = raw ? JSON.parse(raw) : { date, totalRequests: 0, tiers: { training: 0, retrieval: 0, user: 0 }, verified: { training: 0, retrieval: 0, user: 0 }, status: { ok: 0, blocked: 0, notFound: 0, other: 0 }, bots: {}, excluded: { probePaths: 0, ownTraffic: 0, notAPage: 0, offSitemap: 0 }, referrals: null, missing: true };
    const ref = await env.STORE.get(`ref:${date}`);
    if (ref) {
      const by = JSON.parse(ref);
      const cf = day.referrals?.byAssistant ?? {};
      // One click can be seen by both channels: take the larger per assistant, never the sum.
      const merged = {};
      for (const k of new Set([...Object.keys(by), ...Object.keys(cf)])) merged[k] = Math.max(by[k] || 0, cf[k] || 0);
      day.referrals = { source: 'tracker', byAssistant: merged, total: Object.values(merged).reduce((a, b) => a + b, 0) };
    }
    rows.push(day);
  }
  const anyTracker = rows.some((d) => d.referrals?.source === 'tracker');
  const anyCf = rows.some((d) => d.referrals?.source === 'cloudflare-referer');
  const out = summarise({ zoneName: env.ZONE_NAME || '', days, data: rows, referralsAvailable: anyCf, referralTracker: anyTracker || null, sitemapFiltered: !!env.SITEMAP_URL });
  return Response.json(out, { headers: { 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
    if (url.pathname === '/r' && request.method === 'POST') return cors(env, await referral(request, env));
    if (url.pathname === '/api/data') return cors(env, await data(url, env));
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(backfill(env));
  },
};
