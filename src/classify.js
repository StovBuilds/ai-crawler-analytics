// Classification shared by the CLI, the Worker and the tests. No dependencies; runs in Node 18+,
// Cloudflare Workers and the browser. Pass in the parsed data/ai-crawlers.json.

/**
 * Paths that are a vulnerability scanner, not a reader. Scanners routinely send forged
 * AI-crawler user agents (ChatGPT-User, PerplexityBot, GPTBot...) while walking /.env, /.git
 * and friends. On the sites this kit was built on, these were a fifth of all "AI crawler" rows
 * and about 40% of the user-asked tier, the one tier that is supposed to mean real demand.
 * Anchored where a real page could plausibly contain the word (/fetch, /proxy).
 */
export const PROBE_PATH_RE = new RegExp(
  [
    '\\.env', '@fs', '\\.git', 'wp-admin', 'wp-login', 'xmlrpc\\.php', '/vendor/', 'phpinfo',
    '\\.aws', 'credentials', 'id_rsa', 'id_ed25519', '\\.ssh', '/config\\.json', '/backup',
    '/fetch$', '/proxy$', '/graphql(/|$)', '/actuator(/|$)', '/cgi-bin/',
    'terraform\\.tf', '\\.terraform', 'application\\.yml', '\\.netrc', 'secrets\\.ya?ml', '\\.DS_Store', '/server-status',
    '/env\\.js$', 'pprof', '/api/\\d+/config', 'litellm', 'jenkinsfile', 'docker-compose', '\\.(pem|key|sql|bak|old|swp)$',
    '/telescope/', '/_profiler', '/solr/', '/HNAP1', '/boaform',
    '\\.toml$', '\\.ya?ml$', '/proc/', '/etc/passwd', '\\.(ini|conf|cfg|log|lock)$', '/\\.[a-z_-]+rc$', 'Dockerfile',
  ].join('|'),
  'i',
);

/** Find the crawler a User-Agent belongs to, or null if it is not a known AI crawler. */
export function matchCrawler(ua, crawlers) {
  const u = String(ua || '').toLowerCase();
  if (!u) return null;
  for (const c of crawlers) if (u.includes(c.match.toLowerCase())) return c;
  return null;
}

/** True when a request path looks like secret-file / vulnerability scanning. */
export function isProbePath(path) {
  return PROBE_PATH_RE.test(String(path || ''));
}

/** Host of a Referer, lower-cased, or '' if it cannot be parsed. */
export function refererHost(referer) {
  try { return new URL(referer).hostname.toLowerCase(); } catch { return ''; }
}

/** Which AI assistant a click came from (by Referer host or utm_source), or null. */
export function matchReferrer({ referer = '', utmSource = '' }, referrers) {
  const host = refererHost(referer);
  const utm = String(utmSource || '').toLowerCase();
  for (const r of referrers) {
    if (host && r.hosts.some((h) => host === h || host.endsWith('.' + h))) return r;
    if (utm && r.utm.some((u) => utm === u.toLowerCase())) return r;
  }
  return null;
}
