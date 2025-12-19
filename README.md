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
   - **Surrounding context** - Automatically includes 500 words before and after for seamless narrative flow
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

### ✨ Key Highlights

- **Fully Self-Contained** - No Python backend required! Everything runs within Obsidian
- **Multi-Provider Support** - Works with OpenAI, Anthropic (Claude), and Google Gemini
- **Smart Context Integration** - Automatically pulls from your Story Bible, Extractions, Sliding Window, and Character notes
- **Surrounding Context** - Micro-edit mode includes 500 words before/after selected text for better narrative continuity

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
  - Google Gemini (gemini-pro, gemini-1.5-pro, etc.)

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

1. Open Obsidian Settings → **Writing Dashboard**
2. Configure:
   - **API Key**: Your AI API key (OpenAI, Anthropic, or Gemini)
   - **API Provider**: Choose your provider (openai, anthropic, or gemini)
   - **Model**: e.g., `gpt-4`, `claude-3-opus`, `gemini-pro`
   - **Vault Path**: Auto-detected, but can be overridden
   - **Character Folder**: Default is `Characters`
   - **File Paths**: Configure paths to your Story Bible, Extractions, Sliding Window, etc.

## Usage

### Opening the Dashboard

- Click the **book icon** in the ribbon
- Or use Command Palette (`Cmd+P` / `Ctrl+P`): "Open Writing Dashboard"

### Chapter Generation

1. Select **Chapter Generate** mode (bottom-right dropdown)
2. Paste your slate instructions in the "Director Notes" field
3. Set target word count
4. Click **Generate Chapter**
5. Review output and copy to clipboard

### Micro Editing

1. Select **Micro Edit** mode
2. Paste the problematic passage in "Selected Text"
3. Enter your grievances/directives in "Director Notes"
4. Click **Generate Edit**
5. The plugin automatically includes 500 words before and after your selection for context
6. Copy the refined alternative and paste into your manuscript

### Character Updates

1. Select **Character Update** mode
2. Paste character-relevant text in "Selected Text"
3. Click **Update Characters**
4. Character notes will be updated with timestamped entries in the `Characters/` folder

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
[sensitive information]## Smart Connections Integration

The dashboard attempts to read Smart Connections data from:
`.obsidian/plugins/smart-connections/data.json`

If Smart Connections isn't available, it will use a fallback message. The plugin works without Smart Connections, but having it installed enhances context awareness.

## Troubleshooting

### API Key Issues

- Ensure your API key is correctly entered in settings
- Verify the API key is valid and has credits/quota
- Check that the model name matches your provider:
  - OpenAI: `gpt-4`, `gpt-3.5-turbo`, etc.
  - Anthropic: `claude-3-opus`, `claude-3-sonnet`, etc.
  - Gemini: `gemini-pro`, `gemini-1.5-pro`, etc.

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
npm run build### Building for Release
h
cd obsidian-plugin
npm run build
# main.js will be created/updated## Contributing

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

Smart Connections Integration
The dashboard attempts to read Smart Connections data from:
.obsidian/plugins/smart-connections/data.json
If Smart Connections isn't available, it will use a fallback message. The plugin works without Smart Connections, but having it installed enhances context awareness.
Troubleshooting
API Key Issues
Ensure your API key is correctly entered in settings
Verify the API key is valid and has credits/quota
Check that the model name matches your provider:
OpenAI: gpt-4, gpt-3.5-turbo, etc.
Anthropic: claude-3-opus, claude-3-sonnet, etc.
Gemini: gemini-pro, gemini-1.5-pro, etc.
API Errors
Verify your API key is correct
Check your API provider account for rate limits
Ensure the model name is correct for your provider
Check your internet connection
File Not Found Errors
Verify file paths in settings match your vault structure
Ensure files exist at the specified paths
Check vault path is correct
Make sure file names match exactly (case-sensitive on Mac/Linux)
Keyboard Not Working in Text Areas
This was fixed in v1.0.0. If you experience issues, try:
Clicking in the text area again
Restarting Obsidian
Updating to the latest version
