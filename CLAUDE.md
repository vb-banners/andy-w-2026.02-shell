# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HTML5 banner development template using Gulp, Pug templating, Sass, and GSAP animation. Each project produces self-contained banner HTML files for ad networks.

## Requirements

- Node.js >= 18.0.0

## Commands

```bash
npm run dev          # Start dev server (localhost:9000) with file watching
npm run dev:build    # Clean rebuild + dev server
npm run build        # Full rebuild without dev server
npm run zip          # Build + create delivery zip packages
npm run ftp          # Build, zip, and upload to configured FTP server
npm run verify:images  # Verify all banner images exist and are referenced
```

## Architecture

### Directory Structure
```
src/
├── global/           # Shared templates and assets
│   ├── master.pug    # Base HTML template all banners extend
│   ├── preview.pug   # Preview page template with controls
│   ├── vars.pug      # Project variables, colors, mixins (see structure below)
│   ├── set.pug       # Set-specific variables
│   ├── resources.pug # Code snippets and reference patterns (not compiled)
│   └── plugins/      # GSAP plugins (minified)
└── sizes/            # Individual banner directories
    ├── index.pug     # Preview page showing all banners
    └── {set}-{size}/ # Banner folder (e.g., shell-fleet-solutions-300x250/)
        ├── index.pug # Banner template
        └── *.jpg/png # Banner-specific images
```

### vars.pug Structure (top to bottom)
```
1. PROJECT CONFIGURATION  - mainSet, logoLink, footer from banner.config.js
2. SETS                   - Set definitions using mainSet (edited per project)
3. MIXINS - Header        - Header mixin with setsline navigation
4. COLORS                 - Light/dark theme color variables
5. MIXINS - Banner Iframes, Style Blocks, Navigation, Controls
6. EFFECTS                - Shimmer, Spinner, Shadows
7. TIMING                 - Animation timing constants
```
Most-edited sections are at the top for easy access.

### Banner Template Structure

Each banner in `src/sizes/{name}/index.pug`:
```pug
extends ../../global/master
include ../../global/set

block size
    - var width = '300', height = '250'

block svg
    // SVG elements go here

block js
    script.
        // GSAP animation code
        let master = gsap.timeline({...})
        // ... animation sequence
        window.exposeMaster && window.exposeMaster(master);
```

Key points:
- `block size` sets dimensions (used for meta tags and viewBox)
- `block svg` contains SVG elements inside the main viewBox
- `block js` contains GSAP animation - always call `exposeMaster(master)` at the end
- All positioning uses SVG coordinates, not CSS

### Project Configuration

Settings are centralized in `banner.config.js`:
```javascript
module.exports = {
    project: { name: 'shell' },           // Used for zip naming
    paths: { build: './build.nosync' },   // Output directories
    server: { port: 9000 },               // Dev server settings
    features: {
        enableAutoZip: false,             // Auto-rebuild zips on change
        skipInitialBuild: true            // Skip full build on dev start
    },
    timing: { ... }                       // Debounce intervals
}
```

### FTP Configuration

Create `.env` file from template for deployment:
```bash
cp .env.example .env
```

Configure credentials in `.env`:
```
FTP_HOST=your-host.com
FTP_USER=username
FTP_PASSWORD=password
FTP_PORT=22
FTP_REMOTE_PATH=/path/to/banners
FTP_PUBLIC_URL=https://example.com/banners
```

Set `DEBUG=true` in `.env` for verbose logging.

## GSAP Animation Patterns

Available plugins (loaded via inline include in master.pug):
- gsap core (loaded from CDN)
- DrawSVGPlugin, MorphSVGPlugin, CustomEase, SplitText

Common pattern for looping banners:
```javascript
let loop = 0, loopMax = 2,
master = gsap.timeline({delay: 0.25, repeat: loopMax - 1, defaults: {duration: 1, ease: expo}})
    .from('.element', {...})
    .to('.element', {...})
    .call(() => {loop++; loop < loopMax ? master.play() : master.pause()}, null, 14.5)
;
```

## Creating New Banners

1. Duplicate an existing size folder in `src/sizes/`
2. Rename to `{set}-{name}-{width}x{height}`
3. Update `block size` with new dimensions
4. Update `block svg` with new elements
5. Update `block js` with new animation
6. Add to `src/sizes/index.pug` preview using `+iframe(set, 'WIDTHxHEIGHT')`

## Excluding Banners from Build

Prefix folder name with underscore (e.g., `_shell-draft-300x250`) to exclude from build.

## Build Output

- `build.nosync/` - Compiled HTML, CSS, assets (gitignored)
- `build.nosync/{size}.zip` - Individual banner zips
- `build.nosync/{set}-all-banners.zip` - All banners combined
- `build.nosync/{set}-whole-package.zip` - Banners + preview page
