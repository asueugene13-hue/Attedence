# Classroom-presence verification

A check-in is confirmed automatically only when the server has all three:

1. a valid, current QR token,
2. the expected classroom beacon heard strongly enough,
3. a request from the student's trusted phone,

and no GPS reading that clearly places the phone somewhere else. Weaker evidence goes to the lecturer for a quick decision instead of being rejected outright. The phone gathers evidence; the server decides.

**Status:** design draft (2026-11-08). The beacon hardware is not chosen yet (D-08). The hardware trial was planned for Phase 2 but needs beacons bought first; it has not happened and must be done before Phase 4 (see IMPLEMENTATION_PROGRESS, Phase 2 exit check).

## 1. The layers and what each one proves

| Layer | What it shows | What it cannot show | Role in the decision |
| --- | --- | --- | --- |
| Dynamic QR | The student saw the lecturer's screen within the last ~30 seconds | That they are still in the room (a photo can be forwarded) | Required gate |
| BLE beacon | The phone is close to this room's beacon | Which side of a wall it is on | Main location evidence |
| GPS | The phone is on or near campus, when accuracy is good | Which room it is in; indoor readings are often 20–100 m off | Supporting. It can block only when accurate and clearly off-site. |
| Trusted device | The request comes from the student's registered phone | That the student is the one holding it | Required for automatic verification |
| Platform integrity | The app is genuine and the phone is not obviously tampered with | Honest intent | Supporting. A failure sends the check-in to review. |

No single layer is trusted alone. Removing any one of them would let a known trick through: a forwarded QR photo, a beacon copied at home, a borrowed phone.

## 2. Dynamic QR

**Token.** The text inside the QR is `AS1.<sessionId>.<window>.<mac>`.

- `window` is the rotation number: `floor((server time − attendance opened) ÷ rotation seconds)`.
- `mac` is an HMAC-SHA-256 signature (truncated to 128 bits) of `AS1|knutsford|sessionId|window`. It is made with a random secret created for that attendance session, encrypted in the database, and never sent to any device.

The signature makes tokens impossible to forge or alter. The window makes them expire.

**Rotation.** The default is every 15 seconds (configurable from 10 to 30). The server pushes each new token to the lecturer's screen over the WebSocket. If the socket drops, the screen fetches the current token every rotation. The lecturer's device only displays tokens; it never holds the secret, so a lost lecturer phone cannot be used to make them.

**Validity.** The server accepts the current window and one window before it, which allows for scan and upload time. A token is therefore usable for at most about 30 seconds.

| Threat | Defence |
| --- | --- |
| Screenshot used later | Rejected once its window has passed (`QR_EXPIRED`) |
| Photo forwarded live to a friend at home | The QR is still valid, but the friend's phone hears no classroom beacon, so the check-in is not confirmed (§6) |
| Forged or edited token | Signature check fails, using a constant-time comparison |
| Token from another class | The session ID inside must match an attendance session that is open and the student is enrolled in |
| Same request sent twice | Idempotency key: the second request gets the first result |
| Many tries in a row | At most 5 attempts per student per session; all of them are recorded |

**Student ID QR codes are different on purpose.** They start with `ASID1.`, use a separate signing key and carry only a random reference with no personal data. A staff member's app must call the verify endpoint, signed in, to see who it belongs to. The check-in endpoint rejects anything that does not start with `AS1.`, and the ID-verify endpoint rejects `AS1.` tokens.

## 3. BLE beacons

**What is registered for each beacon:** classroom (and therefore building, floor and campus), protocol, identifier, encrypted rotating key if any, transmit power, calibrated signal threshold, status, battery level, installation and calibration dates.

**Protocol recommendation (D-08).** Prefer beacons that broadcast a **rotating identifier**: Eddystone-EID or a vendor's secure rotating ID. The server knows each beacon's key, so it can work out which ID the beacon should be broadcasting right now. A recording or copy made yesterday is useless today.

Avoid beacons that broadcast **only** iBeacon, for two reasons:

- iBeacon IDs never change, so anyone can copy one.
- iPhones hide iBeacon packets from normal Bluetooth scanning (risk R2).

Eddystone frames are visible to iPhone and Android scanning. The hardware trial must prove this with the actual devices Knutsford students use.

**Scanning on the phone.**

