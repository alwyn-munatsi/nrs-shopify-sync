"""
NRS POS -> Shopify sync for 705 BRBR.

What one run does:
  1. Reads the live catalog from the NRS POS (barcode, name, price, department, on-hand).
  2. Reads every Shopify variant (barcode, price, on-hand at the store location).
  3. Matches them by barcode and works out:
       - stock changes   (Shopify on-hand = NRS on-hand minus a 1-unit walk-in buffer)
       - price changes   (NRS always wins)
       - new products    (in NRS with stock, not in Shopify yet) -> created as DRAFT products
  4. In live mode it writes those changes to Shopify. In dry-run mode it writes nothing.
  5. Writes a report (job summary + CSV files) and, when new products were created or are
     waiting to be created, posts a notification on a GitHub issue.

Environment:
  SHOPIFY_STORE_DOMAIN        store handle (7e36ef-2) or full domain (7e36ef-2.myshopify.com)
  SHOPIFY_ADMIN_ACCESS_TOKEN  shpat_ token, or the app's client secret when SHOPIFY_CLIENT_ID is set
  SHOPIFY_CLIENT_ID           optional: app client id, used with the client credentials grant
  SHOPIFY_LOCATION_ID         gid://shopify/Location/... (a bare number also works)
  NRS_AUTH_PATH, NRS_STORE_ID, NRS_GROUP_ID
  SYNC_MODE                   "dry-run" (default) or "live"
  SYNC_PRICES                 "true" (default) / "false"
  MAX_NEW_PRODUCTS_PER_RUN    default 25
  REPORT_DIR                  default "report"
  GITHUB_TOKEN, GITHUB_REPOSITORY, NOTIFY_ASSIGNEE   for the issue notification (set by the workflow)
"""

import csv
import hashlib
import json
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import requests

API_VERSION = "2026-10"
NRS_URL = "https://pos-papi.nrsplus.com/{auth}/inventory/{store}/groups/{group}/upcs"
NRS_PRICEBOOK_URL = "https://pos-papi.nrsplus.com/{auth}/pbitems/{store}/default"
NRS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://mystore.nrsplus.com",
    "Referer": "https://mystore.nrsplus.com/",
}
NOTIFY_LABEL = "new-products"


# ==========================================
# HELPERS
# ==========================================

def env_flag(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None or val.strip() == "":
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def clean_barcode(barcode) -> str:
    """Normalizes barcodes by stripping non-digits and leading zeros for cross-system matching."""
    if not barcode:
        return ""
    digits = re.sub(r"\D", "", str(barcode))
    return digits.lstrip("0") if digits else ""


def calculate_buffer(qty) -> int:
    """
    Online stock rule:
    - Zero or negative stock -> 0 online.
    - Exactly 1 unit -> 0 online (held for walk-ins).
    - More than 1 unit -> stock minus 1 safety buffer.
    """
    try:
        q = int(qty)
    except (ValueError, TypeError):
        return 0
    return q - 1 if q > 1 else 0


def to_price(value):
    """Returns a Decimal rounded to cents, or None when the value is not a usable number."""
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError, TypeError):
        return None


def normalize_store_domain(raw: str) -> str:
    raw = (raw or "").strip().lower()
    raw = re.sub(r"^https?://", "", raw).split("/")[0]
    return raw if raw.endswith(".myshopify.com") else f"{raw}.myshopify.com"


def normalize_location_id(raw: str) -> str:
    raw = (raw or "").strip()
    return raw if raw.startswith("gid://") else f"gid://shopify/Location/{raw}"


def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i : i + size]


# ==========================================
# NRS
# ==========================================

