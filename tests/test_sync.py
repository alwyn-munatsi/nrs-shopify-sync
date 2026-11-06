import json
import os
import sys
from decimal import Decimal

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sync_inventory as s  # noqa: E402

LOC = "gid://shopify/Location/1"


# ---------- helpers ----------

def test_clean_barcode():
    assert s.clean_barcode("0072890000002") == "72890000002"
    assert s.clean_barcode("072-890 000002") == "72890000002"
    assert s.clean_barcode(None) == ""
    assert s.clean_barcode("0000") == ""


@pytest.mark.parametrize("qty,expected", [(-3, 0), (0, 0), (1, 0), (2, 1), (10, 9), ("5", 4), ("x", 0), (None, 0)])
def test_calculate_buffer(qty, expected):
    assert s.calculate_buffer(qty) == expected


def test_normalizers():
    assert s.normalize_store_domain("7e36ef-2") == "7e36ef-2.myshopify.com"
    assert s.normalize_store_domain("https://7e36ef-2.myshopify.com/") == "7e36ef-2.myshopify.com"
    assert s.normalize_location_id("94874992939") == "gid://shopify/Location/94874992939"
    assert s.normalize_location_id(LOC) == LOC


def test_parse_nrs_items():
    items = [
        {"upc": "072890000002", "name": " Heineken 6pk ", "cents": 2249, "department": "BEER", "onhand": 5},
        {"upc": "", "name": "no barcode", "cents": 100, "onhand": 3},
        {"upc": "123", "name": None, "cents": None, "department": None, "onhand": None},
    ]
    m = s.parse_nrs_items(items)
    assert set(m) == {"72890000002", "123"}
    h = m["72890000002"]
    assert h["price"] == Decimal("22.49") and h["name"] == "Heineken 6pk" and h["target_qty"] == 4
    assert m["123"]["price"] is None and m["123"]["name"] == "New In-Store Product" and m["123"]["onhand"] == 0


def variant(b, price="5.00", on_hand=0, stocked=True, tracked=True, n=1):
    return {
        "barcodes": {"nodes": [{"value": b}]},
        "id": f"gid://shopify/ProductVariant/{n}",
        "price": price,
        "product": {"id": f"gid://shopify/Product/{n}", "title": f"Product {n}", "status": "ACTIVE"},
        "inventoryItem": {
            "id": f"gid://shopify/InventoryItem/{n}",
            "tracked": tracked,
            "inventoryLevel": {"quantities": [{"quantity": on_hand}]} if stocked else None,
        },
    }


def shopify_map(*nodes):
    out = {}
    for node in nodes:
        for b, v in s.parse_variant(node):
            out.setdefault(b, []).append(v)
    return out


# ---------- plan ----------

def test_build_plan_stock_prices_and_new():
    nrs = s.parse_nrs_items([
        {"upc": "0001", "name": "Same", "cents": 500, "onhand": 1},          # target 0, on_hand 0 -> no change
        {"upc": "0002", "name": "Stock", "cents": 500, "onhand": 6},         # target 5 -> stock change
        {"upc": "0003", "name": "Price", "cents": 799, "onhand": 0},         # price 5.00 -> 7.99
        {"upc": "0004", "name": "Zero price", "cents": 0, "onhand": 0},      # warn, no price change
        {"upc": "0005", "name": "Unstocked", "cents": 500, "onhand": 3},     # not stocked -> activate with 2
        {"upc": "0009", "name": "B new", "cents": 300, "onhand": 4},         # new
        {"upc": "0010", "name": "A new", "cents": 300, "onhand": 1},         # new (in stock at register)
        {"upc": "0011", "name": "C new", "cents": 300, "onhand": 0},         # no stock -> skipped
        {"upc": "0012", "name": "D new", "cents": None, "onhand": 9},        # no price -> warning
    ])
    shop = shopify_map(
        variant("0001", "5.00", 0, n=1),
        variant("0002", "5.00", 0, n=2),
        variant("0003", "5.00", 0, n=3),
        variant("0004", "5.00", 0, n=4),
        variant("0005", "5.00", 0, stocked=False, n=5),
        variant("0099", "1.00", 3, n=6),   # Shopify only
    )
    plan = s.build_plan(nrs, shop, sync_prices=True, max_new=1)

    assert [(r["barcode"], r["from"], r["to"]) for r in plan.stock] == [("0002", 0, 5)]
    assert [(r["barcode"], r["to"]) for r in plan.activate] == [("0005", 2)]
    assert [(r["barcode"], r["from"], r["to"]) for r in plan.prices] == [("0003", Decimal("5.00"), Decimal("7.99"))]
    assert [p["name"] for p in plan.new_products] == ["A new"]
    assert [p["name"] for p in plan.queued] == ["B new"]
    assert plan.matched == 5 and plan.shopify_only == 1
    assert any("Zero price" in w or "0004" in w for w in plan.warnings)
    assert any("D new" in w for w in plan.warnings)


