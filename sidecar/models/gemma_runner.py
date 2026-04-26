"""
Gemma 3 forward-pass runner.
Loads the model once at startup, keeps it resident, and exposes
extract_hidden_state() which returns a single mean-pooled vector
representing the model's internal understanding of the input text.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import torch

logger = logging.getLogger(__name__)


class GemmaRunner:
    def __init__(self) -> None:
        self._model = None
        self._tokenizer = None
        self._device: str = "cpu"
        self._loaded = False
        self._model_variant: str = ""
        self._num_layers: int = 0

    def load(
        self,
        model_path: str,
        hf_model_id: str,
        device: str,
        quantize_int8: bool = False,
    ) -> None:
        """
        Load Gemma 3 weights. Uses model_path if provided, otherwise
        resolves from HuggingFace cache using hf_model_id.
        """
        from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig

        self._device = device
        source = model_path if model_path else hf_model_id
        logger.info(f"Loading Gemma 3 from: {source} | device={device} | int8={quantize_int8}")

        # Tokenizer
        self._tokenizer = AutoTokenizer.from_pretrained(
            source,
            trust_remote_code=False,
        )

        # Model — choose dtype and quantization strategy
        load_kwargs: dict = {
            "output_hidden_states": True,
            "trust_remote_code": False,
        }

        if quantize_int8:
            try:
                bnb_config = BitsAndBytesConfig(load_in_8bit=True)
                load_kwargs["quantization_config"] = bnb_config
                load_kwargs["device_map"] = "auto"
                logger.info("Loading in int8 quantization (bitsandbytes)")
            except ImportError:
                logger.warning("bitsandbytes not installed — falling back to float16")
                quantize_int8 = False

        if not quantize_int8:
            if device == "cpu":
                load_kwargs["torch_dtype"] = torch.float32
            else:
                load_kwargs["torch_dtype"] = torch.float16
                load_kwargs["device_map"] = device

        self._model = AutoModelForCausalLM.from_pretrained(source, **load_kwargs)

        if not quantize_int8 and "device_map" not in load_kwargs:
            self._model = self._model.to(device)

        self._model.eval()
        self._num_layers = self._model.config.num_hidden_layers
        self._model_variant = hf_model_id.split("/")[-1] if "/" in hf_model_id else hf_model_id
        self._loaded = True

        logger.info(
            f"Gemma 3 loaded | layers={self._num_layers} | "
            f"d_model={self._model.config.hidden_size} | device={self._resolve_actual_device()}"
        )

    def _resolve_actual_device(self) -> str:
        if self._model is None:
            return "unloaded"
        try:
            return str(next(self._model.parameters()).device)
        except Exception:
            return self._device

    def extract_hidden_state(self, text: str, target_layer: int, max_tokens: int = 2048) -> tuple[torch.Tensor, int]:
        """
        Run a forward pass (no generation) and return the mean-pooled
        hidden state at target_layer.

        Returns:
            (hidden_state_vector, token_count)
            hidden_state_vector shape: [d_model], dtype float32
        """
        if not self._loaded or self._model is None or self._tokenizer is None:
            raise RuntimeError("GemmaRunner not loaded. Call load() first.")

        if target_layer >= self._num_layers:
            raise ValueError(
                f"target_layer={target_layer} out of range — model has {self._num_layers} layers (0-{self._num_layers - 1})"
            )

        # Tokenize — truncate to avoid OOM on very long inputs
        inputs = self._tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=max_tokens,
            padding=False,
        )
        token_count = inputs["input_ids"].shape[1]

        # Move inputs to device
        inputs = {k: v.to(self._resolve_actual_device()) for k, v in inputs.items()}

        with torch.no_grad():
            outputs = self._model(**inputs, output_hidden_states=True)

        # hidden_states is a tuple: (embedding_layer, layer_0, layer_1, ..., layer_N)
        # Index [target_layer + 1] because index 0 is the embedding layer output
        hidden = outputs.hidden_states[target_layer + 1]  # shape: [1, seq_len, d_model]

        # Mean-pool over sequence length (exclude padding if any)
        attention_mask = inputs.get("attention_mask")
        if attention_mask is not None:
            mask = attention_mask.unsqueeze(-1).float()
            pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-9)
        else:
            pooled = hidden.mean(dim=1)

        # Shape: [d_model], cast to float32 for SAE arithmetic
        result = pooled.squeeze(0).float().cpu()

        return result, token_count

    def is_loaded(self) -> bool:
        return self._loaded

    def model_variant(self) -> str:
        return self._model_variant

    def num_layers(self) -> int:
        return self._num_layers

    def actual_device(self) -> str:
        return self._resolve_actual_device()
