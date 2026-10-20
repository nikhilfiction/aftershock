"""Hooks run after an order is placed.

They are looked up by name at runtime (see run_hook), so static analysis
cannot see who calls them. This is the hidden dependency Phase 4 finds.
"""

SENT: list[int] = []


def send_receipt(order: dict) -> None:
    SENT.append(order["id"])


def run_hook(name: str, order: dict) -> None:
    hook = globals()[name]
    hook(order)
