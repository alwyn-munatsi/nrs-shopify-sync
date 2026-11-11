# 705 BRBR Account Extras

A private Shopify app that adds a "705 BRBR welcome" block to the customer account Orders page
(placed below the order list): popular products (best sellers with photo and price), store hours with an
Open now badge, the address and the in-store services. Quick links (Shop, NY Lottery, Order delivery,
Visit us) are in the account side menu: Online Store → Navigation → Customer account main menu.

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

Edit `extensions/account-extras/src/OrdersBlock.jsx` (SERVICES, text), then push to `main` (GitHub deploys it).

## Order celebration (Thank you page)

`extensions/order-celebration` shows an animated confetti "HOORAY!" banner, the "order processed / on the way"
message and a 3-step tracker at the top of the Thank you page. The banner is `assets/brbr-hooray.svg`,
served from this public repo through jsDelivr. Turn it on in Settings → Checkout → Customize → page selector:
**Thank you** → Main → Add block → **705 BRBR order celebration** (drag it to the top) → Save.

## Store header bar and footer

- `extensions/store-header`: Open now badge and quick links under the Thank you page logo
  (Settings → Checkout → Customize → **Thank you** → Header → Add block → **705 BRBR store header bar**).
- `extensions/store-footer`: the website footer (address, hours, contact, shop links, socials) at the bottom of every
  customer account page and the Thank you page. Add it on the **Thank you** page (Footer → Add block) and on any
  customer account page (Footer → Add block) → **705 BRBR store footer**.
- The checkout steps themselves (information, shipping, payment) only allow app blocks on Shopify Plus; they keep
  Shopify's logo header and the policy links footer.

## Google review + 10% welcome offer (Thank you page)

`extensions/after-order` adds two cards below the Hooray celebration: "Review us on Google" (opens the write-a-review
box; no reward, since Google bans incentivised reviews) and "Get 10% off your next order" (links to the homepage
sign-up form, hidden when Shopify says the buyer is signed in). The 10% code is WELCOME10: 10% off, once per
customer, only for customers tagged `welcome-offer` (segment "Welcome offer sign-ups"), and it's emailed by the
Shopify Messaging automation set up for that tag.
