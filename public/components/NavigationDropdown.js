// NavigationDropdown component
// Shows homepage link and recent calendars list with pin/remove controls
const NavigationDropdown = {
    template: /* html */ `
        <div class="absolute top-full left-0 md:left-0 mt-2 bg-1 min-w-[280px] md:min-w-[280px] w-[90vw] md:w-auto max-w-[280px] shadow-lg rounded-lg border border-color-default overflow-hidden z-50">
            <!-- Home / New Calendar option -->
            <a @click.prevent="$emit('go-homepage')"
                class="flex items-center px-4 py-3 text-color-2 hover:bg-1 transition-colors cursor-pointer group">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
                    stroke-width="1.5" stroke="currentColor"
                    class="w-5 h-5 mr-3 text-color-1 group-hover:text-blue-500 transition-colors">
                    <path stroke-linecap="round" stroke-linejoin="round"
                        d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
                </svg>
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
                                <!-- Filled star when pinned -->
                                <svg v-if="item.pinned" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5">
                                    <path fill-rule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z" clip-rule="evenodd" />
                                </svg>
                                <!-- Outline star when not pinned -->
                                <svg v-else xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
                                </svg>
                            </button>
                            <button @click.stop="$emit('remove-recent', item.id)"
                                class="p-1.5 rounded-md text-color-1 hover:text-red-500 hover:bg-1 transition-colors"
                                title="Remove from recent">
                                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none"
                                    viewBox="0 0 24 24" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                        d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div v-if="recentCalendars.length === 0" class="px-4 py-6 text-center">
                <svg xmlns="http://www.w3.org/2000/svg"
                    class="w-8 h-8 mx-auto mb-2 text-color-1 opacity-50" fill="none" viewBox="0 0 24 24"
                    stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p class="text-sm text-color-1">No recent calendars yet</p>
                <p class="text-xs text-color-1 opacity-60 mt-1">Your calendars will appear here</p>
            </div>
        </div>
    `,
    props: ['recentCalendars'],
    emits: ['go-homepage', 'toggle-pin', 'remove-recent']
};
