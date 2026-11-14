# User acceptance testing (UAT) plan

**For:** Knutsford University staff who will use AttendSure, and whoever coordinates the testing.
**Purpose:** before AttendSure is used for real attendance, the people who will rely on it try every everyday task themselves and confirm it does what the university needs. Passing UAT, with the sign-off sheet ([UAT_SIGNOFF.md](UAT_SIGNOFF.md)) completed, is Phase 8's exit criterion.

## 1. Who takes part

The university chooses the people. Suggested, at least:

| Role | Who | How many |
| --- | --- | --- |
| Registrar | The Registrar or a member of the Registry | 1–2 |
| University Administrator | Academic administrators (one university-wide, one limited to a faculty or department, if that is how Knutsford works) | 2 |
| Super Admin | The person who will manage AttendSure (often from IT) | 1 |
| Lecturer | Lecturers from at least two departments | 2–3 |
| Course representative | A course rep from one of those courses | 1 |
| Student | Volunteers, each with their own Android phone (and an iPhone if possible) | 5–10 |
| IT | Whoever will run the servers | 1 |

A coordinator books the sessions, keeps the issue list and collects signatures.

## 2. Where it happens

- **On a staging copy of AttendSure** on the chosen host (D-16), never on the live system.
- **With test data only.** Either obviously fake data, or a copy of real data that the university's data protection lead has approved for testing (Act 843). Real student records are never typed into staging without that approval.
- **In real rooms for check-in:** at least two classrooms with the chosen beacons installed (D-08). The Phase 4 field test should be done first ([PHONE_TEST_CHECKLIST.md](PHONE_TEST_CHECKLIST.md) §2).
- Each tester gets their own account; no shared accounts.

**Before UAT starts** (the coordinator checks): the decisions in [GO_LIVE_CHECKLIST.md](GO_LIVE_CHECKLIST.md) §1 that affect behaviour are made (especially D-09 attendance rules and D-14 ID formats); staging is up; testers have their activation emails; this plan has been read.

## 3. How to record results

For every task: ✅ **Pass** (did what was expected), ❌ **Fail** (write what happened, with a screenshot), or ⚠️ **Pass with a comment** (works, but something should change).

Every ❌ and ⚠️ goes on the issue list with a severity:

| Severity | Meaning | Before go-live |
| --- | --- | --- |
| 1, Critical | Wrong attendance, data seen by the wrong person, data lost, or the task cannot be done at all | Must be fixed and re-tested |
| 2, Major | The task can be done only with a workaround, or a rule does not match university policy | Must be fixed, or the university accepts it in writing |
| 3, Minor | Wording, layout, convenience | Fixed when possible; does not block |

## 4. The tasks

Expected results are summaries; the screens explain each step. The numbers in brackets are the matching automated test scenarios ([TESTING.md](TESTING.md) §2), already passing.

### 4.1 Super Admin and IT

| # | Task | Expected |
| --- | --- | --- |
| S1 | Activate the first account, set up two-step sign-in, keep the recovery codes | Works; recovery codes shown once |
| S2 | Create the University Administrator and Registrar accounts; limit one administrator to a faculty or department | They receive activation emails; the limited administrator sees only that area |
| S3 | Change a setting (for example the late cut-off) with a reason | Saved; shown in the audit log with who, when and why |
| S4 | Audit log: filter by area and dates; download the entries | The entries in plain words; the download is itself logged |
| S5 | System health: background jobs and problems | Every schedule "Running"; no unexplained problems |
| S6 | IT: back up staging and restore it into an empty database (DEPLOYMENT.md §9) | Restore matches; time recorded in DEPLOYMENT.md §6 |

### 4.2 Registrar

