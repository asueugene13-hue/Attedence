# Smart class monitoring and cancellation detection

The server watches every scheduled class, not the phones. If a lecturer has not started 15 minutes after the scheduled time, the class becomes UNCONFIRMED and the lecturer is asked what is happening. If the situation is still unresolved 15 minutes later, or once enough students report a problem, the class goes to an administrator for review. Nothing in this process can cancel a class. Only a lecturer or an administrator can, with a reason.

**Status:** design draft (2026-11-08). All times and thresholds below are defaults stored as settings (D-13).

## 1. Timeline of one class

| When (relative to scheduled start) | What the server does |
| --- | --- |
| Timetable published | Session generated; checkpoint jobs scheduled |
| T − 24 h | Lecturer reminder with actions: Confirm, Delay, Cancel, Reschedule, Report issue |
| T − 1 h | Lecturer and student reminders |
| T − 15 min | Lecturer and student reminders. Start class becomes available. |
| T | Lecturer: "Your class starts now". The student issue-report window opens for all issue types. |
| T + 15 min | No lecturer activity: status becomes **UNCONFIRMED**. The lecturer gets a high-priority push: *"Your scheduled class has not been confirmed. What is happening?"* with buttons START CLASS, CLASS DELAYED, CANCEL CLASS, RESCHEDULE CLASS, REPORT A PROBLEM. |
| T + 15 to T + 30 min | Each new report, and a once-a-minute tick, re-runs the detection engine |
| T + 30 min, or earlier if the report threshold is met | Still unresolved: status becomes **UNDER_REVIEW**. A review is opened and the responsible administrator is notified. Students see "The university is checking on this class". |
| Scheduled end | Still under review: it stays there until an administrator decides. Nothing counts toward attendance in the meantime. |

**A delay restarts the clock.** When the lecturer reports a delay, the class becomes POSTPONED with a new expected start. Students are told immediately, and the checkpoints move: the class becomes UNCONFIRMED only if the new start + 15 min passes without activity.

**"Lecturer activity"** means confirming, starting, delaying, cancelling, requesting a reschedule or reporting an issue for that session. Opening the app does not count, because it tells us nothing about the class.

## 2. Student and course-rep reports

| Rule | Value |
| --- | --- |
| Who can report | Students enrolled in one of the session's sections; the section's active course rep; the assigned lecturer |
| Issue types | Lecturer has not arrived, Lecturer verbally cancelled, Class delayed, Wrong classroom, Venue problem, Timetable error, Technical problem, Other |
| Window | T − 30 min to the scheduled end. "Lecturer has not arrived" opens only at T + 5 min. |
| Duplicates | One report per student, per type, per session (database unique key) |
| Spam limits | At most 3 reports per student per session and 10 per student per day. A student whose reports are repeatedly dismissed is flagged to administrators, never auto-punished. |
| Note | Optional, plain text, at most 500 characters |

Every report is stored with its type and time, linked to the session, and shown to the lecturer and to the reviewing administrator.

## 3. Detection engine

`DetectionEngineService` is a pure function, which means it reads only what it is given and changes nothing. That makes every rule easy to test with fixed examples.

**Inputs:** the session and its status; minutes since the (expected) start; lecturer activity so far; reports grouped by type, with distinct reporters; the number of eligible students; course-rep reports; whether the lecturer has already been prompted; and the thresholds.

**Output:** one recommendation and its reasons.

| Recommendation | When (defaults) |
| --- | --- |
| `NONE` | The lecturer has acted, or nothing points to a problem |
| `NOTIFY_LECTURER` | Before T + 15, at least one "not arrived" or "delayed" report has arrived. The lecturer gets an early nudge. |
| `MARK_UNCONFIRMED` | T + 15 has passed with no lecturer activity |
| `ESCALATE_TO_REVIEW` | Status is UNCONFIRMED, and either T + 30 has passed or the report threshold is met |
| `ESCALATE_TO_REVIEW` (priority) | Any "lecturer verbally cancelled" report while the class is unconfirmed. The administrator is also asked to get the lecturer to record the cancellation formally. |

**Report threshold (D-13, decided 2026-11-09):** at least 3 distinct reporting students **and** at least 10% of the enrolled class. Both numbers matter: 3 alone is noise in a class of 300, and 10% alone is a single student in a class of 8. Both are settings. **Course reps (rule confirmed by the product owner 2026-11-09, "corroboration"):**

- The rep always counts as one reporter, never as two.
- A rep's report opens a second, shorter path to an early review: the rep plus at least 1 other enrolled student (setting `monitoring.repCorroboratingStudents`) reporting a problem escalates an UNCONFIRMED class.
- A rep alone never escalates; the class then goes to review at T + 30 as usual.
- A rep's report nudges the lecturer at once and marks the review as priority.

**Which reports count as evidence:** "lecturer has not arrived", "lecturer verbally cancelled" and "class delayed". The other types are shown to the reviewer but never move a class.

The engine never recommends cancellation. `ClassSessionMonitorService` turns a recommendation into a status change through `ClassEventService`, the only place status changes happen (CLASS_LIFECYCLE.md §6).

## 4. Who is alerted

| Event | Lecturer | Students | Course rep | Administrator |
| --- | --- | --- | --- | --- |
| UNCONFIRMED | Push with action buttons, plus in-app | — | In-app note | — |
| Delay reported | — | Push and in-app, with the new time | Push | — |
| UNDER_REVIEW | Push: "This class has been referred for review" | In-app: "The university is checking" | Push | Push and in-app with the evidence summary. Email if not opened within 15 min. |
| Cancelled or rescheduled | Confirmation | Push and in-app immediately; email or SMS for critical categories where configured | Push | In-app |

