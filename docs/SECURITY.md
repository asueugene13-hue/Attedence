# Security and privacy

AttendSure protects three things:

- **student records:** personal data the university holds in trust;
- **attendance integrity:** a record must mean the student was there;
- **staff power:** accounts that can change thousands of records.

The design relies on short-lived tokens, server-side checks on every request, database-enforced integrity, an append-only audit trail, and collecting as little personal data as the job needs.

**Status:** design draft (2026-11-08). This is engineering guidance, not legal advice. The university's legal and data-protection staff must review the privacy section.

## 1. Authentication

| Area | Design |
| --- | --- |
| Passwords | Hashed with Argon2id using OWASP's settings (19 MiB memory, 2 iterations, 1 thread). At least 10 characters, checked against a list of common and breached passwords; long passphrases allowed. |
| Brute force | Per-account and per-IP rate limits. After 5 failures the account is locked for 15 min, with the lock doubling each time. Staff are alerted to repeated lockouts. |
| First sign-in | No default passwords. The account is created as `PENDING_ACTIVATION`, and a single-use link valid for 72 h goes to the university email (D-06). |
| Tokens | Access token: a JWT signed with HMAC-SHA-256, valid for 15 min, checked against its session on every request so logout and suspension take effect at once, carrying user, session, active role and permission version. Refresh token: 256 random bits, stored only as a SHA-256 hash and rotated on every use. Presenting an already-used refresh token revokes the whole session, because it means the token was stolen. |
| Web | The refresh token sits in an `httpOnly`, `Secure`, `SameSite=Strict` cookie scoped to `/api/v1/auth`. The access token is kept in memory only. Origin checks on state-changing requests. |
| Mobile | Tokens and the device secret are kept in the operating system's secure storage, never in plain storage. |
| Two-factor (D-03) | TOTP is required for Super Admin, Administrator and Registrar, with 10 single-use recovery codes. |
| Password reset | Single-use token valid for 30 min. The same response is given whether or not the email exists. A reset revokes every session. |
| Sessions | Users can see and revoke their own sessions. The Super Admin can force sign-out. Role or permission changes force a token refresh. |
| Bootstrap | The first Super Admin is created with a one-time command on the server, which prints an activation link. There are no seeded credentials. |

## 2. Authorisation

- Deny by default: a route without a declared permission is refused.
- Every request is checked for permission, scope policy and scoped queries (ROLE_PERMISSION_MATRIX.md, "How the server enforces this").
- Protected permissions are held only by the Super Admin, and the last Super Admin cannot be removed.
- Sensitive actions require a reason and are audited: role changes, suspensions, corrections, voids, policy changes and exports with personal data.
- Course reps and students have no route that changes attendance or class status.

## 3. Attendance integrity

| Threat | Defence |
| --- | --- |
| QR screenshot used later | 15 s rotation; tokens accepted for one extra window at most |
| QR forwarded live to someone at home | BLE evidence required; GPS cross-check |
| Copied beacon broadcasting from home | Rotating-ID beacons (D-08); `BEACON_LOCATION_CONFLICT` flag when GPS disagrees |
| Fake GPS app | Android mock flag means manual review. GPS is only supporting evidence anyway. |
| Check-in from a borrowed or second phone | Trusted-device binding; signed requests; shared-device and account-switch flags |
| Modified app or rooted phone | Server-side checks of Play Integrity and App Attest verdicts; failures go to review |
| Replayed request | Device signature over body, timestamp and nonce; nonce cache; idempotency keys |
| Double records under load | Unique constraint per student per session |
| Silent edits by staff | Corrections only through the audited workflow; history tables are append-only |
| Manipulated phone clock | Server time only |

Fraud detection raises flags for people to review. It never changes attendance or punishes a student by itself.

## 4. Application security