def test_price_comparison_ignores_formatting():
    nrs = s.parse_nrs_items([{"upc": "0003", "name": "x", "cents": 750, "onhand": 0}])
    plan = s.build_plan(nrs, shopify_map(variant("0003", "7.5")))
    assert plan.prices == []


def test_prices_can_be_turned_off():
    nrs = s.parse_nrs_items([{"upc": "0003", "name": "x", "cents": 799, "onhand": 0}])
    plan = s.build_plan(nrs, shopify_map(variant("0003", "5.00")), sync_prices=False)
    assert plan.prices == []


# ---------- end to end with a fake Shopify ----------

class FakeResponse:
    def __init__(self, body, status=200):
        self._body, self.status_code, self.text = body, status, json.dumps(body)

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise s.requests.HTTPError(self.status_code)


class FakeSession:
    """Answers the catalog query and records every mutation."""

    def __init__(self, nodes, throttle_once=False):
        self.headers = {}
        self.nodes = nodes
        self.calls = []
        self.throttle_once = throttle_once

    def post(self, url, json=None, timeout=None):
        q = json["query"]
        self.calls.append(json)
        if self.throttle_once:
            self.throttle_once = False
            return FakeResponse({"errors": [{"message": "Throttled", "extensions": {"code": "THROTTLED"}}]})
        if "productVariants(" in q:
            return FakeResponse({"data": {"productVariants": {"nodes": self.nodes, "pageInfo": {"hasNextPage": False, "endCursor": None}}}})
        if "inventorySetQuantities" in q:
            return FakeResponse({"data": {"inventorySetQuantities": {"userErrors": []}}})
        if "inventoryActivate" in q:
            return FakeResponse({"data": {"inventoryActivate": {"userErrors": []}}})
        if "productVariantsBulkUpdate" in q:
            n = sum(1 for k in json["variables"] if k.startswith("p"))
            return FakeResponse({"data": {f"u{i}": {"userErrors": []} for i in range(n)}})
        if "productSet" in q:
            return FakeResponse({"data": {"productSet": {"product": {"id": "gid://shopify/Product/999", "title": "t", "handle": "t"}, "userErrors": []}}})
        raise AssertionError(f"unexpected query: {q[:80]}")


NRS_ITEMS = [
    {"upc": "0002", "name": "Stock", "cents": 500, "onhand": 6},
    {"upc": "0003", "name": "Price", "cents": 799, "onhand": 0},
    {"upc": "0009", "name": "Brand new", "cents": 300, "onhand": 4},
]


@pytest.fixture
def env(monkeypatch, tmp_path):
    for k, v in {
        "SHOPIFY_ADMIN_ACCESS_TOKEN": "shpat_test", "SHOPIFY_STORE_DOMAIN": "test-store",
        "SHOPIFY_LOCATION_ID": "1", "NRS_AUTH_PATH": "a", "NRS_STORE_ID": "b", "NRS_GROUP_ID": "c",
        "REPORT_DIR": str(tmp_path / "report"), "GITHUB_STEP_SUMMARY": str(tmp_path / "summary.md"),
    }.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setattr(s.time, "sleep", lambda *_: None)
    monkeypatch.setattr(s, "fetch_nrs_catalog", lambda *a: s.parse_nrs_items(NRS_ITEMS))
    return tmp_path


def run_main(monkeypatch, session):
    monkeypatch.setattr(s.requests, "Session", lambda: session)
    return s.main()


def mutation_calls(session):
    return [c for c in session.calls if c["query"].lstrip().startswith("mutation")]


def test_dry_run_writes_nothing(env, monkeypatch):
    monkeypatch.setenv("SYNC_MODE", "dry-run")
    session = FakeSession([variant("0002", "5.00", 0, n=2), variant("0003", "5.00", 0, n=3)])
    assert run_main(monkeypatch, session) == 0
    assert mutation_calls(session) == []
    report = env / "report"
    assert "Brand new" in (report / "new_products.csv").read_text()
    assert "7.99" in (report / "price_changes.csv").read_text()
    assert "would be created" in (env / "summary.md").read_text().lower()


