"""
GWriter NSM Sidecar — FastAPI Application
==========================================
Runs Gemma 3 forward passes and applies Gemma Scope 2 SAE weights to
extract sparse interpretable feature vectors from prose chunks.

Start with:  python main.py
or:          ./start.sh
"""
from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from config import config
from cache.result_cache import ResultCache, CacheEntry
from labels.label_loader import LabelLoader
from models.gemma_runner import GemmaRunner
from models.sae_runner import SaeRunner

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, config.log_level.upper()),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("nsm-sidecar")

# ── Global singletons ─────────────────────────────────────────────────────────
gemma = GemmaRunner()
sae = SaeRunner()
labels = LabelLoader()
cache = ResultCache(capacity=config.cache_capacity)

_startup_error: str | None = None
_startup_complete: bool = False


# ── Lifespan (startup / shutdown) ─────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _startup_error, _startup_complete

    logger.info("=" * 60)
    logger.info("  GWriter NSM Sidecar starting up")
    logger.info("=" * 60)

    device = config.resolve_device()
    logger.info(f"  Device: {device}")
    logger.info(f"  Model:  {config.hf_model_id}")
    logger.info(f"  SAE:    {config.hf_sae_repo} | layer={config.target_layer} | {config.sae_dict_size // 1024}k features")
    logger.info(f"  Port:   {config.port}")
    logger.info("")

    try:
        # Load Gemma 3
        logger.info("Loading Gemma 3 (this takes 30–90 seconds on first run)...")
        t0 = time.time()
        gemma.load(
            model_path=config.model_path,
            hf_model_id=config.hf_model_id,
            device=device,
            quantize_int8=config.quantize_int8,
        )
        logger.info(f"Gemma 3 ready in {time.time() - t0:.1f}s")

        # Load SAE weights
        logger.info("Loading Gemma Scope 2 SAE weights...")
        t1 = time.time()
        sae.load(
            sae_path=config.sae_path,
            hf_sae_repo=config.hf_sae_repo,
            target_layer=config.target_layer,
            dict_size=config.sae_dict_size,
        )
        logger.info(f"SAE ready in {time.time() - t1:.1f}s")

        # Load labels (optional — degrades gracefully)
        labels_path = config.resolve_labels_path()
        labels.load(labels_path)

        _startup_complete = True
        logger.info("")
        logger.info("  Sidecar ready. Waiting for requests from GWriter.")
        logger.info(f"  Health: http://{config.host}:{config.port}/health")
        logger.info("=" * 60)

    except Exception as e:
        _startup_error = str(e)
        logger.error(f"Startup failed: {e}")
        logger.error("")
        logger.error("Common causes:")
        logger.error("  • Model not downloaded yet — run: python setup.py")
        logger.error("  • HuggingFace token missing — run: huggingface-cli login")
        logger.error("  • Not enough RAM (need 6GB+ free for Gemma 3 2B)")
        logger.error("")
        logger.error("The sidecar will continue running but /extract will return 503.")

    yield  # Server runs here

    logger.info("Sidecar shutting down.")


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="GWriter NSM Sidecar",
    description="Gemma 3 hidden state extractor + Gemma Scope 2 SAE for narrative state tracking.",
    version="1.0.0",
    lifespan=lifespan,
)


# ── Request / Response models ─────────────────────────────────────────────────
class ExtractRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=50_000, description="Prose chunk to analyze.")
    chunk_id: Optional[str] = Field(default=None, description="Caller-assigned ID for correlation.")
    top_k: Optional[int] = Field(default=None, ge=1, le=500, description="Override top-K for this request.")
    layer: Optional[int] = Field(default=None, ge=0, description="Override target layer for this request.")


class FeatureItem(BaseModel):
    index: int
    activation: float
    label: Optional[str] = None


class ExtractResponse(BaseModel):
    chunk_id: str
    model_variant: str
    layer: int
    sae_dict_size: int
    features: list[FeatureItem]
    latency_ms: float
    cache_hit: bool
    token_count: int


