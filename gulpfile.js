// Load environment variables from .env file (if present)
try { require('dotenv').config() } catch (_) { /* dotenv not installed, using defaults */ }

// Load centralized configuration
const config = require('./banner.config.js')

// Debug mode - enable verbose logging
const DEBUG = process.env.DEBUG === 'true'

// Project name (used for zip naming)
const set = config.project.name

// Feature flags from config
const enableAutoZip = config.features.enableAutoZip
const skipInitialBuild = config.features.skipInitialBuild

// Paths from config
const PATHS = config.paths
const TIMING = config.timing

const { series, parallel, src, dest, watch } = require('gulp')
const pug = require('gulp-pug')
const gulpPugBeautify = require('gulp-pug-beautify')
const sass = require('gulp-sass')(require('sass'))
const prefix = require('gulp-autoprefixer')
const csscomb = require('gulp-csscomb')
const path = require('path')
const { exec, spawn } = require('child_process')
// del@6+ is ESM-only; wrap dynamic import for CJS gulpfile
const del = async (patterns, options) => {
    const m = await import('del');
    const fn = m.deleteAsync || m.default;
    return fn(patterns, options);
}
const zip = require('gulp-zip')
const foreach = require('gulp-foreach')
const size = require('gulp-size')
const cache = require('gulp-cached')
const newer = require('gulp-newer')
const plumber = require('gulp-plumber')
const browserSync = require('browser-sync').create()
// FTP deps are loaded lazily so non-FTP tasks don't require them
async function lazyRequire(name) {
    const m = await import(name).catch(() => null)
    if (!m) {
        throw new Error(`Missing dependency: ${name}. Install with: npm i -D ${name}`)
    }
    return m.default || m
}

// Helper for safe execution with optional logging
function safeExecute(fn, context = 'unknown') {
    try {
        return fn()
    } catch (err) {
        if (DEBUG) console.warn(`[${context}]`, err.message)
        return undefined
    }
}

// Helper to safely reload browser (consolidates repeated try/catch pattern)
function reloadBrowser(silent = false) {
    try {
        if (browserSync && browserSync.active) {
            browserSync.reload()
            return true
        }
    } catch (err) {
        if (!silent && DEBUG) console.warn('[browserSync]', err.message)
    }
    return false
}

// Try to copy text to clipboard, using clipboardy if available or OS tools.
function copyToClipboard(text) {
    (async () => {
        try {
            const clipboardy = await lazyRequire('clipboardy')
            if (clipboardy && clipboardy.write) await clipboardy.write(text)
            else if (clipboardy && clipboardy.default && clipboardy.default.write) await clipboardy.default.write(text)
            return
        } catch (_) {}
        try {
            if (process.platform === 'darwin') {
                const p = spawn('pbcopy')
                p.stdin.end(text)
            } else if (process.platform === 'win32') {
                const p = spawn('clip')
                p.stdin.end(text)
            } else {
                const p = spawn('sh', ['-c', 'xclip -selection clipboard || xsel --clipboard --input'])
                p.stdin.end(text)
            }
        } catch (_) {
            // ignore copy failures silently
        }
    })()
}

// Try to open a URL or local file in the default browser (best-effort)
// Uses spawn with array args to prevent shell injection
function openInBrowser(target) {
    try {
        const isMac = process.platform === 'darwin'
        const isWin = process.platform === 'win32'

        if (isMac) {
            spawn('open', [target], { stdio: 'ignore', detached: true }).unref()
        } else if (isWin) {
            spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore', detached: true }).unref()
        } else {
            spawn('xdg-open', [target], { stdio: 'ignore', detached: true }).unref()
        }
    } catch (err) {
        if (DEBUG) console.warn('[browser] Failed to open:', err.message)
    }
}

// Force-reload a local preview tab when BrowserSync isn't available (macOS AppleScript)
function hardReload(cb) {
    const done = () => { if (cb) cb(); };
    // If BrowserSync is running, prefer its reload (fast, cross‑platform)
    if (reloadBrowser(true)) return done();

    if (process.platform !== 'darwin') { console.log('Hard reload (AppleScript) only on macOS'); return done(); }

    const script = `
    set targetFound to false
    tell application "Google Chrome"
        if (count of windows) > 0 then
            activate
            repeat with w in windows
                set ti to 0
                repeat with t in tabs of w
                    set ti to ti + 1
                    try
                        set u to URL of t
                    on error
                        set u to ""
                    end try
                    if u contains "localhost:" or u contains "127.0.0.1:" or u contains "file:///" then
                        set active tab index of w to ti
                        tell t to reload
                        set targetFound to true
                        exit repeat
                    end if
                end repeat
                if targetFound then exit repeat
            end repeat
            if (not targetFound) then
                tell active tab of front window to reload
            end if
        end if
    end tell`;

    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
        if (err) {
            // Safari fallback
            const safariScript = `tell application "Safari" to if (count of windows) > 0 then tell current tab of front window to do JavaScript "location.reload(true)"`;
            exec(`osascript -e '${safariScript}'`, () => done());
            return;
        }
        done();
    });
}

