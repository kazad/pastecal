// Tooltip Component
// Reusable tooltip wrapper with mobile detection

const Tooltip = {
    template: '#tooltip-template',
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
