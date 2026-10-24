// Loads the native renderer's scripts. They download in parallel and run in order:
// dynamically inserted scripts with async = false keep insertion order for execution.
// VERSION is part of every URL, so a browser can reuse what it already has; bump it
// whenever any file below changes (it used to be Date.now(), which defeated all caching).
(function() {
    const VERSION = '20261024';
    const files = [
        '/nativecal/components/ncUx.js',
        '/nativecal/components/NcIcon.js',
        '/nativecal/components/NativeCalendar.js',
        '/nativecal/components/EventEditor.js',
        '/nativecal/components/EventPopover.js',
        '/nativecal/components/QuickCreatePopover.js',
        '/nativecal/app.js'
    ];
    for (const src of files) {
        const script = document.createElement('script');
        script.src = src + '?v=' + VERSION;
        script.async = false;
        script.onerror = function() {
            console.error('Failed to load script: ' + src);
        };
        document.body.appendChild(script);
    }
})();
