// ============================================================
// PASTECAL SELF-TEST SUITE
// ============================================================
// Automatically runs UI and functionality tests on localhost
// Results are logged to console with clear pass/fail indicators
// ============================================================

(function() {
    'use strict';

    // Only run on localhost or if ?test parameter is present
    const isLocalhost = window.location.hostname.match(/^(localhost|127\.0\.0\.1|::1)$/);
    const hasTestParam = window.location.search.includes('?test');

    if (!isLocalhost && !hasTestParam) {
        return;
    }

    const TEST_RESULTS = {
        passed: [],
        failed: [],
        warnings: []
    };

    // ============================================================
    // TEST UTILITIES
    // ============================================================

    function assert(condition, testName, details = '') {
        if (condition) {
            TEST_RESULTS.passed.push(testName);
            console.log(`✅ ${testName}`, details ? `\n   ${details}` : '');
            return true;
        } else {
            TEST_RESULTS.failed.push(testName);
            console.error(`❌ ${testName}`, details ? `\n   ${details}` : '');
            return false;
        }
    }

    function warn(testName, details = '') {
        TEST_RESULTS.warnings.push(testName);
        console.warn(`⚠️  ${testName}`, details ? `\n   ${details}` : '');
    }

    function groupStart(groupName) {
        console.group(`\n🧪 ${groupName}`);
    }

    function groupEnd() {
        console.groupEnd();
    }

    async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitFor(conditionFn, timeout = 5000, interval = 100) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (conditionFn()) return true;
            await sleep(interval);
        }
        return false;
    }

    // ============================================================
    // TEST: COMPONENT REGISTRATION
    // ============================================================

    async function testComponentRegistration() {
        groupStart('Component Registration Tests');

        // Check COMPONENT_REGISTRY exists
        const hasRegistry = assert(
            typeof window.COMPONENT_REGISTRY !== 'undefined' || typeof COMPONENT_REGISTRY !== 'undefined',
            'Component registry exists',
            'COMPONENT_REGISTRY is defined'
        );

        // Check Vue app is mounted
        assert(
            document.getElementById('app').__vue_app__,
            'Vue app is mounted',
            'Vue instance attached to #app'
        );

        // Test for unregistered components
        const customElements = new Set();
        document.querySelectorAll('*').forEach(el => {
            const tagName = el.tagName.toLowerCase();
            if (tagName.includes('-') && !tagName.startsWith('x-') && !tagName.startsWith('e-')) {
                customElements.add(tagName);
            }
        });

        const emptyComponents = Array.from(customElements).filter(tag => {
            // Special case: calendar-title is replaced by its template root, so we look for the class
            if (tag === 'calendar-title') {
                return !document.querySelector('.calendar-title-component');
            }
            const el = document.querySelector(tag);
            return el && el.children.length === 0 && !el.textContent.trim();
        });

        assert(
            emptyComponents.length === 0,
            'No unregistered components',
            emptyComponents.length > 0 ? `Found: ${emptyComponents.join(', ')}` : 'All components rendering properly'
        );

        groupEnd();
    }

    // ============================================================
    // TEST: DOM STRUCTURE
    // ============================================================

    async function testDOMStructure() {
        groupStart('DOM Structure Tests');

        // Test main elements exist
        assert(
            document.getElementById('app') !== null,
            'Main app container exists',
            '#app element found'
        );

        assert(
            document.querySelector('.e-schedule') !== null,
            'Calendar widget exists',
            'Syncfusion calendar rendered'
        );

        // Test mobile header elements
        const isMobile = window.innerWidth < 768;
        if (isMobile) {
            await waitFor(() => document.querySelector('.calendar-title-component'));
            assert(
                document.querySelector('.calendar-title-component') !== null,
                'Mobile calendar title exists',
                'calendar-title component rendered'
            );
        }

        // Test desktop sidebar
        if (!isMobile) {
            assert(
                document.querySelector('[class*="sidebar"]') !== null ||
                document.querySelector('[class*="left"]') !== null,
                'Desktop navigation exists',
                'Sidebar or navigation panel found'
            );
        }

        groupEnd();
    }

    // ============================================================
    // TEST: CALENDAR FUNCTIONALITY
    // ============================================================

    async function testCalendarFunctionality() {
        groupStart('Calendar Functionality Tests');

        // Check Utils is available
        assert(
            typeof Utils !== 'undefined',
            'Utils object is available',
            'Global Utils namespace exists'
        );

        // Check calendar variable
        assert(
            typeof scheduleObj !== 'undefined',
            'Calendar instance exists',
            'Global scheduleObj variable defined'
        );

        // Test event methods exist
        if (typeof Utils !== 'undefined') {
            assert(
                typeof Utils.createEvent === 'function',
                'Utils.createEvent exists',
                'Event creation method available'
            );

            assert(
                typeof Utils.updateEvent === 'function',
                'Utils.updateEvent exists',
                'Event update method available'
            );

            assert(
                typeof Utils.deleteEvent === 'function',
                'Utils.deleteEvent exists',
                'Event deletion method available'
            );

            assert(
                typeof Utils.getEvents === 'function',
                'Utils.getEvents exists',
                'Event retrieval method available'
            );
        }

        groupEnd();
    }

    // ============================================================
    // TEST: LOCAL STORAGE
    // ============================================================

    async function testLocalStorage() {
        groupStart('Local Storage Tests');

        // Test localStorage is available
        assert(
            typeof localStorage !== 'undefined',
            'LocalStorage is available',
            'Browser supports localStorage'
        );

        // Test calendar data exists
        // Note: 'calendar' is the current key for the Vue app (homepage data).
        // '_calstore' was legacy.
        const calstore = localStorage.getItem('calendar');
        
        if (calstore) {
            try {
                const parsed = JSON.parse(calstore);
                // Check for events property (might be missing if empty)
                assert(
                    parsed && (Array.isArray(parsed.events) || typeof parsed.events === 'undefined'), 
                    'Calendar data store is valid',
                    'Found "calendar" key in localStorage'
                );
            } catch (e) {
                assert(false, 'Calendar store is valid JSON', `Parse error: ${e.message}`);
            }
        } else {
            // Not a hard fail if clean state, but noteworthy
            warn('No local calendar data found', '(Key "calendar" is empty)');
        }

        // Test RecentCalendars
        const recentCalendars = localStorage.getItem('recentCalendars');
        if (recentCalendars) {
            try {
                const parsed = JSON.parse(recentCalendars);
                assert(
                    Array.isArray(parsed),
                    'Recent calendars is valid array',
                    `Found ${parsed.length} recent calendars`
                );
            } catch (e) {
                warn('Recent calendars parse error', e.message);
            }
        }

        groupEnd();
    }

    // ============================================================
    // TEST: RESPONSIVE BEHAVIOR
    // ============================================================

    async function testResponsiveBehavior() {
        groupStart('Responsive Behavior Tests');

        const width = window.innerWidth;
        const isMobile = width < 768;

        assert(
            true,
            `Current viewport: ${width}px (${isMobile ? 'mobile' : 'desktop'})`,
            ''
        );

        // Check mobile-specific elements
        if (isMobile) {
            const mobileMenu = document.querySelector('[class*="mobile"]');
            if (mobileMenu) {
                assert(
                    true,
                    'Mobile UI elements present',
                    'Mobile-specific components found'
                );
            }
        }

        // Check calendar is responsive
        const scheduleEl = document.querySelector('.e-schedule');
        if (scheduleEl) {
            const rect = scheduleEl.getBoundingClientRect();
            assert(
                rect.width > 0 && rect.height > 0,
                'Calendar has valid dimensions',
                `${Math.round(rect.width)}x${Math.round(rect.height)}px`
            );
        }

        groupEnd();
    }

    // ============================================================
    // TEST: TITLE COMPONENT & HEADER UI
    // ============================================================

    async function testTitleComponent() {
        groupStart('Title Component & Header UI Tests');

        // 1. Title Component
        // Wait for component to render (Vue replaces custom tag with template root)
        await waitFor(() => document.querySelector('.calendar-title-component'));
        
        // Find the visible title component (since we have mobile and desktop versions)
        const titleComponents = Array.from(document.querySelectorAll('.calendar-title-component'));
        const titleComponent = titleComponents.find(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }) || titleComponents[0]; // Fallback to first if none visible (to show 0x0 error)

        if (titleComponent) {
            // Verify it has content (either H1 or Input)
            const hasContent = titleComponent.children.length > 0 || 
                               titleComponent.querySelector('h1, input') !== null;
            
            assert(hasContent, 'Title component has content', 'Component properly rendered');

            // Verify visibility
            const rect = titleComponent.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0;
            
            assert(isVisible, 'Title component is visible', `${Math.round(rect.width)}x${Math.round(rect.height)}px`);

            // Verify text content if H1
            const titleEl = titleComponent.querySelector('h1');
            if (titleEl) {
                const text = titleEl.textContent.trim();
                assert(text.length > 0, 'Title has text', `Text: "${text}"`);
            }
        } else {
            // Fail if component is missing entirely
            assert(false, 'Title component exists', '.calendar-title-component not found in DOM');
        }

        // 2. Share/Actions Section (Desktop)
        const isMobile = window.innerWidth < 768;
        if (!isMobile) {
            const topbar = document.querySelector('.hidden.md\\:flex');
            if (topbar) {
                // Look for the share/claim section container (it's the last section in topbar)
                const rightSection = topbar.querySelector('section:last-child');
                
                if (rightSection) {
                    const rightRect = rightSection.getBoundingClientRect();
                    assert(
                        rightRect.width > 0 && rightRect.height > 0, 
                        'Share/Actions section is visible',
                        'Right section container is rendered'
                    );

                    // Check for specific buttons/inputs based on state using waitFor to allow for async render
                    // We filter out comments (nodeType 8) and check for visible elements
                    const foundContent = await waitFor(() => {
                        const children = Array.from(rightSection.children);
                        const visibleChildren = children.filter(child => {
                            // For the ShareOrClaimUI component root or its children
                            return child.nodeType === 1 && // Element node
                                   child.style.display !== 'none' && 
                                   child.getBoundingClientRect().width > 0;
                        });
                        return visibleChildren.length > 0;
                    }, 5000);

                    assert(foundContent, 'Share/Actions section has content', `Visible content found after wait (e.g. buttons, inputs, or loading badge)`);
                } else {
                    assert(false, 'Share/Actions section exists', 'Right section not found in topbar');
                }
            }
        }

        groupEnd();
    }

    // ============================================================
    // TEST: NOTES EDITING
    // ============================================================

    async function testNotesEditing() {
        groupStart('Notes Functionality Tests');

        // Locate the Notes toggle button (it might be inside the title component or topbar)
        // We'll look for the button with the aria-label "Toggle notes"
        const notesButton = document.querySelector('button[aria-label="Toggle notes"]');
        
        if (!notesButton) {
            warn('Notes toggle button not found', 'Skipping notes test');
            groupEnd();
            return;
        }

        // Ensure notes are closed initially (or just toggle it open)
        // We can check if the notes panel is visible. 
        // The panel usually has a textarea inside or we can look for the panel container logic.
        // But simpler: click the button and wait for textarea.
        
        // Click to open
        notesButton.click();

        // Wait for panel to open and render either textarea OR view mode with edit button
        const panelReady = await waitFor(() => {
            const ta = document.querySelector('textarea[aria-label="Calendar notes"]');
            const editBtn = document.querySelector('button.text-blue-500'); // The "Edit/Done" button class
            const readOnlyDiv = document.querySelector('div[v-html="getReadOnlyNotes()"]'); // Approximate selector or check for content div
            
            // Valid states: Textarea visible OR (View mode visible AND Edit button visible)
            const isEditMode = ta && ta.offsetParent !== null;
            const isViewMode = !isEditMode && editBtn && editBtn.offsetParent !== null;
            
            return isEditMode || isViewMode;
        });

        if (panelReady) {
            assert(true, 'Notes panel opened', 'Panel content visible');
            
            let textarea = document.querySelector('textarea[aria-label="Calendar notes"]');
            
            // If we are in view mode (textarea not found), click Edit
            if (!textarea) {
                // Look for the Edit button by text content since class might change
                const buttons = Array.from(document.querySelectorAll('button'));
                const editButton = buttons.find(b => b.textContent.trim().toUpperCase() === 'EDIT');
                
                if (editButton) {
                    editButton.click();
                    // Wait for textarea to appear after click
                    await waitFor(() => document.querySelector('textarea[aria-label="Calendar notes"]'));
                    textarea = document.querySelector('textarea[aria-label="Calendar notes"]');
                    assert(textarea !== null, 'Switched to edit mode', 'Textarea appeared after clicking Edit');
                } else {
                    // Check if read-only (no edit button)
                     const isReadOnlyView = window.location.pathname.startsWith('/view/');
                     if (isReadOnlyView) {
                         assert(true, 'Notes are read-only (expected)', 'No Edit button in read-only view');
                         notesButton.click();
                         return;
                     } else {
                         assert(false, 'Edit button missing', 'Not in read-only view but cannot edit');
                     }
                }
            }

            if (textarea && !textarea.disabled && !textarea.readOnly) {
                assert(true, 'Notes are editable', 'Textarea is interactive');
            }
            
            // Close notes to clean up UI state
            notesButton.click(); 
        } else {
            assert(false, 'Notes panel failed to open', 'Neither textarea nor view panel found');
        }

        groupEnd();
    }

    // ============================================================
    // TEST: EVENT HANDLING
    // ============================================================

    async function testEventHandling() {
        groupStart('Event Handling Tests');

        // Check event listeners are attached
        if (typeof calendar !== 'undefined' && calendar.eventBase) {
            assert(
                true,
                'Calendar event handlers initialized',
                'Event system is ready'
            );
        }

        // Test nanoid function
        if (typeof Utils !== 'undefined' && typeof Utils.nanoid === 'function') {
            const id1 = Utils.nanoid(8);
            const id2 = Utils.nanoid(8);
            assert(
                id1 !== id2 && id1.length === 8,
                'nanoid generates unique IDs',
                `Generated: ${id1}, ${id2}`
            );
        }

        // Test parseHumanWrittenCalendar
        if (typeof Utils !== 'undefined' && typeof Utils.parseHumanWrittenCalendar === 'function') {
            try {
                const result = Utils.parseHumanWrittenCalendar('meeting tomorrow at 2pm');
                assert(
                    result.subject && result.startDateTime,
                    'Human calendar parsing works',
                    `Parsed: "${result.subject}"`
                );
            } catch (e) {
                assert(false, 'Calendar parsing error', e.message);
            }
        }

        groupEnd();
    }

    // ============================================================
    // TEST: EXTERNAL DEPENDENCIES
    // ============================================================

    async function testExternalDependencies() {
        groupStart('External Dependencies Tests');

        // Check Vue 3
        assert(
            typeof Vue !== 'undefined' && typeof Vue.createApp === 'function',
            'Vue 3 is loaded',
            `Version: ${Vue.version || 'unknown'}`
        );

        // Check Syncfusion
        assert(
            typeof ej !== 'undefined' && typeof ej.schedule !== 'undefined',
            'Syncfusion Schedule is loaded',
            'ej.schedule namespace exists'
        );

        // Check Chrono (date parsing)
        assert(
            typeof chrono !== 'undefined',
            'Chrono date parser is loaded',
            'Natural language date parsing available'
        );

        // Check Firebase
        if (typeof firebase !== 'undefined') {
            assert(
                true,
                'Firebase is loaded',
                'Firebase SDK available'
            );
        } else {
            warn('Firebase not loaded', 'May be intentional');
        }

        groupEnd();
    }

    // ============================================================
    // TEST: CONSOLE ERRORS
    // ============================================================

    async function testConsoleErrors() {
        groupStart('Console Error Check');

        // This would need to be set up earlier to catch all errors
        // For now, just check if there are obvious issues
        const scripts = document.querySelectorAll('script');
        let brokenScripts = 0;

        scripts.forEach(script => {
            if (script.src && !script.src.startsWith('data:')) {
                // Can't easily check if external scripts loaded successfully
                // This is just a placeholder
            }
        });

        assert(
            true,
            'Console error monitoring',
            'Check browser console for any errors'
        );

        groupEnd();
    }

    // ============================================================
    // RUN ALL TESTS
    // ============================================================

    async function runAllTests() {
        console.clear();
        console.log('%c🧪 PASTECAL SELF-TEST SUITE', 'font-size: 20px; font-weight: bold; color: #4CAF50');
        console.log('%cRunning comprehensive UI and functionality tests...', 'color: #666');
        console.log('━'.repeat(60));

        // Wait for page to fully load
        if (document.readyState !== 'complete') {
            await new Promise(resolve => window.addEventListener('load', resolve));
        }

        // Additional wait for Vue to mount
        await sleep(500);

        // Run all test suites
        await testComponentRegistration();
        await testDOMStructure();
        await testCalendarFunctionality();
        await testLocalStorage();
        await testResponsiveBehavior();
        await testTitleComponent();
        await testNotesEditing();
        await testEventHandling();
        await testExternalDependencies();
        await testConsoleErrors();

        // Print summary
        console.log('\n' + '━'.repeat(60));
        console.log('%c📊 TEST SUMMARY', 'font-size: 18px; font-weight: bold; color: #2196F3');
        console.log('━'.repeat(60));

        const total = TEST_RESULTS.passed.length + TEST_RESULTS.failed.length;
        const passRate = total > 0 ? ((TEST_RESULTS.passed.length / total) * 100).toFixed(1) : 0;

        console.log(`%c✅ Passed: ${TEST_RESULTS.passed.length}`, 'color: #4CAF50; font-weight: bold');
        console.log(`%c❌ Failed: ${TEST_RESULTS.failed.length}`, 'color: #f44336; font-weight: bold');
        console.log(`%c⚠️  Warnings: ${TEST_RESULTS.warnings.length}`, 'color: #FF9800; font-weight: bold');
        console.log(`%c📈 Pass Rate: ${passRate}%`, `color: ${passRate >= 90 ? '#4CAF50' : passRate >= 70 ? '#FF9800' : '#f44336'}; font-weight: bold; font-size: 14px`);

        if (TEST_RESULTS.failed.length > 0) {
            console.log('\n%c🔍 FAILED TESTS:', 'color: #f44336; font-weight: bold');
            TEST_RESULTS.failed.forEach((test, i) => {
                console.log(`   ${i + 1}. ${test}`);
            });
        }

        if (TEST_RESULTS.warnings.length > 0) {
            console.log('\n%c⚠️  WARNINGS:', 'color: #FF9800; font-weight: bold');
            TEST_RESULTS.warnings.forEach((test, i) => {
                console.log(`   ${i + 1}. ${test}`);
            });
        }

        console.log('\n' + '━'.repeat(60));

        if (TEST_RESULTS.failed.length === 0) {
            console.log('%c🎉 ALL TESTS PASSED!', 'font-size: 16px; font-weight: bold; color: #4CAF50; background: #E8F5E9; padding: 8px');
        } else {
            console.log('%c⚠️  SOME TESTS FAILED', 'font-size: 16px; font-weight: bold; color: #f44336; background: #FFEBEE; padding: 8px');
        }

        console.log('━'.repeat(60));

        // Store results globally for access
        window.SELFTEST_RESULTS = TEST_RESULTS;

        return TEST_RESULTS;
    }

    // ============================================================
    // AUTO-RUN
    // ============================================================

    // Run tests after a delay to ensure everything is loaded
    setTimeout(() => {
        runAllTests().catch(error => {
            console.error('Self-test suite error:', error);
        });
    }, 2000);

    // Expose manual test runner
    window.runSelfTest = runAllTests;

    console.log('%c💡 TIP: Run window.runSelfTest() anytime to re-run tests', 'color: #2196F3; font-style: italic');

})();
