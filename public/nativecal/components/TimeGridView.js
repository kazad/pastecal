const NativeTimeGridView = {
    template: '#time-grid-view-template',
    props: [
        'currentView', 'visibleDates', 'weekDays', 'isToday',
        'currentTimeTop', 'dragState', 'selectedEventId', 'eventCursor',
        'getEventsWithLayout', 'getEventStyle', 'getWeekEventPosition', 'getGhostStyle', 'formatTime', 'isSameDay', 'timeFormat'
    ],
    emits: ['create-time-event', 'start-drag', 'select-event'],
    methods: {
        formatTimeLabel(hours) {
            const date = new Date();
            date.setHours(hours, 0, 0, 0);
            return this.formatTime(date.getTime());
        }
    }
};
