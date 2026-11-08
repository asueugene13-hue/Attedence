# Entity-relationship diagrams

The schema has about 60 tables, so it is drawn as six domain diagrams rather than one unreadable poster. Field-level detail, constraints and indexes are in [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md).

Reading the notation: `||--o{` means "one to zero-or-more", `||--|{` means "one to one-or-more", `||--o|` means "one to zero-or-one". The diagrams render on GitHub. In VS Code, install a Mermaid preview extension.

## How the domains connect

```mermaid
flowchart LR
  ID["Identity and security<br/>User, Role, UserRole, UserDevice, AuditLog"]
  AC["Academic structure<br/>Faculty to CourseSection, profiles, enrolments"]
  PL["Places<br/>Campus, Building, Classroom, ClassroomBeacon"]
  TT["Timetable and sessions<br/>TimetableEntry, ClassSession, ClassEvent, reviews"]
  AT["Attendance<br/>AttendanceSession, attempts, evidence, records"]
  CO["Communication and system<br/>Notification, Announcement, imports, exports, RiskFlag"]
  ID --> AC
  AC --> TT
  PL --> TT
  TT --> AT
  AC --> AT
  PL --> AT
  ID --> CO
  AT --> CO
```

## 1. Identity and security

```mermaid
erDiagram
  User ||--o{ UserRole : "holds"
  Role ||--o{ UserRole : "granted as"
  Role ||--o{ RolePermission : "bundles"
  Permission ||--o{ RolePermission : "included in"
  User ||--o{ AuthSession : "signs in through"
  AuthSession ||--o{ RefreshToken : "rotates"
  User ||--o{ UserToken : "receives"
  User ||--o{ UserDevice : "registers"
  UserDevice |o--o{ AuthSession : "used by"
  User ||--o{ AuditLog : "acts in"
  User ||--o| StudentProfile : "is a"
  User ||--o| LecturerProfile : "is a"
```

## 2. Academic structure

```mermaid
erDiagram
  Faculty ||--o{ Department : "contains"
  Department ||--o{ Programme : "offers"
  Department ||--o{ Course : "owns"
  Department ||--o{ LecturerProfile : "employs"
  Programme ||--o{ StudentProfile : "has students"
  AcademicLevel ||--o{ StudentProfile : "current level of"
  AcademicYear ||--|{ Semester : "divided into"
  Semester ||--o{ CalendarException : "has holidays"
  Semester ||--o{ CourseOffering : "runs"
  Course ||--o{ CourseOffering : "offered as"
  CourseOffering ||--|{ CourseSection : "split into"
  StudentProfile ||--o{ CourseEnrollment : "takes"
  CourseSection ||--o{ CourseEnrollment : "has"
  CourseOffering ||--o{ CourseEnrollment : "one per student"
  LecturerProfile ||--o{ LecturerAssignment : "teaches"
  CourseSection ||--o{ LecturerAssignment : "taught by"
  StudentProfile ||--o{ CourseRepresentativeAssignment : "serves as rep"
  CourseSection ||--o{ CourseRepresentativeAssignment : "represented by"
```

## 3. Places

```mermaid
erDiagram
  Campus ||--o{ Building : "contains"
  Building ||--o{ Classroom : "contains"
  Classroom ||--o{ ClassroomBeacon : "fitted with"
  ClassroomBeacon ||--o{ BeaconHealthSnapshot : "observed in"
```

## 4. Timetable and class sessions

```mermaid
erDiagram
  Semester ||--o{ Timetable : "has versions"
  Timetable ||--o{ TimetableEntry : "contains"
  Timetable ||--o{ TimetableChange : "history"
  TimetableEntry ||--|{ TimetableEntrySection : "serves"
  CourseSection ||--o{ TimetableEntrySection : "scheduled in"
  LecturerProfile ||--o{ TimetableEntry : "teaches"
  Classroom ||--o{ TimetableEntry : "hosts"
  TimetableEntry ||--o{ ClassSession : "generates"
  ClassSession ||--|{ ClassSessionSection : "serves"
  CourseSection ||--o{ ClassSessionSection : "meets in"
  LecturerProfile ||--o{ ClassSession : "expected to teach"
  Classroom ||--o{ ClassSession : "held in"
  ClassSession ||--o{ ClassEvent : "history"
  ClassSession ||--o{ ClassIssueReport : "reported on"
  ClassSession ||--o{ ClassStatusReview : "reviewed in"
  ClassSession ||--o{ ClassRescheduleRelationship : "original of"
  ClassSession |o--o| ClassRescheduleRelationship : "replacement in"
  ClassSession ||--o{ MakeupSuggestion : "make-up ideas"
```

## 5. Attendance and verification

```mermaid
erDiagram
  ClassSession ||--o| AttendanceSession : "opens"
  VerificationPolicy ||--o{ AttendanceSession : "applied to"
  AttendanceSession ||--o{ QRToken : "issues"
  AttendanceSession ||--o{ AttendanceAttempt : "receives"
  StudentProfile ||--o{ AttendanceAttempt : "makes"
  UserDevice ||--o{ AttendanceAttempt : "sent from"
  AttendanceAttempt ||--|{ VerificationEvidence : "carries"
  AttendanceAttempt ||--|{ VerificationDecision : "decided by"
  ClassSession ||--o{ AttendanceRecord : "has"
  StudentProfile ||--o{ AttendanceRecord : "has"
  AttendanceAttempt |o--o| AttendanceRecord : "verified"
  AttendanceRecord ||--o{ AttendanceCorrection : "changed by"
  AttendanceRecord ||--o{ AttendanceDispute : "disputed in"
  AttendanceRecord ||--o{ ManualAttendanceOverride : "created by exception"
  StudentProfile ||--o{ ExcuseRequest : "submits"
  ExcuseRequest ||--|{ ExcuseRequestSession : "covers"
  ClassSession ||--o{ ExcuseRequestSession : "excused in"
  AttendanceAttempt ||--o{ RiskFlag : "may raise"
  AttendancePolicy ||--o{ CourseOffering : "may override for"
```

`AttendancePolicy` applies by scope (institution, faculty, department or offering) rather than by a foreign key. The last line shows that relationship conceptually.

## 6. Communication, files and system

```mermaid
erDiagram
  User ||--o{ Notification : "receives"
  Notification ||--o{ NotificationDelivery : "sent through"
  User ||--o{ NotificationPreference : "sets"
  User ||--o{ Announcement : "writes"
  Announcement ||--o{ AnnouncementRecipient : "delivered to"
  User ||--o{ AnnouncementRecipient : "reads"
  Announcement ||--o{ MessageReport : "reported in"
  User ||--o{ FileObject : "uploads"
  FileObject ||--o| ImportBatch : "source of"
  ImportBatch ||--|{ ImportRow : "contains"
  User ||--o{ ReportExport : "requests"
  FileObject |o--o| ReportExport : "result of"
  AttendanceDispute ||--o{ DisputeAttachment : "has"
  ExcuseRequest ||--o{ ExcuseAttachment : "has"
  FileObject ||--o{ DisputeAttachment : "attached as"
  FileObject ||--o{ ExcuseAttachment : "attached as"
```

`InstitutionSetting`, `SystemEvent`, `BackgroundJobRecord` and `OutboxEvent` stand alone and have no relationships worth drawing.
