import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchCrawler, isProbePath, matchReferrer } from '../src/classify.js';
import { summarise, daysBack, collectDay } from '../src/collect.js';

const { crawlers, robotsOnly } = JSON.parse(readFileSync(new URL('../data/ai-crawlers.json', import.meta.url)));
const { referrers } = JSON.parse(readFileSync(new URL('../data/ai-referrers.json', import.meta.url)));

test('vendor bots land in the right tier, specific tokens before the training crawler', () => {
  const cases = {
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)': ['ClaudeBot', 'training'],
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +searchbot@anthropic.com)': ['Claude-SearchBot', 'retrieval'],
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)': ['Claude-User', 'user'],
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)': ['GPTBot', 'training'],
    'Mozilla/5.0 (compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot)': ['OAI-SearchBot', 'retrieval'],
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot': ['ChatGPT-User', 'user'],
    'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)': ['PerplexityBot', 'retrieval'],
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user': ['Perplexity-User', 'user'],
    'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)': ['meta-externalagent', 'training'],
    'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)': ['Meta-ExternalFetcher', 'user'],
    'Mozilla/5.0 (compatible; Amzn-SearchBot/0.1) Chrome/119.0.6045.214 Safari/537.36': ['Amzn-SearchBot', 'retrieval'],
  };
  for (const [ua, [name, tier]] of Object.entries(cases)) {
    const c = matchCrawler(ua, crawlers);
    assert.equal(c?.name, name, ua);
    assert.equal(c?.tier, tier, ua);
  }
});

test('browsers and search engines are not AI crawlers', () => {
  for (const ua of [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    '',
  ]) assert.equal(matchCrawler(ua, crawlers), null, ua);
});

test('every crawler entry is well formed and robots-only tokens are not matchable', () => {
  const tiers = new Set(['training', 'retrieval', 'user']);
  for (const c of crawlers) {
    assert.ok(c.name && c.vendor && c.match && c.robots && c.source, JSON.stringify(c));
    assert.ok(tiers.has(c.tier), c.name);
  }
  for (const r of robotsOnly) assert.equal(crawlers.some((c) => c.name === r.name), false, r.name);
});

test('scanner paths are excluded, real pages are kept', () => {
  for (const p of ['/.env', '/backend/.env.bak', '/.git/config', '/wp-login.php', '/vendor/phpunit/x', '/api/v1/fetch', '/actuator/env', '/debug/pprof', '/public/env.js', '/.terraform.rc', '/Jenkinsfile', '/docker-compose.dev.yml', '/db.sql'])
    assert.equal(isProbePath(p), true, p);
  for (const p of ['/', '/pricing', '/blog/how-to-fetch-data-in-react', '/docs/environment-setup', '/blog/proxy-servers-explained', '/robots.txt', '/llms.txt'])
    assert.equal(isProbePath(p), false, p);
});

test('AI referrals match by referrer host or utm_source, and nothing else', () => {
  assert.equal(matchReferrer({ referer: 'https://chatgpt.com/' }, referrers)?.name, 'ChatGPT');
  assert.equal(matchReferrer({ referer: 'https://www.perplexity.ai/search?q=x' }, referrers)?.name, 'Perplexity');
  assert.equal(matchReferrer({ utmSource: 'chatgpt.com' }, referrers)?.name, 'ChatGPT');
  assert.equal(matchReferrer({ referer: 'https://www.google.com/' }, referrers), null);
  assert.equal(matchReferrer({ referer: 'https://notchatgpt.com/' }, referrers), null);
});

