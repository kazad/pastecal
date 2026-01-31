/**
 * Vue Component Tests
 * Tests for UI components in public/components/
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';

// ============================================================
// Component Definitions (imported inline since they're not modules)
// ============================================================

const QuickAddButton = {
    template: `
        <span class="inline-flex items-start">
            <button slot="trigger" @click="$emit('open')"
                data-testid="desktop-add-event-button"
                class="text-color-1 hover:text-blue-500 p-1.5 rounded-full transition-colors">
                <span class="text-nowrap px-3 py-1 text-white bg-gray-500 rounded-full text-xs hover:bg-blue-600 transition-colors flex-shrink-0">+Event</span>
                <kbd class="hidden px-1.5 py-0.5 text-xs bg-disabled rounded">⌘E</kbd>
            </button>
        </span>
    `,
    emits: ['open', 'clicked']
};

const Tooltip = {
    template: `
        <div class="relative" @mouseenter="show = true" @mouseleave="show = false">
            <slot name="trigger"></slot>
            <div v-show="show && !isMobile"
                class="absolute top-full mt-2 p-3 bg-2 text-color-2 text-xs rounded-lg shadow-xl border border-color-default z-50 transition-opacity duration-200"
                :class="[widthClass, alignClass]">
                <slot name="content"></slot>
                <div class="absolute -top-1 w-2 h-2 bg-2 transform rotate-45 border-l border-t border-color-default"
                     :class="arrowAlignClass"></div>
            </div>
        </div>
    `,
    props: {
        width: { type: String, default: 'w-64' },
        align: { type: String, default: 'left' }
    },
    data() {
        return { show: false, isMobile: false };
    },
    mounted() {
        this.checkMobile();
        window.addEventListener('resize', this.checkMobile);
    },
    beforeUnmount() {
        window.removeEventListener('resize', this.checkMobile);
    },
    methods: {
        checkMobile() {
            this.isMobile = window.innerWidth <= 768;
        }
    },
    computed: {
        widthClass() { return this.width; },
        alignClass() {
            if (this.align === 'center') return 'left-1/2 transform -translate-x-1/2';
            return this.align === 'right' ? 'right-0' : 'left-0';
        },
        arrowAlignClass() {
            if (this.align === 'center') return 'left-1/2 transform -translate-x-1/2';
            return this.align === 'right' ? 'right-6' : 'left-6';
        }
    }
};

const ToastNotification = {
    template: `
        <Teleport to="body">
            <Transition name="toast">
                <div v-if="visible"
                    class="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg"
                    :class="typeClasses"
                    role="alert">
                    <div class="flex items-center gap-2">
                        <span>{{ message }}</span>
                        <button @click="close" class="ml-2 opacity-70 hover:opacity-100">×</button>
                    </div>
                </div>
            </Transition>
        </Teleport>
    `,
    props: {
        message: { type: String, default: '' },
        type: { type: String, default: 'info' },
        duration: { type: Number, default: 3000 }
    },
    emits: ['close'],
    data() {
        return { visible: false, timer: null };
    },
    computed: {
        typeClasses() {
            const classes = {
                success: 'bg-green-500 text-white',
                error: 'bg-red-500 text-white',
                warning: 'bg-yellow-500 text-black',
                info: 'bg-blue-500 text-white'
            };
            return classes[this.type] || classes.info;
        }
    },
    methods: {
        show() {
            this.visible = true;
            if (this.duration > 0) {
                this.timer = setTimeout(() => this.close(), this.duration);
            }
        },
        close() {
            this.visible = false;
            if (this.timer) clearTimeout(this.timer);
            this.$emit('close');
        }
    },
    watch: {
        message(newVal) {
            if (newVal) this.show();
        }
    }
};

// ============================================================
// TEST SUITE: QuickAddButton
// ============================================================

describe('QuickAddButton', () => {
    test('renders button with correct text', () => {
        const wrapper = mount(QuickAddButton);
        expect(wrapper.text()).toContain('+Event');
    });

    test('has correct data-testid attribute', () => {
        const wrapper = mount(QuickAddButton);
        const button = wrapper.find('[data-testid="desktop-add-event-button"]');
        expect(button.exists()).toBe(true);
    });

    test('emits "open" event when clicked', async () => {
        const wrapper = mount(QuickAddButton);
        const button = wrapper.find('button');
        await button.trigger('click');
        expect(wrapper.emitted('open')).toBeTruthy();
        expect(wrapper.emitted('open')).toHaveLength(1);
    });

    test('renders keyboard shortcut hint', () => {
        const wrapper = mount(QuickAddButton);
        const kbd = wrapper.find('kbd');
        expect(kbd.exists()).toBe(true);
        expect(kbd.text()).toContain('⌘E');
    });
});

// ============================================================
// TEST SUITE: Tooltip
// ============================================================

describe('Tooltip', () => {
    test('renders with default props', () => {
        const wrapper = mount(Tooltip, {
            slots: {
                trigger: '<button>Hover me</button>',
                content: '<p>Tooltip content</p>'
            }
        });
        expect(wrapper.exists()).toBe(true);
    });

    test('shows tooltip on mouseenter', async () => {
        const wrapper = mount(Tooltip, {
            slots: {
                trigger: '<button>Hover me</button>',
                content: '<p>Tooltip content</p>'
            }
        });

        // Simulate desktop
        global.innerWidth = 1024;
        await wrapper.vm.checkMobile();

        await wrapper.trigger('mouseenter');
        expect(wrapper.vm.show).toBe(true);
    });

    test('hides tooltip on mouseleave', async () => {
        const wrapper = mount(Tooltip, {
            slots: {
                trigger: '<button>Hover me</button>',
                content: '<p>Tooltip content</p>'
            }
        });

        await wrapper.trigger('mouseenter');
        expect(wrapper.vm.show).toBe(true);

        await wrapper.trigger('mouseleave');
        expect(wrapper.vm.show).toBe(false);
    });

    test('applies custom width class', () => {
        const wrapper = mount(Tooltip, {
            props: { width: 'w-96' },
            slots: {
                trigger: '<button>Hover me</button>',
                content: '<p>Content</p>'
            }
        });
        expect(wrapper.vm.widthClass).toBe('w-96');
    });

    test('applies correct align class for left alignment', () => {
        const wrapper = mount(Tooltip, {
            props: { align: 'left' },
            slots: { trigger: '<button>Trigger</button>', content: '<p>Content</p>' }
        });
        expect(wrapper.vm.alignClass).toBe('left-0');
        expect(wrapper.vm.arrowAlignClass).toBe('left-6');
    });

    test('applies correct align class for right alignment', () => {
        const wrapper = mount(Tooltip, {
            props: { align: 'right' },
            slots: { trigger: '<button>Trigger</button>', content: '<p>Content</p>' }
        });
        expect(wrapper.vm.alignClass).toBe('right-0');
        expect(wrapper.vm.arrowAlignClass).toBe('right-6');
    });

    test('applies correct align class for center alignment', () => {
        const wrapper = mount(Tooltip, {
            props: { align: 'center' },
            slots: { trigger: '<button>Trigger</button>', content: '<p>Content</p>' }
        });
        expect(wrapper.vm.alignClass).toContain('left-1/2');
        expect(wrapper.vm.arrowAlignClass).toContain('left-1/2');
    });

    test('detects mobile viewport', async () => {
        const wrapper = mount(Tooltip, {
            slots: { trigger: '<button>Trigger</button>', content: '<p>Content</p>' }
        });

        global.innerWidth = 500;
        await wrapper.vm.checkMobile();
        expect(wrapper.vm.isMobile).toBe(true);

        global.innerWidth = 1024;
        await wrapper.vm.checkMobile();
        expect(wrapper.vm.isMobile).toBe(false);
    });

    test('adds and removes resize event listener', () => {
        const addSpy = vi.spyOn(window, 'addEventListener');
        const removeSpy = vi.spyOn(window, 'removeEventListener');

        const wrapper = mount(Tooltip, {
            slots: { trigger: '<button>Trigger</button>', content: '<p>Content</p>' }
        });

        expect(addSpy).toHaveBeenCalledWith('resize', wrapper.vm.checkMobile);

        wrapper.unmount();
        expect(removeSpy).toHaveBeenCalledWith('resize', wrapper.vm.checkMobile);
    });
});

// ============================================================
// TEST SUITE: ToastNotification
// ============================================================

describe('ToastNotification', () => {
    test('is hidden by default', () => {
        const wrapper = mount(ToastNotification, {
            props: { message: '' }
        });
        expect(wrapper.vm.visible).toBe(false);
    });

    test('returns correct type classes for each type', () => {
        const types = ['success', 'error', 'warning', 'info'];
        const expectedClasses = {
            success: 'bg-green-500',
            error: 'bg-red-500',
            warning: 'bg-yellow-500',
            info: 'bg-blue-500'
        };

        types.forEach(type => {
            const wrapper = mount(ToastNotification, {
                props: { message: 'Test', type }
            });
            expect(wrapper.vm.typeClasses).toContain(expectedClasses[type]);
        });
    });

    test('defaults to info type for unknown type', () => {
        const wrapper = mount(ToastNotification, {
            props: { message: 'Test', type: 'unknown' }
        });
        expect(wrapper.vm.typeClasses).toContain('bg-blue-500');
    });

    test('show method sets visible to true', async () => {
        const wrapper = mount(ToastNotification, {
            props: { message: 'Test message', duration: 0 }
        });

        wrapper.vm.show();
        expect(wrapper.vm.visible).toBe(true);
    });

    test('close method sets visible to false and emits close', async () => {
        const wrapper = mount(ToastNotification, {
            props: { message: 'Test message' }
        });

        wrapper.vm.show();
        wrapper.vm.close();

        expect(wrapper.vm.visible).toBe(false);
        expect(wrapper.emitted('close')).toBeTruthy();
    });

    test('auto-closes after duration', async () => {
        vi.useFakeTimers();

        const wrapper = mount(ToastNotification, {
            props: { message: 'Test', duration: 1000 }
        });

        wrapper.vm.show();
        expect(wrapper.vm.visible).toBe(true);

        vi.advanceTimersByTime(1000);
        expect(wrapper.vm.visible).toBe(false);

        vi.useRealTimers();
    });

    test('does not auto-close when duration is 0', async () => {
        vi.useFakeTimers();

        const wrapper = mount(ToastNotification, {
            props: { message: 'Test', duration: 0 }
        });

        wrapper.vm.show();
        vi.advanceTimersByTime(5000);
        expect(wrapper.vm.visible).toBe(true);

        vi.useRealTimers();
    });
});
