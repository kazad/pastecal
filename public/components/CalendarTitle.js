// CalendarTitle component
// Handles editable/read-only calendar title display for mobile/desktop modes
const CalendarTitle = {
    template: /* html */ `
        <div class="w-full text-center">
            <!-- Show title ("New calendar" for new calendars; see Calendar.displayTitle) -->
            <component :is="heading" v-if="!isEditing"
                @click="handleTitleClick"
                :class="titleClasses">
                {{ displayTitle }}
            </component>
            <!-- Edit mode input -->
            <input v-if="isEditing"
                type="text"
                :value="title === 'New Calendar' ? displayTitle : title"
                @input="$emit('update:title', $event.target.value)"
                @blur="$emit('blur')"
                @keyup.enter="$emit('enter')"
                :ref="inputRef"
                aria-label="Calendar title"
                :class="inputClass">
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
        // The page's main heading, except on the homepage, where the draft's "New calendar" is
        // not what the page is about (the guide's headline is the h1 there).
        heading: {
            type: String,
            default: 'h1'
        }
    },
    emits: ['update:title', 'blur', 'enter', 'click'],
    computed: {
        displayTitle() {
            return Calendar.displayTitle(this.title);
        },
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
        }
    }
};
