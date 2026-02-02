/**
 * Banner Project Configuration
 * Centralized settings for the banner development template
 */

module.exports = {
    // Project identification
    project: {
        name: 'shell',           // Used for zip file naming and set prefixes
        title: 'Shell Fleet Solutions',          // Display title in preview
        logoLink: false,         // URL for logo click (false = reload page)
        footerLink: false,       // URL for footer link (false = no link)
        footer: {
            copyright: '©',
            year: '2026',
            company: 'NS+R UK Ltd. All rights reserved',
        },
    },

    // Preview page settings
    preview: {
        showWholePackageDownload: false,  // Show "All Banners + Preview" download option
        enablePreloading: false,          // Enable shimmer preloading animation
    },

    // File paths
    paths: {
        src: './src',
        srcSizes: './src/sizes',
        srcGlobal: './src/global',
        srcPlugins: './src/global/plugins',
        build: './build.nosync',
        export: './export.nosync',
        cache: '.cache/zips',
    },

    // File extensions/patterns
    patterns: {
        pug: '**/*.pug',
        sass: '**/*.sass',
        js: '**/*.js',
        images: '**/*.{jpg,png,gif,svg,webp}',
        excludeUnderscore: '!**/_*/**',
        excludeUnderscoreFiles: '!**/_*',
    },

    // BrowserSync server configuration
    server: {
        port: 9000,
        host: 'localhost',
        open: false,
        notify: false,
        logPrefix: 'project',
    },

    // Build feature flags
    features: {
        // Set to true to automatically rebuild zips when files change
        enableAutoZip: false,
        // Set to false to do a full build when starting dev server
        skipInitialBuild: true,
    },

    // Timing constants (milliseconds)
    timing: {
        zipDebounce: 350,       // Debounce time for zip scheduling
        reconcileDebounce: 300, // Debounce time for orphan cleanup
        watcherRefresh: 120,    // Time to wait before refreshing watchers
    },
}
