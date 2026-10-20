from app.config import settings


def subtotal(items: list[dict]) -> float:
    return sum(i["price"] * i["qty"] for i in items)


def apply_discount(amount: float) -> float:
    return round(amount * (1 - settings.discount_rate), 2)


def order_total(items: list[dict]) -> float:
    return apply_discount(subtotal(items))
