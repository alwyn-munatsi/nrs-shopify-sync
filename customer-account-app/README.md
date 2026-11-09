# 705 BRBR Account Extras

A private Shopify app that adds a "705 BRBR welcome" block to the customer account Orders page:
store hours with an Open now badge, quick links (shop, beer, snacks, delivery, NY Lottery, directions),
popular products (best sellers with photo and price) and the in-store services.

## Deploy

Deploys run on GitHub Actions (`.github/workflows/deploy-account-app.yml`) whenever this folder changes on
`main`, or manually from Actions → "Deploy customer account app" → Run workflow.

One-time setup: create a deploy token and save it as a repository secret.
1. Dev Dashboard → 705 BRBR Account Extras → Settings → App CLI automation token → Manage →
   Add service account. Name: "GitHub deploy"; expiry: 6 months; Permissions: App development →
   705 BRBR Account Extras. Copy the token (shown once).
2. GitHub → this repo → Settings → Secrets and variables → Actions → Secrets → New repository secret.
   Name: `SHOPIFY_SERVICE_ACCOUNT_TOKEN`, value: the token.

The token expires; when deploys start failing with an auth error, create a new one and update the secret.

Local deploy (optional): `npm install` then `npm run deploy` from this folder.

## Add the block

Shopify admin → Settings → Checkout → Customize → page selector: **Orders** → Main → **Add block**
→ **705 BRBR welcome** → Save.

## Change the content

Edit `extensions/account-extras/src/OrdersBlock.jsx` (QUICK_LINKS, SERVICES, text), then push to `main` (GitHub deploys it).
