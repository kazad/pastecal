// QuickAddButton Component
// Presentational trigger button for quick-add dialog

const QuickAddButton = {
    template: /* html */ `
        <span class="inline-flex items-start">
                <button slot="trigger" @click="$emit('open')"
                    data-testid="desktop-add-event-button"
                    class="text-color-1 hover:text-blue-500 p-1.5 rounded-full transition-colors">
                    <span class="text-nowrap px-3 py-1 text-white bg-gray-500 rounded-full text-xs hover:bg-blue-600 transition-colors flex-shrink-0">+Event</span>
                    <kbd class="hidden px-1.5 py-0.5 text-xs bg-disabled rounded">⌘E</kbd>
                </button>
        </span>
    `,
    // No props - dialog is a single shared instance
    emits: ['open', 'clicked']
};