let serve = (cb) => {
    browserSync.init({
        server: {
            baseDir: PATHS.build + '/',
        },
        tunnel: false,
        notify: config.server.notify,
        host: config.server.host,
        port: config.server.port,
        logPrefix: config.server.logPrefix,
        open: config.server.open
    });
    cb();
}

function reload(cb) {
    // Try BrowserSync first, then hardReload (AppleScript on macOS)
    if (reloadBrowser(true)) return cb();
    return hardReload(cb);
}

// --- Async zip scheduler for dev ---
let __zipRunning = false;
let __zipScheduled = false;
let __zipTimer = null;
function runZipOnce(cb) {
    if (!enableAutoZip) {
        console.log('[runZipOnce] Skipped - enableAutoZip is false')
        if (cb) cb()
        return
    }
    console.log('[runZipOnce] Running zip tasks - enableAutoZip is true')
    // After zipping and writing sizes, refresh the browser so preview updates
    series(buildZip, writeZipSizes, reload)((err) => {
        if (err) console.error('[zip error]', err)
        if (cb) cb(err)
    })
}
function scheduleZip(reason) {
    if (!enableAutoZip) {
        console.log('[scheduleZip] Skipped - enableAutoZip is false, reason:', reason)
        return
    }
    console.log('[scheduleZip] Scheduling zip, reason:', reason)
    clearTimeout(__zipTimer)
    __zipTimer = setTimeout(() => runZipOnce(), TIMING.zipDebounce);
}

let buildPug = () => {
    return src(['./src/sizes/**/*.pug', '!src/sizes/_*/*.pug', '!src/sizes/_*.pug'])
        .pipe(plumber())
        .pipe(cache('pug'))  // Cache by content to skip unchanged files
        .pipe(pug({ pretty: true }))
        // Temporarily disabled due to truncation issue
        // .pipe(gulpPugBeautify({
        //     omit_empty: true,
        //     fill_tab: false,
        //     tab_size: 4
        // }))
        .pipe(dest('./build.nosync/'))
        .pipe(browserSync.stream())
}

let buildGlobalPug = () => {
    // Global templates are not compiled directly - they're used by size templates
    // This task triggers when global templates change to rebuild size templates
    // Clear cache to force rebuild when dependencies change
    cache.caches = {};
    return buildPug()
}

let buildSass = () => {
    return src(['./src/sizes/**/*.sass', '!src/sizes/_*/*.sass'])
        .pipe(plumber())
        .pipe(cache('sass'))  // Cache by content to skip unchanged files
        .pipe(sass())
        .pipe(prefix())
        .pipe(csscomb())
        .pipe(dest('./build.nosync/'))
        .pipe(browserSync.stream())
}

let buildGlobalSass = () => {
    // Global sass impacts all sizes - just rebuild all sass
    return buildSass()
}

let buildImg = () => {
    const destDir = './build.nosync/'
    return src(
        [
            './src/sizes/**/*.{jpg,png,gif,svg,webp}', 
            './src/global/**/*.{jpg,png,gif,svg,webp}',
            '!src/sizes/_*/*.{jpg,png,gif,svg,webp}',
            '!src/global/_*/*.{jpg,png,gif,svg,webp}'
        ],
        { buffer: true, encoding: false }
    )
        .pipe(newer(destDir))
        .pipe(dest(destDir))
}

let buildJs = () => {
    const destDir = './build.nosync/'
    return src(
        [
            './src/sizes/**/*.js',
            './src/global/**/*.js',
            '!src/sizes/_*/*.js',
            '!src/global/_*/*.js',
            '!src/global/plugins/*.js' // Exclude plugins as they're handled separately
        ],
        { buffer: true }
    )
        .pipe(newer(destDir))
        .pipe(dest(destDir))
}