def parse_nrs_items(items) -> dict:
    """
    Turns the raw NRS 'upcs' list into a dict keyed by clean barcode:
    { 'raw_upc', 'name', 'price' (Decimal or None), 'department', 'onhand', 'target_qty' }
    """
    nrs_map = {}
    for item in items or []:
        raw_upc = item.get("upc")
        b = clean_barcode(raw_upc)
        if not b:
            continue

        cents = item.get("cents")
        price = None
        try:
            if cents is not None:
                price = (Decimal(str(cents)) / 100).quantize(Decimal("0.01"))
        except (InvalidOperation, ValueError, TypeError):
            price = None

        try:
            onhand = int(item.get("onhand") or 0)
        except (ValueError, TypeError):
            onhand = 0

        nrs_map[b] = {
            "raw_upc": re.sub(r"\D", "", str(raw_upc)),
            "name": (item.get("name") or "").strip() or "New In-Store Product",
            "price": price,
            "department": (item.get("department") or item.get("dept") or "").strip() or "General",
            "onhand": onhand,
            "target_qty": calculate_buffer(onhand),
        }
    return nrs_map


def parse_pricebook_items(items) -> dict:
    """
    Turns NRS price book rows into the same shape as parse_nrs_items. The price book carries the
    register price ('cents') and the item's inventory record (with 'onhand').
    Items with a variable (open) price have no fixed price, so their price is left empty.
    """
    rows = []
    for it in items or []:
        inv = it.get("inventory") or {}
        rows.append({
            "upc": it.get("upc"),
            "name": it.get("name"),
            "dept": it.get("dept"),
            "cents": None if it.get("variableprice") else it.get("cents"),
            "onhand": inv.get("onhand", 0),
        })
    return parse_nrs_items(rows)


def fetch_nrs_pricebook(auth: str, store: str, page_size: int = 2000) -> list:
    url = NRS_PRICEBOOK_URL.format(auth=auth, store=store)
    items, start = [], 0
    while True:
        res = requests.get(url, headers=NRS_HEADERS, params={"draw": 1, "start": start, "length": page_size}, timeout=90)
        res.raise_for_status()
        body = res.json()
        rc = (body.get("res") or {}).get("rc", 0)
        if rc != 0:
            raise RuntimeError(f"NRS price book error: {body.get('res')}")
        page = body.get("data") or []
        items.extend(page)
        if len(page) < page_size:
            break
        start += page_size
    return items


def fetch_nrs_catalog(auth: str, store: str, group: str) -> dict:
    """
    Reads the NRS price book (names, departments, register prices, on-hand) and, as a fallback for
    stock, the inventory list. Price book rows win; inventory-only items are added without a price.
    """
    print("Fetching the NRS price book...")
    pricebook = fetch_nrs_pricebook(auth, store)
    print(f"Retrieved {len(pricebook)} price book items from NRS.")
    catalog = parse_pricebook_items(pricebook)
    priced = sum(1 for v in catalog.values() if v["price"] and v["price"] > 0)
    print(f"Price book items with a fixed price: {priced}.")

    print("Fetching live inventory from NRS POS API...")
    res = requests.get(NRS_URL.format(auth=auth, store=store, group=group), headers=NRS_HEADERS, timeout=60)
    res.raise_for_status()
    items = res.json().get("upcs", [])
    print(f"Retrieved {len(items)} inventory items from NRS.")
    describe_nrs(items)
    for b, inv in parse_nrs_items(items).items():
        if b not in catalog:
            catalog[b] = inv
    return catalog


