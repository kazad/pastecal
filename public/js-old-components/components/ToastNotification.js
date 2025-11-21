import { CheckIcon, XIcon, InfoIcon } from './Icons.js';

export default {
    name: 'ToastNotification',
    components: { CheckIcon, XIcon, InfoIcon },
    template: `
        <transition 
            enter-active-class="transform ease-out duration-300 transition"
            enter-from-class="translate-y-2 opacity-0 sm:translate-y-0 sm:translate-x-2"
            enter-to-class="translate-y-0 opacity-100 sm:translate-x-0"
            leave-active-class="transition ease-in duration-100"
            leave-from-class="opacity-100"
            leave-to-class="opacity-0">
            <div v-if="show" class="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-[100] w-full max-w-sm px-4">
                <div class="w-full bg-2 border border-color-default shadow-lg rounded-lg pointer-events-auto ring-1 ring-black ring-opacity-5 overflow-hidden">
                    <div class="p-4">
                        <div class="flex items-start">
                            <div class="flex-shrink-0">
                                <!-- Success Icon -->
                                <check-icon v-if="type === 'success'" class="h-6 w-6 text-green-400"></check-icon>
                                <!-- Error Icon -->
                                <x-icon v-if="type === 'error'" class="h-6 w-6 text-red-400"></x-icon>
                                <!-- Info Icon -->
                                <info-icon v-if="type === 'info'" class="h-6 w-6 text-blue-400"></info-icon>
                            </div>
                            <div class="ml-3 w-0 flex-1 pt-0.5">
                                <p class="text-sm font-medium text-color-2">
                                    {{ message }}
                                </p>
                            </div>
                            <div class="ml-4 flex-shrink-0 flex">
                                <button @click="hide" class="bg-transparent rounded-md inline-flex text-color-1 hover:text-color-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
                                    <span class="sr-only">Close</span>
                                    <x-icon class="h-5 w-5"></x-icon>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </transition>
    `,
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
