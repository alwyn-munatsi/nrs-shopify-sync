# Murray: 705 BRBR chat assistant

The API behind the "Ask Murray" chat bubble on 705brbr.org (theme section `murray-chat`).
It uses Claude with tools that read the live store: product search and details (Shopify storefront),
and NY Lottery results (the brbr-lottery Worker). It only talks about 705 BRBR.

- `POST /chat` `{ messages: [{role, content}], page }` returns `{ reply, products }`
- `GET /health` shows whether the Anthropic key is set

## Deploy
`.github/workflows/deploy-murray.yml` deploys on every change to this folder (or run it from the Actions tab).
Add these repository secrets first: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ANTHROPIC_API_KEY`.

## Change what Murray knows
Store facts and rules are in `systemPrompt()` and `STORE` in `src/index.js`. The model is the `MODEL` var in
`wrangler.toml`. Run `npm test` before pushing.
