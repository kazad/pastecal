// QuickAddButton Component
// Presentational trigger button for quick-add dialog

const QuickAddButton = {
    template: '#quick-add-button-template',
    // No props - dialog is a single shared instance
    emits: ['open', 'clicked']
};
