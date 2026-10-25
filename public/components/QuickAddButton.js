// QuickAddButton Component
// Presentational trigger button for quick-add dialog

const QuickAddButton = {
    template: /* html */ `
        <span class="inline-flex items-start">
                <button slot="trigger" @click="$emit('open')"
                    data-testid="desktop-add-event-button"
                    class="text-color-1 hover:text-blue-500 p-1.5 rounded-full transition-colors">
                    <span class="pc-add-event"><span aria-hidden="true" class="pc-add-event-plus">+</span>Add event<kbd
                        aria-hidden="true" class="pc-add-event-kbd" data-testid="add-event-shortcut">{{ shortcut }}</kbd></span>
                </button>
        </span>
    `,
    // No props - dialog is a single shared instance
    emits: ['open', 'clicked'],
    computed: {
        // The Cmd/Ctrl+E shortcut (QuickAddDialog.handleKeydown), spelled for this keyboard.
        // Decorative: aria-hidden, so the button's name stays "Add event". Hidden on phones (style.css).
        shortcut() {
            const nav = typeof navigator !== 'undefined' ? navigator : {};
            const platform = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || '';
            return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘E' : 'Ctrl E';
        }
    }
};
