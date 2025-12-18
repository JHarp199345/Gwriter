# Quick Setup Guide

## Step 1: Install Python Backend

```bash
cd backend
pip install -r requirements.txt
```

Then start the server:
```bash
python main.py
# Or use the script:
# ./start.sh (Mac/Linux)
# start.bat (Windows)
```

The server will run on `http://localhost:8000`

## Step 2: Build Obsidian Plugin

```bash
cd obsidian-plugin
npm install
npm run build
```

This creates `main.js` which is the compiled plugin.

## Step 3: Install Plugin in Obsidian

### Option A: Manual Installation

1. Copy the entire `obsidian-plugin` folder to your vault's `.obsidian/plugins/` directory
2. Rename it to `writing-dashboard`
3. Restart Obsidian

### Option B: Development Mode

1. Create a symlink from your vault's `.obsidian/plugins/writing-dashboard` to this `obsidian-plugin` folder
2. Run `npm run dev` in the plugin folder for watch mode
3. Reload Obsidian (Ctrl+R / Cmd+R)

## Step 4: Configure

1. Open Obsidian Settings
2. Go to **Writing Dashboard** settings
3. Enter your API key
4. Configure file paths to match your vault structure
5. Ensure Python backend URL is correct (default: `http://localhost:8000`)

## Step 5: Use It!

1. Click the book icon in the ribbon, or
2. Use Command Palette: "Open Writing Dashboard"
3. Select your mode (Chapter/Micro-Edit/Character Update)
4. Start writing!

## Troubleshooting

### "Backend not connected"
- Make sure Python backend is running
- Check the URL in settings
- Try accessing `http://localhost:8000/health` in your browser

### "Module not found" errors
- Run `npm install` in the plugin folder
- Run `pip install -r requirements.txt` in the backend folder

### Plugin doesn't appear
- Check that `main.js` exists in the plugin folder
- Ensure the folder is named `writing-dashboard` in `.obsidian/plugins/`
- Check Obsidian console for errors (Ctrl+Shift+I)

