from app.auth import create_token
from app.routes.orders import my_orders, place_order
from app.services.hooks import SENT
from app.services.pricing import order_total

ITEMS = [{"price": 10.0, "qty": 2}, {"price": 5.0, "qty": 1}]


def test_order_total_applies_discount():
    assert order_total(ITEMS) == 22.5


def test_place_order_sends_receipt():
    token = create_token(7)
    order = place_order(token, ITEMS)
    assert order["total"] == 22.5
    assert order["id"] in SENT


def test_my_orders_lists_only_mine():
    place_order(create_token(8), ITEMS)
    assert all(o["user_id"] == 8 for o in my_orders(create_token(8)))
