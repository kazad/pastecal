const NativeMonthView = {
    template: '#month-view-template',
    props: ['cells', 'weekDays', 'dragState', 'getEventsForDate', 'getEventStyle', 'isToday'],
    emits: ['create-event', 'start-drag', 'select-event']
};
