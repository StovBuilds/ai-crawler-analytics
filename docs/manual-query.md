# Running the query by hand

If you cannot run Node, you can pull one day of AI crawler rows yourself and paste the result into
Claude (with `skill/SKILL.md` or the prompt in the README).

```bash
curl -s https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json" \
  -d '{"query":"{ viewer { zones(filter:{zoneTag:\"YOUR_ZONE_ID\"}) { ai: httpRequestsAdaptiveGroups(limit:10000, orderBy:[count_DESC], filter:{date:\"2026-01-14\", requestSource:\"eyeball\", OR:[{userAgent_like:\"%GPTBot%\"},{userAgent_like:\"%ChatGPT-User%\"},{userAgent_like:\"%OAI-SearchBot%\"},{userAgent_like:\"%ClaudeBot%\"},{userAgent_like:\"%Claude-User%\"},{userAgent_like:\"%Claude-SearchBot%\"},{userAgent_like:\"%PerplexityBot%\"},{userAgent_like:\"%Perplexity-User%\"},{userAgent_like:\"%meta-external%\"},{userAgent_like:\"%Amazonbot%\"},{userAgent_like:\"%Amzn-SearchBot%\"},{userAgent_like:\"%CCBot%\"},{userAgent_like:\"%Bytespider%\"},{userAgent_like:\"%DuckAssistBot%\"},{userAgent_like:\"%MistralAI-User%\"}]}) { count dimensions { userAgent clientRequestPath verifiedBotCategory edgeResponseStatus } } } } }"}'
```

Change the date (one day per query on the Free plan; Cloudflare keeps about two weeks). The zone id
is on your domain's Overview page in the Cloudflare dashboard, bottom right.

The same query can be pasted (without the outer JSON) into Cloudflare's GraphQL explorer:
dashboard > Analytics & Logs > GraphQL, or https://graphql.cloudflare.com/explorer.
