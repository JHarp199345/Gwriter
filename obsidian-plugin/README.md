# Local AI Setup (Ollama)

The plugin ships without any binaries. To enable semantic search, bring your own Ollama and model:

1. Install Ollama: https://ollama.com/download
2. In a new Terminal window:
   ```bash
   ollama --version
   ```
   If it prints a version, the CLI is on PATH. If not, try:
   ```bash
   /Applications/Ollama.app/Contents/MacOS/Ollama --version
   echo 'export PATH="/Applications/Ollama.app/Contents/MacOS:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   ```
3. Pull the embedding model:
   ```bash
   ollama pull nomic-embed-text
   ```
4. If you see errors about `~/.ollama/models` not accessible, create it:
   ```bash
   mkdir -p ~/.ollama/models
   sudo chown -R "$USER":"$USER" ~/.ollama
   chmod -R 755 ~/.ollama
   ```
5. In Obsidian Settings → Local AI Setup (Ollama):
   - Click “Check Connection” to verify Ollama is running and `nomic-embed-text` is present.
   - If OK, optionally click “Re-index” to regenerate embeddings.

Fallback: If Ollama isn’t running, the plugin still works with lexical search; semantic unlocks when Ollama is available.
# Writing Dashboard

A writing dashboard plugin that integrates AI-powered chapter generation, micro-editing, and character management into your writing workflow.

## Quick start

1. Install and enable **Writing dashboard**.
2. Open **Settings → Writing dashboard**.
3. Choose an **API provider**, paste your **API key**, and select a **model**.
4. Set **Book main file** using the file tree picker in settings (select your active manuscript note from the dropdown).
5. Optional but recommended: set **Story bible path**.
6. Open the dashboard:
   - Ribbon icon: **Open dashboard**
   - Command palette: **Open dashboard**

## Where to get API keys

- OpenAI: `https://platform.openai.com/api-keys`
- Anthropic: `https://console.anthropic.com/settings/keys`
- Google Gemini: `https://aistudio.google.com/app/apikey`
- OpenRouter: `https://openrouter.ai/keys`

## Features

### 🎯 Writing modes

1. **Generate chapter** - Generate new chapters using your slate method, pulling from:
   - Retrieved context (whole vault) - RAG retrieval from all indexed files
   - Story Bible + Extractions
   - Sliding Window - Last 20,000 words of your active manuscript (extracted automatically)
   - Your Scene Summary + Rewrite Instructions
   - Target word **range** (Min/Max)

   **Important**: The plugin only sends the last 20,000 words of your active manuscript (sliding window) to the AI, not full book files. Continuity is maintained through RAG retrieval from your whole vault.

2. **Micro Edit** - Refine specific passages with:
   - Selected text analysis
   - Your grievances and directives
   - Full context awareness (characters, canon, style)
   - Single refined alternative output

3. **Character Update** - Extract and update character notes:
   - Manual extraction from selected text
   - Timestamped updates
   - Voice evidence, traits, relationships, arc progression
   - Automatic character folder management
   - Bulk backfill (**Process Entire Book**) with improved recall:
     - Pick which file to process (Book 1 / Book 2 / any note)
     - Splits by H1 chapter headings (`# `)
     - 2-pass pipeline (roster pass + per-chapter extraction)

4. **Continuity check** - Scan a draft against canon and context:
   - Flags violations with evidence
   - Provides suggested patches (copy/paste)

### 📁 Vault Integration

- Full vault browser with folder structure
- Read/write access to all Obsidian files
- Automatic path detection
- Configurable file paths

## Requirements

- Obsidian installed
- An AI API key (OpenAI, Anthropic, or Gemini)
- **No Python backend needed!** This plugin works entirely within Obsidian.

## Installation

### From Obsidian

1. Open Settings → Community Plugins
2. Click "Browse" and search for "Writing Dashboard"
3. Click "Install"
4. Enable the plugin

### Manual Installation

1. Download the latest release from [GitHub Releases](https://github.com/JHarp199345/Gwriter/releases)
2. Extract the `obsidian-plugin` folder
3. Copy it to your vault's `.obsidian/plugins/` directory
4. Rename it to `writing-dashboard`
5. Restart Obsidian

## First-Run Setup

On first run, the plugin will automatically show a **Setup Wizard** to help you create the default vault structure. You can also manually trigger it:

1. Open Obsidian settings → **Writing dashboard**
2. Click **"Run setup wizard"** button
3. Or use Command Palette: **"Run setup wizard"**

The wizard lets you:
- Create default files: `Book-Main.md`, `Book - Story Bible.md`, `Memory - Sliding Window.md`
- Create the `Characters/` folder with a template
- All files/folders are only created if they don't already exist (won't overwrite)

## Configuration

1. Open Obsidian settings → **Writing dashboard**
2. Configure:
   - **API Key**: Your AI API key (OpenAI, Anthropic, or Gemini)
   - **API Provider**: Choose your provider
   - **Model**: examples: `gpt-4o`, `claude-3-5-sonnet`, `gemini-2.5-pro`
   - **Vault Path**: Auto-detected, but can be overridden
   - **Character Folder**: Use the folder tree picker to select or create a folder (default: `Characters`)
   - **Book main file**: Use the file tree picker to select your active manuscript (supports files at root or in folders)
   - **Story Bible Path**: Use the file tree picker to select your story bible file
   - **Generation Logs Folder**: Optional folder for logging generation runs (excluded from retrieval)