def describe_nrs(items):
    """Logs the NRS field names and how stock is spread, to spot feeds without stock counts."""
    if not items:
        return
    keys = sorted({k for it in items[:200] for k in it.keys()})
    print(f"NRS fields: {', '.join(keys)}")
    buckets = {"missing": 0, "<0": 0, "0": 0, "1": 0, "2-5": 0, "6+": 0}
    for it in items:
        v = it.get("onhand")
        try:
            q = int(v)
        except (TypeError, ValueError):
            buckets["missing"] += 1
            continue
        buckets["<0" if q < 0 else "0" if q == 0 else "1" if q == 1 else "2-5" if q <= 5 else "6+"] += 1
    print("NRS on-hand spread: " + ", ".join(f"{k}: {v}" for k, v in buckets.items()))

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0
    last_sold = sorted(str(it["last_sold"]) for it in items if it.get("last_sold"))
    print(
        "NRS activity: "
        f"sold>0: {sum(1 for it in items if num(it.get('sold')) > 0)}, "
        f"added>0: {sum(1 for it in items if num(it.get('added')) > 0)}, "
        f"base_count set: {sum(1 for it in items if it.get('base_count') not in (None, 0, '0'))}, "
        f"tracked: {sum(1 for it in items if it.get('tracked'))}, "
        f"in pricebook: {sum(1 for it in items if it.get('inpricebook'))}, "
        f"with last_sold: {len(last_sold)}"
        + (f" (latest {last_sold[-1]})" if last_sold else "")
    )
    for k in ("base_count", "thresholds", "alarms"):
        ex = next((it[k] for it in items if it.get(k) not in (None, 0, "0", [], {})), None)
        if ex is not None:
            print(f"NRS example {k}: {json.dumps(ex)[:300]}")
    sample = {k: v for k, v in items[0].items() if not isinstance(v, (dict, list))}
    print(f"NRS sample item: {json.dumps(sample)[:600]}")


# ==========================================
# SHOPIFY CLIENT
# ==========================================

class ShopifyError(RuntimeError):
    pass


class Shopify:
    def __init__(self, domain: str, token: str, session=None):
        self.url = f"https://{domain}/admin/api/{API_VERSION}/graphql.json"
        self.session = session or requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token,
        })

    def graphql(self, query: str, variables=None, retries: int = 6) -> dict:
        """Runs a GraphQL call. Raises on HTTP or GraphQL errors; waits and retries when throttled."""
        for attempt in range(retries):
            resp = self.session.post(self.url, json={"query": query, "variables": variables or {}}, timeout=60)
            if resp.status_code in (429, 502, 503, 504):
                time.sleep(min(2 ** attempt, 30))
                continue
            if resp.status_code >= 400:
                raise ShopifyError(f"HTTP {resp.status_code}: {resp.text[:500]}")

            body = resp.json()
            errors = body.get("errors") or []
            if any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in errors):
                time.sleep(min(2 ** attempt, 30))
                continue
            if errors:
                raise ShopifyError(f"GraphQL errors: {json.dumps(errors)[:1000]}")

            self._respect_rate_limit(body)
            return body.get("data") or {}
        raise ShopifyError("Shopify kept throttling the request; giving up after retries.")

    @staticmethod
    def _respect_rate_limit(body):
        status = ((body.get("extensions") or {}).get("cost") or {}).get("throttleStatus") or {}
        available = status.get("currentlyAvailable")
        restore = status.get("restoreRate") or 50
        if available is not None and available < 200:
            time.sleep((200 - available) / restore)


def token_works(domain: str, token: str) -> bool:
    """True when the token is accepted by the Admin API as an access token."""
    res = requests.post(
        f"https://{domain}/admin/api/{API_VERSION}/graphql.json",
        json={"query": "{ shop { id } }"},
        headers={"Content-Type": "application/json", "X-Shopify-Access-Token": token},
        timeout=30,
    )
    return res.status_code == 200 and not res.json().get("errors")


def get_shopify_token(domain: str, token: str, client_id: str) -> str:
    """
    Uses the secret directly when it works as an access token. Otherwise, when a client id is set,
    treats it as the app's client secret and exchanges it with the client credentials grant.
    """
    if not client_id or token_works(domain, token):
        return token
    print("Requesting a Shopify access token with the client credentials grant...")
    res = requests.post(
        f"https://{domain}/admin/oauth/access_token",
        json={"client_id": client_id, "client_secret": token, "grant_type": "client_credentials"},
        timeout=30,
    )
    res.raise_for_status()
    access = res.json().get("access_token")
    if not access:
        raise ShopifyError("Shopify did not return an access_token.")
    return access


