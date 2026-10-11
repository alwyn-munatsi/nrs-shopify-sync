import os
import re
import sys
import time
import requests

# ==========================================
# CONFIGURATION & ENVIRONMENT VARIABLES
# ==========================================
SHOPIFY_TOKEN = os.environ.get("SHOPIFY_ADMIN_ACCESS_TOKEN")
SHOPIFY_STORE = os.environ.get("SHOPIFY_STORE_DOMAIN")
SHOPIFY_LOC_ID = os.environ.get("SHOPIFY_LOCATION_ID")

NRS_AUTH = os.environ.get("NRS_AUTH_PATH")
NRS_STORE = os.environ.get("NRS_STORE_ID")
NRS_GROUP = os.environ.get("NRS_GROUP_ID")

# Set to True if you want register price changes to update on Shopify
SYNC_PRICES = True


def validate_environment():
    """Ensures all necessary environment secrets are set before execution."""
    required = {
        "SHOPIFY_ADMIN_ACCESS_TOKEN": SHOPIFY_TOKEN,
        "SHOPIFY_STORE_DOMAIN": SHOPIFY_STORE,
        "SHOPIFY_LOCATION_ID": SHOPIFY_LOC_ID,
        "NRS_AUTH_PATH": NRS_AUTH,
        "NRS_STORE_ID": NRS_STORE,
        "NRS_GROUP_ID": NRS_GROUP,
    }
    missing = [key for key, val in required.items() if not val]
    if missing:
        print(f"Error: Missing required environment variables: {', '.join(missing)}")
        sys.exit(1)


def clean_barcode(barcode: str) -> str:
    """Normalizes barcodes by stripping non-digits and leading zeros for cross-system matching."""
    if not barcode:
        return ""
    digits = re.sub(r"\D", "", str(barcode))
    return digits.lstrip("0") if digits else ""


def calculate_buffer(qty) -> int:
    """
    Reconciliation logic:
    - Zero or negative stock -> 0 online.
    - Exactly 1 unit -> 0 online (held for walk-ins).
    - > 1 unit -> stock minus 1 safety buffer.
    """
    try:
        q = int(qty)
    except (ValueError, TypeError):
        return 0
    return max(0, q - 1) if q > 1 else 0


def fetch_nrs_catalog() -> dict:
    """
    Fetches the live catalog from the NRS POS API.
    Returns a dictionary keyed by clean_barcode containing:
    {
      'raw_upc': str,
      'name': str,
      'price': float,
      'department': str,
      'onhand': int,
      'buffered_qty': int
    }
    """
    url = f"https://pos-papi.nrsplus.com/{NRS_AUTH}/inventory/{NRS_STORE}/groups/{NRS_GROUP}/upcs"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://mystore.nrsplus.com",
        "Referer": "https://mystore.nrsplus.com/",
    }

    print("Fetching live inventory from NRS POS API...")
    res = requests.get(url, headers=headers, timeout=45)
    res.raise_for_status()

    items = res.json().get("upcs", [])
    print(f"Retrieved {len(items)} catalog items from NRS.")

    nrs_map = {}
    for item in items:
        raw_upc = item.get("upc")
        b = clean_barcode(raw_upc)
        if not b:
            continue

        raw_cents = item.get("cents", 0)
        try:
            price = round(float(raw_cents) / 100.0, 2)
        except (ValueError, TypeError):
            price = 0.0

        nrs_map[b] = {
            "raw_upc": str(raw_upc),
            "name": item.get("name", "New In-Store Product").strip(),
            "price": f"{price:.2f}",
            "department": item.get("department", "General").strip(),
            "onhand": item.get("onhand", 0),
            "buffered_qty": calculate_buffer(item.get("onhand", 0)),
        }

    return nrs_map


def fetch_shopify_catalog() -> dict:
    """
    Paginates all product variants from Shopify Admin GraphQL API.
    Returns a dictionary keyed by clean_barcode containing variant details.
    """
    url = f"https://{SHOPIFY_STORE}.myshopify.com/admin/api/2026-01/graphql.json"
    headers = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    }

    query = """
    query getCatalog($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            price
            barcode
            inventoryItem {
              id
            }
          }
        }
      }
    }
    """

    shopify_map = {}
    has_next = True
    cursor = None
    total_variants = 0

    print("Fetching product variants from Shopify Admin API...")
    while has_next:
        payload = {"query": query, "variables": {"cursor": cursor}}
        resp = requests.post(url, json=payload, headers=headers, timeout=45)
        resp.raise_for_status()

        data = resp.json().get("data", {}).get("productVariants", {})
        for edge in data.get("edges", []):
            node = edge["node"]
            b = clean_barcode(node.get("barcode"))
            inv_item = node.get("inventoryItem")

            if b and inv_item:
                total_variants += 1
                if b not in shopify_map:
                    shopify_map[b] = []
                shopify_map[b].append({
                    "variant_id": node["id"],
                    "inventory_item_id": inv_item["id"],
                    "price": node.get("price"),
                })

        page_info = data.get("pageInfo", {})
        has_next = page_info.get("hasNextPage", False)
        cursor = page_info.get("endCursor")

    print(f"Mapped {total_variants} Shopify variants across {len(shopify_map)} unique barcodes.")
    return shopify_map