test('collectDay classifies, excludes probes and own traffic, and counts verified + refused', async () => {
  const rows = [
    { count: 10, dimensions: { userAgent: 'GPTBot/1.4', clientRequestPath: '/a', verifiedBotCategory: 'AI Crawler', edgeResponseStatus: 200 } },
    { count: 4, dimensions: { userAgent: 'ChatGPT-User/1.0', clientRequestPath: '/pricing', verifiedBotCategory: '', edgeResponseStatus: 403 } },
    { count: 2, dimensions: { userAgent: 'ChatGPT-User/1.0', clientRequestPath: '/pricing/', verifiedBotCategory: 'AI Assistant', edgeResponseStatus: 200 } },
    { count: 6, dimensions: { userAgent: 'Claude-User (claude-code/2.1.0)', clientRequestPath: '/docs', verifiedBotCategory: '', edgeResponseStatus: 200 } },
    { count: 9, dimensions: { userAgent: 'Claude-User/1.0', clientRequestPath: '/railway.toml', verifiedBotCategory: '', edgeResponseStatus: 404 } },
    { count: 8, dimensions: { userAgent: 'Claude-User/1.0', clientRequestPath: '/no-such-page', verifiedBotCategory: '', edgeResponseStatus: 404 } },
    { count: 1, dimensions: { userAgent: 'GPTBot/1.4', clientRequestPath: '/not-in-sitemap', verifiedBotCategory: '', edgeResponseStatus: 200 } },
    { count: 7, dimensions: { userAgent: 'ChatGPT-User/1.0', clientRequestPath: '/.env', verifiedBotCategory: '', edgeResponseStatus: 404 } },
    { count: 3, dimensions: { userAgent: 'PerplexityBot/1.0 my-probe-tag', clientRequestPath: '/', verifiedBotCategory: '', edgeResponseStatus: 200 } },
    { count: 5, dimensions: { userAgent: 'Mozilla/5.0 (compatible; SomeOtherBot/1.0)', clientRequestPath: '/', verifiedBotCategory: '', edgeResponseStatus: 200 } },
  ];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes('clientRefererHost')) return new Response(JSON.stringify({ data: null, errors: [{ message: 'no access', extensions: { code: 'authz' } }] }));
    return new Response(JSON.stringify({ data: { viewer: { zones: [{ total: [{ count: 999 }], ai: rows }] } } }));
  };
  const pagePaths = new Set(['/', '/a', '/pricing', '/docs']);
  const day = await collectDay({ token: 't', zoneId: 'z', date: '2026-01-01', crawlers, referrers, excludeUa: ['my-probe-tag'], pagePaths, fetchImpl: fakeFetch });
  assert.equal(day.tiers.training, 10, 'off-sitemap GPTBot read not counted');
  assert.equal(day.tiers.user, 2 + 6, 'only served real pages count; the 403 does not');
  assert.equal(day.tiers.retrieval, 0);
  assert.equal(day.verified.training, 10);
  assert.equal(day.verified.user, 2);
  assert.equal(day.bots['ChatGPT-User'].blocked, 4);
  assert.equal(day.bots['ChatGPT-User'].count, 2);
  assert.equal(day.bots['Claude-User via Claude Code'].count, 6);
  assert.equal(day.excluded.probePaths, 7 + 9);
  assert.equal(day.excluded.notAPage, 8);
  assert.equal(day.excluded.offSitemap, 1);
  assert.equal(day.excluded.ownTraffic, 3);
  assert.equal(day.referrals, null);
  assert.deepEqual(day.userPaths, { '/pricing': 2, '/docs': 6 });
});

test('summarise compares against the prior period only when it is complete', () => {
  const dates = daysBack(4, new Date('2026-01-10T12:00:00Z'));
  assert.deepEqual(dates, ['2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']);
  const day = (date, n, missing = false) => ({ date, totalRequests: 0, tiers: { training: n, retrieval: n, user: n }, verified: { training: 0, retrieval: 0, user: 0 }, status: { ok: 0, blocked: 0, notFound: 0, other: 0 }, bots: {}, excluded: { probePaths: 0, ownTraffic: 0 }, referrals: null, missing });
  const s = summarise({ zoneName: 'x', days: 2, data: dates.map((d, i) => day(d, i + 1)), referralsAvailable: false });
  assert.equal(s.totals.user, 3 + 4);
  assert.equal(s.priorTotals.user, 1 + 2);
  const s2 = summarise({ zoneName: 'x', days: 2, data: dates.map((d, i) => day(d, i + 1, i === 0)), referralsAvailable: false });
  assert.equal(s2.priorTotals, null);
});

test('a user-asked bot reading one path once a day, every day, is flagged as clockwork', () => {
  const dates = daysBack(7, new Date('2026-01-10T12:00:00Z'));
  const day = (date, reads) => ({ date, totalRequests: 0, tiers: { training: 0, retrieval: 0, user: Object.values(reads).reduce((a, b) => a + b, 0) }, verified: { training: 0, retrieval: 0, user: 0 }, status: { ok: 0, blocked: 0, notFound: 0, other: 0 }, bots: {}, excluded: { probePaths: 0, ownTraffic: 0, notAPage: 0, offSitemap: 0 }, referrals: null, userReads: reads });
  const data = dates.map((d, i) => day(d, { 'Perplexity-User\t/': 1, ...(i % 3 === 0 ? { 'ChatGPT-User\t/pricing': 5 } : {}) }));
  const s = summarise({ zoneName: 'x', days: 7, data, referralsAvailable: false });
  assert.deepEqual(s.clockwork.map((c) => `${c.bot} ${c.path}`), ['Perplexity-User /']);
  assert.equal(s.totals.userClockwork, 7);
});
