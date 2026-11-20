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
66. ~~Beacon health is visible to every lecturer.~~ **Resolved 2026-11-19:** a lecturer reads beacons and their health only for the room where their own class is running, as the role matrix says ("during own class"); otherwise the beacon is "not found". Administrators still see every room, because rooms are not divided by faculty. **Still open: platform integrity always reports "not available"** (no Play Integrity or App Attest token is sent until the accounts exist).
67. ~~No screens for check-in and the roster.~~ **Built in Phase 5 step 6** (web and phone). Real use still waits for the Phase 4 field test, the exit check (step 7) and a phone test of the camera build.
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
80. **Percentages are worked out on every request** from the records (always current, nothing to go stale). For very large sections this may need a cached summary later; the pilot sizes are small.
81. **"How many more absences" assumes the student attends every other remaining class** and counts classes still scheduled, confirmed, delayed or unconfirmed. A class cancelled later is simply no longer counted.
82. ~~Excuse requests are Phase 6.~~ **Built in Phase 6 step 3.** EXCUSED is reached only through an approved excuse request.
83. **The lecturer's phone refreshes the roster every 5 seconds**; the web dashboard's roster is live. Rejecting a check-in (a note is needed) and hand check-ins are on the dashboard; the phone approves.
84. ~~The phone does not keep the screen awake while showing the code.~~ **Resolved 2026-11-19:** the screen stays on while the code is shown, and goes back to the phone's own timeout when attendance closes or the lecturer leaves the page. It uses a module already in the current app build, so no new build is needed; it reaches phones with the next update of the app's code.
85. **Students have six tabs** (Home, Check in, Attendance, Schedule, Alerts, Profile). If that is too crowded on small phones, Schedule can move into Home later.
86. **The browser journey for attendance inserts its "class happening now" straight into the e2e database**, because the earlier journeys' classes are in 2030 and attendance opens only near a class's time. Everything after that goes through the real API and screens.
87. **One API process confirms about 25 check-ins a second on the development laptop.** The load test (500 students checking in at the same instant, real HTTP, live roster connected) confirmed all 500, each exactly once, in about 20 seconds; the last student waited about 20 seconds. 500 spread over a minute is about 8 a second, a third of that. The limit is processor time in the API process (half of it in the database client), not the database. Production should run at least two API processes (the live roster and limits already work across several, through Redis), and Phase 8 measures this again on the real servers.
88. **The load test sends its 500 requests over 100 kept-alive connections**, as a reverse proxy in front of the API does. Opening 500 new connections to Node at once on Windows is refused after about 200 by Windows itself, whatever the API asks for; production runs on Linux behind a proxy.
89. **An automatic close is recorded as a class event, not an audit-log entry.** The class's event log keeps who (the system), why (time up, or class ended) and how many students were marked absent; a person's close is also in the audit log.
90. **The crest SVG wraps the supplied picture; it is not drawn in vector shapes.** The crest is a detailed gold rendering, so tracing it into shapes would lose detail. The SVG file holds the original artwork (452 × 444 pixels) unchanged. The "Knutsford University" wordmark is a true vector outline, traced from the same image. For print or very large displays, ask the university for its original logo files (vector or high resolution) and replace the files in `apps/web/public/brand` and `apps/mobile/assets/brand`.
91. **The new app icon (the crest) appears only after the next app build.** Phones running the current build keep the old icon until it is replaced.
92. **Dispute and excuse notifications point to screens that are not built yet** (`/reviews`, `/requests/…`). The screens come in Phase 6 step 7; until then the in-app notification says what happened but opening it leads nowhere specific.
93. **A dispute does not lock the record.** A lecturer can still correct it directly; approving the dispute afterwards is refused (`RECORD_CHANGED`) and the reviewer rejects or the student withdraws it.
94. **An excused class that had no record yet is excused up to 15 minutes after attendance closes** (the job runs every 15 minutes). Until then the record shows ABSENT.
95. **Excuse requests have no 72-hour hand-over.** Disputes do (D-21); excuse requests already go only to administrators, so there is no one further to pass them to. Waiting requests are listed oldest first.
96. **The Phase 6 phone screens have not been seen on a real phone.** They are covered by component tests and match the canvas in structure; the visual check waits for the next app build on a phone. The same is true of the student ID code being scanned by another phone's camera.
97. ~~Dates in the phone's excuse form are typed.~~ **Resolved 2026-11-19:** both dates are picked from a month calendar (written in plain app code, so no new app build). Days before "From", or more than 31 days after it (one request's limit), cannot be picked. Not yet seen on a real phone.
98. **Lecturers decide disputes on the web dashboard.** The phone shows how many are waiting and says so; a phone screen for deciding them was not part of the approved designs.
99. **Announcements go to students only,** worked out when sent: a student who enrols later does not see earlier ones. Staff-wide messages are not part of Phase 6.
100. **A report on a faculty-wide or university-wide announcement goes to the administrators who cover that faculty (or the whole university)**, not to department administrators.

