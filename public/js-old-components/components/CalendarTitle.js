import { NotesIcon } from './Icons.js';
import Tooltip from './Tooltip.js';

export default {
    name: 'CalendarTitle',
    components: {
        'notes-icon': NotesIcon,
        'custom-tooltip': Tooltip
    },
    template: `
        <div class="calendar-title-component w-full text-center flex justify-center items-center gap-1">
            <!-- Edit Mode -->
            <input v-if="isEditing"
                type="text"
                :value="title"
                @input="$emit('update:title', $event.target.value)"
                @blur="$emit('blur')"
                @keyup.enter="$emit('enter', $event)"
                :ref="inputRef"
                aria-label="Calendar title"
                :class="inputClass">

            <!-- View Mode -->
            <template v-else>
                <!-- Desktop + Editable: Show Title with Tooltip -->
                <custom-tooltip width="w-auto" align="center" v-if="!isReadOnly && mode === 'desktop'">
                    <template #trigger>
                        <h1 @click="handleTitleClick" :class="titleClasses">
                            {{ title || 'New Calendar' }}
                        </h1>
                    </template>
                    <template #content>
                        <span class="whitespace-nowrap">Click to edit title</span>
                    </template>
                </custom-tooltip>

                <!-- Mobile OR ReadOnly: Just Title -->
                <h1 v-else
                    @click="handleTitleClick"
                    :class="titleClasses">
                    {{ title || 'New Calendar' }}
                </h1>

                <!-- Notes Button -->
                <custom-tooltip width="w-auto" align="center" v-if="showNotesButton && !isEditing">
                    <template #trigger>
                        <button v-on:click="handleToggleNotes"
                            aria-label="Toggle notes"
                            class="text-color-1 hover:text-blue-500 p-1.5 rounded-full transition-colors flex items-center justify-center h-8">
                            <notes-icon class="w-5 h-5"></notes-icon>
                            <span v-if="mode === 'desktop'" class="ml-0.5 text-xs hidden lg:inline">Notes</span>
                        </button>
                    </template>
                    <template #content>
                        <span class="whitespace-nowrap">Toggle Notes</span>
                    </template>
                </custom-tooltip>
            </template>
        </div>
    `,
    props: {
        title: String,
        isEditing: Boolean,
        isReadOnly: Boolean,
        mode: {
            type: String,
            default: 'mobile', // 'mobile' or 'desktop'
            validator: (value) => ['mobile', 'desktop'].includes(value)
        },
        inputRef: {
            type: String,
            default: 'titleInput'
        },
        showNotesButton: Boolean,
        toggleNotes: Function,
    },
    emits: ['update:title', 'blur', 'enter', 'click'],
    computed: {
        brandingClass() {
            return this.mode === 'mobile'
                ? 'text-base font-bold text-color-2 leading-tight'
                : 'text-lg font-bold text-color-2 leading-tight';
        },
        taglineClass() {
            return 'text-color-1 text-xs -mt-0.5 text-[10px]';
        },
        titleClasses() {
            const base = this.mode === 'mobile'
                ? 'text-sm font-semibold text-color-2 leading-tight truncate text-center block'
                : 'font-bold max-w-[150px] md:max-w-xs text-center inline-block leading-tight py-1';

            const interactive = !this.isReadOnly
                ? 'cursor-pointer hover:text-blue-500 transition-colors px-1 py-0.5 rounded hover:bg-[var(--bg-interactive-hover)]'
                : 'px-1';

            return [base, interactive].filter(Boolean).join(' ');
        },
        inputClass() {
            return this.mode === 'mobile'
                ? 'w-full bg-1 border-2 border-blue-500 rounded text-base font-bold focus:outline-none focus:ring-2 focus:ring-blue-300 px-2 py-1 text-color-2 leading-tight text-center'
                : 'border border-color-default p-1 max-w-[150px] md:max-w-xs h-8';
        }
    },
    methods: {
        handleTitleClick() {
            if (!this.isReadOnly) {
                this.$emit('click');
            }
        },
        handleToggleNotes() {
            if (this.toggleNotes) {
                this.toggleNotes();
            }
        }
    }
};
