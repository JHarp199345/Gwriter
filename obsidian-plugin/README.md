# Writing Dashboard

A writing dashboard plugin that integrates AI-powered chapter generation, micro-editing, and character management into your writing workflow.

## Quick start

1. Install and enable **Writing dashboard**.
2. Open **Settings → Writing dashboard**.
3. Choose an **API provider**, paste your **API key**, and select a **model**.
4. Set **Book main path** to your active manuscript note.
5. Open the dashboard:
   - Ribbon icon: **Open dashboard**
   - Command palette: **Open dashboard**

## Where to get API keys

- OpenAI: `https://platform.openai.com/api-keys`
- Anthropic: `https://console.anthropic.com/settings/keys`
- Google Gemini: `https://aistudio.google.com/app/apikey`
- OpenRouter: `https://openrouter.ai/keys`

## Features

### 🎯 Three Writing Modes

1. **Chapter Generate** - Generate new chapters using your slate method, pulling from:
   - Retrieved context (whole vault)
   - Story Bible + Extractions
   - Sliding Window (immediate context)
   - Your Scene Summary + Rewrite Instructions
   - Target word **range** (Min/Max)

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

## Configuration

1. Open Obsidian settings → **Writing dashboard**
2. Configure:
   - **API Key**: Your AI API key (OpenAI, Anthropic, or Gemini)
   - **API Provider**: Choose your provider
   - **Model**: examples: `gpt-4o`, `claude-3-5-sonnet`, `gemini-2.5-pro`
   - **Vault Path**: Auto-detected, but can be overridden
   - **Character Folder**: Default is `Characters`
   - **File Paths**: Configure paths to your Story Bible, Extractions, Sliding Window, etc.

Note: model names change frequently. The plugin sends the model id you enter to your chosen provider.

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
4. Click **Generate Edit**
5. Copy the refined alternative and paste into your manuscript

### Character Updates

1. Select **Character Update** mode
2. Paste character-relevant text in "Selected Text"
3. Click **Update Characters**
4. Character notes will be updated with timestamped entries

Bulk character backfill:
1. Select **Character Update** mode
2. Click **Select file to process** and choose the manuscript you want to scan
3. Click **Process Entire Book**
4. The plugin performs a 2-pass scan (roster + per-chapter extraction) and updates character notes

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
- **Book main path** (your manuscript note)
  - The active manuscript the dashboard reads for context and chunking.
- **Story bible path**
  - Canon rules, arcs, timelines, constraints.
- **Sliding window path**
  - Short “what just happened” context for better continuity.
- **Extractions path** (optional)
  - Any distilled notes/summaries/constraints you want included in prompts.

## Architecture

This plugin is **fully self-contained**:

- **Pure Obsidian Plugin** - TypeScript/React UI
- **Direct AI API Integration** - Makes API calls directly from the plugin
- **No Backend Required** - Everything runs within Obsidian

## Retrieval (local RAG)

The dashboard uses retrieval-augmented generation (RAG) to pull relevant context from your vault before asking the model to write.

- **Whole-vault retrieval**: searches your vault (excluding folders you choose in settings) for relevant snippets.
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

## Development

See the [main repository](https://github.com/JHarp199345/Gwriter) for development setup and contributing guidelines.

## License

MIT

## Support

For issues, feature requests, or questions, please visit the [GitHub repository](https://github.com/JHarp199345/Gwriter).