## Reports and administration (Phase 7)

101. **Only institution-wide roles read and export the audit log.** A department or faculty administrator cannot, because audit entries are not tagged with a department. The Super Admin and university-wide administrators can.
102. **An audit-log file holds at most the newest 20,000 entries.** The file says so in its subtitle when it is cut short; narrow the dates to get the rest.
103. **Analytics are worked out from the records each time they are asked for,** one semester at a time. That keeps them exact, but a very large semester may take a few seconds. Load testing in Phase 8 measures it.
104. **Analytics count only classes that were held and whose attendance was closed,** the same rule as each student's own percentage. A class still under review, or still running, appears once it is decided or closed.
105. **A report file shows the records as they were when it was made.** It is not updated afterwards; make it again for newer figures.
106. **Report files are deleted from AttendSure after 7 days** (`reports.exportRetentionDays`), and the export log keeps who made and downloaded each one. A copy someone has already saved on their own computer is outside AttendSure's control; files naming people say so in their footer (Act 843).
107. **The `/metrics` page is for a monitoring server that is not set up yet.** It stays switched off until `METRICS_TOKEN` is set, and charts and alerts on it come with hosting (D-16). Until then, System health shows background jobs and alerts.

## Production readiness (Phase 8)

108. **The rehearsal's certificate is not trusted by browsers.** It comes from Caddy's own local authority, because a public certificate needs a real domain name (D-16). With a real name in `SITE_ADDRESS`, Caddy gets a trusted one automatically.
109. **In the rehearsal, download links use plain http** (`http://localhost:8334`, the stand-in file store). A real host's storage service must serve its links over https; set `S3_PUBLIC_ENDPOINT` to it.
110. ~~The API image is about 1 GB.~~ **Reduced to 609 MB on 2026-11-15** (its packages from 500 MB to 200 MB: the Prisma command-line tool and what it pulls in are removed from the production image; the release-job image keeps them, since it runs migrations). The remaining size is mostly the Node.js base image and the S3, Prisma and PDF libraries.
111. ~~Inline scripts allowed by the dashboard's content security policy.~~ **Resolved 2026-11-15:** each page gets a fresh nonce (`src/proxy.ts`) and only scripts carrying it run; an injected script is refused (browser test `10-security.spec.ts`). Pages are now rendered per request. **Still allowed: inline styles** (`style-src 'unsafe-inline'`), because React writes `style="…"` attributes; styles cannot run code.
112. **32 moderate or low dependency advisories remain, in development and phone-build tools only** (`glob` and `minimatch` under Expo's build tools, Jest and typescript-eslint; `deepmerge`). None is in the API, the dashboard or the code shipped to phones, and none is high or critical. They can be slowed down by a crafted file-matching pattern, but here those patterns come only from AttendSure's own build and test configuration, never from users. Reviewed 2026-11-15: `npm audit fix` removes 1 of 32 while changing about 20 Expo build packages, and every other "fix" npm offers is a **downgrade** to an older major version (Expo 52, ESLint 9, Jest 29). Neither was applied. The real fix is Expo, ESLint and Jest releasing versions with updated sub-packages; check `npm audit` before each release.
    - **2026-11-19: a new high advisory, fixed.** `effect` (ReDoS in `Schema.TemplateLiteral`, GHSA-7589-6fvf-x4pw, versions up to 3.22.0) arrived under the Prisma command-line tool, which pins `effect` 3.20.0 exactly, even in its newest release. It was not exploitable here (that tool reads only AttendSure's own configuration, and it is removed from the production API image), but CI's audit failed on it. The root `package.json` now overrides `effect` to 3.22.4 (patched, released four weeks earlier). npm would not apply the override to the existing lockfile, so the lockfile entry was set to 3.22.4 with the registry's checksum and confirmed with `npm ci`. Prisma's tool was checked afterwards (validate, migration status, drift check). `npm ls` calls the override "invalid"; it says the same after a clean install where npm chose 3.22.4 itself. **Remove the override** when Prisma moves to a patched `effect`. The moderate count is now 31.
113. **The load test ran on one laptop,** with every container and the load driver sharing it. The figures are a floor, not a measurement of the real host; repeat the test there before go-live (apps/api/load/README.md).
114. **When an API instance stops, the lecturers' live rosters connected to it are cut.** The dashboard reconnects to the other instance and reloads by itself within a few seconds; nothing is lost, but the roster pauses briefly.
115. **The phone app's resend after a gateway error (502, 503, 504) reaches phones only with the next app build.** Until then a student who meets one (only during a server restart or failure) sees an error and presses check in again; the attempt still counts once.
116. **Database backups do not include files** (photos, attachments, report files). They are in object storage, which the host must version and copy daily (DEPLOYMENT.md §9).
117. **The restore drill used a small rehearsal database** (33 MB). Real data will take longer; repeat the drill on the real host with real volumes, and record the times.
