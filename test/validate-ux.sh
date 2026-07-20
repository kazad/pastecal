#!/bin/bash

# Validation script for NativeCal UX
# Usage: ./test/validate-ux.sh

URL="http://localhost:8000/nativecal/ux-test"
OUTPUT_DIR="snapshots"
mkdir -p $OUTPUT_DIR

# Seed Data Script (using window.dateFns directly to avoid redeclaration issues)
SEED_JS=' 
    (function() {
        const df = window.dateFns;
        const today = new Date();
        
        // Helper to set time
        const setTime = (d, h, m) => df.set(d, { hours: h, minutes: m });

        const events = [
            {
                id: "evt_1",
                title: "Strategy Retreat",
                start: setTime(today, 0, 0).getTime(),
                end: setTime(today, 23, 59).getTime(),
                isAllDay: true,
                type: 1
            },
            {
                id: "evt_2",
                title: "Team Standup",
                start: setTime(today, 9, 0).getTime(),
                end: setTime(today, 9, 30).getTime(),
                isAllDay: false,
                type: 2
            },
            {
                id: "evt_3",
                title: "Client Call",
                start: setTime(today, 9, 15).getTime(),
                end: setTime(today, 10, 0).getTime(),
                isAllDay: false,
                type: 3
            },
            {
                id: "evt_4",
                title: "Lunch with Sarah",
                start: setTime(today, 12, 0).getTime(),
                end: setTime(today, 13, 0).getTime(),
                isAllDay: false,
                type: 4
            },
            {
                id: "evt_5",
                title: "Project Review",
                start: setTime(today, 14, 0).getTime(),
                end: setTime(today, 15, 30).getTime(),
                isAllDay: false,
                type: 5
            }
        ];
        
        if (window.vm && window.vm.calendar) {
            window.vm.calendar.setEvents(events);
            // Force update if needed (Vue should handle reactivity)
        } else {
            console.error("VM not found");
        }
    })();
' 

echo "📸 Capturing Month View..."
~/dev/llm-toolbox/bin/llm-snap "$URL" \
    --exec="$SEED_JS" \
    --wait=1000 \
    --desc="ux-validation-month"

echo "📸 Capturing Week View..."
~/dev/llm-toolbox/bin/llm-snap "$URL" \
    --exec="$SEED_JS; setTimeout(() => document.querySelector('button[data-testid=view-week]').click(), 100);" \
    --wait=1000 \
    --desc="ux-validation-week"

echo "📸 Capturing Day View..."
~/dev/llm-toolbox/bin/llm-snap "$URL" \
    --exec="$SEED_JS; setTimeout(() => document.querySelector('button[data-testid=view-day]').click(), 100);" \
    --wait=1000 \
    --desc="ux-validation-day"

echo "✅ Validation complete. Check $OUTPUT_DIR for screenshots."