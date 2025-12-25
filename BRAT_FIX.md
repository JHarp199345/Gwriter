# BRAT Configuration Fix

## The Problem

BRAT was pulling from the **GitHub Release v0.1.0** (created 4 days ago when you first submitted to Obsidian) instead of the `main` branch. That release contains old files with version 0.1.0.

## The Solution

You have **two options**:

### Option 1: Configure BRAT to Use the `main` Branch (Recommended)

1. In Obsidian: **Settings → Community Plugins → BRAT**
2. Find your plugin in the list: `writing-dashboard` or `JHarp199345/Gwriter`
3. Click on it to edit the configuration
4. Make sure:
   - **Repository**: `JHarp199345/Gwriter`
   - **Branch**: `main` (NOT a release tag like `v0.1.0`)
   - **Plugin folder**: `obsidian-plugin`
5. Click **"Update plugins"** or **"Re-read plugin list"**
6. Restart Obsidian

BRAT will now pull directly from the `main` branch, which has version 0.2.0 and all your latest changes.

### Option 2: Create a New Release v0.2.0

If you want BRAT to continue using releases (or if that's required), create a new release:

1. **Make sure all changes are committed and pushed**:
   ```bash
   git status  # Should show nothing or only untracked files
   ```

2. **Build the plugin**:
   ```bash
   cd obsidian-plugin
   npm run build
   ```

3. **Commit the built files** (if not already):
   ```bash
   git add obsidian-plugin/main.js
   git commit -m "Build plugin for v0.2.0 release"
   git push origin main
   ```

4. **Create a new GitHub release**:
   - Go to: https://github.com/JHarp199345/Gwriter/releases/new
   - Tag version: `v0.2.0` (or `0.2.0`)
   - Release title: `Writing Dashboard v0.2.0`
   - Description: Update from v0.1.0 release notes
   - **Important**: Select "main" as the target branch
   - Click "Publish release"
   - GitHub will automatically include the files from `obsidian-plugin/` folder

5. **Update BRAT**:
   - In BRAT settings, change the branch/tag to `v0.2.0` (or keep as `main` if Option 1)
   - Click "Update plugins"
   - Restart Obsidian

## Which Option Should You Use?

**Option 1 (main branch)** is better because:
- ✅ You don't need to create a release every time you make changes
- ✅ BRAT will automatically pick up updates when you push to main
- ✅ Faster workflow for development and testing

**Option 2 (releases)** is better if:
- You want to control exactly which versions BRAT users get
- You prefer a more formal release process
- You're sharing the BRAT link with others and want stability

## Quick Check: Which Is BRAT Currently Using?

To see what BRAT is currently configured to use:
1. Go to **Settings → Community Plugins → BRAT**
2. Look at your plugin entry
3. Check the branch/tag field

If it says something like `v0.1.0` or `0.1.0`, that's why you're getting the old version!
Change it to `main` to get the latest code.

## Verification

After fixing, verify:
1. Plugin version shows `0.2.0` in Obsidian settings
2. Your latest features (button groups, file tree picker, etc.) are present
3. The plugin works as expected

