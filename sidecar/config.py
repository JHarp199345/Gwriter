"""
GWriter NSM Sidecar — Configuration
Reads from environment variables and a .env file in the sidecar directory.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class SidecarConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).parent / ".env",
        env_file_encoding="utf-8",
        env_prefix="NSM_",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Model ─────────────────────────────────────────────────────────────────
    model_path: str = Field(
        default="",
        description="Path to local Gemma 3 weights. Leave empty to auto-resolve from HuggingFace cache.",
    )
    model_variant: Literal["gemma-3-2b-pt", "gemma-3-9b-pt"] = Field(
        default="gemma-3-2b-pt",
        description="Which Gemma 3 variant to load.",
    )
    hf_model_id: str = Field(
        default="google/gemma-3-2b-pt",
        description="HuggingFace model ID — used when model_path is empty.",
    )

    # ── SAE ───────────────────────────────────────────────────────────────────
    sae_path: str = Field(
        default="",
        description="Path to Gemma Scope 2 SAE .safetensors file. Leave empty to auto-resolve.",
    )
    hf_sae_repo: str = Field(
        default="google/gemma-scope-2b-pt-res",
        description="HuggingFace repo for Gemma Scope 2 SAE weights.",
    )
    target_layer: int = Field(
        default=20,
        ge=0,
        description="Which transformer layer's hidden state to read (0-indexed).",
    )
    sae_dict_size: Literal[16384, 65536] = Field(
        default=16384,
        description="SAE dictionary size — 16k or 65k features.",
    )

    # ── Labels ────────────────────────────────────────────────────────────────
    labels_path: str = Field(
        default="",
        description="Path to Neuronpedia labels JSON. Auto-detected if empty.",
    )

    # ── Extraction ────────────────────────────────────────────────────────────
    top_k_features: int = Field(
        default=20,
        ge=1,
        le=500,
        description="Number of top activated features to return per request.",
    )
    activation_threshold: float = Field(
        default=0.5,
        ge=0.0,
        description="Minimum activation value to include a feature.",
    )
    max_input_tokens: int = Field(
        default=2048,
        description="Maximum tokens to process per request.",
    )

    # ── Server ────────────────────────────────────────────────────────────────
    port: int = Field(default=8765, ge=1024, le=65535)
    host: str = Field(default="127.0.0.1", description="Bind to localhost only for security.")
    log_level: Literal["debug", "info", "warning", "error"] = Field(default="info")

    # ── Cache ─────────────────────────────────────────────────────────────────
    cache_capacity: int = Field(default=256, ge=1)

    # ── Device ────────────────────────────────────────────────────────────────
    device: Literal["auto", "cpu", "cuda", "mps"] = Field(
        default="auto",
        description="Compute device. 'auto' selects CUDA > MPS > CPU.",
    )
    quantize_int8: bool = Field(
        default=False,
        description="Load model in int8 to reduce memory (requires bitsandbytes). Useful for 8GB machines.",
    )

    @field_validator("target_layer")
    @classmethod
    def validate_layer(cls, v: int, info) -> int:
        # Gemma 3 2B has 26 layers (0-25), 9B has 42 layers (0-41)
        return v

    def resolve_device(self) -> str:
        if self.device != "auto":
            return self.device
        try:
            import torch
            if torch.cuda.is_available():
                return "cuda"
            if torch.backends.mps.is_available():
                return "mps"
        except ImportError:
            pass
        return "cpu"

    def resolve_labels_path(self) -> Path | None:
        if self.labels_path:
            p = Path(self.labels_path)
            return p if p.exists() else None
        # Auto-detect in ./labels/ directory
        labels_dir = Path(__file__).parent / "labels"
        candidates = list(labels_dir.glob(f"*layer{self.target_layer}*{self.sae_dict_size // 1024}k*.json"))
        if not candidates:
            candidates = list(labels_dir.glob("*.json"))
        return candidates[0] if candidates else None


# Global singleton — imported by all modules
config = SidecarConfig()