Note: The sliding window is automatically extracted from your book main file (last 20,000 words), so no separate sliding window path is needed. Model names change frequently. The plugin sends the model id you enter to your chosen provider.

## Usage

### Opening the Dashboard

- Click the book icon in the ribbon
- Or use Command Palette: "Open dashboard"

### Chapter Generation

1. Select **Chapter Generate** mode
2. Write your **Scene Summary / Directions**
3. Review/edit **Rewrite Instructions** (defaults are auto-filled; includes a Reset button)
4. Set a **target word range** (Min → Max). For an exact target, set Min=Max.
5. Click **Generate Chapter**
6. Review output and copy to clipboard

### Micro Editing

1. Select **Micro Edit** mode
2. Paste the problematic passage in "Selected Text"
3. Enter your grievances/directives in "Grievances and directives"
4. Optional: click **Preview prompt** to see the exact prompt that will be sent.
5. Click **Generate Edit**
6. The plugin automatically includes 500 words before and after your selection for context
7. Copy the refined alternative and paste into your manuscript

### Character Updates

1. Select **Character Update** mode
2. Paste character-relevant text in "Selected Text"
3. Optional: click **Preview prompt** to see the extraction prompt.
4. Click **Update Characters**
5. Character notes will be updated with timestamped entries in the `Characters/` folder

Bulk character backfill:
1. Select **Character Update** mode
2. Click **Select file to process** and choose the manuscript you want to scan
3. Click **Process Entire Book**
4. The plugin performs a 2-pass scan (roster + per-chapter extraction) and updates character notes

### File Chunking

Manually chunk large files into smaller segments:

1. Select **Character Update** mode
2. Select text in your editor OR select a file to process
3. Click **Chunk Selected File**
4. The plugin creates a `[FILENAME]-Chunked/` folder with numbered chunk files (e.g., `Book-Main-CHUNK-001.md`)
5. Each chunk is approximately 500 words with overlap for context

### Story Bible Updates

1. Select **Chapter Generate** mode
2. Enter text in "Selected Text" field (the new content to extract story bible updates from)
3. Click **Update story bible**
4. The plugin extracts deltas and merges them with your existing story bible
5. Review the merged output and choose:
   - **Save merged story bible** - Saves to `Story bibles/Story bible - YYYY-MM-DD.md` and auto-updates the active story bible path in settings
   - **Replace story bible** - Saves new versioned file and updates the path

The dashboard displays your current book file path at the top of the main workspace for quick reference.

## Publishing

You can export a professional ebook or submission document directly from the plugin:

1. Open the command palette and run **Export to epub**.
2. Default mode: compile **Book main path** split by H1 (`#`) chapter headings.
3. Optional: select **TOC note** mode if each chapter is a separate note.
4. Choose title/author/language, optional front matter, and an optional license template.
5. Choose an output format (Epub, Docx, Rtf, or plain text) and optional export subset (first N chapters or first N words).
6. Output defaults to `Exports/` in your vault.

Typography:
- Default styling targets **Literata**.
- To guarantee the font, enable **Embed custom fonts** and select your font files.

Font licensing note: only embed fonts you have the rights to redistribute.

## Vault structure (what each folder/file is for)

These paths are configurable in settings. The names below are recommended defaults.

- `Characters/`
  - One note per character (auto-updated by Character update).
- **Book main file** (your manuscript note)
  - The active manuscript you're currently writing.
  - Used to extract the sliding window (last 20,000 words) for immediate context.
  - Continuity with previous books/chapters comes from RAG retrieval, not full file loads.
- **Story bible path**
  - Canon rules, arcs, timelines, constraints.
  - When you save updated story bibles, they're automatically saved to `Story bibles/` folder with timestamps.
  - The plugin auto-updates the active story bible path when you save new versions.
- **Extractions path** (optional)
  - Any distilled notes/summaries/constraints you want included in prompts.
- `Story bibles/` (created automatically when saving story bible updates)
  - Versioned story bible files (e.g., `Story bible - 2024-12-20.md`)
  - The plugin automatically uses the latest version when configured.

## Architecture

This plugin is **fully self-contained**:

- **Pure Obsidian Plugin** - TypeScript/React UI
- **Direct AI API Integration** - Makes API calls directly from the plugin
- **No Backend Required** - Everything runs within Obsidian

## Retrieval (local RAG)

The dashboard uses retrieval-augmented generation (RAG) to pull relevant context from your vault before asking the model to write. **This is how the plugin maintains continuity across large manuscripts** - instead of sending full book files to the AI, it retrieves relevant chunks from your entire vault.

**Context efficiency**: The plugin only sends the last 20,000 words of your active manuscript (sliding window) to the AI, not full book files. Full continuity with previous books and chapters comes from RAG retrieval.