| # | Task | Expected |
| --- | --- | --- |
| R1 | Set up (or check) faculties, departments, programmes, levels, the academic year and semester | Matches the university's structure |
| R2 | Download the student import template, fill in test students, import; fix the rows it reports | Bad rows explained; good rows imported once; activation emails sent |
| R3 | Register one student by hand; add a photo; enrol them in a course | Saved; the student can activate |
| R4 | Change a student's status (for example deferred) with a reason | Recorded with the reason and shown on the record; check what the student can still do and confirm it matches university policy |
| R5 | Approve a student's replacement phone (11) | The new phone works; the old one no longer counts |
| R6 | Reports: students and enrolments for the semester, as Excel | The file matches the screens; marked as personal data |

### 4.3 University Administrator

| # | Task | Expected |
| --- | --- | --- |
| A1 | Courses, lecturers, rooms and beacons for the test classrooms; publish a timetable | Classes appear for lecturers and students |
| A2 | Home dashboard during a teaching day | Today's classes and what waits for a decision, matching the other screens |
| A3 | A class with no lecturer activity becomes "Not confirmed", then "Under review" (16) | Students and the administrator are told; decide the review with a reason (18) |
| A4 | Approve a lecturer's reschedule request; try one that clashes (15) | The clash is refused; the approved one moves the class and tells students |
| A5 | Decide a dispute and an excuse request (19) | The student is told; attendance changes only as decided, with the reason |
| A6 | Review a risk flag (for example two students on one phone) | Nothing happens to the student until a person decides |
| A7 | Reports: attendance by department and by lecturer; class operations; download as PDF | Figures match the screens; only your area if you are limited to one |
| A8 | As a faculty-limited administrator, try another faculty's records | Not shown, or refused |

### 4.4 Lecturer

| # | Task | Expected |
| --- | --- | --- |
| L1 | Today: start the class and open attendance; show the QR on the projector (web) and on the phone | The code changes every 15 s |
| L2 | Watch the live roster while students check in | Each student appears within seconds |
| L3 | Check in a student without a phone (assisted), with a reason | Marked, labelled assisted, logged |
| L4 | Correct a record afterwards, with a reason (20) | Changed; the history shows before, after, who and why |
| L5 | Cancel a class with a reason (13); delay one (14) | Students told; the cancelled class does not count against anyone (21) |
| L6 | Answer a student's dispute | The student sees the decision |
| L7 | Download your class group's register as Excel and PDF | Matches the roster |
| L8 | Send an official course announcement | Students of that course receive it |

### 4.5 Course representative

| # | Task | Expected |
| --- | --- | --- |
| C1 | Send an update to the course (limited per day) | Labelled as from the course rep |
| C2 | Report a problem with a class (17) | The report reaches the administrators; the class's status does not change because of it alone |
| C3 | Try to change attendance or a timetable | Not possible |

### 4.6 Students (in a real classroom)

| # | Task | Expected |
| --- | --- | --- |
| T1 | Activate from the email, sign in on your own phone | Your phone becomes your attendance phone |
| T2 | Check in to a class: scan the QR in the room (1) | Present (or Late after the cut-off) |
| T3 | A tester tries from outside the building, or with a screenshot sent by a friend (2, 4) | Not accepted, or sent for review; never marked present automatically |
| T4 | Bluetooth off (8); internet lost for a minute after scanning (12) | Clear message; the offline check-in is sent when back online |
| T5 | Everyone checks in within the same minute | All recorded; nobody counted twice (25) |
| T6 | My attendance: percentage and per-class explanation | Matches what happened in the session |
| T7 | Dispute a record with a photo; ask to be excused for a date with a document | Shown in My requests; decision arrives as a notification |
| T8 | Show your student ID to a staff member, who checks it with their phone | "Genuine", with your photo |
| T9 | Try someone else's record or a staff screen | Not possible |

## 5. Finishing

UAT is complete when:

1. every task in §4 has been done by someone in that role;
2. there are **no open severity 1 issues**, and every severity 2 issue is fixed and re-tested or accepted in writing;
3. the restore drill on staging has passed (S6);
4. each group lead and the university's sponsor sign [UAT_SIGNOFF.md](UAT_SIGNOFF.md).

The coordinator keeps the completed task sheets and the issue list with the sign-off.