let imageClean = () => del(['./build.nosync/**/*.{jpg,png,gif,svg,webp}']) // Delete image files from build folder

let jsClean = () => del(['./build.nosync/**/*.js', '!./build.nosync/banner-sizes.js']) // Delete JS files from build folder (except banner-sizes.js)

let buildClean = () => del(['./build.nosync/**/*']) // Delete all files from build folder

let exportClean = () => del(['./export.nosync']) // Delete zip files from export folder

let zipClean = () => del(['./build.nosync/*.zip']) // Delete zip files from build folder

let allZipsClean = () => del(['./build.nosync/*.zip', './export.nosync']) // Delete all zip files and export folder

// ---- Zip caching helpers ----
const fs = require('fs')
const crypto = require('crypto')

function ensureDirSync(d) { try { fs.mkdirSync(d, { recursive: true }) } catch (_) {} }

function computeDirHashSync(dir) {
    const base = dir.replace(/\\/g, '/')
    const h = crypto.createHash('md5')
    const stack = ['']
    while (stack.length) {
        const sub = stack.pop()
        const full = path.join(base, sub)
        const entries = fs.readdirSync(full, { withFileTypes: true })
        for (const e of entries) {
            if (e.name === '.DS_Store' || /Thumbs\.db$/i.test(e.name) || /\.zip$/i.test(e.name)) continue
            const rel = sub ? path.posix.join(sub, e.name) : e.name
            const p = path.join(base, rel)
            const st = fs.statSync(p)
            if (e.isDirectory()) {
                stack.push(rel)
                h.update('D:' + rel)
            } else {
                h.update('F:' + rel + ':' + st.size + ':' + st.mtimeMs)
            }
        }
    }
    return h.digest('hex')
}

// Compute total size (bytes) of a directory recursively
function computeDirSizeSync(dir) {
    let total = 0
    const stack = ['']
    const base = dir.replace(/\\/g, '/')
    while (stack.length) {
        const sub = stack.pop()
        const full = path.join(base, sub)
        let entries = []
        try { entries = fs.readdirSync(full, { withFileTypes: true }) } catch (_) { entries = [] }
        for (const e of entries) {
            // ignore common noise and zips inside folders
            if (e.name === '.DS_Store' || /Thumbs\.db$/i.test(e.name) || /\.zip$/i.test(e.name)) continue
            const rel = sub ? path.posix.join(sub, e.name) : e.name
            const p = path.join(base, rel)
            try {
                const st = fs.statSync(p)
                if (e.isDirectory()) stack.push(rel)
                else total += st.size || 0
            } catch (_) {}
        }
    }
    return total
}

function shouldZipDir(dirPath) {
    const cacheDir = path.resolve(__dirname, '.cache', 'zips')
    ensureDirSync(cacheDir)
    const dirName = path.basename(dirPath)
    const marker = path.join(cacheDir, dirName + '.hash')
    const current = computeDirHashSync(dirPath)
    let prev = null
    try { prev = fs.readFileSync(marker, 'utf8').trim() } catch (_) {}
    const changed = prev !== current
    // If build zip is missing, force creation regardless of hash cache
    const buildZipPath = path.resolve(__dirname, 'build.nosync', dirName + '.zip')
    const missingZip = !fs.existsSync(buildZipPath)
    if (changed) { try { fs.writeFileSync(marker, current) } catch (_) {} }
    return changed || missingZip
}

let buildZip = () => {
    console.log('[buildZip] CALLED! This should not happen when enableAutoZip=false')
    console.trace('[buildZip] Call stack trace:')
    return src(['build.nosync/*', '!build.nosync/*.zip'], { read: false, allowEmpty: true })
        .pipe(
            foreach((stream, file) => {
                const isDir = typeof file.isDirectory === 'function' ? file.isDirectory() : (file.stat && file.stat.isDirectory && file.stat.isDirectory())
                if (!isDir) return stream
                const dirPath = file.path
                const dirName = path.basename(dirPath)
                if (!shouldZipDir(dirPath)) return stream
                return src(`${dirPath.replace(/\\/g, '/')}/**/*`, { allowEmpty: true, encoding: false })
                    .pipe(zip(`${dirName}.zip`))
                    .pipe(size({ showFiles: true }))
                    .pipe(dest('build.nosync/'))
            })
        )
}

