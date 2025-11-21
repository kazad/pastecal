export default class RecentCalendars {
    constructor() {
        this.load();
    }

    load() {
        this.items = JSON.parse(localStorage.getItem('recentCalendars')) || [];
    }

    save() {
        localStorage.setItem('recentCalendars', JSON.stringify(this.items));
    }

    add(id, title) {
        // Find existing item to preserve pinned state
        const existingItem = this.items.find(item => item.id === id);
        const wasPinned = existingItem ? existingItem.pinned : false;
        
        // Remove if exists
        this.items = this.items.filter(item => item.id !== id);
        
        // Add to front, preserving pinned state
        this.items.unshift({
            id: id,
            title: title || id,
            pinned: wasPinned, // Preserve existing pinned state
            lastVisited: new Date().toISOString()
        });

        // Keep only last 10 unpinned items
        const pinnedItems = this.items.filter(item => item.pinned);
        const unpinnedItems = this.items.filter(item => !item.pinned).slice(0, 10);
        this.items = [...pinnedItems, ...unpinnedItems];

        this.save();
    }

    remove(id) {
        this.items = this.items.filter(item => item.id !== id);
        this.save();
    }

    togglePin(id) {
        const item = this.items.find(item => item.id === id);
        if (item) {
            item.pinned = !item.pinned;
            this.save();
        }
    }

    getAll() {
        return [...this.items].sort((a, b) => {
            // Pinned items first
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            // Then by last visited
            return new Date(b.lastVisited) - new Date(a.lastVisited);
        });
    }
}
