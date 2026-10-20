from app import db
from app.services.hooks import run_hook
from app.services.pricing import order_total


def create_order(user_id: int, items: list[dict]) -> dict:
    order = db.insert({"user_id": user_id, "items": items, "total": order_total(items)})
    run_hook("send_receipt", order)
    return order


def list_orders(user_id: int) -> list[dict]:
    return db.select(user_id)
