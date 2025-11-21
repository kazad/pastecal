// ToastNotification Component
// Displays toast messages with success/error/info types

const ToastNotification = {
    template: '#toast-notification-template',
    data() {
        return {
            show: false,
            message: '',
            type: 'info',
            timer: null
        }
    },
    methods: {
        display(message, type = 'info') {
            this.message = message;
            this.type = type;
            this.show = true;

            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                this.hide();
            }, 3000);
        },
        hide() {
            this.show = false;
        }
    }
};
