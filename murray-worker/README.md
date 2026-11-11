# Murray: 705 BRBR chat assistant

The API behind the "Ask Murray" chat bubble on 705brbr.org (theme section `murray-chat`).
It uses an AI model (Groq when GROQ_API_KEY is set, otherwise Claude) with tools that read the live store: product search and details (Shopify storefront),
and NY Lottery results (the brbr-lottery Worker). It only talks about 705 BRBR.

- `POST /chat` `{ messages: [{role, content}], page }` returns `{ reply, products }`
- `GET /health` shows whether a model key is set and which provider is in use

## Deploy
`.github/workflows/deploy-murray.yml` deploys on every change to this folder (or run it from the Actions tab).
Add these repository secrets first: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `GROQ_API_KEY` (or `ANTHROPIC_API_KEY`).

## Change what Murray knows
Store facts and rules are in `systemPrompt()` and `STORE` in `src/index.js`. The models are the `GROQ_MODEL` and `MODEL` vars in
`wrangler.toml`. Run `npm test` before pushing.