// Build pug files for a single size directory without cache (used on new dir/rename)
function buildPugFreshDir(dirName) {
    if (!dirName || dirName.startsWith('_')) return Promise.resolve();
    const glob = path.posix.join('src', 'sizes', dirName, '*.pug');
    return new Promise((resolve) => {
        src([glob], { allowEmpty: true })
            .pipe(plumber())
            .pipe(pug({ pretty: true }))
            .pipe(gulpPugBeautify({
                omit_empty: true,
                fill_tab: false,
                tab_size: 4
            }))
            .pipe(dest('./build.nosync/' + dirName + '/'))
            .on('end', () => {
                reloadBrowser(true)
                resolve();
            });
    });
}

// After zipping banners, compute zip sizes and write a manifest to build.nosync/sizes.json
function writeZipSizes(cb) {
    try {
        const base = path.resolve(__dirname, 'build.nosync');
        const out = { updatedAt: new Date().toISOString(), files: {} };
        let entries = [];
        try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { entries = []; }
        for (const e of entries) {
            try {
                if (!e.isFile()) continue;
                const name = e.name;
                if (!/\.zip$/i.test(name)) continue;
                if (/\-banners\.zip$/i.test(name)) continue; // skip aggregated banners zip
                const p = path.join(base, name);
                const st = fs.statSync(p);
                out.files[name] = st.size; // bytes
            } catch (_) {}
        }
        // Also compute sizes per banner folder (fallback when zip is not present)
        for (const e of entries) {
            try {
                if (!e.isDirectory()) continue;
                const dirName = e.name;
                // Consider only folders that look like banner builds (must contain index.html)
                const dirPath = path.join(base, dirName)
                if (!fs.existsSync(path.join(dirPath, 'index.html'))) continue;
                const key = dirName + '.zip'; // keep key format compatible with preview code
                if (out.files[key] == null) {
                    const bytes = computeDirSizeSync(dirPath)
                    out.files[key] = bytes
                }
            } catch (_) {}
        }
        // Create a JS file with the size data that can be loaded without CORS issues
        try {
            const sizeDataJs = `// Auto-generated by gulp writeZipSizes task
if (typeof window !== 'undefined') {
    window.BANNER_SIZES = ${JSON.stringify(out.files, null, 2)};
    window.BANNER_SIZES_UPDATED = '${out.updatedAt}';
    
    // Trigger size update if the function exists
    if (typeof window.applyBannerSizes === 'function') {
        window.applyBannerSizes();
    }
}`;
            fs.writeFileSync(path.join(base, 'banner-sizes.js'), sizeDataJs);
            console.log('Updated banner-sizes.js with actual file sizes');
        } catch (e) {
            console.log('Failed to create banner-sizes.js:', e.message);
        }
        
        // Note: Browser refresh removed from zip task - manual refresh required after zip
    } catch (e) {
        // non-fatal
    }
    cb && cb();
}

// Write a placeholder banner-sizes.js to avoid 404s during local dev before zips are generated
function writeBannerSizesPlaceholder(cb) {
    try {
        const base = path.resolve(__dirname, 'build.nosync');
        const outPath = path.join(base, 'banner-sizes.js');
        try { fs.mkdirSync(base, { recursive: true }); } catch (_) {}
        // Only create if missing; do not overwrite a real file created by writeZipSizes
        if (!fs.existsSync(outPath)) {
            const placeholder = `// Auto-generated placeholder (dev)
if (typeof window !== 'undefined') {
  window.BANNER_SIZES = window.BANNER_SIZES || {};
  window.BANNER_SIZES_UPDATED = window.BANNER_SIZES_UPDATED || '';
  if (typeof window.applyBannerSizes === 'function') window.applyBannerSizes();
}`;
            fs.writeFileSync(outPath, placeholder);
            console.log('Wrote placeholder build.nosync/banner-sizes.js');
        }
    } catch (e) {
        console.log('Failed to write placeholder banner-sizes.js:', e.message);
    }
    cb && cb();
}

