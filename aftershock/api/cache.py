"""Three layers of caching for a snapshot's graph.

  1. this process's memory    (microseconds, lost on restart)
  2. Redis, if configured     (shared by every API process and the worker)
  3. the database             (the source of truth, slowest)

A ready snapshot never changes, except when dynamic tracing adds edges, and
that path calls `invalidate`.
"""

import json
from collections import OrderedDict
from dataclasses import asdict

import networkx as nx
from sqlalchemy.orm import Session

from aftershock.api.scanning import load_result
from aftershock.graph import build_graph
from aftershock.scanner import Edge, ScanResult, Symbol, UnresolvedCall

MEMORY_SLOTS = 16
REDIS_TTL_SECONDS = 24 * 3600


def _to_json(result: ScanResult) -> str:
    return json.dumps({
        "symbols": [asdict(s) for s in result.symbols.values()],
        "edges": [asdict(e) for e in result.edges],
        "unresolved": [asdict(u) for u in result.unresolved_calls],
        "meta": result.meta,
    })


def _from_json(text: str) -> ScanResult:
    data = json.loads(text)       # JSON, not pickle: loading pickle from a shared cache can run code
    result = ScanResult()
    for s in data["symbols"]:
        result.symbols[s["qualified_name"]] = Symbol(**s)
    result.edges = [Edge(**e) for e in data["edges"]]
    result.unresolved_calls = [UnresolvedCall(**u) for u in data["unresolved"]]
    result.meta = data.get("meta", {})
    return result


class GraphCache:
    def __init__(self, redis_client=None):
        self.redis = redis_client
        self._memory: OrderedDict[int, tuple[ScanResult, nx.DiGraph]] = OrderedDict()
        self.hits = {"memory": 0, "redis": 0, "database": 0}

    def get(self, db: Session, snapshot_id: int) -> tuple[ScanResult, nx.DiGraph]:
        if snapshot_id in self._memory:
            self._memory.move_to_end(snapshot_id)
            self.hits["memory"] += 1
            return self._memory[snapshot_id]

        result = None
        if self.redis is not None:
            raw = self.redis.get(self._key(snapshot_id))
            if raw:
                result = _from_json(raw)
                self.hits["redis"] += 1
        if result is None:
            result = load_result(db, snapshot_id)
            self.hits["database"] += 1
            if self.redis is not None:
                self.redis.set(self._key(snapshot_id), _to_json(result), ex=REDIS_TTL_SECONDS)

        entry = (result, build_graph(result))
        self._memory[snapshot_id] = entry
        if len(self._memory) > MEMORY_SLOTS:
            self._memory.popitem(last=False)          # drop the least recently used
        return entry

    def invalidate(self, snapshot_id: int) -> None:
        self._memory.pop(snapshot_id, None)
        if self.redis is not None:
            self.redis.delete(self._key(snapshot_id))

    @staticmethod
    def _key(snapshot_id: int) -> str:
        return f"aftershock:graph:{snapshot_id}"