| Risk | Defence |
| --- | --- |
| Injection | Prisma parameterised queries. Raw SQL only in reviewed migrations and analytics queries, with bound parameters. |
| Mass assignment | Strict Zod schemas reject unknown fields. Protected fields such as `status` and `version` are never accepted from request bodies. |
| Reading other people's data by changing an ID in the URL | Scope policies and scoped queries; automated tests per role |
| XSS in announcements and notes | Stored and shown as plain text; never rendered as HTML; strict Content-Security-Policy on the web dashboard |
| Formula injection in exports | Cells starting with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'` in CSV and XLSX output |
| Malicious uploads | Size limits (photos 2 MB, imports 5 MB and 5,000 rows); type checked from the file's bytes; allow-list (CSV, XLSX, JPEG, PNG so far); uploads pass through the API, after sign-in and permission checks, so the type is checked before anything is stored; files stored privately with random keys; 5-minute download links; spreadsheet exports neutralise formulas (CSV injection). Virus scanning (ClamAV) is not yet in place. |
| Bulk import abuse | Size and row limits; validation before saving; nothing is written until a person confirms the preview |
| Denial of service and cost abuse | Rate limits per route, counted in Redis (built: sign-in 10 per 15 min per IP+email and 300 per min per IP; reset email 3 per hour per address; MFA 60 per min per IP; default 3,000 per min per IP); SMS only for critical categories; course-rep message limits |
| Security headers | Helmet: HSTS, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (the API serves only JSON), no-sniff, referrer policy. **Built** (Phase 1 step 5). |
| Vulnerable dependencies | Lockfile committed; `npm audit` and Dependabot in CI; licences checked |
| WebSocket abuse | Token-authenticated handshake; permission check on every room join; per-connection rate limit |

## 5. Secrets and encryption

- Secrets never enter git. Only `.env.example` with placeholder values is committed, and CI runs a secret scanner.
- Production secrets live in the host's secret manager (D-16).
- TLS is required everywhere. Database and Redis connections use TLS outside local development.
- Application-level encryption (AES-256-GCM) protects per-session QR secrets, rotating beacon keys and TOTP secrets, with the key held outside the database.
- The key can be changed without signing anyone out or losing data (RUNBOOK.md §7, built 2026-11-15). Each value records a short fingerprint of the key that encrypted it. Old keys listed in `ENCRYPTION_KEYS_PREVIOUS` are used only for reading. `rotate-encryption-key` re-encrypts every stored secret with the new key (each module its own table) and writes an audit entry with the counts, never the secrets or keys. Rehearsed on 2026-11-19: 5 secrets written by the old key, in the original format, re-encrypted; all readable with the new key alone.
- Backups are encrypted.

## 6. Privacy and Ghana's Data Protection Act, 2012 (Act 843)

Knutsford University is the data controller for AttendSure's personal data. The engineering work supports the Act's principles. These steps are for the university:

- confirm its registration with Ghana's Data Protection Commission,
- name the person responsible for data protection,
- approve the privacy notice and retention periods (D-16, D-18).

| Principle | How AttendSure applies it |
| --- | --- |
| Purpose | Location and Bluetooth evidence are used only to verify presence at check-in, never to track students. Notification reads are never used as attendance evidence. |
| Minimisation | One GPS reading at check-in, no background location, no biometrics, no contact lists, no photos beyond the optional profile photo. |
| Retention | Raw location evidence is reduced after 30 days. Every category has a retention period (DATABASE_SCHEMA.md §7), and nightly purges are logged. |
| Accuracy | Disputes, corrections and Registrar verification of records. |
| Security | Everything in sections 1–5. |
| Openness | An in-app privacy notice explains what is collected at check-in and why, before permissions are requested. |
| Data subject access | Students can see their attendance records and the evidence summary behind each decision. A full export of a student's data can be produced on request. |
| Accountability | The audit log covers every sensitive action, including who viewed and exported personal data. |

Biometric verification is not part of AttendSure. If it were ever proposed, it would need a separate privacy impact assessment and security review first.

## 7. Audit logging

Logged, with actor, role, time, request ID, IP, before and after values, and a reason where one is required:

- sign-ins and failures,
- role and permission changes,
- account suspensions,
- student record changes,
- imports,
- timetable publishes,
- class cancellations, voids and reinstatements,
- attendance corrections and overrides,
- policy and setting changes,
- exports,
- risk-flag decisions,
- access to audit logs.