class HealthResponse(BaseModel):
    status: str  # "ok" | "loading" | "error"
    model_loaded: bool
    sae_loaded: bool
    labels_loaded: bool
    model_variant: str
    layer: int
    sae_dict_size: int
    device: str
    cache_size: int
    startup_error: Optional[str] = None


class FeaturesResponse(BaseModel):
    count: int
    labels: dict[str, str]


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/health", response_model=HealthResponse)
async def health():
    status = "ok" if _startup_complete else ("error" if _startup_error else "loading")
    return HealthResponse(
        status=status,
        model_loaded=gemma.is_loaded(),
        sae_loaded=sae.is_loaded(),
        labels_loaded=labels.is_loaded(),
        model_variant=gemma.model_variant() or config.hf_model_id,
        layer=config.target_layer,
        sae_dict_size=sae.dict_size() or config.sae_dict_size,
        device=gemma.actual_device(),
        cache_size=cache.size(),
        startup_error=_startup_error,
    )


@app.post("/extract", response_model=ExtractResponse)
async def extract(req: ExtractRequest):
    if not _startup_complete:
        detail = _startup_error or "Sidecar still loading — try again in a few seconds."
        raise HTTPException(status_code=503, detail=detail)

    t_start = time.perf_counter()
    chunk_id = req.chunk_id or str(uuid.uuid4())
    use_layer = req.layer if req.layer is not None else config.target_layer
    use_top_k = req.top_k if req.top_k is not None else config.top_k_features

    # Cache check
    cached = cache.get(req.text)
    if cached and cached.layer == use_layer and cached.sae_dict_size == sae.dict_size():
        latency_ms = (time.perf_counter() - t_start) * 1000
        features = _enrich_with_labels(cached.features)
        return ExtractResponse(
            chunk_id=chunk_id,
            model_variant=cached.model_variant,
            layer=cached.layer,
            sae_dict_size=cached.sae_dict_size,
            features=features,
            latency_ms=round(latency_ms, 1),
            cache_hit=True,
            token_count=cached.token_count,
        )

    try:
        # Forward pass → hidden state
        hidden_state, token_count = gemma.extract_hidden_state(
            req.text,
            target_layer=use_layer,
            max_tokens=config.max_input_tokens,
        )

        # SAE encode → sparse features
        raw_features = sae.encode(
            hidden_state,
            top_k=use_top_k,
            threshold=config.activation_threshold,
        )

        # Cache the raw result (without labels — labels may change)
        cache.put(
            req.text,
            CacheEntry(
                features=raw_features,
                token_count=token_count,
                layer=use_layer,
                sae_dict_size=sae.dict_size(),
                model_variant=gemma.model_variant(),
            ),
        )

    except Exception as e:
        logger.error(f"Extraction failed for chunk_id={chunk_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Extraction error: {str(e)}")

    latency_ms = (time.perf_counter() - t_start) * 1000
    features = _enrich_with_labels(raw_features)

    logger.info(
        f"chunk={chunk_id[:8]} | tokens={token_count} | "
        f"features={len(features)} | {latency_ms:.0f}ms | layer={use_layer}"
    )

    return ExtractResponse(
        chunk_id=chunk_id,
        model_variant=gemma.model_variant(),
        layer=use_layer,
        sae_dict_size=sae.dict_size(),
        features=features,
        latency_ms=round(latency_ms, 1),
        cache_hit=False,
        token_count=token_count,
    )


@app.get("/features", response_model=FeaturesResponse)
async def get_features():
    """Return the complete Neuronpedia label dictionary."""
    if not labels.is_loaded():
        return FeaturesResponse(count=0, labels={})
    return FeaturesResponse(count=labels.count(), labels=labels.all_labels())


# ── Helpers ───────────────────────────────────────────────────────────────────
def _enrich_with_labels(raw_features: list[dict]) -> list[FeatureItem]:
    result = []
    for f in raw_features:
        label = labels.get(f["index"]) if labels.is_loaded() else None
        result.append(FeatureItem(index=f["index"], activation=f["activation"], label=label))
    return result


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=config.host,
        port=config.port,
        log_level=config.log_level,
        reload=False,  # Never use reload — the model is too large
    )
