(function() {
    const timestamp = new Date().getTime();
    const files = [
        '/nativecal/components/NativeCalendar.js',
        '/nativecal/components/EventEditor.js',
        '/nativecal/components/EventPopover.js',
        '/nativecal/components/QuickCreatePopover.js',
        '/nativecal/app.js'
    ];

    function loadScript(index) {
        if (index >= files.length) return;
        
        const src = files[index];
        const script = document.createElement('script');
        script.src = src + '?v=' + timestamp;
        script.async = false;
        script.onload = function() {
            loadScript(index + 1);
        };
        script.onerror = function() {
            console.error('Failed to load script: ' + src);
        };
        document.body.appendChild(script);
    }

    loadScript(0);
})();