- Scanning happens only during a check-in, with the app open. It lasts up to 6 seconds and starts as soon as the QR is read.
- Unknown beacons are ignored. For each registered beacon heard, the app keeps the strongest signal reading (RSSI) and the number of readings.
- No background scanning and no tracking.
- Android 12+ needs the `BLUETOOTH_SCAN` and fine-location permissions. Android treats beacon scanning as location use, so the "never for location" flag cannot be used. iOS needs the Bluetooth usage description. The app explains why on its own screen before the system permission prompt.

**Turning signal into evidence.**

| Result | Rule |
| --- | --- |
| STRONG | A beacon registered to this session's classroom was heard at or above its calibrated threshold |
| WEAK | An expected beacon was heard, but below the threshold |
| OTHER_ROOM | Only beacons registered to other rooms were heard strongly |
| NONE | No registered beacon was heard |
| OFF | Bluetooth is off or permission was denied (reported by the app) |

**Calibration (site survey).** For each room, signal strength is measured with at least three phone models in these places: the back row, the corners, the doorway, the corridor and the rooms on either side. The threshold is set between the weakest reading inside and the strongest reading outside. If those overlap, the room needs another beacon or a different placement. Large halls get several beacons. Measurements are repeated each semester and whenever a beacon moves. They are stored with the beacon record.

**Calibration as built (Phase 4 step 3).** A survey records each reading's beacon, phone model, position and signal. Positions INSIDE_FRONT, INSIDE_MIDDLE, INSIDE_BACK_ROW and INSIDE_CORNER count as inside; **DOORWAY**, CORRIDOR, NEIGHBOUR_ROOM and OUTSIDE_BUILDING count as outside (the doorway is treated as outside on purpose, so a student standing at the door is not verified automatically). The threshold is the strongest outside reading plus half the gap to the weakest inside reading, rounded up, so every inside reading counts as inside and every outside reading as outside. Readings from at least three phone models, inside and outside, are required; an overlap means the room needs another beacon or a better placement. A survey is applied once, by an administrator; the readings themselves can never be edited.

**Beacon health and unexpected activity.**

- Every check-in tells us which beacons phones heard, and the worker summarises this every 5 minutes (`BeaconHealthSnapshot`).
- **Suspected failure:** during an active class, several phones that checked in with GPS on campus heard nothing from the room's beacon. The beacon is marked *suspected faulty*, the lecturer and administrator are alerted, and the session enters **degraded mode** (§6).
- **Unexpected activity:** a registered beacon is heard by a phone whose GPS places it far from campus, or the same beacon is heard in two distant places at once. This raises a `BEACON_LOCATION_CONFLICT` or `UNEXPECTED_BEACON` risk flag.
- Battery level is recorded where the vendor's beacon reports it.

## 4. GPS and geofencing

- Each campus has a circular geofence (centre and radius), and a building may override it with its own.
- The app takes **one** reading at check-in, with its accuracy. There is no background location.
- With distance `d` from the geofence centre, accuracy `a`, radius `r` and margin `m` (default 50 m):

| Result | Rule |
| --- | --- |
| UNCERTAIN | No reading, or accuracy worse than 150 m |
| OUTSIDE | `d − a > r + m`: even the most favourable point of the reading's error circle is well off-site |
| INSIDE | `d ≤ r + a`: the reading is consistent with being on site |
| UNCERTAIN | Anything in between |
| MOCKED | Android reports the location as coming from a mock-location app |

GPS alone never rejects a student, except as OUTSIDE combined with no beacon evidence (§6). Raw coordinates are kept for 30 days and then reduced to a distance band (D-18).

## 5. Trusted device

1. **Registration.** On first sign-in, the app creates a random installation ID and an **Ed25519 key pair** and keeps them in the phone's secure storage (Keychain on iOS, Keystore-backed on Android). The server stores only the **public key**. *(Corrected in Phase 4 step 1: the first draft said "a hash of a secret" with an HMAC, but checking an HMAC needs the secret itself. With a key pair the server holds nothing that could forge a phone's signature, even if its database leaked.)*
2. **Trust.** The first phone a student registers right after activating their account becomes their trusted attendance device. Any later phone starts as `PENDING_APPROVAL` (D-10).
3. **Signing.** Every check-in carries an Ed25519 signature over the method, path, time, a single-use nonce and the exact body bytes, made with the phone's private key. The server verifies it with the public key, refuses times more than 5 minutes off its own clock, and remembers each nonce for 10 minutes, so a request copied off the network can be neither changed nor replayed.
4. **Replacement.** The student requests a new phone, and a Registrar or Administrator approves it. The old device becomes `REPLACED`. Until approval, check-ins from the new phone go to lecturer review instead of being rejected.
5. **Signals:**
   - `SHARED_DEVICE`: one installation ID signed into two student accounts, or two students checking in from one phone in the same class. Both check-ins go to manual review.
   - `ACCOUNT_SWITCH`: different students signing in on one phone within a short time.
   - `DEVICE_SWITCH`: frequent device changes.