def test_live_run_writes_changes(env, monkeypatch):
    monkeypatch.setenv("SYNC_MODE", "live")
    session = FakeSession([variant("0002", "5.00", 0, n=2), variant("0003", "5.00", 0, n=3)], throttle_once=True)
    assert run_main(monkeypatch, session) == 0
    muts = mutation_calls(session)
    kinds = [next(k for k in ("inventorySetQuantities", "productVariantsBulkUpdate", "productSet") if k in m["query"]) for m in muts]
    assert kinds == ["inventorySetQuantities", "productVariantsBulkUpdate", "productSet"]

    stock = muts[0]["variables"]
    assert stock["key"] and stock["input"]["name"] == "on_hand"
    assert stock["input"]["quantities"] == [{"inventoryItemId": "gid://shopify/InventoryItem/2", "locationId": LOC, "quantity": 5, "changeFromQuantity": None}]

    assert muts[1]["variables"] == {"p0": "gid://shopify/Product/3", "v0": [{"id": "gid://shopify/ProductVariant/3", "price": "7.99"}]}

    create = muts[2]["variables"]["input"]
    assert create["status"] == "DRAFT" and create["title"] == "Brand new"
    v = create["variants"][0]
    assert v["barcodes"] == [{"value": "0009"}] and v["price"] == "3.00"
    assert v["inventoryQuantities"] == [{"locationId": LOC, "name": "on_hand", "quantity": 3}]
    assert "created" in (env / "report" / "new_products.csv").read_text()


def test_graphql_errors_fail_loudly(env, monkeypatch):
    monkeypatch.setenv("SYNC_MODE", "live")

    class Broken(FakeSession):
        def post(self, url, json=None, timeout=None):
            if "inventorySetQuantities" in json["query"]:
                return FakeResponse({"errors": [{"message": "Field 'x' doesn't exist"}]})
            return super().post(url, json, timeout)

    with pytest.raises(s.ShopifyError):
        run_main(monkeypatch, Broken([variant("0002", "5.00", 0, n=2)]))


def test_empty_nrs_stops(env, monkeypatch):
    monkeypatch.setattr(s, "fetch_nrs_catalog", lambda *a: {})
    assert run_main(monkeypatch, FakeSession([variant("0002", n=2)])) == 1


def test_notification_skips_repeat(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "t")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    sent = []
    issue = {"number": 7, "body": "intro\n\n<!-- nrs-sync-signature:abc -->"}
    monkeypatch.setattr(s.requests, "get", lambda *a, **k: FakeResponse([issue]))
    monkeypatch.setattr(s.requests, "post", lambda url, **k: sent.append(("post", url, k["json"])) or FakeResponse({}))
    monkeypatch.setattr(s.requests, "patch", lambda url, **k: sent.append(("patch", url, k["json"])) or FakeResponse({}))

    s.notify_github("md", "title", "abc")
    assert sent == []

    s.notify_github("md", "title", "def")
    assert sent[0][0] == "post" and sent[0][1].endswith("/issues/7/comments") and "@owner" in sent[0][2]["body"]
    assert sent[1][0] == "patch" and "nrs-sync-signature:def" in sent[1][2]["body"] and "signature:abc" not in sent[1][2]["body"]


def test_notification_opens_issue(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "t")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    sent = []
    monkeypatch.setattr(s.requests, "get", lambda *a, **k: FakeResponse([]))
    monkeypatch.setattr(s.requests, "post", lambda url, **k: sent.append((url, k["json"])) or FakeResponse({"number": 1}))
    s.notify_github("md", "title", "abc")
    url, body = sent[0]
    assert url.endswith("/issues") and body["labels"] == ["new-products"] and body["assignees"] == ["owner"]


def test_token_used_directly_when_it_works(monkeypatch):
    monkeypatch.setattr(s, "token_works", lambda d, t: True)
    monkeypatch.setattr(s.requests, "post", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no exchange")))
    assert s.get_shopify_token("x.myshopify.com", "atkn_abc", "client") == "atkn_abc"


def test_client_credentials_when_token_rejected(monkeypatch):
    monkeypatch.setattr(s, "token_works", lambda d, t: False)
    monkeypatch.setattr(s.requests, "post", lambda url, **k: FakeResponse({"access_token": "fresh"}))
    assert s.get_shopify_token("x.myshopify.com", "secret", "client") == "fresh"
