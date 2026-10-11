import os
import re
import requests

# ----------------- ENVIRONMENT VARIABLES -----------------
SHOPIFY_TOKEN = os.environ.get("SHOPIFY_ADMIN_ACCESS_TOKEN")
SHOPIFY_STORE = os.environ.get("SHOPIFY_STORE_DOMAIN")
SHOPIFY_LOC_ID = os.environ.get("SHOPIFY_LOCATION_ID")

NRS_AUTH = os.environ.get("NRS_AUTH_PATH")
NRS_STORE = os.environ.get("NRS_STORE_ID")
NRS_GROUP = os.environ.get("NRS_GROUP_ID")

def clean_barcode(barcode: str) -> str:
    """Normalizes barcodes by stripping non-digits and leading zeros for matching."""
    if not barcode:
        return ""
    digits = re.sub(r"\D", "", str(barcode))
    return digits.lstrip("0") if digits else ""

def calculate_buffer(qty) -> int:
    """
    Reconciliation logic:
    - Zero or negative in-store stock -> 0 online.
    - 1 on shelf -> 0 online (reserved for walk-in shoppers).
    - > 1 on shelf -> Stock minus 1 safety buffer.
    """
    try:
        q = int(qty)
    except (ValueError, TypeError):
        return 0
    return max(0, q - 1) if q > 1 else 0

def fetch_nrs_inventory():
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

def fetch_shopify_variants():
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

    print("Fetching product variants and barcodes from Shopify...")
    while has_next:
        resp = requests.post(url, json={"query": query, "variables": {"cursor": cursor}}, headers=headers)
        resp.raise_for_status()
        data = resp.json().get("data", {}).get("productVariants", {})
        for edge in data.get("edges", []):
            node = edge["node"]
            b = clean_barcode(node.get("barcode"))
            if b and node.get("inventoryItem"):
                shopify_map[b] = node["inventoryItem"]["id"]
        
        page_info = data.get("pageInfo", {})
        has_next = page_info.get("hasNextPage", False)
        cursor = page_info.get("endCursor")

    print(f"Mapped {len(shopify_map)} variants with barcodes from Shopify.")
    return shopify_map

def push_shopify(updates):
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
    # Batch updates in groups of 100 to stay within GraphQL limits
    for i in range(0, len(updates), 100):
        chunk = updates[i:i + 100]
        payload = {
            "query": mutation,
            "variables": {
                "input": {
                    "reason": "correction",
                    "setQuantities": chunk,
                }
            },
        }
        resp = requests.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        print(f"Pushed batch {i // 100 + 1}: Status {resp.status_code}")

def main():
    nrs = fetch_nrs_inventory()
    shopify = fetch_shopify_variants()

    updates = [
        {"inventoryItemId": shopify[b], "locationId": SHOPIFY_LOC_ID, "quantity": nrs[b]}
        for b in shopify if b in nrs
    ]

    if updates:
        print(f"Synchronizing {len(updates)} matched items to Shopify location {SHOPIFY_LOC_ID}...")
        push_shopify(updates)
        print("Inventory sync successfully completed.")
    else:
        print("No matching barcodes found between NRS POS and Shopify catalog.")

if __name__ == "__main__":
    main()
