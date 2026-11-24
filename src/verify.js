// Check a request's IP against the ranges each AI vendor publishes, so a forged user agent
// ("ChatGPT-User" typed into a scanner) can be told apart from the real bot. Pure functions plus one
// loader; global fetch only, so it runs in Node 18+ and in a Cloudflare Worker.
//
// Privacy: the raw IP is only ever compared in memory. What callers keep is the verdict.

export const VERDICTS = ['verified', 'unverified', 'no_ranges', 'no_ip', 'unknown'];

// Crawler name (data/ai-crawlers.json) -> the vendor's published range files. All are JSON with
// `prefixes: [{ ipv4Prefix | ipv6Prefix }]`. Anthropic publishes one list for all three of its bots.
const CLAUDE = ['https://claude.com/crawling/bots.json'];
export const RANGE_SOURCES = {
  GPTBot: ['https://openai.com/gptbot.json'],
  'ChatGPT-User': ['https://openai.com/chatgpt-user.json'],
  'OAI-SearchBot': ['https://openai.com/searchbot.json'],
  ClaudeBot: CLAUDE,
  'Claude-User': CLAUDE,
  'Claude-SearchBot': CLAUDE,
  PerplexityBot: ['https://www.perplexity.com/perplexitybot.json'],
  'Perplexity-User': ['https://www.perplexity.com/perplexity-user.json'],
  Googlebot: ['https://developers.google.com/search/apis/ipranges/googlebot.json'],
  Bingbot: ['https://www.bing.com/toolbox/bingbot.json'],
};

/** IPv4 or IPv6 text -> { v: 4|6, n: BigInt }, or null if it is not an address. */
export function parseIp(text) {
  const s = String(text ?? '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  if (!s) return null;
  if (!s.includes(':')) return parseV4(s);
  let t = s.toLowerCase();
  // Embedded IPv4 tail (::ffff:1.2.3.4) -> two hextets.
  const m = t.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const v4 = parseV4(m[2]);
    if (!v4) return null;
    t = m[1] + ((Number(v4.n >> 16n)).toString(16)) + ':' + ((Number(v4.n & 0xffffn)).toString(16));
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  // IPv4-mapped (::ffff:a.b.c.d) is an IPv4 client seen through a dual-stack socket.
  if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
  return { v: 6, n };
}

function parseV4(s) {
  const p = s.split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return { v: 4, n: p.reduce((a, x) => (a << 8n) | BigInt(x), 0n) };
}

/** "192.0.2.0/24" or "2001:db8::/32" -> { v, n, bits } (network bits only), or null. */
export function parseCidr(text) {
  const [addr, len] = String(text ?? '').trim().split('/');
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d+$/.test(len) ? Number(len) : NaN;
  if (!(bits >= 0 && bits <= max)) return null;
  const shift = BigInt(max - bits);
  return { v: ip.v, n: (ip.n >> shift) << shift, bits, max };
}

export function inCidr(ip, cidr) {
  if (!ip || !cidr || ip.v !== cidr.v) return false;
  const shift = BigInt(cidr.max - cidr.bits);
  return ip.n >> shift === cidr.n >> shift;
}

/** Vendor JSON text -> parsed CIDRs. Parse the text, not response.json(): OpenAI serves octet-stream. */
export function parsePrefixes(text) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  return (j?.prefixes ?? []).map((p) => parseCidr(p.ipv4Prefix ?? p.ipv6Prefix)).filter(Boolean);
}

/**
 * Fetch every list once. Returns { [crawlerName]: CIDR[] }. A bot whose lists all failed or came
 * back empty is left at [] so the verdict is `no_ranges` (we could not check), never `unverified`.
 */
export async function loadRanges({ fetchImpl = fetch, sources = RANGE_SOURCES, log = () => {} } = {}) {
  const cache = new Map();
  const get = (url) => {
    if (!cache.has(url)) {
      cache.set(url, fetchImpl(url, { headers: { accept: 'application/json' } })
        .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return parsePrefixes(await r.text()); })
        .catch((e) => { log(`ranges ${url} failed: ${e.message}`); return []; }));
    }
    return cache.get(url);
  };
  const out = {};
  for (const [name, urls] of Object.entries(sources)) out[name] = (await Promise.all(urls.map(get))).flat();
  return out;
}

/**
 * verified   - IP is inside the vendor's published ranges for this bot
 * unverified - we have the ranges and the IP is outside them (a forged user agent, or a new range)
 * no_ranges  - the vendor publishes a list but we have none loaded (fetch failed): could not check
 * no_ip      - no usable IP on the request
 * unknown    - the vendor publishes no list for this bot, so nothing to check against
 */
export function verdictFor(ip, botName, ranges) {
  const parsed = typeof ip === 'string' || typeof ip === 'number' ? parseIp(ip) : ip;
  if (!parsed) return 'no_ip';
  if (!ranges || !(botName in ranges)) return 'unknown';
  const list = ranges[botName];
  if (!list.length) return 'no_ranges';
  return list.some((c) => inCidr(parsed, c)) ? 'verified' : 'unverified';
}
