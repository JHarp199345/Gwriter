# BRAT Troubleshooting Guide

## How BRAT Works

BRAT (Beta Reviewer's Auto-update Tool) installs plugins directly from GitHub repositories. It caches plugin files and checks for updates based on the `manifest.json` version number.

## Why You're Seeing an Old Version

**Root Cause**: BRAT caches plugin files and only updates when:
1. The `version` field in `manifest.json` changes, OR
2. You manually force a re-read in BRAT

## Step-by-Step Diagnosis & Fix

### Step 1: Check Your BRAT Configuration

1. Open Obsidian Settings → **Community Plugins**
2. Find **BRAT** in the list and open its settings
3. Check:
   - **Repository URL**: Should be `JHarp199345/Gwriter` (or `https://github.com/JHarp199345/Gwriter`)
   - **Branch**: Should be `main` (or `master` if that's your default branch)
   - **Plugin path/folder**: Should be `obsidian-plugin` (this is critical!)

### Step 2: Force BRAT to Re-read the Repository

**Option A: Through BRAT Settings**
1. Go to Settings → Community Plugins → BRAT
2. Click **"Update plugins"** or **"Re-read plugin list"** button
3. Wait for it to complete
4. Restart Obsidian

**Option B: Manually Clear BRAT Cache**
1. Close Obsidian completely
2. Navigate to your vault's `.obsidian/plugins/` folder
3. Find the `brat` folder
4. Delete or rename the cache folder inside (if it exists)
5. Reopen Obsidian
6. Go to BRAT settings and click "Update plugins"

**Option C: Uninstall and Reinstall via BRAT**
1. In BRAT settings, find your plugin in the list
2. Click **"Remove plugin"** or uninstall it
3. Add it again with the correct settings:
   - Repo: `JHarp199345/Gwriter`
   - Branch: `main`
   - Folder: `obsidian-plugin`
4. Click **"Add plugin"**

### Step 3: Update the Version Number (Recommended)

BRAT uses the `version` field in `manifest.json` to detect updates. Update it to force a refresh:

1. **Edit `obsidian-plugin/manifest.json`**
   ```json
   {
     "version": "0.2.0",  // ← Increment this
   }
   ```

2. **Commit and push to GitHub**
   ```bash
   git add obsidian-plugin/manifest.json
   git commit -m "Bump version to 0.2.0 for BRAT update"
   git push origin main
   ```

3. **In BRAT, click "Update plugins"**
   - BRAT will detect the version change and download the new files

### Step 4: Verify the Correct Files Are Being Read

Check what BRAT is actually reading from GitHub:

1. Go to: `https://github.com/JHarp199345/Gwriter/tree/main/obsidian-plugin`
2. Verify:
   - ✅ `manifest.json` exists
   - ✅ `main.js` exists (the built plugin file)
   - ✅ `styles.css` exists
   - ✅ These files are up-to-date

### Step 5: Check Plugin Installation Path

1. Go to your vault's `.obsidian/plugins/` folder
2. Find the `writing-dashboard` folder
3. Check:
   - Does `main.js` match the latest build?
   - Does `manifest.json` show the correct version?
   - Check file timestamps - are they recent?

### Step 6: Common BRAT Issues & Solutions

**Issue: "Plugin not found"**
- **Fix**: Check that the folder path is `obsidian-plugin` (not `obsidian-plugin/` or `/obsidian-plugin`)

**Issue: "Old version still loading"**
- **Fix**: Update `manifest.json` version number and re-read in BRAT

**Issue: "Changes not appearing"**
- **Fix**: Make sure `main.js` is committed to GitHub (BRAT needs the built file)

**Issue: "Wrong branch"**
- **Fix**: Ensure BRAT is pointing to the `main` branch (not `master` or a feature branch)

## Quick Fix Command (If You Have Terminal Access)

```bash
# Navigate to your vault's plugins folder
cd "path/to/your/vault/.obsidian/plugins"

# Remove the old plugin installation
rm -rf writing-dashboard  # On Windows: rmdir /s writing-dashboard

# Then in Obsidian:
# 1. Go to BRAT settings
# 2. Click "Update plugins"
# 3. Or re-add the plugin manually
```

## Verification Checklist

After following the steps above, verify:

- [ ] `manifest.json` version number is incremented
- [ ] Latest `main.js` is committed and pushed to GitHub
- [ ] BRAT repository path is: `JHarp199345/Gwriter`
- [ ] BRAT branch is: `main`
- [ ] BRAT plugin folder is: `obsidian-plugin`
- [ ] BRAT has been told to "Update plugins"
- [ ] Obsidian has been restarted
- [ ] Plugin folder `.obsidian/plugins/writing-dashboard/` has recent files

## Alternative: Manual Installation (Temporary Workaround)

If BRAT continues to have issues, you can manually install the latest version:

1. Download the latest `main.js` from: `https://github.com/JHarp199345/Gwriter/raw/main/obsidian-plugin/main.js`
2. Download `manifest.json` from: `https://github.com/JHarp199345/Gwriter/raw/main/obsidian-plugin/manifest.json`
3. Download `styles.css` from: `https://github.com/JHarp199345/Gwriter/raw/main/obsidian-plugin/styles.css`
4. Place them in: `.obsidian/plugins/writing-dashboard/`
5. Restart Obsidian

Note: This bypasses BRAT's auto-update, so you'll need to manually update each time.

