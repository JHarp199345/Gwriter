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

## Requirements

This plugin requires a **Python backend server** to be running. The backend handles AI API calls and processing.

### Backend Setup

1. Clone or download the backend from the [main repository](https://github.com/JHarp199345/Gwriter)
2. Navigate to the `backend` folder
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   # or
   python3 -m pip install -r requirements.txt
   ```
4. Start the server:
   ```bash
   python main.py
   # or
   python3 main.py
   ```
5. The server will run on `http://localhost:8000` by default

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

1. Open Obsidian Settings → **Writing Dashboard**
2. Configure:
   - **API Key**: Your AI API key (OpenAI, Anthropic, or Gemini)
   - **API Provider**: Choose your provider
   - **Model**: e.g., `gpt-4`, `claude-3-opus`, `gemini-pro`
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

## Architecture

This plugin uses a **hybrid architecture**:

- **Obsidian Plugin** (Frontend) - TypeScript/React UI
- **Python Backend** (FastAPI) - AI processing, prompt engineering, character extraction

The backend must be running separately for the plugin to function.

## Troubleshooting

### Backend Not Connecting

- Ensure Python backend is running: `python main.py` (or `python3 main.py`)
- Check the URL in settings matches your backend
- Try accessing `http://localhost:8000/health` in your browser
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

See the [main repository](https://github.com/JHarp199345/Gwriter) for development setup and contributing guidelines.

## License

MIT

## Support

For issues, feature requests, or questions, please visit the [GitHub repository](https://github.com/JHarp199345/Gwriter).