CATALOG_QUERY = """
query Catalog($cursor: String, $loc: ID!) {
  productVariants(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      price
      product { id title status }
      barcodes(first: 5) { nodes { value } }
      inventoryItem {
        id
        tracked
        inventoryLevel(locationId: $loc) { quantities(names: ["on_hand"]) { quantity } }
      }
    }
  }
}
"""


def parse_variant(node: dict) -> list:
    """Returns (clean_barcode, variant_dict) pairs for one Shopify variant node."""
    inv = node.get("inventoryItem") or {}
    if not inv.get("id"):
        return []
    level = inv.get("inventoryLevel")
    on_hand = None
    if level:
        qs = level.get("quantities") or []
        on_hand = qs[0].get("quantity") if qs else 0
    product = node.get("product") or {}
    variant = {
        "variant_id": node["id"],
        "product_id": product.get("id"),
        "title": product.get("title", ""),
        "status": product.get("status", ""),
        "price": to_price(node.get("price")),
        "inventory_item_id": inv["id"],
        "tracked": bool(inv.get("tracked")),
        "stocked": level is not None,
        "on_hand": on_hand,
    }
    seen = set()
    pairs = []
    for bc in ((node.get("barcodes") or {}).get("nodes") or []):
        b = clean_barcode(bc.get("value"))
        if b and b not in seen:
            seen.add(b)
            pairs.append((b, variant))
    return pairs


def fetch_shopify_catalog(shop: Shopify, location_id: str) -> dict:
    print("Fetching product variants from Shopify Admin API...")
    shopify_map = {}
    cursor, has_next, total = None, True, 0
    while has_next:
        data = shop.graphql(CATALOG_QUERY, {"cursor": cursor, "loc": location_id})
        conn = data.get("productVariants") or {}
        for node in conn.get("nodes", []):
            total += 1
            for b, variant in parse_variant(node):
                shopify_map.setdefault(b, []).append(variant)
        page = conn.get("pageInfo") or {}
        has_next = page.get("hasNextPage", False)
        cursor = page.get("endCursor")
    print(f"Read {total} Shopify variants; {len(shopify_map)} unique barcodes.")
    return shopify_map


# ==========================================
# PLAN (pure: no API calls, easy to test)
# ==========================================

@dataclass
class Plan:
    stock: list = field(default_factory=list)        # existing variants whose on-hand changes
    activate: list = field(default_factory=list)     # existing variants not stocked at the location yet
    prices: list = field(default_factory=list)       # existing variants whose price changes
    new_products: list = field(default_factory=list) # NRS items to create this run
    queued: list = field(default_factory=list)       # NRS items that would be created, but over the per-run cap
    warnings: list = field(default_factory=list)
    matched: int = 0
    shopify_only: int = 0
    untracked: int = 0


def build_plan(nrs: dict, shopify: dict, sync_prices: bool = True, max_new: int = 25) -> Plan:
    plan = Plan()

    for b, variants in shopify.items():
        item = nrs.get(b)
        if not item:
            plan.shopify_only += len(variants)
            continue
        for v in variants:
            plan.matched += 1
            if not v["tracked"]:
                plan.untracked += 1
            row = {**v, "barcode": item["raw_upc"], "nrs_name": item["name"], "nrs_onhand": item["onhand"]}

            target = item["target_qty"]
            if not v["stocked"]:
                plan.activate.append({**row, "from": None, "to": target})
            elif v["on_hand"] != target:
                plan.stock.append({**row, "from": v["on_hand"], "to": target})

            if sync_prices:
                if item["price"] is None or item["price"] <= 0:
                    plan.warnings.append(
                        f"Price not changed for '{v['title']}' ({item['raw_upc']}): NRS price is "
                        f"{item['price'] if item['price'] is not None else 'missing'}."
                    )
                elif v["price"] != item["price"]:
                    plan.prices.append({**row, "from": v["price"], "to": item["price"]})

    candidates = [
        {"barcode": item["raw_upc"], **item}
        for b, item in nrs.items()
        if b not in shopify and item["onhand"] > 0
    ]
    candidates.sort(key=lambda x: x["name"].lower())
    for item in candidates:
        if item["price"] is None or item["price"] <= 0:
            plan.warnings.append(f"New register item '{item['name']}' ({item['raw_upc']}) has no NRS price; not created.")
            continue
        (plan.new_products if len(plan.new_products) < max_new else plan.queued).append(item)

    return plan