The audit table is append-only at the database level (DATABASE_SCHEMA.md §4).

## 8. Backup and recovery

PostgreSQL is the only source of truth.

- Continuous WAL archiving gives point-in-time recovery, plus a daily encrypted snapshot kept off-site.
- A restore drill runs monthly in staging and before every major release, and its results are recorded in DEPLOYMENT.md.
- Targets (proposals): data loss of no more than 5 minutes, service restored within 4 hours.
- Redis is not backed up as a source of truth. Queued work is rebuilt from the outbox and the sweepers.

## 9. Security testing (Phase 8 step 3, 2026-11-14)

| Check | How | Result |
| --- | --- | --- |
| Every API route needs sign-in and the right permission | Scenario 24 finds every route automatically: each non-public one must refuse a request without sign-in (401), and every role lacking a route's permission must be refused (403) and logged. New: the list of public routes is fixed in the test (7 sign-in routes, 2 health probes, `/metrics`), so a route made public by mistake fails CI. Checked by marking a dashboard route public: the test failed | Passed |
| Routes open to any signed-in user | Each of the ~63 was read: every one passes the caller to its service or uses only the caller's own ID ("me" routes). Each route that takes an ID has a test file that calls it and checks a refusal for someone else (a file-level check, not proof for every case) | No gap found |
| Secrets in git | gitleaks 8.24.0 over the whole history (100 commits). 8 findings, all deliberate fake values (the test password, the example and CI keys, a beacon test key, an example request ID), listed with reasons in `.gitleaksignore`. A planted fake token was caught. CI now runs this scan on every push | Passed |
| Dependencies | `npm audit`: 32 advisories, 1 low and 31 moderate, none high or critical. All are in development tools (ESLint, test tools) or the phone app's Expo **build** tools; none in the API, the dashboard or code shipped to phones. The available fix changes about 20 Expo build packages, so it waits for the next phone build where it can be tested (KNOWN_LIMITATIONS 112). CI fails on high or critical | Recorded |
| Dependencies (2026-11-19) | A new high advisory in `effect`, under the Prisma command-line tool (development and migrations only), failed CI. Fixed by overriding it to the patched 3.22.4 (KNOWN_LIMITATIONS 112). The audit now reports 31 moderate, none high or critical | Fixed |
| Web scan | OWASP ZAP 2.16.1 baseline against the production rehearsal over HTTPS: 0 failures, 58 checks passed | See below |

**ZAP findings and what was done:**

- **Fixed: a password could land in the address.** Forms did not say `method="post"`, so a form sent before the page's code had loaded (slow phone or network) would put its fields, including the password, in the URL (browser history, server logs). Every form now posts; a unit test checks every form.
- **Fixed: the content security policy allowed any source.** It now allows only AttendSure itself, plus the file store for photos and `data:` images (the two-step QR code). A browser test proves the photo still loads, and fails when the file store is removed from the policy.
- **Fixed: HSTS and site isolation headers.** The proxy sends `Strict-Transport-Security` (one year; the rehearsal on localhost sends 0 so it does not affect local development), and the dashboard sends `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`.
- **Fixed 2026-11-15: no more inline scripts.** Each page gets a fresh random nonce (`apps/web/src/proxy.ts`); Next.js puts it on its own scripts and the browser refuses any script without it. Browser tests check that every script carries the page's nonce, that the nonce changes on each load, and that a script injected into the page does not run while the page keeps working (with `'unsafe-inline'` put back, both tests failed). A ZAP rescan no longer reports it (0 failures, 59 passed). **Accepted: `unsafe-inline` styles**, because React writes `style="…"` attributes, which cannot run code. **`Cross-Origin-Embedder-Policy` is not set**, because it would block photos from the file store.
- **False positive: "no anti-CSRF tokens".** The API acts only on an `Authorization` header, which browsers never add by themselves; the one cookie (staying signed in) is `SameSite=Strict` and only honoured from the dashboard's own origin; forms never act through a plain submission.
- **Informational only:** cache directives on static files, comments in the bundled JavaScript, "modern web application", and the ZAP version notice.
