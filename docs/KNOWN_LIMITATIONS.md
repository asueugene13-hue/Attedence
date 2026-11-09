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
37. **A holiday entered after a timetable is published does not yet remove existing class sessions.** Publishing a new version applies it. Changing published timetables directly, including holidays, comes with Phase 3 step 4.
38. **Changing a class's start time replaces its future sessions** (the old ones are cancelled with "Timetable changed", new ones created), so a confirmation for the old time does not carry over. Changes of room, lecturer, end time or sections update the same session.
39. **Nobody is notified yet when a timetable change cancels or moves a class.** Notifications arrive in Phase 3 step 6; every change is already recorded as a class event.
