# Quick Setup Guide

## Step 1: Build Obsidian Plugin

```bash
cd obsidian-plugin
npm install
npm run build
```

This creates `main.js` which is the compiled plugin.

## Step 2: Install Plugin in Obsidian

### Option A: Manual Installation

1. Copy the entire `obsidian-plugin` folder to your vault's `.obsidian/plugins/` directory
2. Rename it to `writing-dashboard`
3. Restart Obsidian

### Option B: Development Mode

1. Create a symlink from your vault's `.obsidian/plugins/writing-dashboard` to this `obsidian-plugin` folder
2. Run `npm run dev` in the plugin folder for watch mode
3. Reload Obsidian (Ctrl+R / Cmd+R)

### Option C: Install from GitHub (Recommended)

1. In Obsidian: Settings → Community Plugins → Browse
2. Click "..." (three dots) → "Install from URL"
3. Enter: `https://github.com/JHarp199345/Gwriter`
4. Obsidian will find the plugin in the `obsidian-plugin` folder

## Step 3: Configure

1. Open Obsidian Settings
2. Go to **Writing Dashboard** settings
3. Enter your API key (OpenAI, Anthropic, Gemini, or OpenRouter)
4. Select your API provider and model
5. Configure file paths to match your vault structure:
   - Book Main Path (any file name is fine; e.g., `Book - MAIN 2.md`)
   - Story Bible Path (e.g., `Book - Story Bible.md`)
   - Sliding Window Path (e.g., `Memory - Sliding Window.md`)
   - Character Folder (e.g., `Characters`)
   - Extractions Path (optional)

## Step 4: Run Setup Wizard (Optional)

1. In Settings → Writing Dashboard, click **"Run Setup Wizard"**
2. Select which files/folders to create
3. The wizard will create default structure for your writing workspace

## Step 5: Use It!

1. Click the book icon in the ribbon, or
2. Use Command Palette (`Cmd+P` / `Ctrl+P`): "Open Writing Dashboard"
3. Select your mode (Chapter Generate / Micro Edit / Character Update)
4. Start writing!

## Troubleshooting

### "API Key not configured"
- Go to Settings → Writing Dashboard
- Enter your API key from your chosen provider
- Ensure the API key is valid and has credits/quota

### "Module not found" errors
- Run `npm install` in the `obsidian-plugin` folder
- Ensure Node.js is installed

### Plugin doesn't appear
- Check that `main.js` exists in the plugin folder
- Ensure the folder is named `writing-dashboard` in `.obsidian/plugins/`
- Check Obsidian console for errors (Ctrl+Shift+I / Cmd+Option+I)
- Try restarting Obsidian

### API Errors
- Verify your API key is correct
- Check your API provider account for rate limits
- Ensure the model name matches your provider
- Check your internet connection

### File Not Found Errors
- Verify file paths in settings match your vault structure
- Ensure files exist at the specified paths
- Use the Setup Wizard to create default files
- Check vault path is correct

### Smart Connections Not Working
- Smart Connections is optional but enhances context
- If installed, ensure it has indexed your vault
- Book 1 content can also be loaded from chunked folders or files
- Look for folders like `Book 1 - Chunked` or files with "Book 1" in the name