# ==========================================
# WRITES (live mode only)
# ==========================================

def apply_stock(shop: Shopify, rows: list, location_id: str) -> list:
    """Sets on-hand quantities, 100 per call. Returns a list of error strings."""
    mutation = """
    mutation SetStock($input: InventorySetQuantitiesInput!, $key: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $key) {
        userErrors { code field message }
      }
    }
    """
    errors = []
    batches = list(chunks(rows, 100))
    for i, batch in enumerate(batches, 1):
        data = shop.graphql(mutation, {
            "key": str(uuid.uuid4()),
            "input": {
                "name": "on_hand",
                "reason": "correction",
                "referenceDocumentUri": "nrs-shopify-sync://run",
                "quantities": [
                    {
                        "inventoryItemId": r["inventory_item_id"],
                        "locationId": location_id,
                        "quantity": r["to"],
                        # NRS is the source of truth, so skip Shopify's compare-and-set check.
                        "changeFromQuantity": None,
                    }
                    for r in batch
                ],
            },
        })
        user_errors = (data.get("inventorySetQuantities") or {}).get("userErrors") or []
        if user_errors:
            errors.append(f"Stock batch {i}/{len(batches)}: {user_errors}")
        print(f"Stock batch {i}/{len(batches)}: {len(batch)} items, {len(user_errors)} errors")
    return errors


def apply_activations(shop: Shopify, rows: list, location_id: str) -> list:
    mutation = """
    mutation Activate($item: ID!, $loc: ID!, $qty: Int, $key: String!) {
      inventoryActivate(inventoryItemId: $item, locationId: $loc, onHand: $qty) @idempotent(key: $key) {
        userErrors { field message }
      }
    }
    """
    errors = []
    for r in rows:
        data = shop.graphql(mutation, {"item": r["inventory_item_id"], "loc": location_id, "qty": r["to"], "key": str(uuid.uuid4())})
        user_errors = (data.get("inventoryActivate") or {}).get("userErrors") or []
        if user_errors:
            errors.append(f"Activate '{r['title']}': {user_errors}")
    print(f"Stocked {len(rows) - len(errors)} variants at the location for the first time.")
    return errors


def apply_prices(shop: Shopify, rows: list, per_request: int = 20) -> list:
    """Updates prices grouped by product, several products per request using aliases."""
    by_product = {}
    for r in rows:
        by_product.setdefault(r["product_id"], []).append({"id": r["variant_id"], "price": str(r["to"])})

    errors = []
    products = list(by_product.items())
    groups = list(chunks(products, per_request))
    for gi, group in enumerate(groups, 1):
        params, fields, variables = [], [], {}
        for i, (pid, variants) in enumerate(group):
            params.append(f"$p{i}: ID!, $v{i}: [ProductVariantsBulkInput!]!")
            fields.append(
                f"u{i}: productVariantsBulkUpdate(productId: $p{i}, variants: $v{i}) {{ userErrors {{ field message }} }}"
            )
            variables[f"p{i}"] = pid
            variables[f"v{i}"] = variants
        mutation = f"mutation Prices({', '.join(params)}) {{ {' '.join(fields)} }}"
        data = shop.graphql(mutation, variables)
        group_errors = 0
        for i, (pid, _) in enumerate(group):
            user_errors = (data.get(f"u{i}") or {}).get("userErrors") or []
            if user_errors:
                group_errors += 1
                errors.append(f"Price update for {pid}: {user_errors}")
        print(f"Price batch {gi}/{len(groups)}: {len(group)} products, {group_errors} errors")
    return errors


