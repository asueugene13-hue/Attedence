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
