#!/bin/bash
URL="http://localhost:8000/nativecal/recurrence-test"
OUTPUT_DIR="snapshots/debug"
mkdir -p $OUTPUT_DIR

SEED_JS='
    (function() {
        const df = window.dateFns;
        const today = new Date();
        const setTime = (d, h, m) => df.set(d, { hours: h, minutes: m });

        const events = [
            {
                id: "evt_rec_1",
                title: "Weekly Meeting",
                start: setTime(today, 10, 0).getTime(),
                end: setTime(today, 11, 0).getTime(),
                isAllDay: false,
                type: 1,
                recurrencerule: "FREQ=WEEKLY"
            }
        ];
        
        if (window.vm && window.vm.calendar) {
            window.vm.calendar.setEvents(events);
            
            // Open editor for this event
            setTimeout(() => {
                const evt = window.vm.calendar.events[0];
                window.vm.openEditorForEvent(evt);
            }, 500);
        }
    })();
'

echo "📸 Debugging Recurrence Editor..."
~/dev/llm-toolbox/bin/llm-snap "$URL" \
    --exec="$SEED_JS" \
    --wait=2000 \
    --desc="recurrence-editor-check"

echo "Check snapshots/debug/screen-*-recurrence-editor-check.png"