CREATE_MUTATION = """
mutation CreateProduct($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) {
    product { id title handle }
    userErrors { field message code }
  }
}
"""


def create_product(shop: Shopify, item: dict, location_id: str):
    """Creates one DRAFT product with price, barcode, tracked inventory and on-hand stock."""
    data = shop.graphql(CREATE_MUTATION, {
        "input": {
            "title": item["name"],
            "productType": item["department"],
            "status": "DRAFT",
            "tags": ["nrs-sync", "needs-review"],
            "productOptions": [{"name": "Title", "values": [{"name": "Default Title"}]}],
            "variants": [{
                "optionValues": [{"optionName": "Title", "name": "Default Title"}],
                "price": str(item["price"]),
                "barcodes": [{"value": item["raw_upc"]}],
                "inventoryItem": {"tracked": True},
                "inventoryQuantities": [{"locationId": location_id, "name": "on_hand", "quantity": item["target_qty"]}],
            }],
        }
    })
    payload = data.get("productSet") or {}
    user_errors = payload.get("userErrors") or []
    if user_errors:
        return None, f"Create '{item['name']}' ({item['raw_upc']}): {user_errors}"
    return payload.get("product"), None


# ==========================================
# REPORTING & NOTIFICATION
# ==========================================

def write_csv(path, rows, columns):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def admin_product_url(domain: str, product_id: str) -> str:
    handle = domain.replace(".myshopify.com", "")
    return f"https://admin.shopify.com/store/{handle}/products/{product_id.rsplit('/', 1)[-1]}"


def new_products_markdown(created: list, pending: list, failed: list, live: bool, domain: str) -> str:
    lines = []
    if created:
        lines.append(f"### Created as draft products ({len(created)})")
        lines.append("| Product | Barcode | Department | Price | Online stock |")
        lines.append("|---|---|---|---|---|")
        for c in created:
            name = f"[{c['name']}]({admin_product_url(domain, c['product_id'])})" if c.get("product_id") else c["name"]
            lines.append(f"| {name} | {c['raw_upc']} | {c['department']} | ${c['price']} | {c['target_qty']} |")
        lines.append("")
    if pending:
        heading = "Would be created (dry run)" if not live else "Waiting to be created on the next runs (over this run's limit)"
        lines.append(f"### {heading} ({len(pending)})")
        lines.append("| Product | Barcode | Department | Price | Register stock |")
        lines.append("|---|---|---|---|---|")
        for p in pending[:200]:
            lines.append(f"| {p['name']} | {p['raw_upc']} | {p['department']} | ${p['price']} | {p['onhand']} |")
        if len(pending) > 200:
            lines.append(f"| ...and {len(pending) - 200} more (see the CSV in the run's report) | | | | |")
        lines.append("")
    if failed:
        lines.append(f"### Could not be created ({len(failed)})")
        lines.extend(f"- {f}" for f in failed)
        lines.append("")
    return "\n".join(lines)


