import os
import re
import requests

# ----------------- CREDENTIALS & SECRETS -----------------
SHOPIFY_STORE = os.environ.get("SHOPIFY_STORE_DOMAIN")      # 7e36ef-2
SHOPIFY_LOC_ID = os.environ.get("SHOPIFY_LOCATION_ID")     # gid://shopify/Location/94874992939
CLIENT_ID = os.environ.get("SHOPIFY_CLIENT_ID")            # 66b5f34ecc5b5db4dcc66759f817f892
CLIENT_SECRET = os.environ.get("SHOPIFY_ADMIN_ACCESS_TOKEN") # Your Client Secret

NRS_AUTH = os.environ.get("NRS_AUTH_PATH")
NRS_STORE = os.environ.get("NRS_STORE_ID")
NRS_GROUP = os.environ.get("NRS_GROUP_ID")

def get_shopify_token() -> str:
    """Exchanges Client ID and Secret for an Admin API Access Token."""
    # If a static shpat_ token was provided directly, use it
    if CLIENT_SECRET and CLIENT_SECRET.startswith("shpat_"):
        return CLIENT_SECRET

    url = f"https://{SHOPIFY_STORE}.myshopify.com/admin/oauth/access_token"
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "client_credentials"
    }
    print("Authenticating with Shopify Admin API via Client Credentials...")
    res = requests.post(url, json=payload, timeout=20)
    res.raise_for_status()
    data = res.json()
    token = data.get("access_token")
    if not token:
        raise ValueError(f"No access_token returned by Shopify: {data}")
    print("Shopify authentication successful.")
    return token

def clean_barcode(barcode: str) -> str:
    if not barcode:
        return ""
    digits = re.sub(r"\D", "", str(barcode))
    return digits.lstrip("0") if digits else ""

def calculate_buffer(qty) -> int:
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

def fetch_shopify_variants(token: str):
    url = f"https://{SHOPIFY_STORE}.myshopify.com/admin/api/2026-01/graphql.json"
    headers = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
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

    print("Fetching product catalog from Shopify...")
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

def push_shopify(token: str, updates: list):
    url = f"https://{SHOPIFY_STORE}.myshopify.com/admin/api/2026-01/graphql.json"
    headers = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
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
    token = get_shopify_token()
    nrs = fetch_nrs_inventory()
    shopify = fetch_shopify_variants(token)

    updates = [
        {"inventoryItemId": shopify[b], "locationId": SHOPIFY_LOC_ID, "quantity": nrs[b]}
        for b in shopify if b in nrs
    ]

    if updates:
        print(f"Synchronizing {len(updates)} matched items to Shopify location {SHOPIFY_LOC_ID}...")
        push_shopify(token, updates)
        print("Inventory sync completed successfully.")
    else:
        print("No matching barcodes found between NRS POS and Shopify catalog.")

if __name__ == "__main__":
    main()
