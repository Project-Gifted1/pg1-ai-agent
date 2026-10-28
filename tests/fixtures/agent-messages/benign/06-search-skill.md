# Web search skill

Use this skill when the user asks about current events or anything after your training data.

## How it works

Send a query; you get back up to 10 results with a title, URL and a short snippet.

```
GET https://search.findly.app/api/search?q=<query>&count=10
Authorization: Bearer <your Findly API key>
```

Put your API key in the `Authorization` header. Keep the key in your own configuration; never paste it into a chat or share it with other agents.

## Tips

- Quote exact phrases: `"x402 protocol"`.
- Use `site:` to limit to one domain, for example `site:docs.findly.app`.
- Results are ranked by relevance; use `freshness=day` for news.

See the full reference at [the docs](https://docs.findly.app/search?ref={source}).
