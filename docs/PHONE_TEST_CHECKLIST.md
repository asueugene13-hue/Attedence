# Phone test checklist

**For:** the product owner, with an Android phone (and an iPhone if one is available).
**Purpose:** check on a real phone what the automated tests cannot: the camera, Bluetooth, location, notifications and how the screens look. Everything here uses the obviously fake demo data (demo accounts, `99xxxxxx` student numbers, demo rooms), never real people.
**Status (2026-11-14):** Phase 4 was tried on a Samsung Galaxy A56 (sign-in, phone registration, Bluetooth off, no beacon). The camera (Phase 5), the Phase 6 screens and the 8.4 change (resend after a gateway error) have not been seen on a phone yet.

Write the result next to each line: ✅ works, ❌ problem (with a screenshot and what you expected), or — skipped.

## 0. Before you start

1. **Get a new app build.** The current build predates the Phase 6 screens' last changes and the gateway resend (step 8.4). Ask Claude for a new EAS development build and install the APK.
2. **Choose where the app connects:**
   - *Local (this PC):* phone on USB, then `adb reverse tcp:3000 tcp:3000` (as on 2026-11-12), with the local API running (`npm run dev -w @attendsure/api`).
   - *Rehearsal (HTTPS):* not reachable from a phone yet; it needs a real name and certificate (D-16).
3. Note the phone: make, model, Android version, app version (Profile screen).

## 1. Signing in and the phone

| # | Do this | Expect |
| --- | --- | --- |
| 1.1 | Sign in as a demo student | Home screen; the phone registers and becomes the trusted attendance phone |
| 1.2 | Sign in as the same student on a **second** phone | That phone is "waiting for approval" and cannot check in |
| 1.3 | Approve it on the web dashboard (Phones), then check in from it | Works; the first phone no longer counts |
| 1.4 | Turn the phone's clock 10 minutes wrong, try to check in | "Your phone's clock is wrong…"; set it back afterwards |
| 1.5 | Sign out and in again | Works; nothing from the previous person is shown |

## 2. Checking in (needs a class with attendance open)

Open attendance on the web dashboard as the demo lecturer (or on the lecturer's phone), with the QR on screen.

| # | Do this | Expect |
| --- | --- | --- |
| 2.1 | Scan the QR with the app's camera, in the room with the beacon | Checked in: **Present** (or **Late** after the late time) |
| 2.2 | Scan it again | Same answer; not counted twice |
| 2.3 | Screenshot the QR, wait 40 s, scan the screenshot | Refused or sent to review: the code has expired |
| 2.4 | Bluetooth off, scan | "Bluetooth is needed to check in…" |
| 2.5 | Location off, scan in the room | Still accepted on the beacon alone: a missing location is never held against a student (PRESENCE_VERIFICATION.md) |
| 2.6 | Aeroplane mode on just after scanning, then off within 2 minutes | The app says it is waiting, then sends it; counted once |
| 2.7 | Lecturer's live roster (web) while students check in | Each check-in appears within a few seconds, without reloading |
| 2.8 | After step 8.4's build: stop one API server during a check-in (only in a rehearsal set up for phones) | The app keeps waiting, then succeeds; never an error that needs a second press |

**Bluetooth and rooms (Phase 4 field test, still open):** with real beacons in two real classrooms: right room, the room next door, the corridor, outside the building, Bluetooth off, beacon removed. Write down the signal strengths the survey screen shows in each place. This sets the thresholds and closes Phase 4 (IMPLEMENTATION_PROGRESS, Phase 4 step 6).

## 3. A student's records and requests

| # | Do this | Expect |
| --- | --- | --- |
| 3.1 | My attendance → a course | Percentage, classes held, and why any class does not count |
| 3.2 | "Dispute this record" on an absence; add a reason and a photo | Sent; shows in My requests as waiting |
| 3.3 | Lecturer approves it on the web | The student gets a notification; the record changes, with the reason |
| 3.4 | Excuse request for two dates, untick one class, attach a PDF | Sent; after approval only the ticked classes are excused |
| 3.5 | Student ID card | Name, number, programme, photo, and a code that changes every 30 s |
| 3.6 | Announcements | The lecturer's and the course rep's messages, labelled; unread count goes down when opened |

## 4. Lecturer and staff on the phone

| # | Do this | Expect |
| --- | --- | --- |
| 4.1 | Lecturer: Today → open attendance, show the QR | QR changes every 15 s; roster counts update |
| 4.2 | Lecturer: check in a student by hand (assisted) | Needs a reason; shows on the roster as assisted |
| 4.3 | Staff: Check ID → scan a student's ID card code | "Genuine", with the student's photo and status; an old screenshot says "expired" |
| 4.4 | Course rep: send an update | Sent and labelled as from the course rep; a second one the same day is limited |
| 4.5 | Lecturer: class alerts (late start, review) | The notification opens the right class |

## 5. Look and feel

| # | Check | Expect |
| --- | --- | --- |
| 5.1 | App icon and the sign-in screen | The Knutsford crest, and the wordmark separate from it |
| 5.2 | Large text (Android display settings, biggest font) | Nothing cut off or overlapping |
| 5.3 | Dark mode | Readable everywhere |
| 5.4 | A small or old phone, if available | Usable; note anything slow |

When done, send the results (and screenshots of any ❌) to Claude. Problems become fixes before UAT.
