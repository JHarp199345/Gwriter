# Publishing to Obsidian Community Plugins

This guide will help you publish Writing Dashboard to Obsidian's community plugin browser.

## Architecture at a Glance

Writing Dashboard is a **fully self-contained Obsidian plugin**. 

- **Local Processing**: All story logic, character extraction, and RAG (Retrieval-Augmented Generation) indexing occur locally within Obsidian.
- **Direct AI Integration**: The plugin makes direct HTTPS calls to supported AI providers (OpenAI, Anthropic, Gemini, OpenRouter).
- **No Server Required**: Users do not need to host a separate backend or database.

> **Note**: All generation and auditing now occurs inside the Obsidian plugin.

## Prerequisites

- ✅ GitHub repository (you have: https://github.com/JHarp199345/Gwriter)
- ✅ Plugin is built (`main.js` exists)
- ✅ `manifest.json` is properly configured
- ✅ `README.md` in the plugin folder

## Step 1: Prepare the Plugin for Release

### Build the Plugin

```bash
cd obsidian-plugin
npm install
npm run build
```

This creates `main.js` which needs to be included in the release.

### Commit Built Files

For community plugins, you typically commit `main.js` so Obsidian can install directly from GitHub:

```bash
cd obsidian-plugin
git add main.js
git commit -m "Add built plugin for community release"
git push
```

## Step 2: Create a GitHub Release

1. Go to your GitHub repository: https://github.com/JHarp199345/Gwriter
2. Click "Releases" → "Create a new release"
3. Tag version: `v1.0.4` (incremental from your current version)
4. Release title: `Writing Dashboard v1.0.4`
5. Description: Copy from the plugin README
6. Upload `obsidian-plugin/main.js`, `obsidian-plugin/manifest.json`, and `obsidian-plugin/styles.css` as release assets.
7. Click "Publish release"

## Step 3: Submit to Obsidian Community Plugins

### Option A: Direct GitHub Installation (via BRAT)

Users can install directly from GitHub using the BRAT plugin:

1. In Obsidian: Install **BRAT** from community plugins.
2. In BRAT: Add `JHarp199345/Gwriter` as a beta plugin.
3. Specify `obsidian-plugin` as the folder if prompted.

### Option B: Official Community Plugin List

To get listed in Obsidian's official community plugin browser:

1. **Prepare your plugin:**
   - Ensure `main.js`, `manifest.json`, and `styles.css` are in the `obsidian-plugin` folder in the `main` branch.
   - Ensure `manifest.json` has correct `id`, `name`, `version`, `author`.

2. **Submit via Pull Request:**
   - Fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases).
   - Add your plugin to `community-plugins.json`.
   - Submit a PR.
   - The Obsidian team will review your plugin.

## Step 4: Update Version for Future Releases

When you want to release a new version:

1. Update `manifest.json` version number.
2. Build the plugin: `npm run build`.
3. Commit and push.
4. Create a new GitHub release with the new version tag.

## Important Note for Legacy Users

The `backend/` folder in the repository is legacy code and is no longer required for the plugin to function. It has been moved to `legacy/backend/` for historical reference.
