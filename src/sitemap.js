// Read a sitemap (or sitemap index) into a Set of normalised paths, for counting only real pages.
import { normalisePath } from './collect.js';

// Every sitemap a site declares: /sitemap.xml plus each robots.txt "Sitemap:" line.
export async function declaredSitemaps(origin, { fetchImpl = fetch } = {}) {
  const out = new Set([`${origin}/sitemap.xml`]);
  try {
    const r = await fetchImpl(`${origin}/robots.txt`, { headers: { 'user-agent': 'ai-crawler-analytics (sitemap read)' } });
    if (r.ok) for (const m of (await r.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)) out.add(m[1]);
  } catch {}
  return [...out];
}

export async function sitemapPaths(url, { fetchImpl = fetch, maxFiles = 50, log = () => {} } = {}) {
  const paths = new Set(['/']);
  const queue = Array.isArray(url) ? [...url] : [url];
  let files = 0;
  while (queue.length && files < maxFiles) {
    const u = queue.shift();
    files += 1;
    const res = await fetchImpl(u, { headers: { 'user-agent': 'ai-crawler-analytics (sitemap read)' } });
    if (!res.ok) { log(`sitemap ${u}: HTTP ${res.status}`); continue; }
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(xml)) queue.push(...locs);
    else for (const l of locs) { try { paths.add(normalisePath(new URL(l).pathname)); } catch {} }
  }
  return paths;
}
