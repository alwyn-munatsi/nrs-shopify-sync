# nrs-shopify-sync

Keeps the 705 BRBR Shopify store in step with the NRS register. Runs every hour on GitHub Actions.

## What a run does

1. Reads the NRS catalog (barcode, name, price, department, on-hand) and every Shopify variant.
2. Matches them by barcode (digits only, leading zeros ignored).
3. **Stock:** sets Shopify on-hand to the register count minus 1, held back for walk-in customers
   (0 or 1 in the register means 0 online).
4. **Prices:** NRS always wins. A Shopify price that differs from the register is changed to the
   register price. A missing or $0 NRS price is never pushed; it's listed as a warning instead.
5. **New products:** register items that are in stock but not on Shopify are created as **draft**
   products (title, department as the product type, price, barcode, stock), tagged
   `nrs-sync` and `needs-review`. At most 25 per run; the rest wait for the next runs.
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

Optional variables: `MAX_NEW_PRODUCTS_PER_RUN` (default 25), `SYNC_PRICES` (`true`/`false`),
`NOTIFY_ASSIGNEE` (GitHub username to notify; defaults to the repo owner).

## Secrets

| Secret | Value |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `7e36ef-2` (or the full `.myshopify.com` domain) |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API token (`shpat_...`), or the app's client secret when `SHOPIFY_CLIENT_ID` is set |
| `SHOPIFY_CLIENT_ID` | Optional. App client id, for the client credentials grant |
| `SHOPIFY_LOCATION_ID` | `gid://shopify/Location/...` (a bare number works too) |
| `NRS_AUTH_PATH`, `NRS_STORE_ID`, `NRS_GROUP_ID` | NRS POS API values |

The Shopify app needs the `read_products`, `write_products`, `read_inventory`, `write_inventory`
and `read_locations` scopes.

## Development

```bash
pip install -r requirements.txt
python -m pytest -q
```

Uses Shopify Admin GraphQL API version `2026-10`.