- **Whole-vault retrieval**: searches your vault (excluding folders you choose in settings) for relevant snippets.
- **Retrieval profiles**: optionally restrict retrieval/indexing to a folder include list (story-only, research-heavy, manuscript-only, or your own custom profiles).
- **Hybrid ranking**: combines heuristic matching, **BM25** (search-engine lexical ranking), and an optional semantic index.
- **Local embeddings**: semantic retrieval runs locally (no external vector database).
- **Diversity**: uses MMR-style selection to reduce near-duplicate snippets.
- **Reranking (optional)**: can use a local CPU reranker to improve ordering at Generate time.
- **Token budgeting**: retrieved context is injected with a budget so prompts stay under your configured context limit.

Indexing quality:
- Retrieval indexing can prefer a heading level (H1/H2/H3) when chunking notes. Default is H1.
- If headings are missing (or set to None), indexing falls back to word-window chunking with overlap.

## Generation logs

If enabled in settings, the plugin writes a per-run log note to `Generation logs/` containing inputs, retrieved context, and output. This folder is always excluded from retrieval to avoid feedback loops.

## Troubleshooting

### API Key Issues

- Ensure your API key is correctly entered in settings
- Verify the API key is valid and has credits/quota
- Check that the model name matches your provider

### API Errors

- Verify your API key is correct
- Check your API provider account for rate limits
- Ensure the model name is correct for your provider

### File Not Found Errors

- Verify file paths in settings match your vault structure
- Ensure files exist at the specified paths
- Check vault path is correct

### Embedding/Indexing Issues

- **Check Ollama Status** - Ensure Ollama is running (`ollama serve`) and the embedding model (e.g., `nomic-embed-text`) is pulled.
- **BM25 retrieval still works** - Even if embeddings fail, the plugin uses BM25 (text-based) retrieval which works reliably.
- **Check index status** - Go to Settings → Writing dashboard → Retrieval to see indexing status.
- **Manual Management** - Use the **Re-index Vault** or **Clear Index** buttons in the "Semantic Index Management" section to refresh or wipe your index.
- **Robust Processing**: Automatically handles long contiguous strings (like logs or base64) by splitting them into digestible chunks for the embedding model, preventing API "400 Bad Request" errors.
- **Run stress test** - Use the Developer Tools stress test (Settings → Writing dashboard → Developer Tools) to get detailed diagnostics.

### 🧠 Under the Hood (Advanced Architecture)

#### 1. Rolling Window Refinement
Treats the generation field as a **Living Document**:
- **3-Chunk Juggling**: Maintains a rolling buffer of the last ~1500 words to ensure narrative cohesion.
- **Live Patching**: The AI background "Stitcher" pass polishes transitions in real-time. You'll see text "settle" into its final form with a subtle highlight.
- **Hardware Optimization**: Uses **KV Cache Grafting** and a stable prefix to allow single-model hardware (16GB/32GB RAM) to switch between writing and stitching in milliseconds without VRAM swapping.

#### 2. Narrative Integrity Gates
Five layers of protection ensure the AI never breaks your story:
- **Hash Gate**: Rejects AI edits if you've manually changed the paragraph in the meantime.
- **User-Dirty Protection**: Once you edit a paragraph, the AI is strictly forbidden from auto-patching it.
- **LockMap Gate**: Protects proper nouns, character names, and dates from being altered.
- **Tuple Gate**: Prevents the introduction of contradictory facts or "hallucinated" canon.
- **Budget Gate**: Limits the amount of change the background pass can make, preventing "runaway" edits.

#### 3. 2-Pass Character Extraction
The "Process Entire Book" feature uses a sophisticated pipeline:
- **Pass 1 (Roster Discovery)**: Scans the manuscript to build a global list of names and resolve aliases.
- **Pass 2 (Extraction)**: Re-scans each chapter with the roster in mind to ensure accurate, non-duplicate character notes.

#### 4. Hybrid Retrieval & Diversity (MMR)
The RAG engine uses **Reciprocal Rank Fusion (RRF)** to combine keyword (BM25) and semantic results, followed by **Maximal Marginal Relevance (MMR)** to filter out redundant context snippets.

### Developer Tools

The plugin includes a comprehensive stress test for diagnostics:

1. Go to Settings → Writing dashboard → Developer Tools
2. Click **"Start Stress Test"**
3. The test will:
   - Create temporary test files
   - Test indexing, retrieval (hash + BM25 + semantic), and file ops
   - **Check adversarial word handling** (verifies long-word splitting for 400 error prevention)
   - **Check Safety Gates** (verifies Hash Gate, User-Dirty, and Budget limits)
   - **If an API key is set, run a live generation call** (chapter-style prompt) and log a snippet
   - Clean up all temporary files automatically
4. The log is saved as a note in your vault: `Stress Test Log - [timestamp].md`

## Development

See the [main repository](https://github.com/JHarp199345/Gwriter) for development setup and contributing guidelines.

## License

MIT

## Support

For issues, feature requests, or questions, please visit the [GitHub repository](https://github.com/JHarp199345/Gwriter).

