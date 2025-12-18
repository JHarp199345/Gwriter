# Writing Dashboard

A comprehensive writing dashboard for Obsidian that integrates AI-powered chapter generation, micro-editing, and character management into your writing workflow.

## Features

### 🎯 Three Writing Modes

1. **Chapter Generate** - Generate new chapters using your slate method, pulling from:
   - Smart Connections (Book 1 canon)
   - Story Bible + Extractions
   - Sliding Window (immediate context)
   - Your director instructions
   - Target word count

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

### 📁 Vault Integration

- Full vault browser with folder structure
- Read/write access to all Obsidian files
- Automatic path detection
- Configurable file paths

## Architecture

### Hybrid Setup

- **Obsidian Plugin** (Frontend) - TypeScript/React UI
- **Python Backend** (FastAPI) - AI processing, prompt engineering, character extraction

## Setup Instructions

### Prerequisites

- Node.js (v18+)
- Python 3.9+
- Obsidian installed
- AI API key (OpenAI or Anthropic)

### 1. Python Backend Setup

```bash
cd backend
pip install -r requirements.txt
python main.py
```

The backend will start on `http://localhost:8000` by default.

### 2. Obsidian Plugin Setup

```bash
cd obsidian-plugin
npm install
npm run build
```

### 3. Install Plugin in Obsidian

1. Open Obsidian Settings
2. Go to **Community Plugins**
3. Turn off **Safe Mode** (if enabled)
4. Click **Browse** and search for "Writing Dashboard"
5. Or manually install:
   - Copy the `obsidian-plugin` folder to your vault's `.obsidian/plugins/` directory
   - Rename it to `writing-dashboard`
   - Restart Obsidian

### 4. Configure Settings

1. Open Obsidian Settings
2. Go to **Writing Dashboard** settings
3. Configure:
   - **API Key**: Your OpenAI or Anthropic API key
   - **API Provider**: Choose your provider
   - **Model**: e.g., `gpt-4`, `claude-3-opus`
   - **Vault Path**: Auto-detected, but can be overridden
   - **Character Folder**: Default is `Characters`
   - **File Paths**: Configure paths to your Story Bible, Extractions, Sliding Window, etc.
   - **Python Backend URL**: Default is `http://localhost:8000`

## Usage

### Opening the Dashboard

- Click the book icon in the ribbon
- Or use Command Palette: "Open Writing Dashboard"

### Chapter Generation

1. Select **Chapter Generate** mode
2. Paste your slate instructions in the "Director Notes" field
3. Set target word count
4. Click **Generate Chapter**
5. Review output and copy to clipboard

### Micro Editing

1. Select **Micro Edit** mode
2. Paste the problematic passage in "Selected Text"
3. Enter your grievances/directives in "Director Notes"
4. Click **Generate Edit**
5. Copy the refined alternative and paste into your manuscript

### Character Updates

1. Select **Character Update** mode
2. Paste character-relevant text in "Selected Text"
3. Click **Update Characters**
4. Character notes will be updated with timestamped entries

## File Structure

```
Gwriter/
├── backend/
│   ├── main.py                    # FastAPI server
│   ├── requirements.txt
│   └── services/
│       ├── ai_client.py          # BYOK AI wrapper
│       ├── prompt_engine.py      # 3 prompt modes
│       ├── context_aggregator.py  # Vault file reader
│       └── character_extractor.py # Character parsing
│
└── obsidian-plugin/
    ├── main.ts                    # Plugin entry
    ├── manifest.json
    ├── package.json
    ├── styles.css
    ├── services/
    │   ├── PythonBridge.ts       # Backend communication
    │   └── VaultService.ts       # File operations
    └── ui/
        ├── DashboardView.ts
        ├── DashboardComponent.tsx
        ├── VaultBrowser.tsx
        ├── EditorPanel.tsx
        ├── DirectorNotes.tsx
        ├── ModeSelector.tsx
        └── SettingsTab.ts
```

## API Endpoints

The Python backend exposes:

- `POST /api/generate/chapter` - Chapter generation
- `POST /api/generate/micro-edit` - Micro editing
- `POST /api/extract/characters` - Character extraction
- `GET /health` - Health check

## Character Notes Format

Character notes are stored in markdown with timestamped updates:

```markdown
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
```

## Smart Connections Integration

The dashboard attempts to read Smart Connections data from:
`.obsidian/plugins/smart-connections/data.json`

If Smart Connections isn't available, it will use a fallback or you can manually configure similar note retrieval.

## Troubleshooting

### Backend Not Connecting

- Ensure Python backend is running: `python backend/main.py`
- Check the URL in settings matches your backend
- Verify firewall/network settings

### API Errors

- Verify your API key is correct
- Check your API provider account for rate limits
- Ensure the model name is correct for your provider

### File Not Found Errors

- Verify file paths in settings match your vault structure
- Ensure files exist at the specified paths
- Check vault path is correct

## Development

### Backend Development

```bash
cd backend
# Install dependencies
pip install -r requirements.txt

# Run with auto-reload (if using uvicorn --reload)
python main.py
```

### Plugin Development

```bash
cd obsidian-plugin
# Install dependencies
npm install

# Watch mode (auto-rebuilds on changes)
npm run dev

# Production build
npm run build
```

## License

MIT

## Contributing

This is a personal project, but suggestions and improvements are welcome!

