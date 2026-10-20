ORDERS: list[dict] = []


def insert(row: dict) -> dict:
    row = {**row, "id": len(ORDERS) + 1}
    ORDERS.append(row)
    return row


def select(user_id: int) -> list[dict]:
    return [o for o in ORDERS if o["user_id"] == user_id]
