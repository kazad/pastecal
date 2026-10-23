// NavigationDropdown component
// "New calendar", then your calendars and recently visited ones, with pin/remove controls
const NavigationDropdown = {
    template: /* html */ `
        <div class="pc-nav absolute top-full left-0 mt-2 bg-1 shadow-xl border border-color-default overflow-hidden z-50">
            <!-- Starts a fresh draft on the homepage -->
            <a href="/" @click.prevent="$emit('go-homepage')"
                class="pc-nav-row pc-nav-new flex items-center text-color-2 hover:bg-theme-hover transition-colors cursor-pointer group">
                <span class="pc-nav-plus">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>
                </span>
                <span class="min-w-0">
                    <span class="block font-semibold group-hover:text-blue-500 transition-colors">New calendar</span>
                    <span class="block text-xs text-color-1">No sign-up. Share it when it's ready.</span>
                </span>
            </a>

            <!-- Calendars grouped by ownership: yours first, then ones you visited -->
            <div v-if="recentCalendars.length > 0" class="pc-nav-list">
                <template v-for="group in groups" :key="group.label">
                <div v-if="group.items.length > 0">
                <div class="pc-nav-label text-xs font-semibold text-color-1 border-t border-color-default">
                    {{ group.label }}
                </div>
                <div>
                    <div v-for="item in group.items" :key="item.id"
                        class="pc-nav-row flex justify-between items-center hover:bg-theme-hover transition-colors group">
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
                                class="p-1.5 rounded-md hover:bg-theme-hover transition-colors text-color-1"
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
                                class="p-1.5 rounded-md text-color-1 hover:text-red-500 hover:bg-theme-hover transition-colors"
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
                </template>
            </div>

            <p v-if="recentCalendars.length === 0" class="pc-nav-empty border-t border-color-default text-sm text-color-1">
                Calendars you open or save show up here, so you can find them again.
            </p>
        </div>
    `,
    props: ['recentCalendars'],
    emits: ['go-homepage', 'toggle-pin', 'remove-recent'],
    computed: {
        // Calendars you created are listed separately from ones you merely visited:
        // in a no-login product this list is the only route back to your own work.
        groups() {
            const all = this.recentCalendars || [];
            return [
                { label: 'Your calendars', items: all.filter(item => item.mine) },
                { label: 'Recently visited', items: all.filter(item => !item.mine) },
            ];
        }
    }
};
