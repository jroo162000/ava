from threading import RLock
from typing import Callable, List, Any


class EventBus:
    def __init__(self) -> None:
        self._handlers: List[Callable[[Any], None]] = []
        self._lock = RLock()

    def subscribe(self, handler: Callable[[Any], None]) -> None:
        with self._lock:
            self._handlers.append(handler)

    def emit(self, event: Any) -> None:
        # Fire handlers best-effort; protect against handler exceptions
        with self._lock:
            handlers = list(self._handlers)
        for h in handlers:
            try:
                h(event)
            except Exception:
                pass

