# Writing Dashboard

A writing dashboard plugin that integrates AI-powered chapter generation, micro-editing, and character management into your writing workflow.

## Quick start (recommended)

1. Install and enable **Writing dashboard**.
2. Open **Settings → Writing dashboard** (plugin settings).
3. Choose an **API provider**, paste your **API key**, and select a **model**.
4. Set **Book main file** using the file tree picker (select your active manuscript note from the dropdown).
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
   - **Surrounding context** - Automatically includes 500 words before and after for seamless narrative flow
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
   - Flags violations (knowledge state, timeline, POV drift, naming)
   - Includes evidence quotes and suggested patches (copy/paste)

### 📁 Vault Integration

- Full vault browser with folder structure
- Read/write access to all Obsidian files
- Automatic path detection
- Configurable file paths

### ✨ Key Highlights

- **Fully Self-Contained** - No Python backend required! Everything runs within Obsidian
- **Multi-Provider Support** - Works with OpenAI, Anthropic (Claude), Google Gemini, and OpenRouter
- **Smart Context Integration** - Automatically pulls from your Story Bible, Extractions, sliding window (last 20k words), and Character notes via RAG retrieval
- **Efficient Context Usage** - Only sends the last 20,000 words of your active manuscript to the AI, not full book files. Full continuity comes from RAG retrieval.
- **Surrounding Context** - Micro-edit mode includes 500 words before/after selected text for better narrative continuity
- **Prompt Size Warning** - Estimates prompt size and warns if you exceed your configured context limit
- **Smarter First-Run Setup** - If your vault already has notes, the plugin can prompt you to select your main manuscript file
- **Hybrid retrieval (local RAG)** - Combines BM25 lexical ranking, local embeddings, and diversity selection to inject relevant context without a server

## Architecture

### Self-Contained Plugin

- **Pure Obsidian Plugin** - TypeScript/React UI
- **Direct AI API Integration** - Makes API calls directly from the plugin
- **No Backend Required** - Everything runs within Obsidian

**Note**: The `backend/` folder contains legacy Python code that is no longer required. The plugin now handles all AI processing internally.

## Setup Instructions

### Prerequisites

