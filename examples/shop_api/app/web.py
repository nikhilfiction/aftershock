"""A tiny stand-in for FastAPI so this example runs with no installs.

Routes use the same @router.get / @router.post shape FastAPI does.
"""


class Router:
    def __init__(self, prefix: str = ""):
        self.prefix = prefix
        self.routes = {}

    def _add(self, method: str, path: str):
        def decorator(fn):
            self.routes[(method, self.prefix + path)] = fn
            return fn
        return decorator

    def get(self, path: str):
        return self._add("GET", path)

    def post(self, path: str):
        return self._add("POST", path)


class Depends:
    def __init__(self, dependency):
        self.dependency = dependency