def notify_github(markdown: str, title: str, signature: str = ""):
    """
    Comments on the open 'new-products' issue (creating it if needed) so the assignee gets a notification.
    `signature` identifies what is being reported; when it matches the last notification the comment is
    skipped, so the same pending list is not re-sent every hour.
    """
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo:
        print("GitHub notification skipped (GITHUB_TOKEN/GITHUB_REPOSITORY not set).")
        return
    api = f"https://api.github.com/repos/{repo}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    assignee = os.environ.get("NOTIFY_ASSIGNEE") or repo.split("/")[0]
    run_url = ""
    if os.environ.get("GITHUB_RUN_ID"):
        run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    body = f"## {title}\n\n{markdown}\n" + (f"\nFull report: {run_url}\n" if run_url else "")
    if len(body) > 60000:
        body = body[:60000] + "\n\n(truncated, see the full report)"

    try:
        res = requests.get(f"{api}/issues", headers=headers, params={"labels": NOTIFY_LABEL, "state": "open"}, timeout=30)
        res.raise_for_status()
        issues = [i for i in res.json() if "pull_request" not in i]
        marker = f"<!-- nrs-sync-signature:{signature} -->"
        if issues:
            issue = issues[0]
            number = issue["number"]
            issue_body = issue.get("body") or ""
            if signature and marker in issue_body:
                print(f"Nothing new since the last notification on issue #{number}; skipped.")
                return
            requests.post(f"{api}/issues/{number}/comments", headers=headers, json={"body": f"@{assignee}\n\n{body}"}, timeout=30).raise_for_status()
            new_body = re.sub(r"<!-- nrs-sync-signature:[^>]* -->", "", issue_body).rstrip() + "\n\n" + marker
            requests.patch(f"{api}/issues/{number}", headers=headers, json={"body": new_body}, timeout=30).raise_for_status()
            print(f"Notification posted on issue #{number}.")
        else:
            res = requests.post(f"{api}/issues", headers=headers, json={
                "title": "New register products for Shopify",
                "body": "The NRS sync posts here whenever it creates new draft products, or finds register items "
                        "that are waiting to be created. Review the drafts in Shopify, add images and publish them.\n\n" + body
                        + "\n\n" + marker,
                "labels": [NOTIFY_LABEL],
                "assignees": [assignee],
            }, timeout=30)
            res.raise_for_status()
            print(f"Notification issue #{res.json()['number']} opened.")
    except requests.RequestException as e:
        print(f"Warning: could not post the GitHub notification: {e}")


def summary(text: str):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text + "\n")


# ==========================================
# MAIN
# ==========================================

