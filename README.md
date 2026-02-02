# HTML5 Banner Development Template

A Gulp-based development environment for creating animated HTML5 banners using Pug, Sass, and GSAP.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template and configure FTP (optional)
cp .env.example .env

# Start development server
npm run dev
```

Open http://localhost:9000 to preview banners.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run dev:build` | Clean rebuild + dev server |
| `npm run build` | Full rebuild without server |
| `npm run zip` | Build and create delivery packages |
| `npm run ftp` | Build, zip, and upload to FTP |

## Project Structure

```
src/
├── global/           # Shared templates
│   ├── master.pug    # Base banner template
│   ├── vars.pug      # Variables, colors, mixins
│   ├── preview.pug   # Preview page template
│   └── plugins/      # GSAP plugins
└── sizes/            # Individual banners
    └── {name}-{WxH}/ # Banner folder (e.g., shell-thinking-300x250)
        ├── index.pug # Banner template
        └── *.jpg/png # Assets
```

## Configuration

Edit `banner.config.js` to customize:
- Project name (used for zip naming)
- Server port and settings
- Build feature flags (auto-zip, skip initial build)
- Timing constants

## Creating a New Banner

1. Duplicate an existing folder in `src/sizes/`
2. Rename to `{set}-{name}-{width}x{height}`
3. Edit `index.pug`:
   - Update `block size` with dimensions
   - Update `block svg` with elements
   - Update `block js` with GSAP animation
4. Add to preview: edit `src/sizes/index.pug`

## FTP Deployment

Configure credentials in `.env` (see `.env.example`):

```bash
FTP_HOST=your-host.com
FTP_USER=username
FTP_PASSWORD=password
FTP_REMOTE_PATH=/path/to/banners
```

Then run: `npm run ftp`

## Excluding Banners

Prefix folder name with underscore to exclude from build:
```
src/sizes/_draft-300x250/  # Excluded
src/sizes/final-300x250/   # Included
```
