import base64
import json

from app.config import settings


def create_token(user_id: int) -> str:
    payload = json.dumps({"user_id": user_id, "secret": settings.jwt_secret})
    return base64.b64encode(payload.encode()).decode()


def decode_token(token: str) -> int:
    payload = json.loads(base64.b64decode(token))
    if payload["secret"] != settings.jwt_secret:
        raise PermissionError("bad token")
    return payload["user_id"]


def current_user(token: str) -> int:
    return decode_token(token)