let watchTask = () => {
    // When any size Pug changes or new pages/folders are added, rebuild ONLY that specific file
    const pugWatcher = watch('./src/sizes/**/*.pug')
    pugWatcher.on('change', (changedPath) => {
        const fileName = path.basename(changedPath)
        // Skip underscore-prefixed files (partials)
        if (fileName.startsWith('_')) {
            console.log(`[watch] Skipping partial: ${changedPath}`)
            return
        }
        
        const relativePath = path.relative(path.join(__dirname, 'src/sizes'), changedPath)
        const destPath = path.join(__dirname, 'build.nosync', relativePath).replace(/\.pug$/, '.html')
        
        src(changedPath)
            .pipe(plumber())
            .pipe(pug({ pretty: true }))
            .pipe(dest(path.dirname(destPath)))
            .on('end', () => {
                reloadBrowser(true)
                if (enableAutoZip) scheduleZip('pug file changed: ' + relativePath)
            })
    })
    
    // Global Pug impacts many pages; rebuild and schedule zipping
    watch('src/global/*.pug', enableAutoZip
        ? series(buildGlobalPug, (cb) => { scheduleZip('global pug changed'); cb(); })
        : series(buildGlobalPug)
    )

    watch('src/global/plugins/*.js', enableAutoZip
        ? series(buildGlobalPug, (cb) => { scheduleZip('global plugin changed'); cb(); })
        : series(buildGlobalPug)
    )

    // Watch for individual SASS file changes and compile only that file
    const sassWatcher = watch('./src/sizes/**/*.sass')
    sassWatcher.on('change', (changedPath) => {
        const fileName = path.basename(changedPath)
        // Skip underscore-prefixed files (partials/mixins)
        if (fileName.startsWith('_')) {
            console.log(`[watch] Skipping SASS partial: ${changedPath}`)
            return
        }
        
        const relativePath = path.relative(path.join(__dirname, 'src/sizes'), changedPath)
        const destPath = path.join(__dirname, 'build.nosync', relativePath).replace(/\.sass$/, '.css')
        
        console.log(`[watch] Processing single SASS file: ${relativePath}`)
        
        src(changedPath)
            .pipe(plumber())
            .pipe(sass())
            .pipe(prefix())
            .pipe(csscomb())
            .pipe(dest(path.dirname(destPath)))
            .on('end', () => {
                reloadBrowser(true)
                if (enableAutoZip) scheduleZip('sass file changed: ' + relativePath)
            })
    })
    watch('./src/global/*.sass', enableAutoZip
        ? series(buildGlobalSass, (cb) => { scheduleZip('global sass changed'); cb(); })
        : series(buildGlobalSass)
    )

    // Assets copied into build; schedule zipping afterwards
    const imgWatcher = watch(['./src/sizes/**/*.{jpg,png,gif,svg,webp}', './src/global/**/*.{jpg,png,gif,svg,webp}'], enableAutoZip
        ? series(buildImg, (cb) => { scheduleZip('assets changed'); cb(); }, reload)
        : series(buildImg, reload)
    )
    
    // JS files copied into build; schedule zipping afterwards
    const jsWatcher = watch(['./src/sizes/**/*.js', './src/global/**/*.js', '!./src/global/plugins/*.js'], enableAutoZip
        ? series(buildJs, (cb) => { scheduleZip('js files changed'); cb(); }, reload)
        : series(buildJs, reload)
    )
    
    // Helper to create unlink handlers for cleaning up build files
    const createUnlinkHandler = (fileType) => (srcFilePath) => {
        try {
            const relativePath = path.relative(path.resolve(__dirname, 'src'), srcFilePath)
            const buildFilePath = path.resolve(__dirname, 'build.nosync', relativePath.replace(/^sizes\//, ''))

            if (fs.existsSync(buildFilePath)) {
                fs.unlinkSync(buildFilePath)
                console.log(`[watch:unlink] Removed orphaned ${fileType}: ${buildFilePath}`)
                if (enableAutoZip) scheduleZip(`${fileType} deleted`)
                reloadBrowser(true)
            }
        } catch (e) {
            console.log(`[watch:unlink] Error cleaning up ${fileType}: ${e.message}`)
        }
    }

    // Watch for file deletions to clean up build artifacts
    imgWatcher.on('unlink', createUnlinkHandler('image'))
    jsWatcher.on('unlink', createUnlinkHandler('JS file'))

    // As a safety net, also watch build output and trigger zipping (ignore zips and manifest to avoid loops)
    // watch(['./build.nosync/**', '!build.nosync/*.zip', '!build.nosync/sizes.json'], () => scheduleZip('build changed'))

    // Watch for size folder additions/removals in src and clean corresponding build artifacts
    const dirWatcher = watch('./src/sizes/**', { ignoreInitial: true, depth: 1 })
    const removeBuildForDir = async (srcDir) => {
        try {
            const dirName = path.basename(srcDir)
            const targets = [
                path.resolve(__dirname, 'build.nosync', dirName),
                path.resolve(__dirname, 'build.nosync', dirName + '.zip')
            ]
            await del(targets, { force: true })
            // sizes.json removed - we only use banner-sizes.js now
            reloadBrowser(true)
        } catch (e) {
            // ignore
        }
    }
    dirWatcher.on('unlinkDir', (p) => {
        console.log('[watch:unlinkDir] directory removed:', path.basename(p))
        removeBuildForDir(p)
    })
    // If a new dir appears, schedule a zip pass after it builds and refresh watchers
    dirWatcher.on('addDir', (p) => {
        const dirName = path.basename(p)
        const srcSizesRoot = path.resolve(__dirname, 'src', 'sizes')
        
        // Ignore the root sizes directory itself (prevents scanning src/sizes/sizes)
        if (path.resolve(p) === srcSizesRoot || dirName === 'sizes') {
            return
        }
        
        // If this is a folder being renamed TO have an underscore (normal -> _underscore)
        // we need to clean up the corresponding build folder without the underscore
        if (dirName.startsWith('_')) {
            const normalName = dirName.slice(1) // Remove underscore
            const buildPath = path.resolve(__dirname, 'build.nosync', normalName)
            const zipPath = path.resolve(__dirname, 'build.nosync', normalName + '.zip')
            
            // Check if there's a build folder/zip that needs cleanup
            if (fs.existsSync(buildPath) || fs.existsSync(zipPath)) {
                console.log('[watch:addDir] Cleaning up build artifacts for underscored folder:', normalName)
                del([buildPath, zipPath], { force: true }).catch(err => 
                    console.error('[watch:addDir] Cleanup error:', err)
                )
            }
            return // Don't build underscored folders
        }
        
        // Force a fresh compile for the new directory (handles underscore -> normal rename)
        buildPugFreshDir(dirName)
            .then(() => {
                // Also rebuild sizes/index.pug (if present) so listing pages update
                return new Promise((resolve) => {
                    src(['src/sizes/index.pug'], { allowEmpty: true })
                        .pipe(plumber())
                        .pipe(pug({ pretty: true }))
                        .pipe(gulpPugBeautify({
                            omit_empty: true,
                            fill_tab: false,
                            tab_size: 4
                        }))
                        .pipe(dest('./build.nosync/'))
                        .on('end', () => { resolve(); })
                })
            })
            .then(() => {
                if (enableAutoZip) scheduleZip('dir added:' + dirName)
            })
        // Refresh watchers to pick up new files in the added directory
        setTimeout(() => {
            try { pugWatcher.add('./src/sizes/' + dirName + '/**/*.pug') } catch(_) {}
            try { sassWatcher.add('./src/sizes/' + dirName + '/**/*.sass') } catch(_) {}
            try { imgWatcher.add('./src/sizes/' + dirName + '/**/*.{jpg,png,gif,svg,webp}') } catch(_) {}
            try { jsWatcher.add('./src/sizes/' + dirName + '/**/*.js') } catch(_) {}
        }, TIMING.watcherRefresh)
    })

    // Some environments may not emit unlinkDir; as a fallback, watch deeper and reconcile orphans
    watch('./src/sizes/**', { ignoreInitial: true }).on('unlink', () => {
        scheduleReconcileOrphans() // Always reconcile orphans, regardless of auto-zip setting
    })
}

// Periodically reconcile build directories vs src and remove orphans
let __reconcileTimer = null
function scheduleReconcileOrphans() {
    // Always run cleanup for orphaned build directories, regardless of auto-zip setting
    clearTimeout(__reconcileTimer)
    __reconcileTimer = setTimeout(() => reconcileOrphanBuildDirs(), TIMING.reconcileDebounce)
}

async function reconcileOrphanBuildDirs(cb) {
    try {
        const srcBase = path.resolve(__dirname, 'src', 'sizes')
        const buildBase = path.resolve(__dirname, 'build.nosync')
        let srcDirs = []
        let buildDirs = []
        try { srcDirs = fs.readdirSync(srcBase, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch (_) { srcDirs = [] }
        try { buildDirs = fs.readdirSync(buildBase, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch (_) { buildDirs = [] }
        const srcSet = new Set(srcDirs)
        const orphans = buildDirs.filter(name => !srcSet.has(name))
        if (orphans.length) {
            const targets = []
            for (const name of orphans) {
                targets.push(path.join(buildBase, name))
                targets.push(path.join(buildBase, name + '.zip'))
            }
            await del(targets, { force: true })
            // sizes.json removed - we only use banner-sizes.js now
            reloadBrowser(true)
        }
    } catch (_) {}
    cb && cb()
}

exports.default = skipInitialBuild
    ? series(writeBannerSizesPlaceholder, serve, watchTask)
    : enableAutoZip 
        ? series(allZipsClean, buildClean, parallel(buildPug, buildGlobalPug, buildSass, buildImg, buildJs), writeBannerSizesPlaceholder, buildZip, writeZipSizes, serve, watchTask)
        : series(buildClean, parallel(buildPug, buildGlobalPug, buildSass, buildImg, buildJs), writeBannerSizesPlaceholder, serve, watchTask)
// Full rebuild of all assets without zipping
exports.build = series(buildClean, parallel(buildPug, buildGlobalPug, buildSass, buildImg, buildJs), writeBannerSizesPlaceholder)
// Clean build then start dev server with watch
exports.devbuild = series(buildClean, parallel(buildPug, buildGlobalPug, buildSass, buildImg, buildJs), writeBannerSizesPlaceholder, serve, watchTask)
// Ensure the browser refreshes after zip so preview updates live
exports.zip = series(allZipsClean, imageClean, jsClean, buildImg, buildJs, buildPug, buildGlobalPug, buildZip, writeZipSizes, reload, createCompletePackage, createPackage)
exports.clean = buildClean

// ---------- Package ----------
function createPackage(cb) {
    // Create zip of entire build.nosync folder (including the files zip)
    return src(['build.nosync/**/*'], { allowEmpty: true, encoding: false })
        .pipe(zip(`${set}-whole-package.zip`))
        .pipe(size({ showFiles: true, title: 'Package' }))
        .pipe(dest('build.nosync/'))
}

function createCompletePackage(cb) {
    // Create zip with only individual banner zips (no folders or package files)
    return src(['build.nosync/*.zip', '!build.nosync/*-all-banners.zip', '!build.nosync/*-whole-package.zip'], { allowEmpty: true, encoding: false })
        .pipe(zip(`${set}-all-banners.zip`))
        .pipe(size({ showFiles: true, title: 'Complete Package' }))
        .pipe(dest('build.nosync/'))
}

function getFtpConfig() {
    // Read from environment variables first, fall back to config file
    let cfg = {
        host: process.env.FTP_HOST,
        user: process.env.FTP_USER,
        password: process.env.FTP_PASSWORD,
        port: parseInt(process.env.FTP_PORT || '22', 10),
        remotePath: process.env.FTP_REMOTE_PATH,
        remoteSubdir: process.env.FTP_REMOTE_SUBDIR,
        publicUrlBase: process.env.FTP_PUBLIC_URL,
        parallel: parseInt(process.env.FTP_PARALLEL || '5', 10)
    }

    // Fall back to config file if env vars not set
    if (!cfg.host || !cfg.user || !cfg.password) {
        try {
            const filePath = path.resolve(__dirname, 'ftp.config.json')
            const fileCfg = require(filePath)
            cfg = Object.assign({ parallel: 5, port: 22 }, fileCfg)
            if (DEBUG) console.log('[ftp] Using ftp.config.json')
        } catch (e) {
            // No config file found
        }
    } else {
        if (DEBUG) console.log('[ftp] Using environment variables')
    }

    if (!cfg.host || !cfg.user || !cfg.password || !cfg.remotePath) {
        throw new Error('FTP config missing. Set FTP_HOST, FTP_USER, FTP_PASSWORD, FTP_REMOTE_PATH environment variables or provide ftp.config.json')
    }

    // If extra subdir is provided, append it to remotePath
    if (cfg.remoteSubdir) {
        const base = String(cfg.remotePath).replace(/\\/g, '/').replace(/\/$/, '')
        const sub = String(cfg.remoteSubdir).replace(/\\/g, '/').replace(/^\//, '')
        cfg.remotePath = path.posix.join(base, sub)
    }
    return cfg
}

async function ftpList() {
    const cfg = getFtpConfig()
    const SftpClient = await lazyRequire('ssh2-sftp-client')
    const client = new SftpClient()
    const remoteBase = String(cfg.remotePath).replace(/\\/g, '/').replace(/\/$/, '')
    try {
        await client.connect({
            host: cfg.host,
            username: cfg.user,
            password: cfg.password,
            port: cfg.port || 22
        })
        // Ensure remote directory exists
        const exists = await client.exists(remoteBase)
        if (!exists) {
            await client.mkdir(remoteBase, true)
        }
        const list = await client.list(remoteBase)
        console.log(`Remote listing for ${remoteBase}:`)
        list.forEach((item) => {
            const type = item.type === 'd' ? 'dir ' : 'file'
            const sizeKb = item.size != null ? (Math.round(item.size / 10.24) / 100).toFixed(2) + ' KB' : '-'
            console.log(` - [${type}] ${item.name} ${sizeKb}`)
        })
        if (cfg.publicUrlBase) {
            const baseUrl = String(cfg.publicUrlBase).replace(/\/$/, '')
            const sub = cfg.remoteSubdir ? String(cfg.remoteSubdir).replace(/^\//, '') + '/' : ''
            console.log(`Public URL: ${baseUrl}/${sub}`)
        }
    } finally {
        await client.end()
    }
}

async function ftpClean() {
    const cfg = getFtpConfig()
    const SftpClient = await lazyRequire('ssh2-sftp-client')
    const client = new SftpClient()
    const remoteBase = String(cfg.remotePath).replace(/\\/g, '/').replace(/\/$/, '')
    try {
        await client.connect({
            host: cfg.host,
            username: cfg.user,
            password: cfg.password,
            port: cfg.port || 22
        })
        // Ensure remote directory exists
        const exists = await client.exists(remoteBase)
        if (exists) {
            // Remove directory contents recursively, then recreate
            await client.rmdir(remoteBase, true)
        }
        await client.mkdir(remoteBase, true)
        console.log(`Remote folder cleared: ${remoteBase}`)
    } finally {
        await client.end()
    }
}

let ftpUpload = async () => {
    const cfg = getFtpConfig()
    const SftpClient = await lazyRequire('ssh2-sftp-client')
    const through2 = await lazyRequire('through2')
    const client = new SftpClient()

    const localBase = path.resolve(__dirname, 'build.nosync')
    const remoteBase = String(cfg.remotePath).replace(/\\/g, '/').replace(/\/$/, '')

    const connect = async () => {
        await client.connect({
            host: cfg.host,
            username: cfg.user,
            password: cfg.password,
            port: cfg.port || 22
        })
        const exists = await client.exists(remoteBase)
        if (!exists) {
            await client.mkdir(remoteBase, true)
        }
    }

    let connected = false

    const ensureConnected = async () => {
        if (!connected) {
            await connect()
            connected = true
        }
    }

    const ensureDir = async (dir) => {
        const exists = await client.exists(dir)
        if (!exists) {
            await client.mkdir(dir, true)
        }
    }

    const uploadStream = through2.obj(function (file, _, cb) {
        if (file.isDirectory()) return cb()
        const rel = path.relative(localBase, file.path).split(path.sep).join('/')
        if (/\.DS_Store$/.test(rel) || /Thumbs\.db$/i.test(rel)) return cb()
        const remotePath = remoteBase + '/' + rel
        const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'))

        ensureConnected()
            .then(() => ensureDir(remoteDir))
            .then(() => client.put(file.path, remotePath))
            .then(() => cb())
            .catch((err) => cb(err))
    }, function (cb) {
        if (cfg.publicUrlBase) {
            const baseUrl = String(cfg.publicUrlBase).replace(/\/$/, '')
            const sub = cfg.remoteSubdir ? String(cfg.remoteSubdir).replace(/^\//, '') + '/' : ''
            const url = `${baseUrl}/${sub}`
            console.log(`Public URL: ${url}`)
            copyToClipboard(url)
            // Try to open default browser (macOS: open, Windows: start, Linux: xdg-open)
            const cmd = process.platform === 'darwin'
                ? `open "${url}"`
                : process.platform === 'win32'
                    ? `start "" "${url}"`
                    : `xdg-open "${url}"`
            exec(cmd, (err) => {
                if (err) {
                    // non-fatal: just log a short note
                    console.log('Tip: open this URL in your browser if it did not open automatically.')
                }
                client.end()
                cb()
            })
            return
        }
        client.end()
        cb()
    })

    return src(['build.nosync/**'], { base: 'build.nosync', nodir: false, buffer: false, encoding: false })
        .pipe(uploadStream)
}


// Build assets, zip them, bundle files zip, clean remote, then upload to FTP
exports.ftp = series(allZipsClean, buildClean, parallel(buildPug, buildSass, buildImg, buildJs), buildZip, writeZipSizes, createCompletePackage, createPackage, ftpClean, ftpUpload)
// syncImages removed; buildImg + gulp-newer handles syncing
