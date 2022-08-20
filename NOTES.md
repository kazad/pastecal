IN PROGRESS:

FUTURE:

- Style top bar similar to instacalc
- Remember recents in localstorage
- Readonly flag
- Password protection
- Safer writing / conflict avoidance (https://firebase.google.com/docs/database/admin/save-data#node.js_8)
- Have public version. So, we have pastecal.com/zad (as public) and pastecal.com/zad?key=1234 as private. The key (hashed) gives the ID to subscribe to?
- Better (official) field (see: https://ej2.syncfusion.com/demos/ Scheduler > Editor > Window > Editor Template)

DONE:

- Event color
- Disable touch events for mobile (to avoid accidental changes)
- Add google tag manager and hotjar
- Date and view params (pastecal.com/test?d=2022-04-1&v=day)
- Add hotjar for feedback / recording
- Help / tour button
- Figure out creation and permissions issue
- Rename Calendar Title
- Visiting URL directly (/doesnotexist) should have button to create
- Have mode for full 24 hours
- Make it responsive (with all-hours moved via JS to just below the nav)
- Have it save the calendar to localstorage until you share it
- 5am mode

Security model:

```
calendars : {
    $GUID : {
        title,
        events,
        sharedID
    }
}

lookup : {
    $code : {
       GUID: $GUID
    }
}

shared : {
    sharedID :  {
        data
    }
}
```

- Issue: once you make a shortcode, it's in the ledger.
- When you password protect it, we're moving it from the ledger to
- We have server-side functions which are "registerShortcode(code, GUID)" and "protectShortcode(code, encrtyptedGUID)"
- Once it's password protected, can't be un-protected [for simplicity]
- One of the problems is anyone can make a test calendar, then decide to password protect it. Any user has admin access. ok.
- We should have server-side functions which are doing the syncing here? Or keep it simple. Have the client write to the shared entry as needed.
