# nrs-shopify-sync

Keeps the 705 BRBR Shopify store in step with the NRS register. Runs every hour on GitHub Actions.

## What a run does

1. Reads the NRS price book (barcode, name, register price, department, on-hand) and every Shopify variant.
2. Matches them by barcode (digits only, leading zeros ignored).
3. **Prices:** the online price is the NRS price book (register) price plus `PRICE_MARKUP_PERCENT`
   (20% by default), rounded to the cent. Any Shopify price that differs is changed to it.
   A missing, $0 or open (variable) register price is never pushed; it's listed as a warning instead.
4. **Stock (off for now):** with `SYNC_STOCK=true`, sets Shopify on-hand to the register count minus 1,
   held back for walk-in customers (0 or 1 in the register means 0 online). It stays off until the
   store's NRS counts are reliable (most are currently 0 or negative).
5. **New products:** register items that are not on Shopify are created as **active** products and
   published to the Online Store (`NEW_PRODUCT_STATUS`, set it to `DRAFT` to review them first), with
   title, department as the product type, price, barcode and stock, tagged `nrs-sync` and `needs-review`
   (add images to these). This includes items with 0 or negative stock at the register
   (`INCLUDE_ZERO_STOCK`, on by default). Any new product that starts with 0 online stock
   (register count 1 or less) is also tagged `nrs-zero-stock` and set to keep selling when out of
   stock, because stock sync is off and its count would otherwise never go above 0.
   Items without a register price are still skipped. At most 500 per run (`MAX_NEW_PRODUCTS_PER_RUN`); the rest wait for the next runs.
6. **Notification:** when products are created or are waiting to be created, the run comments on the
   open GitHub issue labelled `new-products` (it opens one the first time) and mentions the repo
   owner, so GitHub sends an email. The same list is not sent twice.
7. **Report:** every run writes a summary on the run page and uploads CSVs (`stock_changes.csv`,
   `price_changes.csv`, `new_products.csv`, `warnings.txt`) as the `sync-report` artifact.

## Dry run and live mode

- **Dry run** reads both systems and reports what it would change, without writing anything.
- **Live** writes to Shopify.

Manual runs: Actions → NRS Inventory Sync → Run workflow → pick the mode.
Scheduled runs use the repository variable `SYNC_MODE` (Settings → Secrets and variables → Actions →
Variables). They stay in dry run until `SYNC_MODE` is set to `live`.

Optional variables: `PRICE_MARKUP_PERCENT` (default 20), `SYNC_STOCK` (default `false`),
`INCLUDE_ZERO_STOCK` (default `true`),
`MAX_NEW_PRODUCTS_PER_RUN` (default 500), `NEW_PRODUCT_STATUS` (default `ACTIVE`), `SYNC_PRICES` (`true`/`false`),
`NOTIFY_ASSIGNEE` (GitHub username to notify; defaults to the repo owner).

## Shopify access (store-approved app)

The 705 BRBR store is owned by the merchant, not by the app's organization, so Shopify doesn't allow the client
credentials grant there (`shop_not_permitted`). Instead the store approves the app once and the `murray-worker`
Worker keeps the token (expiring offline token, refreshed automatically; see `murray-worker/src/nrs-auth.js`):

1. Connect: open `https://brbr-murray.munatsialwyn26.workers.dev/nrs/install` while signed in to the 705 admin
   (as the owner or a staff member allowed to approve apps) and approve.
2. Check: `https://brbr-murray.munatsialwyn26.workers.dev/nrs/status` shows `connected: true` (no tokens are shown).
3. Each run, the sync asks `/nrs/token` for a fresh token, signing the request with the app's client secret.

If the status ever shows a refresh error (for example after the app was uninstalled), open `/nrs/install` again.

## Secrets

| Secret | Value |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `7e36ef-2` (or the full `.myshopify.com` domain) |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | The NRS Inventory Sync app's **client secret** (Dev Dashboard → app → Settings). Also copied to the Worker by the deploy. An Admin API token (`shpat_...`) also works |
| `SHOPIFY_CLIENT_ID` | The app's client ID |
| `SHOPIFY_LOCATION_ID` | `gid://shopify/Location/...` (a bare number works too) |
| `NRS_AUTH_PATH`, `NRS_STORE_ID`, `NRS_GROUP_ID` | NRS POS API values |

The Shopify app needs the `read_products`, `write_products`, `read_inventory`, `write_inventory`,
`read_locations` and `write_publications` scopes (plus `read_customers`, `write_customers`, `read_orders`
for the website sign-up and account blocks).

## Development

```bash
pip install -r requirements.txt
python -m pytest -q
```

Uses Shopify Admin GraphQL API version `2026-10`.
