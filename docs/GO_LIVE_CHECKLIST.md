# Go-live checklist

**For:** the product owner and the university's project sponsor, who decide when AttendSure starts being used for real attendance, and IT, who carry out the technical items.
**How to use it:** tick each item and write who confirmed it and when. Go live only when every item in §1–§5 is ticked or explicitly waived in writing by the sponsor.

## 1. Decisions the university must make

These are still open (IMPLEMENTATION_PROGRESS.md, decision list). AttendSure is built to take each one as a setting or configuration; none needs new development unless noted.

| ☐ | Decision | Why it matters at go-live |
| --- | --- | --- |
| ☐ | **D-16** Hosting, data location, Data Protection Commission registration | Nothing can go live without a host and the university's data protection approval (Act 843) |
| ☐ | **D-09** Attendance rules: minimum percentage, late cut-off, whether late counts, how excused absences count, when attendance closes | The interim defaults would otherwise decide students' percentages |
| ☐ | **D-08** Beacon hardware and protocol, after the classroom trial | Check-in in real rooms depends on it (fixed-ID beacons are weaker: KNOWN_LIMITATIONS 6) |
| ☐ | **D-14** Staff ID format, and confirmation of the 8-digit student ID | Imports and searches use them |
| ☐ | **D-17** Email service (and an SMS gateway if wanted) | Activation emails, alerts and notifications |
| ☐ | **D-18** How long each kind of record is kept | Required by Act 843; only report files are cleaned up today (7 days) |
| ☐ | **D-07** University single sign-on (Microsoft 365 or Google), if wanted | Without it, everyone activates an AttendSure password (works today) |
| ☐ | **D-20** Whether combined classes happen | Supported; confirms how timetables are entered |
| ☐ | **D-15** Brand colours | The crest and wordmark are in use; colours can be swapped |
| ☐ | Who is Super Admin (at least two people) and who approves accounts | The last Super Admin cannot be removed; two-step sign-in is required |

## 2. Tested and signed off

| ☐ | Item |
| --- | --- |
| ☐ | Phase 4 field test in two real classrooms done, thresholds set from the measurements (PHONE_TEST_CHECKLIST.md §2) |
| ☐ | Phone test checklist completed on Android (and iPhone if supported at launch) with the release build |
| ☐ | UAT completed and signed (UAT_PLAN.md, UAT_SIGNOFF.md): no open severity 1 issues |
| ☐ | Load test repeated on the real host (apps/api/load/README.md) with the expected largest class; results in DEPLOYMENT.md §8 |
| ☐ | Restore drill passed on the real host's staging, timed (DEPLOYMENT.md §6) |
| ☐ | CI green on the release commit: tests, image builds, secret scan |
| ☐ | `npm audit` checked on the release commit: nothing high or critical; the moderate advisories in build tools reviewed again (KNOWN_LIMITATIONS 112) |

## 3. Production set up

| ☐ | Item |
| --- | --- |
| ☐ | Real domain name; HTTPS certificate valid; `SITE_ADDRESS` set; HSTS at one year (the default) |
| ☐ | Secrets only in the host's secret manager: new `JWT_ACCESS_SECRET` and `ENCRYPTION_KEY` (never the example or rehearsal ones; the API refuses the examples) |
| ☐ | `ENCRYPTION_KEY` and the backup passphrase stored safely, separately from backups, with at least two people able to reach them |
| ☐ | Database with encrypted storage, TLS and point-in-time recovery; Redis with a password, persistence and TLS; private storage bucket with versioning |
| ☐ | `FILES_ORIGIN` / `S3_PUBLIC_ENDPOINT` set to the storage service's https address |
| ☐ | Daily encrypted backups running and copied off-site; first one restored successfully |
| ☐ | Monitoring: uptime check on the site; alerts when System health has overdue schedules or problems; metrics collected if wanted (`METRICS_TOKEN`) |
| ☐ | Email sending from a university address works (activation email received by a test account) |
| ☐ | Mobile app built for production with the real API address, signed with the university's keys, and published (Google Play, App Store, or the university's own distribution) |
| ☐ | Runbook contacts filled in (RUNBOOK.md §8) |

## 4. Real data loaded

| ☐ | Item |
| --- | --- |
| ☐ | Academic structure, calendar, rooms and beacons entered and checked by the Registry and administrators |
| ☐ | Lecturers and courses entered; timetable published for the first week |
| ☐ | Students imported from the Registry's file; the error report reviewed; enrolments checked for a sample of courses |
| ☐ | **No test data in production:** no `example.test` accounts, no `99xxxxxx` students, no `(test)` names. The load-test setup refuses to run outside the rehearsal; nothing else in the repository creates test people in a running system |
| ☐ | Activation emails sent in batches, starting with staff |

## 5. People ready

| ☐ | Item |
| --- | --- |
| ☐ | Lecturers shown how to open attendance, run the live roster, check in a student by hand and correct a record |
| ☐ | Administrators shown the dashboard, class reviews, disputes, excuses, risk flags and reports |
| ☐ | Students told how to activate, which phone counts, and what to do if check-in fails (ask the lecturer; nobody is marked absent by a fraud flag alone) |
| ☐ | A help contact announced for the first weeks |

## 6. The first week

| ☐ | Item |
| --- | --- |
| ☐ | Start with a pilot (a few courses or one faculty) before everyone, if the sponsor agrees |
| ☐ | Daily: System health, overdue schedules, risk flags, disputes waiting, beacons suspected faulty |
| ☐ | Watch the first busy check-in times (start of the day's first classes) |
| ☐ | Collect problems in one list; fix severity 1 at once |
| ☐ | **Fallback if AttendSure is unavailable:** lecturers record attendance as they do today and enter it afterwards as corrections with the reason "System unavailable" (every correction keeps a reason and an audit entry) |
| ☐ | End of week: review with the sponsor; decide whether to widen the rollout |