6. **Integrity.** Play Integrity (Android) and App Attest (iOS) verdicts are checked on the server. A failure sends the check-in to review rather than rejecting it, because some legitimate phones fail these checks. The library is chosen in Phase 4.

## 6. Decision engine

The engine runs in this order.

**Step 1: hard gates.** Any failure means REJECTED, and the student is told why.

| Gate | Reason code |
| --- | --- |
| Token malformed or signature wrong | `QR_INVALID` |
| Token window too old | `QR_EXPIRED` |
| Attendance session not open | `SESSION_NOT_OPEN` |
| Student not enrolled in any of the session's sections | `NOT_ENROLLED` |
| Account or student status not active | `ACCOUNT_INACTIVE` |
| Device revoked | `DEVICE_REVOKED` |
| Attempt limit reached | `TOO_MANY_ATTEMPTS` |

**Step 2: evidence.** Each layer produces one of the results in §3–§5.

**Step 3: decision table** (with the default policy):

| BLE | GPS | Device | Outcome | Student sees |
| --- | --- | --- | --- | --- |
| STRONG | INSIDE or UNCERTAIN | TRUSTED | **VERIFIED** | "You're checked in" |
| STRONG | OUTSIDE | any | MANUAL_REVIEW_REQUIRED + `BEACON_LOCATION_CONFLICT` flag | "Your check-in needs review" |
| STRONG or WEAK | not OUTSIDE | PENDING (new phone) | PENDING_VERIFICATION + `DEVICE_SWITCH` flag | "Waiting for your lecturer to confirm" |
| WEAK | INSIDE or UNCERTAIN | TRUSTED | PENDING_VERIFICATION | "Waiting for your lecturer to confirm" |
| OTHER_ROOM | any | any | REJECTED, retry allowed | "You seem to be in another room. Move into the classroom and try again." After a second failure: "Ask your lecturer to review". |
| NONE | INSIDE | TRUSTED | PENDING_VERIFICATION | "Waiting for your lecturer to confirm" |
| NONE | UNCERTAIN | TRUSTED | REJECTED, retry allowed | "We couldn't detect the classroom. Move closer to the front and try again." After a second failure: "Ask your lecturer to review". |
| NONE | OUTSIDE | any | **REJECTED** | "You don't appear to be in the classroom" |
| OFF | — | — | Not sent: the app asks the student to turn on Bluetooth | "Bluetooth is needed to check in" plus a link to the exception route |
| any | MOCKED | any | MANUAL_REVIEW_REQUIRED + `MOCK_LOCATION` flag | "Your check-in needs review" |

**Modifiers:**

