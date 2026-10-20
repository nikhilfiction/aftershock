from app.auth import current_user
from app.services.orders import create_order, list_orders
from app.web import Depends, Router

router = Router(prefix="/orders")


@router.post("/")
def place_order(token: str, items: list[dict], user=Depends(current_user)) -> dict:
    return create_order(current_user(token), items)


@router.get("/")
def my_orders(token: str, user=Depends(current_user)) -> list[dict]:
    return list_orders(current_user(token))
