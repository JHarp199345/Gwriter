"""
Gemma Scope 2 SAE runner.
Loads a single SAE weight file (safetensors) and applies the encoder
to a hidden state vector to produce a sparse interpretable feature vector.

SAE encoder formula (standard Gemma Scope convention):
    pre_acts = (hidden_state - b_dec) @ W_enc.T + b_enc
    feature_activations = ReLU(pre_acts)
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import torch
import torch.nn.functional as F

logger = logging.getLogger(__name__)

# Known Gemma Scope 2 repo directory patterns
_SAE_GLOB_PATTERNS = [
    "layer_{layer}/width_{width}k/average_l0_*/*.safetensors",
    "layer_{layer}/width_{width}k/*.safetensors",
    "*layer{layer}*width{width}k*.safetensors",
    "*layer_{layer}*{width}k*.safetensors",
]


def _find_sae_file(repo_root: Path, layer: int, dict_size: int) -> Path | None:
    """Scan a downloaded HuggingFace repo for the matching SAE file."""
    width_k = dict_size // 1024
    for pattern in _SAE_GLOB_PATTERNS:
        pat = pattern.format(layer=layer, width=width_k)
        matches = sorted(repo_root.glob(pat))
        if matches:
            logger.info(f"Resolved SAE file via pattern '{pat}': {matches[0]}")
            return matches[0]
    return None


class SaeRunner:
    def __init__(self) -> None:
        self._W_enc: torch.Tensor | None = None  # [d_model, dict_size]
        self._b_enc: torch.Tensor | None = None  # [dict_size]
        self._b_dec: torch.Tensor | None = None  # [d_model]
        self._dict_size: int = 0
        self._d_model: int = 0
        self._loaded = False
        self._sae_path: str = ""

    def load(self, sae_path: str, hf_sae_repo: str, target_layer: int, dict_size: int) -> None:
        """
        Load SAE weights. Uses sae_path if provided, otherwise resolves
        from the HuggingFace cache for hf_sae_repo.
        """
        from safetensors.torch import load_file

        resolved_path: Path | None = None

        if sae_path:
            resolved_path = Path(sae_path)
            if not resolved_path.exists():
                raise FileNotFoundError(f"SAE file not found at configured path: {sae_path}")
        else:
            # Try to find in HuggingFace cache
            try:
                from huggingface_hub import snapshot_download
                repo_root = Path(
                    snapshot_download(hf_sae_repo, local_files_only=True)
                )
                resolved_path = _find_sae_file(repo_root, target_layer, dict_size)
                if resolved_path is None:
                    raise FileNotFoundError(
                        f"Could not find SAE file for layer={target_layer}, width={dict_size // 1024}k "
                        f"in repo cache at {repo_root}. "
                        f"Run python setup.py to download SAE weights."
                    )
            except Exception as e:
                raise RuntimeError(
                    f"Failed to resolve SAE weights: {e}\n"
                    f"Run: python setup.py --download-sae"
                ) from e

        logger.info(f"Loading SAE weights from: {resolved_path}")
        tensors = load_file(str(resolved_path))

        # Gemma Scope safetensors keys
        self._W_enc = tensors["W_enc"].float()   # [d_model, dict_size]
        self._b_enc = tensors["b_enc"].float()   # [dict_size]
        self._b_dec = tensors["b_dec"].float()   # [d_model]

        self._dict_size = self._W_enc.shape[1]
        self._d_model = self._W_enc.shape[0]
        self._loaded = True
        self._sae_path = str(resolved_path)

        logger.info(
            f"SAE loaded | d_model={self._d_model} | dict_size={self._dict_size:,} | path={resolved_path.name}"
        )

    def encode(
        self,
        hidden_state: torch.Tensor,
        top_k: int = 20,
        threshold: float = 0.5,
    ) -> list[dict]:
        """
        Apply the SAE encoder to a hidden state vector.

        Args:
            hidden_state: shape [d_model], float32
            top_k: maximum number of features to return
            threshold: minimum activation to include

        Returns:
            List of dicts: [{"index": int, "activation": float}, ...]
            sorted by activation descending, length <= top_k
        """
        if not self._loaded:
            raise RuntimeError("SaeRunner not loaded. Call load() first.")

        if hidden_state.shape[0] != self._d_model:
            raise ValueError(
                f"Hidden state dim {hidden_state.shape[0]} != SAE d_model {self._d_model}"
            )

        # Re-center: subtract decoder bias (Gemma Scope convention)
        centered = hidden_state - self._b_dec  # [d_model]

        # Encoder projection: [d_model] @ [d_model, dict_size] + [dict_size] = [dict_size]
        pre_acts = centered @ self._W_enc + self._b_enc  # [dict_size]

        # ReLU activation
        activations = F.relu(pre_acts)  # [dict_size]

        # Apply threshold
        mask = activations >= threshold
        active_indices = mask.nonzero(as_tuple=True)[0]

        if len(active_indices) == 0:
            return []

        # Get top-K among active features
        active_activations = activations[active_indices]
        k = min(top_k, len(active_indices))
        topk = torch.topk(active_activations, k)

        results = []
        for rank_idx in range(k):
            feat_idx = int(active_indices[topk.indices[rank_idx]])
            feat_act = float(topk.values[rank_idx])
            results.append({"index": feat_idx, "activation": round(feat_act, 4)})

        return results  # Already sorted descending by activation

    def is_loaded(self) -> bool:
        return self._loaded

    def dict_size(self) -> int:
        return self._dict_size

    def d_model(self) -> int:
        return self._d_model
