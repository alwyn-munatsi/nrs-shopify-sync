# NRS → Shopify Sync: Automated POS-to-E-commerce Catalog Pipeline for 705 BRBR

[![Orchestration](https://img.shields.io/badge/Orchestration-GitHub%20Actions-2088FF?logo=githubactions)](https://docs.github.com/actions)
[![Python](https://img.shields.io/badge/Sync%20Engine-Python%203.12-3776AB?logo=python)](https://www.python.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Edge-Cloudflare%20Workers-F38020?logo=cloudflare)](https://workers.cloudflare.com/)
[![Shopify](https://img.shields.io/badge/Target-Shopify%20Admin%20GraphQL%202026--10-7AB55C?logo=shopify)](https://shopify.dev/docs/api/admin-graphql)

An hourly, production integration pipeline that keeps the **705 BRBR** Shopify store in step with its in-store **NRS POS register**. A Python sync engine running on **GitHub Actions** reads the NRS price book and inventory, matches every item to Shopify by barcode, and plans price changes, new product listings, compliance archiving and (optionally) stock updates. Shopify calls are routed through a **Cloudflare Worker** (`brbr-murray`) that holds the store-approved OAuth token in a **Durable Object**, refreshes it on a cron, and calls Shopify from an allowlisted US network. The same Worker also powers the website's "Ask Murray" AI shopping assistant, customer sign-up and the customer-account blocks shipped by a private **Shopify app** in `customer-account-app/`.

---

## 1. System Architecture & End-to-End Data Flow

### End-to-End Execution Flow
$$\text{NRS POS API} \xrightarrow{\text{Python (GitHub Actions, hourly)}} \text{Barcode Match + Plan} \xrightarrow{\text{signed request}} \text{Cloudflare Worker } (/nrs/graphql) \xrightarrow{\text{OAuth token}} \text{Shopify Admin GraphQL}$$

1. **NRS POS (source):** The register's price book (`/pbitems/{store}/default`) and UPC inventory (`/inventory/{store}/groups/{group}/upcs`) on `pos-papi.nrsplus.com` provide barcode, name, register price, department and on-hand count.
2. **GitHub Actions (`sync.yml`):** Runs at minute `:17` every hour (GitHub often delays on-the-hour jobs), runs the test suite first, then executes `sync_inventory.py`. A `concurrency` group guarantees two syncs never overlap.
3. **Barcode matching:** Both catalogs are normalised with `clean_barcode()` (digits only, leading zeros stripped) so UPC-A, EAN-13 and zero-padded register codes line up.
4. **Planning (`build_plan`):** Produces a `Plan` of price changes, stock changes, location activations, new products, a queue for items over the per-run cap, and warnings.
5. **Compliance filter:** Nicotine and restricted items are split out before planning and any already on Shopify are archived (or deleted on a manual run).
6. **Cloudflare Worker (`brbr-murray`):** Receives Shopify GraphQL calls at `/nrs/graphql`, verifies the signature with the app's client secret, attaches the stored token and forwards to Shopify from `aws:us-east-1` placement.
7. **Shopify Admin GraphQL (target):** Prices, products, publications and inventory are written in batches (live mode only).
8. **Reporting:** The run summary, CSV artifacts and a GitHub issue notification tell the owner what changed.

---

## 2. Infrastructure & Component Directory

| Component | Service Type | Purpose / Function in Solution | Configuration & Security Details |
| :--- | :--- | :--- | :--- |
| **`sync_inventory.py`** | Python sync engine | Reads NRS + Shopify, builds and applies the plan | `requests`, `Decimal` money maths, Admin API `2026-10` |
| **`audit_catalog.py`** | Python audit job | One-off read-only price book vs Shopify comparison | Output is encrypted before printing because run logs are public |
| **`sync.yml`** | GitHub Actions workflow | Hourly schedule + manual dry-run/live runs | `concurrency: nrs-sync`, 50-min timeout, `issues: write` only |
| **`brbr-murray`** | Cloudflare Worker | Token broker, AI chat API, sign-up and account endpoints | US placement, CORS allowlist, secrets set by deploy workflow |
| **`NrsTokenStore`** | Durable Object (SQLite) | Holds the access + rotating refresh token | Refreshed every 6 h (`23 */6 * * *`) so the 90-day refresh token never lapses |
| **`brbr-lottery`** | Cloudflare Worker (service binding) | Live NY Lottery results for the chat assistant | Bound as `LOTTERY` to avoid workers.dev cross-calls |
| **`customer-account-app`** | Private Shopify app | Customer account + Thank-you page UI extensions | Deployed by `deploy-account-app.yml` with a service-account token |
| **`stop-workers.yml`** | GitHub Actions workflow | Emergency pause for the Workers' cron triggers | Manual run only |

---

## 3. Engineering Decisions (Why It's Built This Way)

| Concern | Naive Approach | This Implementation | Technical Justification |
| :--- | :--- | :--- | :--- |
| **Shopify auth** | Client-credentials grant or a pasted `shpat_` token | **Store-approved app + token broker Worker** | The store is merchant-owned, so client credentials return `shop_not_permitted`; the Worker keeps an expiring offline token and refreshes it automatically. |
| **Network allowlist** | Call Shopify straight from GitHub runners | **Proxy through Cloudflare (US placement)** | GitHub runner IPs change and are often refused by the app's IP allowlist; Cloudflare egress from `aws:us-east-1` is accepted. |
| **Pricing** | Copy the register price | **Register price + `PRICE_MARKUP_PERCENT` (20%)** rounded half-up to the cent with `Decimal` | Avoids float drift; $0, missing and open (variable) prices are never pushed — they become warnings. |
| **Stock** | Mirror on-hand directly | **On-hand − 1 safety buffer, off by default** | Holds the last unit for walk-ins; disabled until the store's NRS counts are reliable (most are 0 or negative). |
| **New listings** | Create everything at once | **Capped at 500 per run, alphabetical, tagged `nrs-sync` + `needs-review`** | Large backlogs drain over several runs; tags make image follow-up easy. |
| **Compliance** | Manual curation | **Department + regex exclusion, auto-archive** | Vaporizers/Tobacco departments, nicotine brands, kratom, THC/CBD/delta-8/9 and rolling papers never go online. |
| **Safety** | Write on every run | **Dry run by default** | Scheduled runs stay read-only until the `SYNC_MODE` variable is set to `live`. |

---

## 4. Phase 1: Reading the NRS Register

The sync pulls the price book (paged, 2,000 items per request) and the UPC inventory, then merges them into one dictionary keyed by cleaned barcode.

```python
NRS_URL           = "https://pos-papi.nrsplus.com/{auth}/inventory/{store}/groups/{group}/upcs"
NRS_PRICEBOOK_URL = "https://pos-papi.nrsplus.com/{auth}/pbitems/{store}/default"

def clean_barcode(barcode) -> str:
    """Normalizes barcodes by stripping non-digits and leading zeros for cross-system matching."""
    if not barcode:
        return ""
    digits = re.sub(r"\D", "", str(barcode))
    return digits.lstrip("0") if digits else ""
```

---

## 5. Phase 2: Matching & Planning

`build_plan()` walks every Shopify variant, looks up its barcode in the NRS catalog and records what needs to change. Register items that are not on Shopify become new-product candidates.

```python
def online_price(register: Decimal, markup_pct: Decimal) -> Decimal:
    """Register price plus the online markup, rounded to the cent."""
    return (register * (1 + markup_pct / 100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

def calculate_buffer(qty) -> int:
    """0 or 1 at the register -> 0 online; otherwise stock minus 1 held for walk-ins."""
    try:
        q = int(qty)
    except (ValueError, TypeError):
        return 0
    return q - 1 if q > 1 else 0
```

The resulting `Plan` holds:

| Field | Meaning |
| :--- | :--- |
| `prices` | Existing variants whose online price differs from register × markup |
| `stock` / `activate` | On-hand changes and variants not yet stocked at the location (only with `SYNC_STOCK=true`) |
| `new_products` | Register items to create this run |
| `queued` | Items that would be created but are over `MAX_NEW_PRODUCTS_PER_RUN` |
| `warnings` | Missing/zero prices and other items needing a human |

---

## 6. Phase 3: Applying Changes to Shopify (Live Mode)

* **Prices:** batched `productVariantsBulkUpdate` calls, 20 variants per request.
* **New products:** created as `ACTIVE` (or `DRAFT` via `NEW_PRODUCT_STATUS`) with title, department as product type, price, barcode and stock, then published to the Online Store. Items starting at 0 online stock are tagged `nrs-zero-stock` and set to keep selling when out of stock, because stock sync is off.
* **Compliance:** excluded items already on Shopify are archived (restorable). A manual run with `excluded_action = delete` deletes them permanently; scheduled runs only archive.
* **Stock (optional):** inventory set to `calculate_buffer(onhand)` at `SHOPIFY_LOCATION_ID`.

---

## 7. Phase 4: Token Broker & Edge Services (Cloudflare Worker)

The `murray-worker` handles the store-approved OAuth connection (`src/nrs-auth.js`) and a few customer-facing APIs.

| Route | Purpose |
| :--- | :--- |
| `GET /nrs/install`, `/nrs/callback` | One-time approval of the app by the store owner/staff |
| `GET /nrs/status` | Shows `connected: true` (never shows tokens) |
| `POST /nrs/graphql` | Signed proxy used by the hourly sync |
| `POST /chat` | "Ask Murray" AI assistant (Groq if `GROQ_API_KEY` is set, otherwise Claude) with live product search and NY Lottery tools |
| `POST /signup`, `/signin-check` | Website sign-up form → Shopify customers |
| `/account/*` | Data for the customer account blocks, checked against the account app's session tokens |
| `GET /health` | Model/provider status |

If `/nrs/status` ever shows a refresh error (for example after the app was uninstalled), open `/nrs/install` again.

---

## 8. Phase 5: Customer Account & Thank-You Page Extensions

`customer-account-app/` is a private Shopify app ("705 BRBR Account Extras") with these UI extensions:

| Extension | Where it appears | What it shows |
| :--- | :--- | :--- |
| `account-extras` | Orders page | Best sellers, store hours with an Open-now badge, address, in-store services |
| `order-celebration` | Thank-you page | Animated "HOORAY!" banner and a 3-step order tracker |
| `after-order` | Thank-you page | Google review card + WELCOME10 10% sign-up offer |
| `store-header` / `store-footer` | Thank-you + account pages | Quick links, hours, contact and socials |
| `my-705`, `profile-details`, `order-help` | Customer account | Profile, order help and loyalty-style blocks backed by `/account/*` |

---

## 9. Reporting & Notifications

Every run writes a summary to the Actions run page and uploads a `sync-report-<run_id>` artifact:

```text
stock_changes.csv    price_changes.csv    new_products.csv    warnings.txt
```

When products are created or waiting to be created, the run comments on the open GitHub issue labelled `new-products` (opening one the first time) and mentions the repo owner so GitHub sends an email. The same list is never sent twice.

---

## 10. Repository Structure

```text
nrs-shopify-sync/
├── README.md
├── requirements.txt                    <-- requests, pytest
├── sync_inventory.py                   <-- Hourly NRS → Shopify sync engine
├── audit_catalog.py                    <-- Read-only catalog audit (encrypted output)
├── tests/
│   └── test_sync.py                    <-- pytest suite for matching, pricing and planning
├── murray-worker/                      <-- Cloudflare Worker "brbr-murray"
│   ├── wrangler.toml                   <-- Vars, Durable Object, cron, US placement
│   ├── src/index.js                    <-- Router + "Ask Murray" chat assistant
│   ├── src/nrs-auth.js                 <-- Store-approved OAuth + token store
│   ├── src/signup.js                   <-- Website sign-up
│   ├── src/account.js                  <-- Customer account block APIs
│   └── test/*.test.mjs                 <-- Worker tests
├── customer-account-app/               <-- Private Shopify app (UI extensions)
│   ├── shopify.app.toml
│   └── extensions/                     <-- account-extras, order-celebration, after-order, ...
└── .github/workflows/
    ├── sync.yml                        <-- Hourly sync (dry-run / live)
    ├── audit.yml                       <-- Catalog audit
    ├── deploy-murray.yml               <-- Test + deploy the Worker
    ├── deploy-account-app.yml          <-- Deploy the Shopify app
    └── stop-workers.yml                <-- Pause Worker crons
```

---

## 11. Configuration Reference

### Repository secrets

| Secret | Value |
| :--- | :--- |
| `SHOPIFY_STORE_DOMAIN` | Store handle or full `.myshopify.com` domain |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | The NRS Inventory Sync app's **client secret** (also copied to the Worker by the deploy). An Admin API token (`shpat_...`) also works |
| `SHOPIFY_CLIENT_ID` | The app's client ID |
| `SHOPIFY_LOCATION_ID` | `gid://shopify/Location/...` (a bare number works too) |
| `NRS_AUTH_PATH`, `NRS_STORE_ID`, `NRS_GROUP_ID` | NRS POS API values |
| `NRS_TOKEN_URL`, `NRS_PROXY_URL` | Optional: the Worker's `/nrs/token` and `/nrs/graphql` endpoints |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Worker deploys |
| `GROQ_API_KEY` or `ANTHROPIC_API_KEY` | Chat assistant model |
| `SHOPIFY_SERVICE_ACCOUNT_TOKEN` | Shopify app deploys |

### Repository variables (all optional)

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `SYNC_MODE` | dry run | Set to `live` to let scheduled runs write |
| `PRICE_MARKUP_PERCENT` | `20` | Online markup over register price |
| `SYNC_PRICES` | `true` | Turn price sync on/off |
| `SYNC_STOCK` | `false` | Turn stock sync on/off |
| `INCLUDE_ZERO_STOCK` | `true` | Create items with 0 or negative register stock |
| `MAX_NEW_PRODUCTS_PER_RUN` | `500` | Cap on new listings per run |
| `NEW_PRODUCT_STATUS` | `ACTIVE` | Use `DRAFT` to review new items first |
| `NOTIFY_ASSIGNEE` | repo owner | GitHub user to notify |

Required Shopify scopes: `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_locations`, `write_publications` (plus `read_customers`, `write_customers`, `read_orders` for sign-up and account blocks).

---

## 12. Complete Step-by-Step Reproduction Guide

### Step 1: Install & Test Locally
```bash
pip install -r requirements.txt
python -m pytest -q
cd murray-worker && npm install && npm test
```

### Step 2: Deploy the Worker
1. Add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and a model key as repository secrets.
2. Push a change under `murray-worker/` (or run **Deploy Murray** from the Actions tab). The workflow tests, deploys, sets Worker secrets and runs a health check.

### Step 3: Connect the Store
1. While signed in to the Shopify admin as an owner or app-approving staff member, open `https://<worker>.workers.dev/nrs/install` and approve.
2. Confirm `https://<worker>.workers.dev/nrs/status` returns `connected: true`.

### Step 4: Run a Dry Run
1. Add the NRS and Shopify secrets.
2. Actions → **NRS Inventory Sync** → Run workflow → mode `dry-run`.
3. Download the `sync-report` artifact and review the planned changes.

### Step 5: Go Live
1. Set the repository variable `SYNC_MODE=live`.
2. Scheduled runs now write to Shopify every hour at `:17`.

### Step 6: (Optional) Deploy the Customer Account App
1. Save `SHOPIFY_SERVICE_ACCOUNT_TOKEN` as a secret and push a change under `customer-account-app/`.
2. In Shopify admin → Settings → Checkout → Customize, add the **705 BRBR** blocks to the Orders and Thank-you pages.
