import { CopyIcon, ShareIcon } from './Icons.js';
import Tooltip from './Tooltip.js';
import { SlugManager } from '../firebase.js';

export default {
    name: 'ShareOrClaimUI',
    components: {
        'custom-tooltip': Tooltip,
        'copy-icon': CopyIcon,
        'share-icon': ShareIcon
    },
    template: `
        <div class="flex items-center justify-end text-xs min-w-0 h-8">
            <!-- Loading state -->
            <div v-if="isLoading" class="mr-2">
                <div class="flex items-center bg-1 border border-color-default rounded-full p-1 pl-3 pr-3 shadow-sm select-none opacity-70">
                    <div class="text-color-1 text-xs">Loading...</div>
                </div>
            </div>

            <template v-if="!isLoading">
                <!-- Read Only Mode -->
                <div v-if="isReadOnly">
                    <custom-tooltip align="right">
                        <template #trigger>
                            <div class="flex items-center bg-1 border border-color-default rounded-full p-1 pl-3 pr-3 shadow-sm cursor-pointer select-none hover:border-blue-500 hover:bg-[var(--bg-interactive-hover)] transition-all"
                                @click="toggleShare">
                                <!-- Share Icon -->
                                <div class="text-color-1 flex-shrink-0 mr-1.5">
                                    <share-icon class="w-4 h-4"></share-icon>
                                </div>
                                <!-- Text -->
                                <div class="text-color-1 text-xs font-bold">
                                    View Only
                                </div>
                            </div>
                        </template>
                        <template #content>
                            <p class="leading-relaxed">
                                You are in View Only mode. Events cannot be added or edited.
                            </p>
                        </template>
                    </custom-tooltip>
                </div>

                <!-- Edit Mode (Existing or New) -->
                <div v-else>
                    <!-- Existing calendar info -->
                    <div v-if="isExisting">
                        <custom-tooltip align="right">
                            <template #trigger>
                                <div class="relative flex items-center bg-1 border border-color-default rounded-full p-1 pl-3 pr-3 shadow-sm hover:border-blue-500 hover:bg-[var(--bg-interactive-hover)] cursor-pointer transition-all group select-none"
                                    @click="toggleShare">

                                    <!-- Icon -->
                                    <div class="text-color-1 group-hover:text-blue-500 transition-colors flex-shrink-0 p-1 rounded-full mr-1">
                                        <share-icon class="w-4 h-4"></share-icon>
                                    </div>

                                    <!-- URL Text -->
                                    <div class="text-color-1 text-xs truncate max-w-[150px] md:max-w-xs">
                                        pastecal.com/<span class="font-bold text-color-2" v-text="calendar.id"></span>
                                    </div>
                                </div>
                            </template>
                            <template #content>
                                <p class="leading-relaxed">
                                    Get links to share with anyone or sync to your phone.
                                </p>
                            </template>
                        </custom-tooltip>
                    </div>

                    <!-- New calendar creation -->
                    <div v-else class="flex flex-wrap md:flex-nowrap items-center gap-2 relative">
                        <custom-tooltip>
                            <template #trigger>
                                <!-- Unified Pill Container -->
                                <div class="flex items-center bg-1 border border-color-default rounded-full p-0 sm:p-1 pl-1.5 sm:pl-3 pr-0 sm:pr-1 shadow-sm focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100 transition-all max-w-full relative">
                                    <!-- Domain -->
                                    <span class="text-color-1 text-sm font-medium hidden md:inline flex-shrink-0 tracking-tight">pastecal.com/</span>
                                    <span class="text-color-1 text-sm font-medium md:hidden flex-shrink-0">/</span>

                                    <!-- Input -->
                                    <input id="slug"
                                        class="bg-transparent border-none focus:ring-0 p-0 text-sm font-bold text-color-2 w-24 md:w-40 focus:outline-none placeholder-gray-400 min-w-0"
                                        type="text" 
                                        :value="calendar.id"
                                        @input="handleSlugInput"
                                        @keyup.enter="create"
                                        placeholder="your-name">

                                    <!-- Claim Button (Integrated) -->
                                    <button @click="create"
                                        class="ml-0.5 sm:ml-1 px-2 sm:px-3 py-1 sm:py-1.5 text-white bg-blue-600 font-bold rounded-full text-xs hover:bg-blue-700 transition-colors flex-shrink-0 shadow-sm">
                                        <span class="hidden sm:inline">Claim URL</span>
                                        <span class="inline sm:hidden">Claim</span>
                                    </button>
                                </div>
                            </template>
                            <template #content>
                                <p class="leading-relaxed">
                                    Claim any URL, like \`/trip-2025\`. Everyone with the URL can edit events. Use a random ID for privacy.
                                </p>
                            </template>
                        </custom-tooltip>
                    </div>
                </div>
            </template>
        </div>
    `,
    props: {
        calendar: Object,
        isReadOnly: Boolean,
        isExisting: Boolean,
        isLoading: Boolean
    },
    emits: ['toggle-share', 'create', 'update-slug'],
    methods: {
        handleSlugInput(e) {
            this.$emit('update-slug', e.target.value);
        },
        create() {
            this.$emit('create');
        },
        toggleShare() {
            this.$emit('toggle-share');
        },
        copyToClipboard(text, target) {
            // Reuse the parent's logic or reimplement simply
            navigator.clipboard.writeText(text).then(() => {
                // simplified feedback or emit event
            });
        }
    }
};
