---
name: ai-crawler-analytics
description: Build an AI crawler analytics dashboard for a website on Cloudflare, showing which AI bots read the site and why (training, retrieval, or a person asking an assistant right now), with scanners, 404s, self-traffic and clockwork monitors excluded. Use when someone asks which AI crawlers visit their site, whether ChatGPT / Claude / Perplexity read it, how much AI traffic they get, or wants an AI crawler dashboard or artifact.
---

# AI crawler analytics

Turn a Cloudflare zone's analytics into an honest picture of AI crawler activity, and show it as a
dashboard (an Artifact in claude.ai, or the static page in `dashboard/` in Claude Code).

## 1. Get the data

**In Claude Code (or anywhere with a shell and Node 18+):**

1. Ask the user for a Cloudflare API token with **only** `Zone > Analytics > Read` (plus
   `Zone > Zone > Read` if they want to pass a domain instead of a zone id), scoped to the one zone.
   Never ask for a Global API Key, and never write the token into a file in the repo.
2. Run, from this repo:
   ```
   CF_API_TOKEN=<token> node bin/fetch.mjs --zone <domain> --days 7 --sitemap auto --out /tmp/ai-crawlers.json
   ```
   Add `--exclude-ip` for the user's own servers and `--exclude-ua` for a tag their own uptime
   checks carry, if they have them. If `--sitemap auto` reports 0 paths, ask for the sitemap URL.
3. Read the JSON. Then either open `dashboard/index.html` with it as `dashboard/data.json`
   (`npm run dashboard`), or build an Artifact from it (step 2).

**In claude.ai (no shell):** you cannot call the Cloudflare API from here. Ask the user to either
run the command above on their machine and paste the JSON, or paste the output of the GraphQL query in
`docs/manual-query.md` (Cloudflare dashboard > Analytics > GraphQL explorer, or curl). If they paste
raw GraphQL rows, classify them yourself using `data/ai-crawlers.json` and the rules in section 3.
Never invent numbers: if they have no data, say so.

## 2. Build the Artifact

One page, light and dark mode, no external data calls. Embed the JSON in the page. Show, in order:

1. **Four tiles**: Training, Retrieval, User-asked, AI referrals clicked. Each with the total and the
   change vs the prior period (`priorTotals`; if null, say "no prior period"). Under User-asked, say how
   many reads are clockwork (`totals.userClockwork`) and coding agents (`totals.userAgentTools`). If
   `referralsSource` is `unavailable`, show "not measured" and say the referral tracker is how to get it.
2. **Stacked bars per day** (`daily[].tiers`), training / retrieval / user-asked, weakest evidence at
   the bottom. Mark missing days.
3. **Flags**, only when true: training > 0 but retrieval = 0 (feeding corpora while absent from the
   answer indexes: check robots.txt and Cloudflare's AI-bot blocking); refused > 10% of reads; truncated
   or missing days.
4. **Bots table**: name, vendor, tier, reads, % verified by Cloudflare, refused.
5. **Clockwork readers** (`clockwork`), if any.
6. **Pages people asked AI about** (`topUserAskedPaths`).
7. **What these numbers leave out**: the excluded counts in `totals` (probePaths, notAPage, offSitemap,
   ownTraffic, blocked) and the standing caveats in section 4.

Write labels in plain words. Do not call training reads "visits" or imply anyone saw the page.

## 3. Rules the numbers follow (do not loosen them)

- A read counts only if it is a **real page that was served**: 2xx/3xx, not a scanner path
  (`src/classify.js` PROBE_PATH_RE), not your own traffic, and in the sitemap when one is given.
- Tier comes from the bot, not the volume: training = corpus copy; retrieval = search index for AI
  answers; user-asked = fetched because a person asked just now. Unknown AI bots count as training.
- Clockwork: a user-asked bot fetching the same path on nearly every day, at most twice a day, is a
  monitor. Report it; do not count it as demand.
- AI referrals (clicks from chatgpt.com, perplexity.ai, claude.ai...) are the only number that is
  certainly people. Treat it as a floor: referrers get stripped.

## 4. Caveats to state every time

- Cloudflare's adaptive analytics are sampled: small numbers mean present / absent, not exact volume.
- User agents can be forged. "Verified by Cloudflare" is the check; not every genuine bot is on the list. For a stronger check run the fetch with `--verify-ips`: each bot then has `ipVerdicts` (verified / unverified / no_ranges / no_ip / unknown) from the vendors' published IP ranges. A large `unverified` share on a user-asked bot means a scanner is wearing its user agent. See README "Spotting fake AI bots".
- A bot not appearing is not proof it is blocked. Test with its real user agent.
- Google-Extended and Applebot-Extended are robots.txt switches, not crawlers, so they never appear.
- Cloudflare only keeps this data for a short time (about two weeks on Free); the Worker keeps history.
- Cloudflare's "Block AI bots" and managed robots.txt settings can silently refuse these crawlers.
