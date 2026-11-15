"""
One-off catalog audit: NRS price book vs the Shopify store (read-only, changes nothing).

Writes report/audit.csv.gz with one row per price book item (matched to Shopify by barcode) plus one row
per Shopify variant that isn't in the price book. The workflow encrypts that file before printing it,
because this repository's run logs are public.

Columns: source, barcode, pos_name, pos_size, pos_dept, pos_price, pos_variable, pos_onhand,
         shop_title, shop_handle, shop_status, shop_type, shop_price, shop_policy, expected_online
"""
import csv
import gzip
import json
import os
from decimal import Decimal

from sync_inventory import (
    Shopify, clean_barcode, fetch_nrs_pricebook, get_shopify_token, normalize_store_domain,
    online_price, to_price,
)

QUERY = """
query Catalog($cursor: String) {
  productVariants(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      price
      inventoryPolicy
      product { title handle status productType }
      barcodes(first: 5) { nodes { value } }
    }
  }
}
"""


def main() -> int:
    domain = normalize_store_domain(os.environ["SHOPIFY_STORE_DOMAIN"])
    token = get_shopify_token(domain, os.environ["SHOPIFY_ADMIN_ACCESS_TOKEN"], os.environ.get("SHOPIFY_CLIENT_ID"))
    shop = Shopify(domain, token)
    markup = to_price(os.environ.get("PRICE_MARKUP_PERCENT") or "20") or Decimal("0")

    items = fetch_nrs_pricebook(os.environ["NRS_AUTH_PATH"], os.environ["NRS_STORE_ID"])
    print(f"Price book items: {len(items)}")
    if items:
        print("Price book fields:", ", ".join(sorted(items[0].keys())))

    shop_map, cursor, more, total = {}, None, True, 0
    while more:
        data = shop.graphql(QUERY, {"cursor": cursor})
        conn = data["productVariants"]
        for n in conn["nodes"]:
            total += 1
            p = n.get("product") or {}
            v = {"title": p.get("title", ""), "handle": p.get("handle", ""), "status": p.get("status", ""),
                 "type": p.get("productType", ""), "price": n.get("price"), "policy": n.get("inventoryPolicy", "")}
            for bc in (n.get("barcodes") or {}).get("nodes") or []:
                b = clean_barcode(bc.get("value"))
                if b:
                    shop_map.setdefault(b, v)
        more = conn["pageInfo"]["hasNextPage"]
        cursor = conn["pageInfo"]["endCursor"]
    print(f"Shopify variants: {total}, unique barcodes: {len(shop_map)}")

    os.makedirs("report", exist_ok=True)
    seen = set()
    cols = ["source", "barcode", "pos_name", "pos_size", "pos_dept", "pos_price", "pos_variable", "pos_onhand",
            "shop_title", "shop_handle", "shop_status", "shop_type", "shop_price", "shop_policy", "expected_online"]
    matched = missing = 0
    with gzip.open("report/audit.csv.gz", "wt", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for it in items:
            raw = "".join(ch for ch in str(it.get("upc") or "") if ch.isdigit())
            b = clean_barcode(raw)
            inv = it.get("inventory") or {}
            cents = it.get("cents")
            price = (Decimal(str(cents)) / 100).quantize(Decimal("0.01")) if cents not in (None, "") else None
            s = shop_map.get(b) if b else None
            if b:
                seen.add(b)
            matched += 1 if s else 0
            missing += 0 if s else 1
            size = it.get("size")
            if isinstance(size, (dict, list)):
                size = json.dumps(size)
            w.writerow([
                "pricebook", raw, (it.get("name") or "").strip(), size or "", (it.get("dept") or "").strip(),
                price if price is not None else "", "y" if it.get("variableprice") else "n", inv.get("onhand", ""),
                (s or {}).get("title", ""), (s or {}).get("handle", ""), (s or {}).get("status", ""),
                (s or {}).get("type", ""), (s or {}).get("price", ""), (s or {}).get("policy", ""),
                online_price(price, markup) if price else "",
            ])
        only = 0
        for b, s in shop_map.items():
            if b not in seen:
                only += 1
                w.writerow(["shopify_only", b, "", "", "", "", "", "", s["title"], s["handle"], s["status"], s["type"],
                            s["price"], s["policy"], ""])
    print(f"Price book items on Shopify: {matched}; not on Shopify: {missing}; Shopify-only barcodes: {only}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
