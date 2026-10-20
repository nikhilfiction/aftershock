"""Running scans in the background.

Without REDIS_URL: the scan runs inside the API process right after the
response is sent (FastAPI BackgroundTasks). Simple, fine on a laptop.

With REDIS_URL: the API pushes the snapshot id onto a Redis list and returns.
A separate worker process (`python -m aftershock.api.jobs`) pops ids off
the list and scans them, so slow scans never block the API.
"""

import logging
import signal

from fastapi import BackgroundTasks

from aftershock.api.models import make_session_factory
from aftershock.api.scanning import run_scan
from aftershock.api.settings import Settings

log = logging.getLogger("aftershock.worker")


def enqueue_scan(snapshot_id: int, settings: Settings, session_factory, redis_client,
                 background: BackgroundTasks) -> str:
    """Returns where the job went: "redis" or "in-process"."""
    if redis_client is not None:
        redis_client.rpush(settings.queue_name, snapshot_id)
        return "redis"

    def job() -> None:
        with session_factory() as db:
            run_scan(db, snapshot_id, settings)

    background.add_task(job)
    return "in-process"


def work(settings: Settings, redis_client, session_factory, stop_after: int | None = None) -> int:
    """The worker loop. BLPOP waits for the next id without busy-polling.
    `stop_after` exists so tests can run a fixed number of jobs."""
    done = 0
    running = True

    def stop(*_):
        nonlocal running
        running = False

    try:
        signal.signal(signal.SIGTERM, stop)       # finish the current scan, then exit cleanly
        signal.signal(signal.SIGINT, stop)
    except ValueError:
        pass                                      # not the main thread (e.g. inside tests)

    while running and (stop_after is None or done < stop_after):
        item = redis_client.blpop([settings.queue_name], timeout=5)
        if item is None:
            continue
        snapshot_id = int(item[1])
        log.info("scanning snapshot %s", snapshot_id)
        with session_factory() as db:
            run_scan(db, snapshot_id, settings)
        done += 1
    return done


def main() -> None:
    import redis

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    settings = Settings()
    if not settings.redis_url:
        raise SystemExit("REDIS_URL is not set; without it the API runs scans itself and needs no worker.")
    client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    log.info("worker waiting for scans on %s", settings.queue_name)
    work(settings, client, make_session_factory(settings.database_url))


if __name__ == "__main__":
    main()
