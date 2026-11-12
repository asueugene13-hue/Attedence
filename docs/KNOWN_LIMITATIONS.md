# Known limitations

AttendSure makes proxy and remote attendance much harder, but no phone-based system can prove who is physically in a room. This page lists what the design cannot guarantee, so that nobody is surprised later.

**Status:** updated 2026-11-08 (Phase 0). New limitations are added as they are discovered in each phase.

## Presence verification

1. **Bluetooth passes through walls.** A student in the next room or the corridor may hear the beacon. Calibrated thresholds and the "weak signal goes to lecturer review" rule reduce this. They cannot remove it, and some rooms may need extra beacons.
2. **Signal strength is noisy.** RSSI changes with the phone model, the pocket or bag, the student's body and how crowded the room is. Thresholds come from site surveys and must be re-checked when furniture or beacons move.
3. **Indoor GPS is imprecise.** Indoor readings are often 20–100 m off and sometimes worse. GPS is supporting evidence only. It cannot tell one room from the next.
4. **Collusion can still work.** A classmate who carries an absent student's phone, signed in and trusted, into the room can produce a valid check-in. Defences: one trusted phone per student, shared-device detection, roster photos for lecturers, and comparing the headcount with verified counts. Stopping this completely would need biometrics, which are deliberately out of scope.
5. **Live relay.** An accomplice in class can forward the QR in real time, but the remote student's phone still needs the classroom beacon. Relaying a rotating beacon signal in real time is technically possible, though much harder. It would show up as a beacon-location conflict when GPS is accurate.
6. **Fixed-ID beacons can be copied.** If rotating-ID beacons prove unavailable or too expensive (D-08), fixed-ID beacons are weaker. That risk is accepted only with the GPS cross-check and risk flags in place.
7. **iPhones and iBeacon.** iPhones hide iBeacon packets from ordinary Bluetooth scanning. The beacon choice must account for this (risk R2).
8. **Phones without Bluetooth Low Energy, or students without smartphones,** depend on lecturer-assisted check-in.
9. **Integrity checks are imperfect.** Some genuine phones fail Play Integrity or App Attest, and some tampered phones pass. Failures send check-ins to review, never to automatic rejection.

## Operations

10. **Push notifications are best-effort.** Android battery savers, iOS focus modes and an expired FCM token can delay or drop a push. The in-app notification centre is the record, and critical messages can also go by email or SMS.
11. **Connectivity.** Students need mobile data or Wi-Fi to check in. The 2-minute offline grace caps outcomes at "pending". If the lecturer's screen loses connection, the QR stops rotating until it reconnects. Lecturer-assisted check-in remains available.
12. **Lecturer response time.** Class monitoring depends on lecturers answering prompts and administrators deciding reviews. Unanswered prompts escalate, but a class can stay UNDER_REVIEW until a person decides.
13. **Thresholds are first guesses.** The 15-minute and 30-minute timings, the report thresholds, the attendance cut-offs and the RSSI levels are defaults. They need tuning with real Knutsford data (D-09, D-13).

## Scope

14. **No biometrics,** by design.
15. **One university only.** The design is for Knutsford University. Supporting other institutions would need real multi-tenant isolation, which it does not have.
16. **Not legal advice.** The privacy design supports Act 843 principles, but compliance is decided by the university with its own legal and data-protection staff.

## Sign-in (Phase 1, step 4)

17. **The common-password list is a starter list** of about 60 entries. Checking new passwords against a full breached-password corpus (for example a downloaded Have I Been Pwned range file) is a later improvement.
18. **Rate limits are per IP address, and campuses share addresses.** A whole class on campus Wi-Fi can appear as one IP (NAT), so the default limit is deliberately high (3,000 requests a minute per IP). Sign-in uses a tighter limit per IP *and* email, so one student's mistakes do not block classmates. Per-user limits for signed-in routes arrive with the busy endpoints (check-in, Phase 5). If Redis is down, limits are skipped (logged), while account lock-out still applies.
19. **Strict refresh-token reuse detection.** If the same web session refreshes from two browser tabs at exactly the same moment, the second request looks like a stolen token and ends the session, so the user signs in again. This trades occasional inconvenience for safety. The web dashboard (step 7) will refresh from one place to avoid it.
20. **Reset emails are sent directly, not through the job queue.** A failed send is logged but not retried. Phase 3 moves email onto the worker with retries and delivery records.

## Web dashboard (Phase 1, step 7)

21. **Scripts are not yet restricted by Content-Security-Policy on the dashboard.** Framing, plugins, base URLs and form targets are locked down, but Next.js injects inline scripts, so a nonce-based script policy needs middleware. Planned before production (Phase 8).
22. **Page protection in the browser is a convenience.** Signed-in pages check the session in the browser; the API checks every request, so a person who reaches a page they may not use sees no data.
23. **The Inter font is not bundled.** The font stack starts with Inter, but falls back to the system font (Segoe UI on Windows) unless Inter is installed. Bundling it is a small later task.
24. **The dashboard proxies `/api/v1` to the API**, and the proxy target is fixed at build time (`API_INTERNAL_URL`). In production the load balancer should route `/api` straight to the API on the same domain.