def main() -> int:
    required = ["SHOPIFY_ADMIN_ACCESS_TOKEN", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_LOCATION_ID",
                "NRS_AUTH_PATH", "NRS_STORE_ID", "NRS_GROUP_ID"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Error: Missing required environment variables: {', '.join(missing)}")
        return 1

    mode = (os.environ.get("SYNC_MODE") or "dry-run").strip().lower()
    live = mode == "live"
    sync_prices = env_flag("SYNC_PRICES", True)
    max_new = int(os.environ.get("MAX_NEW_PRODUCTS_PER_RUN") or 25)
    report_dir = os.environ.get("REPORT_DIR") or "report"
    os.makedirs(report_dir, exist_ok=True)

    domain = normalize_store_domain(os.environ["SHOPIFY_STORE_DOMAIN"])
    location_id = normalize_location_id(os.environ["SHOPIFY_LOCATION_ID"])
    print(f"Mode: {'LIVE (writes to Shopify)' if live else 'DRY RUN (no changes)'} | store {domain} | prices {'on' if sync_prices else 'off'}")

    token = get_shopify_token(domain, os.environ["SHOPIFY_ADMIN_ACCESS_TOKEN"], os.environ.get("SHOPIFY_CLIENT_ID"))
    shop = Shopify(domain, token)

    nrs = fetch_nrs_catalog(os.environ["NRS_AUTH_PATH"], os.environ["NRS_STORE_ID"], os.environ["NRS_GROUP_ID"])
    shopify = fetch_shopify_catalog(shop, location_id)
    if not nrs:
        print("Error: NRS returned no items; stopping so Shopify is not zeroed out.")
        return 1

    plan = build_plan(nrs, shopify, sync_prices=sync_prices, max_new=max_new)
    print(
        f"Matched {plan.matched} variants by barcode ({plan.shopify_only} Shopify variants not in NRS). "
        f"Planned: {len(plan.stock)} stock changes, {len(plan.activate)} first-time stockings, "
        f"{len(plan.prices)} price changes, {len(plan.new_products)} new products "
        f"(+{len(plan.queued)} over the per-run limit)."
    )

    errors, created, failed = [], [], []
    if live:
        if plan.stock:
            errors += apply_stock(shop, plan.stock, location_id)
        if plan.activate:
            errors += apply_activations(shop, plan.activate, location_id)
        if plan.prices:
            errors += apply_prices(shop, plan.prices)
        for item in plan.new_products:
            product, err = create_product(shop, item, location_id)
            if err:
                failed.append(err)
            else:
                created.append({**item, "product_id": product["id"]})
                print(f"Created draft: {item['name']} ({item['raw_upc']})")
        pending = plan.queued
    else:
        pending = plan.new_products + plan.queued

    # Reports
    write_csv(os.path.join(report_dir, "stock_changes.csv"), plan.stock + plan.activate,
              ["title", "barcode", "nrs_onhand", "from", "to", "product_id", "variant_id"])
    write_csv(os.path.join(report_dir, "price_changes.csv"), plan.prices,
              ["title", "barcode", "from", "to", "product_id", "variant_id"])
    write_csv(os.path.join(report_dir, "new_products.csv"),
              [{**c, "status": "created"} for c in created] + [{**p, "status": "pending"} for p in pending],
              ["status", "name", "raw_upc", "department", "price", "onhand", "target_qty", "product_id"])
    with open(os.path.join(report_dir, "warnings.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(plan.warnings + errors + failed))

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    verb = "" if live else "would be "
    md = [
        f"## NRS → Shopify sync ({'live' if live else 'dry run'}) · {stamp}",
        "",
        "| | Count |",
        "|---|---|",
        f"| NRS items with a barcode | {len(nrs)} |",
        f"| Shopify variants matched by barcode | {plan.matched} |",
        f"| Shopify variants not found in NRS | {plan.shopify_only} |",
        f"| Stock levels {verb}changed | {len(plan.stock) + len(plan.activate)} |",
        f"| Prices {verb}changed | {len(plan.prices)} |",
        f"| New draft products {'created' if live else 'that would be created'} | {len(created) if live else len(pending)} |",
        f"| Warnings | {len(plan.warnings)} |",
        f"| Errors | {len(errors) + len(failed)} |",
        "",
    ]
    if plan.untracked:
        md.append(f"Note: {plan.untracked} matched variants do not track inventory in Shopify, so stock changes won't limit sales for them.\n")
    if plan.prices:
        ups = [p for p in plan.prices if p["to"] > p["from"]]
        downs = [p for p in plan.prices if p["to"] < p["from"]]
        pct = sorted(float((p["to"] - p["from"]) / p["from"] * 100) for p in plan.prices if p["from"])
        median = pct[len(pct) // 2] if pct else 0
        md.append(
            f"**Price changes:** {len(downs)} lower, {len(ups)} higher than Shopify today. "
            f"Median change {median:+.1f}%.\n"
        )
        md.append("### Price changes (first 25)")
        md.append("| Product | Shopify | NRS |")
        md.append("|---|---|---|")
        md.extend(f"| {p['title']} | ${p['from']} | ${p['to']} |" for p in plan.prices[:25])
        md.append("")
    new_md = new_products_markdown(created, pending, failed, live, domain)
    md.append(new_md)
    if errors:
        md.append("### Errors")
        md.extend(f"- {e}" for e in errors[:50])
    summary("\n".join(md))

    if created or pending or failed:
        title = (f"{len(created)} new draft product(s) created" if live else "Dry run") + \
                (f", {len(pending)} {'waiting' if live else 'would be created'}" if pending else "") + f" · {stamp}"
        signature = hashlib.sha1(json.dumps({
            "mode": mode,
            "created": sorted(c["raw_upc"] for c in created),
            "pending": sorted(p["raw_upc"] for p in pending),
            "failed": sorted(failed),
        }).encode()).hexdigest()[:16]
        notify_github(new_md, title, signature)

    print(
        f"\nRun complete ({'live' if live else 'dry run'}): "
        f"{len(plan.stock) + len(plan.activate)} stock changes, {len(plan.prices)} price changes, "
        f"{len(created)} products created, {len(pending)} pending, {len(errors) + len(failed)} errors."
    )
    return 1 if (errors or failed) else 0


if __name__ == "__main__":
    sys.exit(main())
