const NativeCalendarToolbar = {
    template: '#calendar-toolbar-template',
    props: ['currentTitle', 'currentView', 'views'],
    emits: ['prev', 'next', 'today', 'change-view']
};
