
export default {
    name: 'Tooltip',
    template: `
        <div class="relative" @mouseenter="show = true" @mouseleave="show = false">
            <slot name="trigger"></slot>
            <div v-show="show && !isMobile" 
                class="absolute top-full mt-2 p-3 bg-2 text-color-2 text-xs rounded-lg shadow-xl border border-color-default z-50 transition-opacity duration-200"
                :class="[widthClass, alignClass]">
                
                <slot name="content"></slot>
                
                <!-- Arrow -->
                <div class="absolute -top-1 w-2 h-2 bg-2 transform rotate-45 border-l border-t border-color-default"
            </div>
        </div>
    `,
    props: {
        width: {
            type: String,
            default: 'w-64'
        },
        align: {
            type: String,
            default: 'left' // 'left' or 'right'
        }
    },
    data() {
        return {
            show: false,
            isMobile: false
        }
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
            this.isMobile = window.innerWidth <= 768; // Adjust breakpoint as needed
        }
    },
    computed: {
        widthClass() {
            return this.width;
        },
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