- Obsidian installed
- An AI API key from one of the supported providers:
  - OpenAI (GPT-4, GPT-3.5, etc.)
  - Anthropic (Claude 3 Opus, Claude 3 Sonnet, etc.)
  - Google Gemini (for example: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-1.5-pro`)
  - OpenRouter (multi-provider gateway)

### Installation

#### Option 1: From Obsidian Community Plugins (Recommended)

1. Open Obsidian Settings
2. Go to **Community Plugins**
3. Turn off **Safe Mode** (if enabled)
4. Click **Browse** and search for "Writing Dashboard"
5. Click **Install**
6. Enable the plugin

#### Option 2: Manual Installation

1. Download the latest release from [GitHub Releases](https://github.com/JHarp199345/Gwriter/releases)
2. Extract the `obsidian-plugin` folder
3. Copy it to your vault's `.obsidian/plugins/` directory
4. Rename it to `writing-dashboard`
5. Restart Obsidian
6. Go to Settings → Community Plugins → Enable "Writing Dashboard"

#### Option 3: Install from GitHub URL

1. In Obsidian: Settings → Community Plugins → Browse
2. Click "..." (three dots) → "Install from URL"
3. Enter: `https://github.com/JHarp199345/Gwriter`
4. Obsidian will find the plugin in the `obsidian-plugin` folder

### Configuration

1. Open Obsidian settings → **Writing dashboard**
2. Configure:
   - **API Key**: Your AI API key (OpenAI, Anthropic, or Gemini)
   - **API Provider**: Choose your provider (openai, anthropic, gemini, or openrouter)
   - **Model**: examples: `gpt-4o`, `claude-3-5-sonnet`, `gemini-2.5-pro`
   - **Vault Path**: Auto-detected, but can be overridden
   - **Character Folder**: Default is `Characters`
   - **Book main file**: Use the file tree picker to select your active manuscript (supports files at root or in folders)
   - **File Paths**: Configure paths to your Story Bible, Extractions, etc.
   
   Note: The sliding window is automatically extracted from your book main file (last 20,000 words), so no separate sliding window path is needed.

Note: model names change frequently. The plugin does not hardcode model availability; it sends the model id you enter to your chosen provider.

## Usage

### Opening the Dashboard

- Click the **book icon** in the ribbon
- Or use Command Palette (`Cmd+P` / `Ctrl+P`): "Open dashboard"

### Chapter Generation

1. Select **Chapter Generate** mode (bottom-right dropdown)
2. Write your **Scene Summary / Directions**
3. Review/edit **Rewrite Instructions** (defaults are auto-filled; includes a Reset button)
4. Set a **target word range** (Min → Max). For an exact target, set Min=Max.
4. Optional: click **Preview prompt** to see the exact prompt that will be sent.
5. Click **Generate chapter**
5. Review output and copy to clipboard

Notes:
- The dashboard shows word/character counters for Scene Summary, Rewrite Instructions, and Generated Output.
- The dashboard may warn you if the prompt is estimated to exceed your configured context window.

### Micro Editing

1. Select **Micro Edit** mode
2. Paste the problematic passage in "Selected Text"
3. Enter your grievances/directives in "Grievances and directives"
4. Optional: click **Preview prompt** to see the exact prompt that will be sent.
5. Click **Generate edit**
5. The plugin automatically includes 500 words before and after your selection for context
6. Copy the refined alternative and paste into your manuscript

The dashboard displays your current book file path at the top of the main workspace for quick reference.

Examples you can paste into grievances/directives:
- `Character A has no knowledge of Event X yet; remove any references that imply they do. Keep the scene outcome the same.`
- `Fix POV leaks: this is Character B POV only.`
- `Tone is too modern; make it tighter and more tense, matching surrounding chapters.`
- `Continuity: the injury is on the left arm, not the right.`

### Character Updates

1. Select **Character Update** mode
2. Paste character-relevant text in "Selected Text"
3. Optional: click **Preview prompt** to see the exact extraction prompt.
4. Click **Update characters**

### Continuity check

1. Select **Continuity check** mode
2. Paste the draft to check (defaults to the last generated output when empty)
3. Optional: adjust focus toggles (Knowledge, Timeline, POV, Naming)
4. Optional: click **Preview prompt**
5. Click **Run continuity check**

### Per-mode fields

Each mode keeps its own saved inputs (per vault). Switching modes does not overwrite other mode fields.

Bulk character backfill:
1. Select **Character Update** mode
2. Click **Select file to process** and choose the manuscript you want to scan
3. Click **Process Entire Book**
4. The plugin performs a 2-pass scan (roster + per-chapter extraction) and updates character notes

## File Structure

Gwriter/
├── backend/ # Legacy Python backend (no longer required)
│ ├── main.py
│ ├── requirements.txt
│ └── services/
│
└── obsidian-plugin/ # The actual plugin
├── main.js # Built plugin (for installation)
├── main.ts # Source code
├── manifest.json # Plugin manifest
├── package.json
├── styles.css
├── README.md # Plugin-specific README
├── services/
│ ├── AIClient.ts # Direct AI API calls
│ ├── PromptEngine.ts # Prompt building
│ ├── ContextAggregator.ts # Vault file reading
│ ├── CharacterExtractor.ts # Character parsing
│ └── VaultService.ts # File operations
└── ui/
├── DashboardView.ts
├── DashboardComponent.tsx
├── VaultBrowser.tsx
├── EditorPanel.tsx
├── DirectorNotes.tsx
├── ModeSelector.tsx
└── SettingsTab.ts


## Character Notes Format

Character notes are stored in markdown with timestamped updates:

# CharacterName

## January 15, 2024 - 2:30 PM - Update

**Voice Evidence:**
[quoted dialogue]

**New Traits:**
- [trait]: [evidence]

**Relationships:**
- **OtherCharacter**: [relationship change]

**Arc Progression:**
[what changed]

**Spoiler Notes:**
[sensitive information]

## Retrieval (whole vault)

This plugin includes whole-vault retrieval to keep prompts relevant without manual curation. This is how the plugin maintains continuity across large manuscripts - instead of sending full book files, it retrieves relevant chunks from your entire vault.

- You can exclude non-story folders in Settings → Writing dashboard → Retrieval.
- You can use retrieval profiles to include only specific folders (for example: story-only vs research-heavy).
- Semantic retrieval builds a local index in the background (the dashboard shows index status).
- The plugin only sends the last 20,000 words of your active manuscript (sliding window) to the AI, relying on RAG retrieval for full continuity.

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
- `<Manuscript>-Chunked/` (created automatically)
  - Chunked copy of a manuscript note (used by the plugin's chunking and bulk workflows).
- `Story bibles/` (created automatically when saving story bible updates)
  - Versioned story bible files (e.g., `Story bible - 2024-12-20.md`)
  - The plugin automatically uses the latest version when configured.

## Publishing

You can export a professional EPUB directly from the plugin:

1. Open the command palette and run **Export to epub**.
2. Default mode: compile your **Book main path** split by H1 (`#`) chapter headings.
3. Optional: select **TOC note** mode if each chapter is a separate note.
4. Choose title/author/language, optional front matter, and an optional license template.
5. Output defaults to `Exports/` in your vault.

Typography:
- Default styling targets **Literata**.
- To guarantee the font, enable **Embed custom fonts** and select your font files.

Font licensing note: only embed fonts you have the rights to redistribute.

## Privacy notes

Your text is sent only to the AI provider you configured when you click generate/extraction buttons.
No backend server is required for this plugin.

## Troubleshooting

### API Key Issues

- Ensure your API key is correctly entered in settings
- Verify the API key is valid and has credits/quota
- Check that the model name matches your provider:
  - OpenAI: `gpt-4o`, `gpt-4o-mini`, etc.
  - Anthropic: `claude-3-5-sonnet`, `claude-3-5-haiku`, etc.
  - Gemini: `gemini-2.5-pro`, `gemini-2.5-flash`, etc.
  - OpenRouter: provider-prefixed model ids like `openai/gpt-4o` or `google/gemini-2.5-pro`

### API Errors

- Verify your API key is correct
- Check your API provider account for rate limits
- Ensure the model name is correct for your provider
- Check your internet connection

### File Not Found Errors

- Verify file paths in settings match your vault structure
- Ensure files exist at the specified paths
- Check vault path is correct
- Make sure file names match exactly (case-sensitive on Mac/Linux)

### Keyboard Not Working in Text Areas

- This was fixed in v1.0.0. If you experience issues, try:
  - Clicking in the text area again
  - Restarting Obsidian
  - Updating to the latest version

## Development

### Plugin Development

cd obsidian-plugin

# Install dependencies
npm install

# Watch mode (auto-rebuilds on changes)
npm run dev

# Production build
npm run build

### Building for Release

```bash
cd obsidian-plugin
npm run build
# main.js will be created/updated
```

## Contributing

Contributions are welcome! Please feel free to:
- Open issues for bugs or feature requests
- Submit pull requests
- Share feedback and suggestions

## License

MIT License - Free to use and modify

## Support

For issues, feature requests, or questions:
- Open an issue on [GitHub](https://github.com/JHarp199345/Gwriter)
- Check the [plugin README](obsidian-plugin/README.md) for detailed usage

---

**Note**: The Python backend in the `backend/` folder is legacy code and is no longer required. The plugin is now fully self-contained and makes AI API calls directly from within Obsidian.
