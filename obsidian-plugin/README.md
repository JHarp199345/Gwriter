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

1. Open Obsidian Settings → **Writing Dashboard**
2. Configure:
   - **API Key**: Your AI API key (OpenAI, Anthropic, or Gemini)
   - **API Provider**: Choose your provider
   - **Model**: e.g., `gpt-4`, `claude-3-opus`, `gemini-pro`
   - **Vault Path**: Auto-detected, but can be overridden
   - **Character Folder**: Default is `Characters`
   - **File Paths**: Configure paths to your Story Bible, Extractions, Sliding Window, etc.

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

This plugin is **fully self-contained**:

- **Pure Obsidian Plugin** - TypeScript/React UI
- **Direct AI API Integration** - Makes API calls directly from the plugin
- **No Backend Required** - Everything runs within Obsidian

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

