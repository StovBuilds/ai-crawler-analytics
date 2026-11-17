#!/usr/bin/env node
// Usage:
//   CF_API_TOKEN=... node bin/fetch.mjs --zone example.com [--days 7] [--out dashboard/data.json]
//                    [--zone-id <id>] [--exclude-ip 203.0.113.7,...] [--exclude-ua my-monitor-tag,...]
//                    [--sitemap auto|<url>]  count only pages listed in your sitemap (recommended)
// Writes the dashboard data file. Read-only against Cloudflare.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, zoneIdFor } from '../src/collect.js';
import { sitemapPaths, declaredSitemaps } from '../src/sitemap.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);

if (args.help || (!args.zone && !args['zone-id'])) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 7).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(args.help ? 0 : 1);
}
const token = process.env.CF_API_TOKEN;
if (!token) { console.error('Set CF_API_TOKEN (a read-only token: Zone > Analytics > Read).'); process.exit(1); }

const list = (s) => (s && s !== 'true' ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
const crawlers = JSON.parse(readFileSync(join(root, 'data/ai-crawlers.json'), 'utf8')).crawlers;
const referrers = JSON.parse(readFileSync(join(root, 'data/ai-referrers.json'), 'utf8')).referrers;

const zoneId = args['zone-id'] ?? (await zoneIdFor(token, args.zone));
let pagePaths = null;
if (args.sitemap) {
  const url = args.sitemap === 'auto' || args.sitemap === 'true' ? await declaredSitemaps(`https://${args.zone}`) : args.sitemap;
  pagePaths = await sitemapPaths(url, { log: (m) => process.stderr.write(m + '\n') });
  process.stderr.write(`sitemap: ${pagePaths.size} paths\n`);
  if (pagePaths.size <= 1) { process.stderr.write('sitemap gave no pages; counting without it\n'); pagePaths = null; }
}
const data = await collect({
  token,
  zoneId,
  zoneName: args.zone ?? '',
  days: Number(args.days ?? 7),
  crawlers,
  referrers,
  excludeIps: list(args['exclude-ip']),
  excludeUa: list(args['exclude-ua']),
  pagePaths,
  log: (m) => process.stderr.write(m + '\n'),
});
const out = args.out ?? join(root, 'dashboard/data.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
const t = data.totals;
console.error(`wrote ${out}: training ${t.training}, retrieval ${t.retrieval}, user-asked ${t.user}; excluded ${t.probePaths} scanner, ${t.notAPage} not-a-page, ${t.offSitemap} off-sitemap, ${t.ownTraffic} own; clockwork user reads ${t.userClockwork}; referrals: ${data.referralsSource}`);
