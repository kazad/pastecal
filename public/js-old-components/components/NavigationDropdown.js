import { StarIcon, TrashIcon } from './Icons.js';

export default {
    name: 'NavigationDropdown',
    components: {
        'star-icon': StarIcon,
        'trash-icon': TrashIcon
    },
    template: `
        <div class="absolute top-full left-0 md:left-0 mt-2 bg-1 min-w-[280px] md:min-w-[280px] w-[90vw] md:w-auto max-w-[280px] shadow-lg rounded-lg border border-color-default overflow-hidden z-50">
            <!-- Home / New Calendar option -->
            <a @click.prevent="$emit('go-homepage')"
                class="flex items-center px-4 py-3 text-color-2 hover:bg-1 transition-colors cursor-pointer group">
                <div class="mr-3 text-color-1 group-hover:text-blue-500 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
                    </svg>
                </div>
                <span class="font-medium group-hover:text-blue-500 transition-colors">Home [New Calendar]</span>
            </a>

            <!-- Recent calendars -->
            <div v-if="recentCalendars.length > 0">
                <div class="px-4 py-2 text-xs font-semibold text-color-1 uppercase tracking-wider bg-1 border-t border-color-default">
                    Recent Calendars
                </div>
                <div class="max-h-[36rem] overflow-y-auto">
                    <div v-for="item in recentCalendars" :key="item.id"
                        class="flex justify-between items-center px-4 py-3 hover:bg-1 transition-colors group">
                        <a :href="'/' + item.id" class="flex-1 min-w-0 mr-3">
                            <div class="text-color-2 font-medium truncate group-hover:text-blue-500 transition-colors">
                                {{ item.title }}
                            </div>
                            <div class="text-xs text-color-1 truncate">
                                pastecal.com/{{ item.id }}
                            </div>
                        </a>
                        <div class="flex items-center gap-1 transition-opacity"
                            :class="{ 'opacity-100': item.pinned, 'opacity-0 group-hover:opacity-100': !item.pinned }">
                            <button @click.stop="$emit('toggle-pin', item.id)"
                                class="p-1.5 rounded-md hover:bg-1 transition-colors text-color-1"
                                :class="{ 'text-color-2': item.pinned }"
                                :title="item.pinned ? 'Unpin calendar' : 'Pin calendar'">
                                <star-icon :filled="item.pinned" class="w-4 h-4"></star-icon>
                            </button>
                            <button @click.stop="$emit('remove-recent', item.id)"
                                class="p-1.5 rounded-md text-color-1 hover:text-red-500 hover:bg-1 transition-colors"
                                title="Remove from recent">
                                <trash-icon class="w-4 h-4"></trash-icon>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div v-if="recentCalendars.length === 0" class="px-4 py-6 text-center">
                <div class="w-8 h-8 mx-auto mb-2 text-color-1 opacity-50 flex justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                </div>
                <p class="text-sm text-color-1">No recent calendars yet</p>
                <p class="text-xs text-color-1 opacity-60 mt-1">Your calendars will appear here</p>
            </div>
        </div>
    `,
    props: ['recentCalendars'],
    emits: ['go-homepage', 'toggle-pin', 'remove-recent']
};
