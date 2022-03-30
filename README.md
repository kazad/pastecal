TODO
Tell Joey if we make the website: https://github.com/joereynolds/what-to-code#websites

Use cases:

- On homepage, make a calendar, share with 1 click. No logins. Can use random/default ID or pick your own.
- Visiting pastecal.com/ID creates the calendar (prefilled option to create)
- Visiting homepage, make changes, stored in localstorage. Refresh page, changes still there.

TODO:

- Add google tag manager and hotjar

FUTURE:

- Add hotjar for feedback / recording
- Style top bar similar to instacalc
- Event color (based on hashtag?)
- Remember recents in localstorage
- Help/tour button
- Readonly flag
- Password protection
- Safer writing / conflict avoidance (https://firebase.google.com/docs/database/admin/save-data#node.js_8)
- Have public version. So, we have pastecal.com/zad (as public) and pastecal.com/zad?key=1234 as private. The key (hashed) gives the ID to subscribe to?

DONE:

- Figure out creation and permissions issue
- Rename Calendar Title
- Visiting URL directly (/doesnotexist) should have button to create
- Have mode for full 24 hours
- Make it responsive (with all-hours moved via JS to just below the nav)
- Have it save the calendar to localstorage until you share it
- 5am mode

Security model:

- All calendars are stored by GUID (firebase-generated)
- Anyone can create an entry in the ledger. This maps a shortcodel (/zad: GUID) to the GUID. Cannot be changed once mapped.
- If you password protect a calc, the shortcode (/zad)
