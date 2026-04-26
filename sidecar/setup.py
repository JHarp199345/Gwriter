"""
GWriter NSM Sidecar — Setup Script
====================================
Handles everything needed to get the sidecar running:
  • Python dependency check
  • HuggingFace account login (with browser-based token flow)
  • Gemma 3 model download
  • Gemma Scope 2 SAE weight download
  • Neuronpedia label download
  • .env file generation

Run: python setup.py
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
ENV_FILE = HERE / ".env"
LABELS_DIR = HERE / "labels"


# ── Colours for terminal output ───────────────────────────────────────────────
def _c(code: str, text: str) -> str:
    if sys.platform == "win32" and not os.environ.get("WT_SESSION"):
        return text  # No ANSI on plain Windows cmd
    return f"\033[{code}m{text}\033[0m"

def green(t): return _c("32", t)
def yellow(t): return _c("33", t)
def red(t): return _c("31", t)
def bold(t): return _c("1", t)
def cyan(t): return _c("36", t)


def _banner(text: str) -> None:
    print(f"\n{bold(cyan('═' * 60))}")
    print(f"  {bold(text)}")
    print(f"{bold(cyan('═' * 60))}\n")


def _ok(msg: str) -> None:
    print(f"  {green('✓')} {msg}")


def _warn(msg: str) -> None:
    print(f"  {yellow('⚠')} {msg}")


def _err(msg: str) -> None:
    print(f"  {red('✗')} {msg}")


def _step(msg: str) -> None:
    print(f"\n{bold(msg)}")


# ── Python version check ──────────────────────────────────────────────────────
def check_python() -> None:
    _step("Checking Python version...")
    v = sys.version_info
    if v < (3, 11):
        _err(f"Python 3.11+ required. You have {v.major}.{v.minor}.")
        _warn("Download from: https://www.python.org/downloads/")
        sys.exit(1)
    _ok(f"Python {v.major}.{v.minor}.{v.micro}")


# ── Pip dependencies ──────────────────────────────────────────────────────────
def install_deps(skip: bool = False) -> None:
    if skip:
        _warn("Skipping dependency install (--skip-deps)")
        return

    _step("Installing Python dependencies...")
    req_file = HERE / "requirements.txt"
    if not req_file.exists():
        _err("requirements.txt not found")
        sys.exit(1)

    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(req_file), "-q"],
        capture_output=False,
    )
    if result.returncode != 0:
        _err("pip install failed. See errors above.")
        sys.exit(1)
    _ok("Dependencies installed")


# ── HuggingFace login ─────────────────────────────────────────────────────────
def huggingface_login() -> bool:
    """
    Check if the user is already logged in. If not, walk them through it
    with clear instructions. Returns True when logged in successfully.
    """
    _step("HuggingFace authentication...")

    try:
        from huggingface_hub import HfApi, HfFolder
        token = HfFolder.get_token()
        if token:
            try:
                api = HfApi()
                user = api.whoami(token=token)
                _ok(f"Already logged in as: {bold(user['name'])}")
                return True
            except Exception:
                pass  # Token may be expired — fall through to login
    except ImportError:
        _err("huggingface_hub not installed. Run: pip install huggingface_hub")
        sys.exit(1)

    print()
    print(bold("  You need a HuggingFace account to download Gemma 3."))
    print("  This is free and takes 2 minutes.")
    print()
    print("  Steps:")
    print(f"    1. Go to: {cyan('https://huggingface.co/join')}")
    print(f"    2. Create a free account")
    print(f"    3. Accept Gemma 3's license: {cyan('https://huggingface.co/google/gemma-3-2b-pt')}")
    print(f"       (Click 'Agree and access repository' on that page)")
    print(f"    4. Get your token: {cyan('https://huggingface.co/settings/tokens')}")
    print(f"       (Create a token with 'Read' permission)")
    print()

    while True:
        token = input("  Paste your HuggingFace token here (starts with hf_): ").strip()
        if not token:
            _warn("No token entered. Skipping login.")
            return False
        if not token.startswith("hf_"):
            _warn("Token should start with 'hf_' — try again, or press Enter to skip.")
            continue
        try:
            from huggingface_hub import HfApi, HfFolder
            api = HfApi()
            user = api.whoami(token=token)
            HfFolder.save_token(token)
            _ok(f"Logged in as: {bold(user['name'])}")
            return True
        except Exception as e:
            _err(f"Login failed: {e}")
            print("  Check that your token is correct and try again.")
            choice = input("  Try again? (y/n): ").strip().lower()
            if choice != "y":
                return False


# ── Model download ────────────────────────────────────────────────────────────
def download_model(model_id: str = "google/gemma-3-2b-pt", skip: bool = False) -> str | None:
    if skip:
        _warn(f"Skipping model download (--skip-model). Set NSM_MODEL_PATH in .env if already downloaded.")
        return None

    _step(f"Downloading Gemma 3 weights ({model_id})...")
    print(f"  {yellow('This is a large download (~5 GB). It may take several minutes.')}")
    print(f"  Files are cached in: ~/.cache/huggingface/hub/")
    print()

    try:
        from huggingface_hub import snapshot_download
        t0 = time.time()
        path = snapshot_download(
            model_id,
            ignore_patterns=["*.msgpack", "*.h5", "flax_model*", "tf_model*"],
        )
        elapsed = time.time() - t0
        _ok(f"Model downloaded in {elapsed:.0f}s → {path}")
        return path
    except Exception as e:
        err_str = str(e)
        if "401" in err_str or "403" in err_str or "gated" in err_str.lower():
            _err("Access denied.")
            print()
            print(bold("  You need to accept Gemma 3's license on HuggingFace:"))
            print(f"  → {cyan('https://huggingface.co/google/gemma-3-2b-pt')}")
            print("  Click 'Agree and access repository', then re-run this script.")
        else:
            _err(f"Download failed: {e}")
        return None


# ── SAE weight download ───────────────────────────────────────────────────────
def download_sae(
    sae_repo: str = "google/gemma-scope-2b-pt-res",
    target_layer: int = 20,
    dict_size: int = 16384,
    skip: bool = False,
) -> str | None:
    if skip:
        _warn("Skipping SAE download (--skip-sae).")
        return None

    width_k = dict_size // 1024
    _step(f"Downloading Gemma Scope 2 SAE weights (layer {target_layer}, {width_k}k features)...")
    print("  No license acceptance required for Gemma Scope 2.")
    print(f"  Repository: {sae_repo}")
    print()

    try:
        from huggingface_hub import snapshot_download
        # Only download the specific layer/width we need — not the whole repo
        allow_patterns = [
            f"layer_{target_layer}/width_{width_k}k/**",
            f"*layer{target_layer}*width{width_k}k*",
            f"*layer_{target_layer}*{width_k}k*",
        ]
        t0 = time.time()
        path = snapshot_download(
            sae_repo,
            allow_patterns=allow_patterns,
        )
        elapsed = time.time() - t0
        _ok(f"SAE weights downloaded in {elapsed:.0f}s → {path}")
        return path
    except Exception as e:
        _err(f"SAE download failed: {e}")
        return None


# ── Label download ────────────────────────────────────────────────────────────
def download_labels(target_layer: int = 20, dict_size: int = 16384, skip: bool = False) -> None:
    if skip:
        _warn("Skipping label download (--skip-labels). Features will have indexes but no names.")
        return

    _step("Downloading Neuronpedia feature labels...")
    print("  These give each SAE dimension a human-readable name.")
    print("  Example: Feature #14521 → 'Suppressed Grief'")
    print()

    LABELS_DIR.mkdir(exist_ok=True)
    width_k = dict_size // 1024
    filename = f"gemma-scope-2b-layer{target_layer}-{width_k}k-labels.json"
    out_path = LABELS_DIR / filename

    if out_path.exists():
        _ok(f"Labels already present: {out_path.name}")
        return

    # Neuronpedia bulk export endpoint
    url = (
        f"https://www.neuronpedia.org/api/explanation/export"
        f"?modelId=gemma-2-2b&layer={target_layer}&saeId={width_k}k"
    )

    try:
        print(f"  Fetching from Neuronpedia...", end="", flush=True)
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())

        # Neuronpedia export format: list of {index, description} objects
        if isinstance(data, list):
            labels: dict[str, str] = {}
            for item in data:
                idx = item.get("index", item.get("featureIndex"))
                desc = item.get("description", item.get("label", ""))
                if idx is not None and desc:
                    labels[str(idx)] = desc
        elif isinstance(data, dict):
            labels = {str(k): v for k, v in data.items()}
        else:
            raise ValueError("Unexpected response format")

        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"labels": labels}, f, indent=2)

        print(f" done")
        _ok(f"Downloaded {len(labels):,} labels → {out_path.name}")

    except urllib.error.HTTPError as e:
        print()
        _warn(f"Neuronpedia returned HTTP {e.code}. Saving empty labels file.")
        with open(out_path, "w") as f:
            json.dump({"labels": {}}, f)
        _warn("You can add labels later by re-running: python setup.py --download-labels")
    except Exception as e:
        print()
        _warn(f"Label download failed ({e}). Sidecar will run without labels.")
        _warn("Re-run later: python setup.py --download-labels")


# ── .env generation ───────────────────────────────────────────────────────────
def write_env(model_path: str | None, sae_path: str | None, target_layer: int, dict_size: int) -> None:
    _step("Writing .env configuration file...")

    lines = [
        "# GWriter NSM Sidecar — configuration",
        "# Generated by setup.py. Edit as needed.",
        "",
        f"# Model",
        f'NSM_MODEL_PATH={model_path or ""}',
        f'NSM_HF_MODEL_ID=google/gemma-3-2b-pt',
        f'NSM_MODEL_VARIANT=gemma-3-2b-pt',
        "",
        f"# SAE",
        f'NSM_SAE_PATH=',
        f'NSM_HF_SAE_REPO=google/gemma-scope-2b-pt-res',
        f'NSM_TARGET_LAYER={target_layer}',
        f'NSM_SAE_DICT_SIZE={dict_size}',
        "",
        f"# Extraction",
        f'NSM_TOP_K_FEATURES=20',
        f'NSM_ACTIVATION_THRESHOLD=0.5',
        "",
        f"# Server",
        f'NSM_PORT=8765',
        f'NSM_HOST=127.0.0.1',
        f'NSM_LOG_LEVEL=info',
        "",
        f"# Device: auto, cpu, cuda, mps",
        f'NSM_DEVICE=auto',
        "",
        f"# Set to true on machines with <16GB RAM (requires: pip install bitsandbytes)",
        f'NSM_QUANTIZE_INT8=false',
    ]

    with open(ENV_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    _ok(f".env written to: {ENV_FILE}")


# ── Final instructions ────────────────────────────────────────────────────────
def print_next_steps() -> None:
    print()
    _banner("Setup complete!")
    print(f"  To start the sidecar:")
    print()
    if sys.platform == "win32":
        print(f"    {cyan('start.bat')}")
    else:
        print(f"    {cyan('./start.sh')}")
    print(f"    or: {cyan('python main.py')}")
    print()
    print(f"  Then in Obsidian:")
    print(f"    Settings → Writing Dashboard → NSM → Enable NSM")
    print(f"    Click 'Test connection' to verify")
    print()
    print(f"  Health check: {cyan('http://127.0.0.1:8765/health')}")
    print()


# ── CLI ───────────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(
        description="GWriter NSM Sidecar setup",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python setup.py                     # Full setup (recommended)
  python setup.py --skip-model        # Skip model download (already have it)
  python setup.py --download-labels   # Only download Neuronpedia labels
  python setup.py --layer 26 --dict-size 65536  # Different layer/dict config
        """,
    )
    parser.add_argument("--skip-deps", action="store_true", help="Skip pip install")
    parser.add_argument("--skip-model", action="store_true", help="Skip Gemma 3 download")
    parser.add_argument("--skip-sae", action="store_true", help="Skip SAE weight download")
    parser.add_argument("--skip-labels", action="store_true", help="Skip Neuronpedia label download")
    parser.add_argument("--download-labels", action="store_true", help="Only download labels and exit")
    parser.add_argument("--model-id", default="google/gemma-3-2b-pt", help="HuggingFace model ID")
    parser.add_argument("--layer", type=int, default=20, help="Target transformer layer (default: 20)")
    parser.add_argument("--dict-size", type=int, default=16384, choices=[16384, 65536], help="SAE dict size")

    args = parser.parse_args()

    _banner("GWriter NSM Sidecar — Setup")

    # Labels-only mode
    if args.download_labels:
        install_deps(skip=args.skip_deps)
        download_labels(args.layer, args.dict_size)
        return

    check_python()
    install_deps(skip=args.skip_deps)

    logged_in = huggingface_login()
    if not logged_in:
        _warn("Skipping model download (not logged in).")
        args.skip_model = True

    model_path = download_model(args.model_id, skip=args.skip_model)
    sae_path = download_sae(
        target_layer=args.layer,
        dict_size=args.dict_size,
        skip=args.skip_sae,
    )
    download_labels(args.layer, args.dict_size, skip=args.skip_labels)
    write_env(model_path, sae_path, args.layer, args.dict_size)
    print_next_steps()


if __name__ == "__main__":
    main()