- **Integrity failure.** A VERIFIED result becomes PENDING_VERIFICATION, and an `INTEGRITY_FAILED` flag is raised.
- **Shared device in this session.** Both students' attempts become MANUAL_REVIEW_REQUIRED.
- **Degraded mode** (the room's beacon is suspected faulty). BLE NONE is not counted against students. With GPS INSIDE or UNCERTAIN and a trusted device, the check-in becomes PENDING_VERIFICATION, and the lecturer can approve all of them in one action. With GPS OUTSIDE it is still REJECTED.
- **"Ask your lecturer to review."** After a rejection with retry allowed, the student can turn the last attempt into MANUAL_REVIEW_REQUIRED. The lecturer sees it in the roster.

**Cases the table above did not cover (decided in Phase 4 step 2, for the product owner's review):**

- **WEAK beacon + GPS OUTSIDE** is treated like STRONG + OUTSIDE: review, with a `BEACON_LOCATION_CONFLICT` flag.
- **A phone waiting for approval with no beacon heard:** GPS INSIDE → PENDING_VERIFICATION with a `DEVICE_SWITCH` flag (like the beacon rows); GPS UNCERTAIN → rejected, retry allowed; GPS OUTSIDE → rejected.
- **Bluetooth OFF reaching the server** (the app normally stops before sending): rejected, retry allowed, with "turn Bluetooth on".
- **A phone shared in the same class** sends both attempts to review, but never turns a rejection into a review.
- **An integrity failure** raises its flag even when the outcome is already not "verified".
- **Degraded mode with a phone waiting for approval** follows the new-phone rows.
- **Beacons not required** (`bleRequired` off): GPS decides — INSIDE → `noBleGpsInsideAction`, UNCERTAIN → rejected with a retry, OUTSIDE → rejected.

**Step 4: record.** The outcome becomes the attendance record status (see [ATTENDANCE_FLOW.md](ATTENDANCE_FLOW.md) §4). The full rule trace is saved in `VerificationDecision` with each check-in attempt (Phase 5), so every outcome can be explained in a dispute. The engine (`apps/api/src/modules/verification/decision-engine.ts`) already returns the trace; administrators can see it on the policy screen's "Try a case".

*Why a decision table and not a points score:* a table can be read, explained to a student, argued about in a meeting and tested row by row. A hidden score cannot.

## 7. The brief's scenarios

| Scenario | Evidence | Outcome |
| --- | --- | --- |
| Student at home with a forwarded QR | QR valid, BLE NONE, GPS OUTSIDE | REJECTED |
| Student in the wrong classroom | QR valid, BLE OTHER_ROOM | REJECTED, retry allowed; can ask for review |
| Student in the correct classroom | QR valid, BLE STRONG, trusted device, GPS INSIDE or UNCERTAIN | VERIFIED |
| Bluetooth off | App detects it | Not sent; asked to turn it on; exception route available |
| Beacon failure | Several on-campus phones hear nothing | Degraded mode; lecturer alerted; check-ins pending for lecturer approval; lecturer-assisted check-in available |
| GPS inaccurate indoors | BLE STRONG, GPS UNCERTAIN | VERIFIED. GPS is not held against the student. |
| Dead phone | No check-in possible | Lecturer-assisted check-in (§8) |
| New phone | BLE STRONG, device PENDING | PENDING_VERIFICATION; replacement request prompted |

## 8. Exceptions and fairness

- **Lecturer-assisted check-in.** For a dead phone, no compatible phone, or a broken Bluetooth chip. The lecturer picks the student on the roster, chooses a reason and confirms. The record becomes PRESENT (or LATE), with source `LECTURER_ASSISTED`, outcome EXCEPTION_APPROVED and a `ManualAttendanceOverride` row. Administrators can see each lecturer's share of assisted check-ins; a high share is information for review, not an automatic penalty.
- **No-device exemption.** The Registrar can mark a student who has no compatible phone. The lecturer's roster then shows a "check in manually" button for that student.
- **Every rejection gives a reason and a next step,** and every outcome can be disputed.
- **Risk flags never change attendance by themselves.** A person reviews each one.
- **No biometrics.** Face or fingerprint verification is not used. Adding it would need a separate privacy and security review first.

## 9. Configurable policy (VerificationPolicy rules, with defaults)

| Setting | Default | Notes |
| --- | --- | --- |
| `qrRotationSeconds` | 15 | 10–30 |
| `qrGraceWindows` | 1 | The previous window is still accepted |
| `bleScanSeconds` | 6 | |
| `bleRequired` | true | Turning this off needs Super Admin approval and is audited |
| `bleWeakAction` | PENDING_VERIFICATION | Could be relaxed to VERIFIED for a room after calibration |
| `noBleGpsInsideAction` | PENDING_VERIFICATION | |
| `gpsMaxUsableAccuracyM` | 150 | |
| `gpsOutsideMarginM` | 50 | |
| `requireTrustedDevice` | true | |
| `newDeviceAction` | PENDING_VERIFICATION | |
| `integrityFailAction` | PENDING_VERIFICATION | |
| `mockLocationAction` | MANUAL_REVIEW_REQUIRED | |
| `maxAttemptsPerSession` | 5 | |
| `offlineGraceSeconds` | 120 | See ATTENDANCE_FLOW.md §8 |

Policies are versioned and never edited in place. Each attendance session records the version it used, so a decision made in March can be explained in May.