The responsible administrators are those whose scope covers the course's department. If none exists, administrators with institution-wide scope are alerted. The Super Admin is not part of day-to-day escalation.

## 5. Services

| Service | Job |
| --- | --- |
| `ClassSessionMonitorService` | Schedules checkpoint jobs per session and runs the sweeper. Calls the detection engine and applies recommendations. |
| `DetectionEngineService` | Pure evaluation of evidence → recommendation (section 3) |
| `ClassAlertService` | Chooses recipients and channels and builds the messages, with action buttons for lecturers |
| `ClassEventService` | Validates and applies status transitions, and writes events, audit entries and outbox rows |

## 6. Reliability

- **Two mechanisms, one result.** Each checkpoint (T − 24 h, T − 1 h, T − 15, T, T + 15, T + 30) is a BullMQ delayed job with a fixed ID such as `monitor:<sessionId>:T+15`, so it cannot be queued twice. A sweeper also runs every minute and finds any session whose checkpoint has passed without being applied. Whichever runs first does the work, and the other finds nothing to do.
- **Conditional updates.** Every automatic transition says "only if the status is still X". A lecturer pressing Start at the same moment the T + 15 job fires produces exactly one outcome: ACTIVE wins if it commits first, and if the job wins, the lecturer's later Start is still allowed from UNCONFIRMED.
- **Job records.** Every run writes a `BackgroundJobRecord`. Failed jobs retry with backoff. After the final failure, a `SystemEvent` alert reaches the Super Admin's system-health view. Test scenario 23 covers this.
- **Changes move checkpoints.** A delay, a timetable edit or a reschedule cancels and re-creates that session's jobs.

## 6a. As built (Phase 3 step 5a)

- **One sweep, every minute,** finds every watched class (SCHEDULED, CONFIRMED, POSTPONED, UNCONFIRMED) whose first checkpoint has passed, looking back 7 days, and evaluates it. Each issue report also queues an immediate evaluation of its class, in the same transaction as the report. Per-session delayed checkpoint jobs (section 6) are not used: the sweep alone is simpler and at most one minute late. Reminders (T − 24 h, T − 1 h, T − 15) come with notifications in step 6.
- The sweep is a repeating job (`JobRegistry.every`), queued once per minute even with several processes, and recorded like any other job. `RUN_SCHEDULED_JOBS=false` switches repeating jobs off; the API's automated tests do this and run the sweep themselves at the test clock's time.
- **Confirmation (D-13 wording "no lecturer activity or confirmation"):** a class the lecturer confirmed does not become UNCONFIRMED. So that a confirmed class nobody starts cannot slip through, the report threshold and the course-rep rule still send a confirmed-but-not-started class to review after the +15 checkpoint. The time-based review at +30 applies only to UNCONFIRMED classes.
- **Lecturer activity** that prevents UNCONFIRMED: confirming, starting, delaying (which moves the clock), cancelling, a waiting reschedule request, or a report by the lecturer about this class.
- **Nudges:** before the checkpoint (or for a confirmed class), the first evidence report records a `LECTURER_PROMPTED` event, once per class. Becoming UNCONFIRMED counts as the nudge. Sending the actual message comes with notifications in step 6.
- **System changes** go through `ClassEventService.applySystem`. It changes the class only if its status and version are still what the check saw, records a SYSTEM class event and an audit entry, and otherwise does nothing (a person acting at the same moment wins).
- **Escalation** opens a `class_status_reviews` row (trigger `SYSTEM_ESCALATION`, priority if a rep reported or a verbal cancellation was reported, with the engine's reasons) in the same transaction. An administrator's "open review" action opens one with trigger `ADMIN_OPENED`.
- **Who sees reports:** administrators within scope see the reporter. The class's lecturer sees every report, but students only as "student" or "course rep", so nobody is discouraged from reporting. Students see their own reports.
- Dismissed reports never count as evidence.

## 6b. As built (Phase 3 step 5b)

- **Queue:** administrators with `class_reviews.decide` see open reviews for classes within their scope, priority first, then the oldest. Each comes with the class, the reasons it was opened and report counts by type, and opens to the full event timeline and every report.
- **Decisions** (section 7) go through `ClassEventService` like any status change. The review is decided in the same transaction, with the administrator's note. "Cancelled" uses the cancel action with its reason code. "Rescheduled" runs the reschedule flow (D-11), including its conflict check.
- **When a person changes a class under review** (cancels it, reschedules it or puts it on hold), its open review is decided in the same transaction with a note saying how. **Starting the class does not decide it** (CLASS_LIFECYCLE.md §4): the start shows in the timeline, and the administrator then decides "held", which leaves the class as it is.
- **Dismissing a report** keeps it in the record but stops it counting as evidence.
- **Auto-end:** the sweep ends a class still ACTIVE 30 minutes after its scheduled end (`AUTO_ENDED`, a SYSTEM event). The lecturer is told when notifications arrive (step 6).

## 7. Administrator review

The review screen shows the timeline of events, every report, the lecturer's responses and attendance activity. The administrator chooses one decision:

| Decision | Result |
| --- | --- |
| Class was held | COMPLETED. It counts for attendance only if attendance was taken. |
| Cancelled | CANCELLED with a reason, for example `LECTURER_ABSENT_NO_NOTICE`. Students notified. |
| Postponed | POSTPONED with a new expected start |
| Rescheduled | Reschedule flow (CLASS_LIFECYCLE.md §5) |
| No action needed | Returns to SCHEDULED, or CONFIRMED if the lecturer had confirmed. Only allowed before start + 15 min; after that, one of the decisions above must be chosen. |

Every decision needs a note and is audited.
