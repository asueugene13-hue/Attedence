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
| Malicious uploads | Size limits; type checked from the file's bytes; allow-list (CSV, XLSX, JPEG, PNG, PDF); files stored privately with random keys; short-lived download links; optional ClamAV scan |
| Bulk import abuse | Size and row limits; validation before saving; nothing is written until a person confirms the preview |
| Denial of service and cost abuse | Rate limits per route; SMS only for critical categories; course-rep message limits |
| Security headers | Helmet: HSTS, frame-ancestors none, no-sniff, referrer policy |
| Vulnerable dependencies | Lockfile committed; `npm audit` and Dependabot in CI; licences checked |
| WebSocket abuse | Token-authenticated handshake; permission check on every room join; per-connection rate limit |

## 5. Secrets and encryption

- Secrets never enter git. Only `.env.example` with placeholder values is committed, and CI runs a secret scanner.
- Production secrets live in the host's secret manager (D-16).
- TLS is required everywhere. Database and Redis connections use TLS outside local development.
- Application-level encryption (AES-256-GCM) protects per-session QR secrets, rotating beacon keys and TOTP secrets, with the key held outside the database.
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