## Mobile app (Phase 1, step 8)

25. **The native Android app has not been built or run yet.** This PC lacks JDK 17 and the Android SDK; the Java 17 install was cancelled at the Windows permission prompt. The app's JavaScript is type-checked, unit-tested, bundled for Android (`expo export`) and its native project generated (`expo prebuild`), but nothing has run on an emulator or phone. iPhone builds need a Mac or Expo's cloud build service.
26. **The app identifiers are placeholders** (`app.attendsure.mobile`). Before publishing, they change to identifiers under the university's own Google Play and Apple developer accounts.
27. **Two-step setup is web-only.** Staff who must set up an authenticator do it on the web dashboard, where recovery codes can be saved safely; the app then accepts codes.
28. ~~Sign-in forms still ask for "Email".~~ **Resolved in Phase 2 step 7a:** web and mobile sign-in say "Email or Student ID" and send `identifier`.
29. ~~Import activation emails are sent by the API process, not a job queue.~~ **Resolved in Phase 3 step 1:** each email is a background job, queued in the same transaction as the import, retried with growing waits, and marked FAILED (re-sendable) only after the last try. A restart no longer loses emails.
30. **One import is at most 5,000 rows and 5 MB**, saved in a single transaction. Larger intakes are split into several files.
31. **Uploaded files are not virus-scanned yet.** Only CSV, Excel, JPEG and PNG are accepted, checked from their bytes, and stored privately; a ClamAV scan is planned before production.
32. **Import files and rows are not yet deleted after 90 days.** The retention job (DATABASE_SCHEMA §7) arrives with the other retention rules (D-18). Cancelled imports already delete their stored file.
33. **Production file storage is not chosen (D-16).** Development and CI use SeaweedFS; switching host means changing the `S3_*` settings only.
34. **Moving a student to another section is two steps:** end the enrolment with a reason, then enrol in the new section. Both are recorded.
35. **Course reps keep only the Student role.** No separate Course Rep role is granted yet; rep tools (class-issue reports, rep announcements) arrive from Phase 3 and will check for an active rep assignment. There is no limit on reps per section until the university sets one.
36. ~~Display joins across modules.~~ **Decided 2026-11-09 (product owner, option 1):** read-only joins across modules are allowed for display only. Every write and every rule check goes through the owning module's service (done in step 7a). CLAUDE.md rule 8 now says so.
37. ~~A holiday entered after a timetable is published does not yet remove existing class sessions.~~ **Resolved in Phase 3 step 4b.** Adding or removing a holiday or closure now cancels or restores the affected classes automatically. A published timetable is changed by publishing a new version (a copy of the current one, edited as a draft); there is no separate "edit in place" path, so every change is reviewed for clashes before it applies.
38. **Changing a class's start time replaces its future sessions** (the old ones are cancelled with "Timetable changed", new ones created), so a confirmation for the old time does not carry over. Changes of room, lecturer, end time or sections update the same session.
39. **Nobody is notified yet when a timetable change, a holiday or a reschedule cancels or moves a class.** Notifications arrive in Phase 3 step 6; every change is already recorded as a class event.
40. **A waiting reschedule request is not closed automatically when its class is cancelled or started.** Approving it is refused (`409 TRANSITION_NOT_ALLOWED`), and an administrator rejects it. A direct reschedule does close a waiting request.
41. **A class restored after a holiday is removed stays cancelled if its room or lecturer was booked meanwhile.** The job leaves it cancelled rather than fail the whole timetable; it is counted in the job summary but not yet shown on a screen (screens come in step 7).
42. **A reschedule request has no "edit".** The lecturer withdraws it and asks again.
43. **Monitoring checks once a minute.** A class can become UNCONFIRMED or go to review up to a minute after its checkpoint. Reports are checked at once. Reminders before a class (24 h, 1 h, 15 min) come with notifications in step 6.
44. **Each minute's sweep leaves a job record** (about 1,440 a day). They are small, and a clean-up rule comes with the data-retention decision (D-18).
45. ~~Not yet in step 5a: the review queue and decisions, dismissing reports and auto-end.~~ **Built in step 5b.**
46. **Students whose reports are repeatedly dismissed are not flagged yet.** Flags (and their review screen) come with the risk-flag work in a later phase. Dismissals are already recorded and audited, so the history will be there.
47. **A review has no "reopen".** A wrong decision is corrected with the class actions (for example "reinstate"), which are audited.
48. **Push notifications are off** until the university creates its own Firebase project. Everything reaches people in the app, and the important messages by email.
49. **A large change sends many emails at once** (for example a holiday cancelling a day of classes: one email per student per class). There is no daily digest yet.
50. **Changes of end time or lecturer made by a new timetable version are not announced** (the class history records them). Room changes, cancellations and restored classes are announced.
51. **On the phone, lecturers confirm, start, delay, interrupt, resume, end and cancel.** Reschedule requests, holds, voids and review decisions are on the web dashboard. The phone has no "edit preferences" screen yet (the web has one).
52. **Screens refresh every 30–60 seconds**, not instantly; live updates arrive with the attendance work (Phase 5).
53. **The class monitor shows every class in the university, one day at a time.** It is not yet narrowed to the administrator's faculty or department; the review queue, reschedule requests and every action already are. A scoped monitor comes with reports.
54. **Phone approvals need university-wide scope.** The Super Admin approves by default; a Registrar or Administrator can be given `devices.approve` (the matrix allows it), but only with university-wide scope. Faculty-scoped approval can come later if wanted.
55. **Approvers are not notified of new phone requests yet;** they see them on the Phones screen.
56. **The phone's private key is in secure storage, not in a hardware key store that refuses to export it.** Hardware-backed keys need a native module; they can come with the development build (step 4). The phone model is not reported yet for the same reason.
57. **Rotating-ID beacons are registered (with their encrypted key) but their broadcasts are not resolved yet.** Working out which ID a beacon should be broadcasting right now depends on the beacon type the trial picks (D-08); it is completed then. Fixed-ID beacons work now, for the trial only.
58. ~~Calibration surveys are typed in on the dashboard.~~ **Resolved in Phase 4 step 4:** the phone's survey mode measures on the spot, and each phone adds its readings to the same survey. Typing them in on the dashboard still works.
59. **iPhones cannot hear iBeacon broadcasts with ordinary Bluetooth scanning** (Apple hides them; they need Apple's location ranging instead). Eddystone beacons work on both. The trial's beacon choice (D-08) should prefer Eddystone, or the iPhone ranging path is added then.
60. **The app is an Android development build for now.** It loads its screens from this PC (over USB with `adb reverse`, or Wi-Fi), so it is for testing, not for students. An iPhone build needs an Apple Developer account; a store build comes before the pilot.
61. **The phone model is reported by the operating system's name for it** (for example "Google Pixel 7"). Two phones of the same model with different names in different regions would count as two models in a survey; the surveyor sees the name on screen.
62. **Beacon health has no reports yet.** Its reports come from check-ins, which arrive in Phase 5; "Check this classroom" records nothing on purpose. Until then the Health panel says no phone has reported the beacon, and suspected faults and degraded mode are proven by tests only.
63. **A room with no site boundary (geofence) never triggers "suspected faulty".** The rule only counts phones shown to be on site, so a campus or building needs its geofence set (Places) for beacon health to work there.
64. **A class stays in degraded mode until it ends**, even if its beacon is heard again part-way. Check-ins then wait for the lecturer's approval for the rest of that class. This is the safer side for students.
65. **Raw phone coordinates in beacon reports are kept until the retention rules exist (D-18)**, which will reduce them to a distance band after 30 days.
66. **Beacon health is visible to every lecturer**, not only for their own classes, and **platform integrity always reports "not available"** (no Play Integrity or App Attest token is sent until the accounts exist).
67. **Check-in works through the API, but the phone has no scan screen yet** (Phase 5 step 6), and the roster, approvals and assisted check-in have no screens yet (step 6; the API is built). Attendance must not be used for real classes until those exist.
68. **Attendance closes up to a minute after its closing time** (the sweeper runs every minute). Check-in (step 2) checks the closing time itself, so no late check-in is accepted in that minute.
69. **Attendance cannot be extended past 30 minutes after the scheduled end** (the point where a running class is ended automatically), and reopening ends at the scheduled end.
70. **A student who enrolled after a class started cannot check in to it** (NOT_ENROLLED): only students eligible at the scheduled start are counted for a class (ATTENDANCE_FLOW §5). The lecturer can check them in by hand once assisted check-in exists (step 3).
71. **Text that is not an attendance code at all is answered but not recorded** (there is no attendance session to attach it to). Every attempt with a real attendance code is recorded, whatever its outcome.
72. **The per-student check-in limit (20 a minute) is skipped if Redis is down** (logged), like the other limits; the 5-attempt limit per class, kept in the database, always applies.
73. **The QR is not pushed over the live connection yet**: the lecturer's screen fetches the current code every rotation (`GET /attendance-sessions/:id/qr`). Same result, one request every 15 seconds per screen.
74. **Only the class's lecturer can check a student in by hand.** Administrators correct records instead (step 4), so every hand check-in is made by someone who was in the room.
75. **Live roster numbering lives in Redis.** If Redis is unavailable, events carry no number and screens reload the full roster each time: slower, never wrong.
76. **If Redis is down when the API starts, live events reach only the screens connected to the same API server** until Redis is back. Then the screens already connected are asked to reconnect (and reload the roster), so none silently misses events. With one API server, as in the pilot, nothing changes for users.
77. **The correction window counts from the class's scheduled start** (default 14 days, a setting). It is the same for every faculty until Knutsford's rules say otherwise (D-09).
78. **A late correction approved by an administrator is recorded as the administrator's change** (with the lecturer's reason and a link to the request), because the administrator applied it.
79. **Reminders about undecided check-ins go to the lecturer and to University Administrators in scope**, not to Super Admins, and only for classes whose attendance has closed.
