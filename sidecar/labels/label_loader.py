"""
Neuronpedia feature label loader.
Loads a JSON file mapping feature index → human-readable label.
Falls back to unlabeled mode if no file is found.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class LabelLoader:
    def __init__(self) -> None:
        self._labels: dict[int, str] = {}
        self._loaded = False

    def load(self, path: Path | None) -> None:
        if path is None:
            logger.warning(
                "No Neuronpedia labels file found — running in unlabeled mode. "
                "Features will be returned with index only. "
                "Run python setup.py --download-labels to fetch them."
            )
            self._loaded = False
            return

        try:
            with open(path, "r", encoding="utf-8") as f:
                raw: dict = json.load(f)

            # Support two formats:
            # 1. {"labels": {"0": "Label text", ...}}  (Neuronpedia export)
            # 2. {"0": "Label text", ...}               (flat dict)
            if "labels" in raw and isinstance(raw["labels"], dict):
                raw = raw["labels"]

            self._labels = {int(k): v for k, v in raw.items() if v and str(v).strip()}
            self._loaded = True
            logger.info(f"Loaded {len(self._labels):,} feature labels from {path}")
        except Exception as e:
            logger.warning(f"Failed to load labels from {path}: {e} — running in unlabeled mode.")
            self._loaded = False

    def get(self, index: int) -> str | None:
        return self._labels.get(index)

    def is_loaded(self) -> bool:
        return self._loaded

    def count(self) -> int:
        return len(self._labels)

    def all_labels(self) -> dict[str, str]:
        """Return all labels as string-keyed dict for JSON serialization."""
        return {str(k): v for k, v in self._labels.items()}
