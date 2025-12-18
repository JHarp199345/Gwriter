# Publishing to Obsidian Community Plugins

This guide will help you publish Writing Dashboard to Obsidian's community plugin browser.

## Prerequisites

- ✅ GitHub repository (you have: https://github.com/JHarp199345/Gwriter)
- ✅ Plugin is built (`main.js` exists)
- ✅ `manifest.json` is properly configured
- ✅ `README.md` in the plugin folder

## Step 1: Prepare the Plugin for Release

### Build the Plugin

```bash
cd obsidian-plugin
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

**Note:** Some developers prefer to only include built files in releases. Both approaches work.

## Step 2: Create a GitHub Release

1. Go to your GitHub repository: https://github.com/JHarp199345/Gwriter
2. Click "Releases" → "Create a new release"
3. Tag version: `obsidian-plugin-v1.0.0`
4. Release title: `Writing Dashboard v1.0.0`
5. Description: Copy from the plugin README
6. Upload `obsidian-plugin/main.js` and `obsidian-plugin/styles.css` as release assets
7. Or create a zip with: `manifest.json`, `main.js`, `styles.css`, `README.md`
8. Click "Publish release"

## Step 3: Submit to Obsidian Community Plugins

### Option A: Direct GitHub Installation (Easier)

Users can install directly from GitHub:

1. In Obsidian: Settings → Community Plugins → Browse
2. Click "..." (three dots) → "Install from URL"
3. Enter: `https://github.com/JHarp199345/Gwriter`
4. Obsidian will find the plugin in the `obsidian-plugin` folder

### Option B: Official Community Plugin List (More Visibility)

To get listed in Obsidian's official community plugin browser:

1. **Prepare your plugin:**
   - Ensure `main.js` is in the repo (or in releases)
   - Ensure `manifest.json` has correct `id`, `name`, `version`, `author`
   - Ensure `README.md` exists in the plugin folder

2. **Submit via Obsidian's process:**
   - Go to Obsidian's community plugin submission (usually through their Discord or forum)
   - Provide:
     - Repository URL: `https://github.com/JHarp199345/Gwriter`
     - Plugin folder: `obsidian-plugin`
     - Description: Brief description of what the plugin does
     - Requirements: Mention the Python backend requirement

3. **Wait for review:**
   - Obsidian team will review your plugin
   - They may ask for changes or clarifications
   - Once approved, it appears in the community plugin browser

## Step 4: Update Version for Future Releases

When you want to release a new version:

1. Update `manifest.json` version number
2. Update `package.json` version (if needed)
3. Build the plugin: `npm run build`
4. Commit changes
5. Create a new GitHub release with the new version tag
6. Push to GitHub

## Important Notes

### Python Backend Requirement

Since this plugin requires a Python backend, make sure to:

- **Clearly document** this requirement in the README
- **Provide setup instructions** for the backend
- **Consider** creating a simple installer script or documentation

### Plugin Structure

For community installation, Obsidian expects:
```
obsidian-plugin/
├── manifest.json    ✅ Required
├── main.js          ✅ Required (built file)
├── styles.css        ✅ Required (if you have styles)
└── README.md        ✅ Recommended
```

## Alternative: Standalone Plugin Repository

If you want the plugin to be installable directly (without the backend repo), you could:

1. Create a separate repository just for the plugin
2. Include only the `obsidian-plugin` folder contents
3. Include built `main.js` in the repo
4. Submit that repository to Obsidian

This makes it cleaner for users who only want the plugin, but requires maintaining two repos.

## Current Status

Your plugin is ready for community installation! Users can:

1. Install from GitHub URL directly in Obsidian
2. Or you can submit it to the official community plugin list for broader visibility

The Python backend requirement is clearly documented, so users will know they need to set that up separately.

