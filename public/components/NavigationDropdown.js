// NavigationDropdown component
// Shows homepage link and recent calendars list with pin/remove controls
const NavigationDropdown = {
    template: '#navigation-dropdown-template',
    props: ['recentCalendars'],
    emits: ['go-homepage', 'toggle-pin', 'remove-recent']
};
