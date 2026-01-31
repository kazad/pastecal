/**
 * Test setup file for Vitest
 * Provides mocks for global dependencies used by components
 */

import { vi } from 'vitest';

// Mock Utils global object
global.Utils = {
    uuidv4: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9),
    nanoid: (length = 8) => Math.random().toString(36).substr(2, length),
    parseHumanWrittenCalendar: (entry) => ({
        subject: entry.replace(/tomorrow|today|next\s+\w+/gi, '').trim() || 'Untitled Event',
        startDateTime: new Date().toISOString(),
        endDateTime: new Date(Date.now() + 3600000).toISOString()
    }),
    formatDate: (date) => new Date(date).toLocaleDateString(),
    formatTime: (date) => new Date(date).toLocaleTimeString(),
    debounce: (fn, delay) => fn,
    throttle: (fn, delay) => fn
};

// Mock localStorage
const localStorageMock = {
    store: {},
    getItem: vi.fn((key) => localStorageMock.store[key] || null),
    setItem: vi.fn((key, value) => { localStorageMock.store[key] = value; }),
    removeItem: vi.fn((key) => { delete localStorageMock.store[key]; }),
    clear: vi.fn(() => { localStorageMock.store = {}; })
};
global.localStorage = localStorageMock;

// Mock window properties
global.innerWidth = 1024;
global.innerHeight = 768;

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn()
}));

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn()
}));

// Reset mocks between tests
beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.store = {};
});
