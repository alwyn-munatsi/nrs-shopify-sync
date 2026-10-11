import os
import re
import sys
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
    - Negative or zero stock on shelf -> 0 online.
    - Exactly 1 unit on shelf -> 0 online (reserved for in-store walk-in customers).
    - > 1 unit on shelf -> Stock minus 1 unit safety buffer.
    """
    try:
        q = int(qty)
    except (ValueError, TypeError):
        return 0
    return max(0, q - 1) if q > 1 else 0


def fetch_nrs_inventory() -> dict:
    """Fetches full inventory catalog from the NRS POS API."""
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
        if b:
            nrs_map[b] = calculate_buffer(item.get("onhand", 0))

    return nrs_map


def fetch_shopify_variants() -> dict:
    """
    Paginates all product variants from Shopify Admin GraphQL API.
    Maps normalized barcodes to a list of inventoryItem IDs to handle shared barcodes.
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
    total_variants_with_barcodes = 0

    print("Fetching product variants and barcodes from Shopify...")
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
                total_variants_with_barcodes += 1
                if b not in shopify_map:
                    shopify_map[b] = []
                shopify_map[b].append(inv_item["id"])

        page_info = data.get("pageInfo", {})
        has_next = page_info.get("hasNextPage", False)
        cursor = page_info.get("endCursor")

    print(
        f"Mapped {total_variants_with_barcodes} variants "
        f"across {len(shopify_map)} unique barcodes from Shopify."
    )
    return shopify_map


def push_shopify_updates(updates: list):
    """Batches inventory updates in groups of 100 via Shopify GraphQL mutation."""
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
        inventoryAdjustmentGroup {
          createdAt
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

        res_data = resp.json().get("data", {}).get("inventorySetOnHandQuantities", {})
        user_errors = res_data.get("userErrors", [])
        if user_errors:
            print(f"Batch {idx}/{total_batches} encountered errors: {user_errors}")
        else:
            print(f"Pushed batch {idx}/{total_batches}: Status {resp.status_code}")


def main():
    validate_environment()

    nrs = fetch_nrs_inventory()
    shopify = fetch_shopify_variants()

    updates = []
    for b, item_ids in shopify.items():
        if b in nrs:
            qty = nrs[b]
            for inv_id in item_ids:
                updates.append({
                    "inventoryItemId": inv_id,
                    "locationId": SHOPIFY_LOC_ID,
                    "quantity": qty,
                })

    if updates:
        print(f"Synchronizing {len(updates)} matched items to Shopify location {SHOPIFY_LOC_ID}...")
        push_shopify_updates(updates)
        print("Inventory sync completed successfully.")
    else:
        print("No matching barcodes found between NRS POS and Shopify catalog.")


if __name__ == "__main__":
    main()
