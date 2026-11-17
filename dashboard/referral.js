/*
 * AI referral beacon (optional, ~1 KB). Counts visits that arrive from an AI assistant
 * (ChatGPT, Perplexity, Claude, Gemini, Copilot...). Sends NOTHING for any other visit.
 * No cookies, no IDs, no IP stored: the Worker only increments a per-day counter per assistant.
 *
 * Add before </body> on every page, with your Worker's URL:
 *   <script src="/referral.js" data-endpoint="https://ai-crawler-analytics.<you>.workers.dev/r" defer></script>
 */
(function () {
  var s = document.currentScript;
  var endpoint = s && s.getAttribute('data-endpoint');
  if (!endpoint) return;
  var hosts = ['chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'bard.google.com',
    'copilot.microsoft.com', 'chat.deepseek.com', 'chat.mistral.ai', 'meta.ai', 'you.com'];
  var utms = ['chatgpt.com', 'perplexity', 'perplexity.ai', 'claude.ai', 'gemini', 'copilot.com', 'copilot'];
  var ref = document.referrer || '';
  var host = '';
  try { host = ref ? new URL(ref).hostname.toLowerCase() : ''; } catch (e) {}
  var utm = '';
  try { utm = (new URLSearchParams(location.search).get('utm_source') || '').toLowerCase(); } catch (e) {}
  var fromAi = hosts.some(function (h) { return host === h || host.slice(-(h.length + 1)) === '.' + h; }) || utms.indexOf(utm) !== -1;
  if (!fromAi) return;
  var body = JSON.stringify({ ref: host ? 'https://' + host + '/' : '', utm: utm });
  if (navigator.sendBeacon) navigator.sendBeacon(endpoint, body);
  else fetch(endpoint, { method: 'POST', body: body, keepalive: true, headers: { 'content-type': 'application/json' } });
})();
