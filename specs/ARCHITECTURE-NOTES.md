# Architecture Notes - Component Registration Issue

## Problem Summary

**Symptom**: The "New Calendar" title was not visible on mobile homepage despite existing in the DOM.

**Root Cause**: The `CalendarTitle` component was defined but never registered with Vue's component registry. Vue 3 fails silently when an unregistered component is used - it renders an empty custom element tag with no content.

## Why This Was Hard to Debug

1. **Silent Failure**: Vue doesn't throw errors for unregistered components - they just render as empty elements
2. **Scattered Logic**: Component setup requires 3 separate locations:
   - Template: `<script type="text/x-template" id="calendar-title-template">`
   - Definition: `const CalendarTitle = { template: '#calendar-title-template', ... }`
   - Registration: `components: { 'calendar-title': CalendarTitle }`
3. **No Build-Time Validation**: Without TypeScript/build step, no compile-time checks
4. **Large Monolithic File**: 4200+ lines makes it hard to track these connections

## Solutions Implemented

### 1. Explicit Component Registry (index.html:2239-2260)

Created a central `COMPONENT_REGISTRY` object with clear documentation:

```javascript
// ============================================================
// COMPONENT REGISTRY
// ============================================================
// IMPORTANT: All components used in templates must be registered here!
// ============================================================
const COMPONENT_REGISTRY = {
    'calendar-title': CalendarTitle,           // Mobile & desktop title component
    'navigation-dropdown': NavigationDropdown, // Recent calendars dropdown
    'custom-tooltip': Tooltip,                 // Tooltip wrapper
    // ... etc
};

const CalendarVueApp = {
    components: COMPONENT_REGISTRY,
    // ...
};
```

**Benefits**:
- Single source of truth for all component registrations
- Comments document what each component does
- Easy to see what's registered at a glance
- Reduces chance of forgetting to register a component

### 2. Runtime Validation (index.html:4202-4238)

Added automatic validation that checks for unregistered components on page load:

```javascript
function validateComponentRegistration() {
    const registeredComponents = Object.keys(COMPONENT_REGISTRY).concat(['quick-add']);
    const allElements = document.querySelectorAll('*');
    const customElements = new Set();

    allElements.forEach(el => {
        const tagName = el.tagName.toLowerCase();
        if (tagName.includes('-') && !tagName.startsWith('x-')) {
            customElements.add(tagName);
        }
    });

    const unregistered = Array.from(customElements).filter(
        tag => !registeredComponents.includes(tag)
    );

    if (unregistered.length > 0) {
        console.error('⚠️  UNREGISTERED COMPONENTS DETECTED:');
        console.error('The following components are used in templates but not registered:');
        unregistered.forEach(tag => {
            console.error(`  - <${tag}> (empty/not rendering)`);
        });
        console.error('\nTo fix: Add these components to COMPONENT_REGISTRY in index.html');
    } else {
        console.log('✅ All components properly registered');
    }
}

setTimeout(validateComponentRegistration, 1000);
```

**Benefits**:
- Immediate feedback in console if a component isn't registered
- Catches this class of errors automatically during development
- Clear error messages with instructions on how to fix

## Best Practices Going Forward

1. **When adding a new component**:
   - Define the template: `<script type="text/x-template" id="my-component-template">`
   - Define the component object: `const MyComponent = { template: '#my-component-template', ... }`
   - **Add to COMPONENT_REGISTRY**: `'my-component': MyComponent,`
   - The validator will catch it if you forget step 3!

2. **Check the console**: Look for the "✅ All components properly registered" message on page load

3. **If you see empty space where a component should be**: Check console for unregistered component warnings

## Future Improvements to Consider

1. **Component File Organization**: Move to separate `.js` files per component
2. **Build Step**: Add Vite/Webpack to enable:
   - TypeScript for compile-time type checking
   - Single File Components (.vue files)
   - Automatic component registration
   - Better error messages
3. **Testing**: Add integration tests that verify component rendering
4. **Linting**: Use ESLint with Vue plugin to catch these issues

## Related Files

- `/public/index.html` - Main application file (all Vue components defined here)
- `/public/index.js` - Utilities and calendar helpers

## Date

2025-11-20
