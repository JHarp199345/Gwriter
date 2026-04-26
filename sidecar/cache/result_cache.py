"""
LRU cache for extraction results keyed on SHA-256 of input text.
Avoids re-running the forward pass when the same chunk is submitted twice.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any


@dataclass
class CacheEntry:
    features: list[dict]
    token_count: int
    layer: int
    sae_dict_size: int
    model_variant: str


class ResultCache:
    def __init__(self, capacity: int = 256) -> None:
        self._capacity = max(1, capacity)
        self._store: OrderedDict[str, CacheEntry] = OrderedDict()

    @staticmethod
    def _key(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def get(self, text: str) -> CacheEntry | None:
        k = self._key(text)
        if k not in self._store:
            return None
        # Move to end (most recently used)
        self._store.move_to_end(k)
        return self._store[k]

    def put(self, text: str, entry: CacheEntry) -> None:
        k = self._key(text)
        if k in self._store:
            self._store.move_to_end(k)
        self._store[k] = entry
        if len(self._store) > self._capacity:
            self._store.popitem(last=False)  # Evict least recently used

    def size(self) -> int:
        return len(self._store)

    def clear(self) -> None:
        self._store.clear()
