// Read a sitemap (or sitemap index) into a Set of normalised paths, for counting only real pages.
import { normalisePath } from './collect.js';

export async function sitemapPaths(url, { fetchImpl = fetch, maxFiles = 50, log = () => {} } = {}) {
  const paths = new Set(['/']);
  const queue = [url];
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
