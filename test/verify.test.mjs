import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIp, parseCidr, inCidr, parsePrefixes, loadRanges, verdictFor, RANGE_SOURCES } from '../src/verify.js';
import { collectDay } from '../src/collect.js';

const hit = (ip, cidr) => inCidr(parseIp(ip), parseCidr(cidr));

test('IPv4 CIDR matching, including edges and /32', () => {
  assert.ok(hit('192.0.2.1', '192.0.2.0/24'));
  assert.ok(hit('192.0.2.255', '192.0.2.0/24'));
  assert.ok(!hit('192.0.3.0', '192.0.2.0/24'));
  assert.ok(hit('198.51.100.7', '198.51.100.7/32'));
  assert.ok(!hit('198.51.100.8', '198.51.100.7/32'));
  assert.ok(hit('203.0.113.99', '0.0.0.0/0'));
  assert.ok(hit('192.0.2.130', '192.0.2.128/25'));
  assert.ok(!hit('192.0.2.127', '192.0.2.128/25'));
});

test('IPv6 CIDR matching, compressed forms and mapped IPv4', () => {
  assert.ok(hit('2001:db8::1', '2001:db8::/32'));
  assert.ok(hit('2001:db8:ffff::1', '2001:db8::/32'));
  assert.ok(!hit('2001:db9::1', '2001:db8::/32'));
  assert.ok(hit('2001:db8:1:2:3:4:5:6', '2001:db8:1::/48'));
  assert.ok(hit('::1', '::1/128'));
  assert.ok(hit('::ffff:192.0.2.9', '192.0.2.0/24'), 'mapped v4 matches a v4 range');
  assert.ok(!hit('2001:db8::1', '192.0.2.0/24'), 'families never cross');
});

test('bad input is rejected, not matched', () => {
  for (const bad of ['', null, 'nope', '1.2.3', '1.2.3.256', '1::2::3', '12345::1', '1:2:3:4:5:6:7:8:9']) assert.equal(parseIp(bad), null, String(bad));
  assert.equal(parseCidr('192.0.2.0/33'), null);
  assert.equal(parseCidr('2001:db8::/129'), null);
  assert.equal(parseCidr('192.0.2.0/x'), null);
});

test('parsePrefixes reads both families and ignores junk', () => {
  const text = JSON.stringify({ prefixes: [{ ipv4Prefix: '192.0.2.0/24' }, { ipv6Prefix: '2001:db8::/32' }, { other: 1 }, { ipv4Prefix: 'bad' }] });
  assert.equal(parsePrefixes(text).length, 2);
  assert.deepEqual(parsePrefixes('<html>'), []);
});

const lists = {
  'https://openai.com/chatgpt-user.json': { prefixes: [{ ipv4Prefix: '192.0.2.0/24' }] },
  'https://claude.com/crawling/bots.json': { prefixes: [{ ipv4Prefix: '198.51.100.0/24' }] },
};
// OpenAI serves octet-stream, so the fake does too: only .text() is safe.
const fakeFetch = async (url) => (lists[url]
  ? { ok: true, text: async () => JSON.stringify(lists[url]), json: async () => { throw new Error('use text()'); } }
  : { ok: false, status: 500, text: async () => '' });

test('loadRanges tolerates failures; verdicts cover all five outcomes', async () => {
  const ranges = await loadRanges({ fetchImpl: fakeFetch });
  assert.equal(verdictFor('192.0.2.5', 'ChatGPT-User', ranges), 'verified');
  assert.equal(verdictFor('203.0.113.5', 'ChatGPT-User', ranges), 'unverified');
  assert.equal(verdictFor('198.51.100.5', 'Claude-User', ranges), 'verified', 'one list serves all Claude bots');
  assert.equal(verdictFor('192.0.2.5', 'GPTBot', ranges), 'no_ranges', 'list fetch failed');
  assert.equal(verdictFor(null, 'ChatGPT-User', ranges), 'no_ip');
  assert.equal(verdictFor('garbage', 'ChatGPT-User', ranges), 'no_ip');
  assert.equal(verdictFor('192.0.2.5', 'CCBot', ranges), 'unknown', 'no published list');
  assert.ok(Object.keys(RANGE_SOURCES).length >= 8);
});

test('collectDay stores verdict counts only, never the IP', async () => {
  const ranges = await loadRanges({ fetchImpl: fakeFetch });
  const crawlers = [{ name: 'ChatGPT-User', vendor: 'OpenAI', tier: 'user', match: 'ChatGPT-User' }];
  const row = (ip, count) => ({ count, dimensions: { userAgent: 'ChatGPT-User/1.0', clientRequestPath: '/', verifiedBotCategory: '', edgeResponseStatus: 200, clientIP: ip } });
  let query = '';
  const fetchImpl = async (_u, init) => {
    query = JSON.parse(init.body).query;
    return { ok: true, json: async () => ({ data: { viewer: { zones: [{ total: [{ count: 9 }], ai: [row('192.0.2.5', 3), row('203.0.113.77', 2)] }] } } }) };
  };
  const day = await collectDay({ token: 't', zoneId: 'z', date: '2026-01-01', crawlers, referrers: [], tryReferrals: false, fetchImpl, ipRanges: ranges });
  assert.match(query, /clientIP/);
  assert.deepEqual(day.bots['ChatGPT-User'].ipVerdicts, { verified: 3, unverified: 2 });
  assert.ok(!JSON.stringify(day).includes('203.0.113.77') && !JSON.stringify(day).includes('192.0.2.5'));
});
