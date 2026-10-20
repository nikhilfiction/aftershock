from app.auth import create_token, current_user
from app.web import Depends, Router

router = Router(prefix="/users")


@router.post("/login")
def login(user_id: int) -> dict:
    return {"token": create_token(user_id)}


@router.get("/me")
def me(token: str, user=Depends(current_user)) -> dict:
    return {"user_id": current_user(token)}