def create_draft_product_in_shopify(nrs_item: dict):
    """Creates a new unlisted DRAFT product in Shopify with inventory tracking enabled."""
    url = f"https://{SHOPIFY_STORE}.myshopify.com/admin/api/2026-01/graphql.json"
    headers = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    }

    mutation = """
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          title
          variants(first: 1) {
            nodes {
              id
              inventoryItem {
                id
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
    """

    variables = {
        "input": {
            "title": nrs_item["name"],
            "productType": nrs_item["department"],
            "status": "DRAFT",
            "variants": [
                {
                    "barcode": nrs_item["raw_upc"],
                    "price": nrs_item["price"],
                    "inventoryManagement": "SHOPIFY",
                }
            ],
        }
    }

    resp = requests.post(url, json={"query": mutation, "variables": variables}, headers=headers, timeout=30)
    data = resp.json().get("data", {}).get("productCreate", {})
    user_errors = data.get("userErrors", [])

    if user_errors:
        print(f"Failed to create draft '{nrs_item['name']}': {user_errors}")
        return None

    created = data.get("product", {})
    variants = created.get("variants", {}).get("nodes", [])
    if variants:
        inv_id = variants[0].get("inventoryItem", {}).get("id")
        return inv_id
    return None


def push_inventory_updates(updates: list):
    """Pushes batched inventory quantities to Shopify."""
    url = f"https://{SHOPIFY_STORE}.myshopify.com/admin/api/2026-01/graphql.json"
    headers = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    }

    mutation = """
    mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) {
      inventorySetOnHandQuantities(input: $input) {
        userErrors {
          field
          message
        }
      }
    }
    """

    total_batches = (len(updates) + 99) // 100
    for idx, i in enumerate(range(0, len(updates), 100), 1):
        chunk = updates[i : i + 100]
        payload = {
            "query": mutation,
            "variables": {
                "input": {
                    "reason": "correction",
                    "setQuantities": chunk,
                }
            },
        }

        resp = requests.post(url, json=payload, headers=headers, timeout=45)
        resp.raise_for_status()
        user_errors = resp.json().get("data", {}).get("inventorySetOnHandQuantities", {}).get("userErrors", [])

        if user_errors:
            print(f"Inventory batch {idx}/{total_batches} errors: {user_errors}")
        else:
            print(f"Pushed inventory batch {idx}/{total_batches}: Status {resp.status_code}")


def push_price_updates(price_updates: list):
    """Pushes price corrections to Shopify variants."""
    url = f"https://{SHOPIFY_STORE}.myshopify.com/admin/api/2026-01/graphql.json"
    headers = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    }

    mutation = """
    mutation productVariantUpdate($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        userErrors {
          field
          message
        }
      }
    }
    """

    print(f"Syncing {len(price_updates)} price adjustments from NRS POS...")
    for item in price_updates:
        payload = {
            "query": mutation,
            "variables": {
                "input": {
                    "id": item["variant_id"],
                    "price": item["price"],
                }
            },
        }
        resp = requests.post(url, json=payload, headers=headers, timeout=20)
        time.sleep(0.05)


def main():
    validate_environment()

    nrs = fetch_nrs_catalog()
    shopify = fetch_shopify_catalog()

    inventory_updates = []
    price_updates = []
    new_products_created = 0

    # 1. Sync Existing Products
    for b, variant_list in shopify.items():
        if b in nrs:
            target_qty = nrs[b]["buffered_qty"]
            nrs_price = nrs[b]["price"]

            for variant in variant_list:
                inventory_updates.append({
                    "inventoryItemId": variant["inventory_item_id"],
                    "locationId": SHOPIFY_LOC_ID,
                    "quantity": target_qty,
                })

                if SYNC_PRICES and variant.get("price") != nrs_price:
                    price_updates.append({
                        "variant_id": variant["variant_id"],
                        "price": nrs_price,
                    })

    # 2. Detect & Auto-Create Products Added on POS (capped at 25 per run to protect rate limits)
    max_creations_per_run = 25
    for b, nrs_item in nrs.items():
        if b not in shopify:
            # Only create drafts for items with positive stock or active listings
            if nrs_item["buffered_qty"] > 0 and new_products_created < max_creations_per_run:
                print(f"New POS item detected: '{nrs_item['name']}' (UPC: {nrs_item['raw_upc']}). Creating Draft...")
                inv_id = create_draft_product_in_shopify(nrs_item)
                if inv_id:
                    new_products_created += 1
                    inventory_updates.append({
                        "inventoryItemId": inv_id,
                        "locationId": SHOPIFY_LOC_ID,
                        "quantity": nrs_item["buffered_qty"],
                    })
                time.sleep(0.2)

    # 3. Execute Batch Updates
    if inventory_updates:
        print(f"Synchronizing {len(inventory_updates)} inventory items to Shopify location {SHOPIFY_LOC_ID}...")
        push_inventory_updates(inventory_updates)

    if price_updates:
        push_price_updates(price_updates)

    print(
        f"\nRun complete: "
        f"{len(inventory_updates)} inventory entries updated, "
        f"{len(price_updates)} price changes applied, "
        f"{new_products_created} new draft products created."
    )


if __name__ == "__main__":
    main()
