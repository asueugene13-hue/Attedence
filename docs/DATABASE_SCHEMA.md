# Database schema

PostgreSQL holds every AttendSure record; Prisma is the tool the API uses to read and write it. This document is the Phase 0 design: about 60 tables in six domains. The constraints that protect attendance and timetables are enforced by the database itself, not only by application code.

**Status:** design draft (2026-11-08). The real `apps/api/prisma/schema.prisma` is written domain by domain in Phases 1–5. Diagrams are in [ER_DIAGRAM.md](ER_DIAGRAM.md).

## 1. Conventions

- **Primary keys:** `id String @id @default(uuid(7)) @db.Uuid` on every table, except pure join tables, which use a composite key.
- **Timestamps:** every table has `createdAt`. Tables whose rows change also have `updatedAt`. All date-times are `timestamptz` and stored in UTC. Calendar dates (semester start, holidays) are `date`.
- **Shorthand in this draft:** `id`, `createdAt` and `updatedAt` stand for the full declarations above. Any field ending in `ById` is a foreign key to `User.id`. Its Prisma relation field, and the matching back-relations on `User`, are left out to keep this readable. The real schema includes them.
- **Table names:** every model maps to a snake_case plural table (`@@map("class_sessions")`) so hand-written SQL stays readable.
- **No hard deletes of academic or attendance data.** Rows change status (`DROPPED`, `RETIRED`, `VOIDED`) instead. Deletion happens only under the retention rules in section 7.
- **Optimistic locking:** rows that two people might edit at once carry `version Int @default(0)`. An update says "only if version is still N". If someone else changed it first, the API returns `409 Conflict` instead of silently overwriting.
- **Foreign keys** use `ON DELETE RESTRICT` unless stated otherwise, so a record that others depend on cannot vanish.

## 2. Enums

```prisma
enum RoleKey             { SUPER_ADMIN UNIVERSITY_ADMIN REGISTRAR LECTURER STUDENT COURSE_REP }
enum UserStatus          { PENDING_ACTIVATION ACTIVE SUSPENDED DEACTIVATED }
enum ScopeType           { INSTITUTION FACULTY DEPARTMENT }
enum ClientType          { WEB MOBILE }
enum TokenPurpose        { ACTIVATION PASSWORD_RESET EMAIL_CHANGE }
enum DevicePlatform      { ANDROID IOS }
enum DeviceStatus        { PENDING_APPROVAL TRUSTED REVOKED REPLACED }
enum ActorType           { USER SYSTEM }

enum StudentStatus       { ACTIVE DEFERRED SUSPENDED WITHDRAWN GRADUATED }
enum StaffStatus         { ACTIVE ON_LEAVE INACTIVE }
enum SemesterStatus      { PLANNED ACTIVE CLOSED }
enum OfferingStatus      { DRAFT OPEN CLOSED }
enum EnrollmentStatus    { ENROLLED DROPPED WITHDRAWN }
enum CalendarExceptionType { PUBLIC_HOLIDAY UNIVERSITY_CLOSURE EXAM_PERIOD OTHER }

enum BeaconProtocol      { EDDYSTONE_EID EDDYSTONE_UID IBEACON VENDOR_SECURE }
enum BeaconStatus        { ACTIVE INACTIVE FAULTY RETIRED }

enum TimetableStatus     { DRAFT PUBLISHED SUPERSEDED ARCHIVED }
enum Recurrence          { WEEKLY EVERY_OTHER_WEEK SELECTED_WEEKS ONCE }   // decided 2026-11-09; WEEKLY is the default
enum SessionKind         { REGULAR MAKEUP REPLACEMENT }
enum ClassStatus         { SCHEDULED CONFIRMED ACTIVE COMPLETED CANCELLED POSTPONED RESCHEDULED
                           UNCONFIRMED UNDER_REVIEW SUSPENDED INTERRUPTED }
enum ClassEventType      { GENERATED UPDATED VENUE_CHANGED REMINDER_SENT CONFIRMED STARTED DELAY_REPORTED
                           MARKED_UNCONFIRMED LECTURER_PROMPTED ISSUE_REPORTED ESCALATED REVIEW_DECIDED
                           CANCELLED RESCHEDULED SUSPENDED RESUMED INTERRUPTED ENDED AUTO_ENDED
                           ATTENDANCE_OPENED ATTENDANCE_CLOSED ATTENDANCE_REOPENED ATTENDANCE_VOIDED REINSTATED }
enum CancelReason        { LECTURER_UNAVAILABLE ILLNESS OFFICIAL_DUTY VENUE_UNAVAILABLE INSTITUTION_EVENT
                           PUBLIC_HOLIDAY EMERGENCY LECTURER_ABSENT_NO_NOTICE OTHER }
enum IssueType           { LECTURER_NOT_ARRIVED VERBAL_CANCELLATION CLASS_DELAYED WRONG_CLASSROOM
                           VENUE_PROBLEM TIMETABLE_ERROR TECHNICAL_PROBLEM OTHER }
enum ReporterRole        { STUDENT COURSE_REP LECTURER }
enum ReviewTrigger       { SYSTEM_ESCALATION ADMIN_OPENED }
enum ReviewStatus        { OPEN DECIDED }
enum IssueReportStatus   { OPEN ACKNOWLEDGED RESOLVED DISMISSED }
enum ReviewDecision      { CLASS_HELD CANCELLED POSTPONED RESCHEDULED NO_ACTION }
enum RescheduleStatus    { PENDING APPROVED REJECTED WITHDRAWN }

enum AttendanceSessionStatus { OPEN CLOSED VOIDED }
enum VerificationOutcome { VERIFIED REJECTED PENDING_VERIFICATION MANUAL_REVIEW_REQUIRED EXCEPTION_APPROVED }
enum AttendanceStatus    { PRESENT LATE ABSENT PENDING REJECTED EXCUSED UNDER_REVIEW VOIDED }
enum RecordSource        { CHECK_IN LECTURER_ASSISTED AUTO_ABSENT CORRECTION }
enum EvidenceType        { QR BLE GPS DEVICE INTEGRITY }
enum EvidenceResult      { PASS WEAK FAIL UNAVAILABLE CONFLICT }
enum DeciderType         { ENGINE LECTURER ADMIN }
enum OverrideMethod      { LECTURER_ASSISTED BEACON_FAILURE DEVICE_FAILURE NO_SMARTPHONE OTHER }
enum CorrectionSource    { DISPUTE EXCUSE LECTURER ADMIN SESSION_VOID REVIEW }
enum CorrectionStatus    { APPLIED PENDING_APPROVAL REJECTED }
enum RequestStatus       { SUBMITTED NEEDS_INFO APPROVED REJECTED WITHDRAWN }
enum ExcuseCategory      { MEDICAL BEREAVEMENT OFFICIAL_UNIVERSITY_DUTY OTHER }
enum PolicyScope         { INSTITUTION FACULTY DEPARTMENT OFFERING }

enum NotificationChannel { IN_APP EMAIL PUSH }   // IN_APP and EMAIL first; PUSH built but disabled until a university Firebase project exists; SMS waits for D-17
enum NotificationPriority { NORMAL HIGH CRITICAL }
enum DeliveryStatus      { QUEUED SENT FAILED SUPPRESSED }
enum AnnouncementScope   { SECTION OFFERING DEPARTMENT FACULTY INSTITUTION }
enum AnnouncementStatus  { PUBLISHED HIDDEN REMOVED }
enum ReportStatus        { OPEN ACTIONED DISMISSED }

enum FilePurpose         { PROFILE_PHOTO IMPORT_FILE EXPORT_FILE ATTACHMENT }
enum FileStatus          { PENDING_UPLOAD AVAILABLE QUARANTINED DELETED }
enum ImportType          { STUDENTS ENROLLMENTS LECTURERS COURSES }
enum ImportStatus        { UPLOADED VALIDATING VALIDATED IMPORTING COMPLETED FAILED CANCELLED }
enum ImportRowStatus     { VALID INVALID DUPLICATE_IN_FILE DUPLICATE_EXISTING IMPORTED FAILED SKIPPED }
enum ExportFormat        { CSV XLSX PDF }
enum ExportStatus        { QUEUED RUNNING READY FAILED EXPIRED }
enum RiskType            { SHARED_DEVICE DEVICE_SWITCH ACCOUNT_SWITCH BEACON_LOCATION_CONFLICT MOCK_LOCATION
                           INTEGRITY_FAILED REPEATED_REJECTIONS UNEXPECTED_BEACON }
enum Severity            { INFO LOW MEDIUM HIGH CRITICAL }
enum FlagStatus          { OPEN UNDER_REVIEW DISMISSED CONFIRMED }
enum JobStatus           { QUEUED RUNNING SUCCEEDED FAILED DEAD }
```

## 3. Models

### 3.1 Identity and security

```prisma
model User {
  id
  email            String     @unique            // stored lower-case
  phone            String?                        // Ghana format validated in the shared schema
  fullName         String
  passwordHash     String?                        // Argon2id; null until the account is activated
  status           UserStatus @default(PENDING_ACTIVATION)
  mfaSecretEnc     String?                        // encrypted TOTP secret (staff roles)
  mfaEnabledAt     DateTime?
  failedLoginCount Int        @default(0)
  lockedUntil      DateTime?
  lastLoginAt      DateTime?
  createdAt
  updatedAt
}

model Role {
  id
  key         RoleKey @unique
  name        String
  description String?
}

model Permission {
  id
  key         String  @unique        // e.g. "attendance.correct"
  description String
  isProtected Boolean @default(false) // may only be held by SUPER_ADMIN
}

model RolePermission {
  roleId       String @db.Uuid
  permissionId String @db.Uuid
  role         Role       @relation(fields: [roleId], references: [id])
  permission   Permission @relation(fields: [permissionId], references: [id])
  @@id([roleId, permissionId])
}

model UserRole {                     // a grant of a role, optionally limited to a faculty or department
  id
  userId      String    @db.Uuid
  roleId      String    @db.Uuid
  scopeType   ScopeType @default(INSTITUTION)
  scopeId     String?   @db.Uuid     // Faculty.id or Department.id when scoped
  grantedById String    @db.Uuid
  grantedAt   DateTime  @default(now())
  revokedAt   DateTime?
  revokedById String?   @db.Uuid
  user        User @relation(fields: [userId], references: [id])
  role        Role @relation(fields: [roleId], references: [id])
  @@index([userId])
  // partial unique index (SQL): one active grant per user, role and scope
}

model AuthSession {                  // one signed-in client
  id
  userId        String     @db.Uuid
  client        ClientType
  deviceId      String?    @db.Uuid   // UserDevice for mobile sessions
  activeRoleKey RoleKey?
  ip            String?
  userAgent     String?
  createdAt
  expiresAt     DateTime
  lastUsedAt    DateTime?
  revokedAt     DateTime?
  revokeReason  String?
  @@index([userId])
}

model RefreshToken {                 // rotated on every use; reuse of a used token revokes the session
  id
  sessionId    String    @db.Uuid
  tokenHash    String    @unique     // SHA-256 of the random token; the token itself is never stored
  issuedAt     DateTime  @default(now())
  expiresAt    DateTime
  usedAt       DateTime?
  replacedById String?   @db.Uuid
  session      AuthSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
}

model UserToken {                    // activation and password-reset links
  id
  userId    String       @db.Uuid
  purpose   TokenPurpose
  tokenHash String       @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt
}

model UserDevice {
  id
  userId               String         @db.Uuid
  installationId       String                     // random ID created on first launch, kept in secure storage
  platform             DevicePlatform
  model                String?
  osVersion            String?
  appVersion           String?
  publicKey            String?                    // the phone's Ed25519 public key (base64url); the private key never leaves the phone
  trustRequestedAt     DateTime?                  // a student's request to make this the attendance phone (D-10)
  trustRequestReason   String?
  isAttendanceDevice   Boolean        @default(false)
  status               DeviceStatus   @default(PENDING_APPROVAL)
  trustedAt            DateTime?
  approvedById         String?        @db.Uuid
  revokedAt            DateTime?
  revokedById          String?        @db.Uuid
  revokeReason         String?
  lastIntegrityVerdict Json?
  lastIntegrityAt      DateTime?
  pushToken            String?
  pushTokenUpdatedAt   DateTime?
  lastSeenAt           DateTime?
  createdAt
  updatedAt
  @@unique([userId, installationId])
  @@index([installationId])            // spots one phone used by several accounts
  // partial unique index (SQL): one TRUSTED attendance device per user
}

model AuditLog {                     // append-only (trigger in section 4)
  id
  occurredAt   DateTime  @default(now())
  actorType    ActorType
  actorUserId  String?   @db.Uuid
  actorRoleKey RoleKey?
  action       String               // e.g. "attendance.record.corrected"
  entityType   String
  entityId     String?
  before       Json?
  after        Json?
  reason       String?
  requestId    String?
  ip           String?
  userAgent    String?
  @@index([entityType, entityId])
  @@index([actorUserId, occurredAt])
  @@index([action, occurredAt])
}
```

### 3.2 Academic structure and places

```prisma
model Faculty    { id  code String @unique  name String  isActive Boolean @default(true)  createdAt updatedAt }
model Department { id  facultyId String @db.Uuid  code String @unique  name String  isActive Boolean @default(true)  createdAt updatedAt }
model Programme  { id  departmentId String @db.Uuid  code String @unique  name String  qualification String?  durationYears Int?  isActive Boolean @default(true)  createdAt updatedAt }

model AcademicLevel {
  id
  code      String @unique   // as Knutsford names them, e.g. a level code entered by staff
  name      String
  sortOrder Int    @unique
}

model AcademicYear {
  id
  label     String   @unique  // e.g. "2026/2027", entered by staff
  startDate DateTime @db.Date
  endDate   DateTime @db.Date
  isCurrent Boolean  @default(false)   // partial unique index: only one current year
}

model Semester {
  id
  academicYearId String         @db.Uuid
  number         Int
  name           String
  startDate      DateTime       @db.Date
  endDate        DateTime       @db.Date
  status         SemesterStatus @default(PLANNED)   // partial unique index: only one ACTIVE
  @@unique([academicYearId, number])
}

model CalendarException {            // holidays and closures: no sessions are generated on these dates
  id
  semesterId        String?               @db.Uuid
  type              CalendarExceptionType
  name              String
  startDate         DateTime              @db.Date
  endDate           DateTime              @db.Date
  suppressesClasses Boolean               @default(true)
  createdById       String                @db.Uuid
  createdAt
}

model Course {
  id
  code         String  @unique
  title        String
  creditHours  Int?
  departmentId String  @db.Uuid
  isActive     Boolean @default(true)
  createdAt
  updatedAt
}

model CourseOffering {               // a course running in a specific semester
  id
  courseId   String         @db.Uuid
  semesterId String         @db.Uuid
  status     OfferingStatus @default(DRAFT)
  createdAt
  updatedAt
  @@unique([courseId, semesterId])
}

model CourseSection {                // a class group inside an offering
  id
  offeringId  String  @db.Uuid
  code        String           // e.g. "A", entered by staff
  name        String?
  capacity    Int?
  programmeId String? @db.Uuid  // optional cohort hint for timetable conflict checks
  levelId     String? @db.Uuid
  createdAt
  updatedAt
  @@unique([offeringId, code])
}

model StudentProfile {
  id
  userId                String        @unique @db.Uuid
  studentNumber         String        @unique   // 8 digits (D-14, confirmed 2026-11-08)
  programmeId           String        @db.Uuid  // faculty and department come from the programme
  levelId               String        @db.Uuid
  currentAcademicYearId String        @db.Uuid
  currentSemesterId     String        @db.Uuid
  status                StudentStatus @default(ACTIVE)
  photoFileId           String?       @db.Uuid
  noDeviceExemption     Boolean       @default(false)   // student without a compatible phone
  registeredById        String        @db.Uuid
  verifiedAt            DateTime?
  verifiedById          String?       @db.Uuid
  version               Int           @default(0)
  createdAt
  updatedAt
  @@index([programmeId, levelId])
}

model LecturerProfile {
  id
  userId       String      @unique @db.Uuid
  staffNumber  String      @unique
  departmentId String      @db.Uuid
  title        String?
  status       StaffStatus @default(ACTIVE)
  createdAt
  updatedAt
}

model CourseEnrollment {
  id
  studentId   String           @db.Uuid
  offeringId  String           @db.Uuid   // stored so one student cannot hold two sections of one offering
  sectionId   String           @db.Uuid
  status      EnrollmentStatus @default(ENROLLED)
  enrolledAt  DateTime         @default(now())   // classes before this date do not count for the student
  droppedAt   DateTime?
  importRowId String?          @db.Uuid
  createdById String           @db.Uuid
  createdAt
  updatedAt
  @@unique([studentId, offeringId])
  @@index([sectionId, status])
  @@index([studentId, status])
}

model LecturerAssignment {
  id
  lecturerId   String    @db.Uuid
  sectionId    String    @db.Uuid
  isPrimary    Boolean   @default(true)
  assignedById String    @db.Uuid
  assignedAt   DateTime  @default(now())
  endedAt      DateTime?
  @@unique([lecturerId, sectionId])
  @@index([sectionId])
}

model CourseRepresentativeAssignment {
  id
  studentId    String    @db.Uuid   // must be enrolled in the section (checked in the service)
  sectionId    String    @db.Uuid   // the semester comes from section -> offering -> semester
  startsAt     DateTime
  endsAt       DateTime?
  revokedAt    DateTime?
  assignedById String    @db.Uuid
  revokedById  String?   @db.Uuid
  createdAt
  @@index([sectionId])
  @@index([studentId])
}

model Campus {
  id
  code            String  @unique
  name            String
  geofenceLat     Decimal? @db.Decimal(9, 6)
  geofenceLng     Decimal? @db.Decimal(9, 6)
  geofenceRadiusM Int?
  isActive        Boolean @default(true)
}

model Building {
  id
  campusId        String   @db.Uuid
  code            String
  name            String
  geofenceLat     Decimal? @db.Decimal(9, 6)   // overrides the campus geofence when set
  geofenceLng     Decimal? @db.Decimal(9, 6)
  geofenceRadiusM Int?
  @@unique([campusId, code])
}

model Classroom {
  id
  buildingId String  @db.Uuid
  code       String
  name       String
  floor      String?
  capacity   Int?
  isActive   Boolean @default(true)
  createdAt
  updatedAt
  @@unique([buildingId, code])
}

model ClassroomBeacon {
  id
  classroomId         String         @db.Uuid
  label               String
  vendor              String?
  protocol            BeaconProtocol
  identifier          String         // namespace+instance, or UUID:major:minor
  rotatingKeyEnc      String?        // encrypted identity key for rotating-ID beacons
  rotationExponent    Int?
  txPowerDbm          Int?
  rssiThresholdDbm    Int            // calibrated per room during the site survey
  status              BeaconStatus   @default(ACTIVE)
  batteryPercent      Int?
  lastSeenAt          DateTime?
  installedAt         DateTime?
  calibratedAt        DateTime?
  retiredAt           DateTime?
  notes               String?
  createdAt
  updatedAt
  @@unique([protocol, identifier])
  @@index([classroomId])
}

model BeaconHealthSnapshot {         // built from what students' phones heard, in 5-minute windows
  id
  beaconId        String   @db.Uuid
  windowStart     DateTime
  sightings       Int
  distinctDevices Int
  medianRssi      Int?
  anomalies       Json?    // e.g. heard while GPS was far from campus
  @@unique([beaconId, windowStart])
}
```

### 3.3 Timetable and class sessions

```prisma
model Timetable {
  id
  semesterId    String          @db.Uuid
  name          String
  version       Int
  status        TimetableStatus @default(DRAFT)
  publishedAt   DateTime?
  publishedById String?         @db.Uuid
  createdById   String          @db.Uuid
  createdAt
  updatedAt
  @@unique([semesterId, version])
}

model TimetableEntry {               // a repeating slot, e.g. Tuesdays 10:00-11:30
  id
  timetableId   String      @db.Uuid
  lecturerId    String      @db.Uuid
  classroomId   String      @db.Uuid
  dayOfWeek     Int                     // 1 = Monday ... 7 = Sunday
  startMinute   Int                     // minutes after midnight, Africa/Accra
  endMinute     Int
  recurrence    Recurrence  @default(WEEKLY)
  // EVERY_OTHER_WEEK counts from the first meeting on or after effectiveFrom. SELECTED_WEEKS lists teaching-week numbers, where week 1
  // is the semester's first week. ONCE: effectiveFrom = effectiveTo = the date of the single class.
  selectedWeeks Int[]
  effectiveFrom DateTime    @db.Date
  effectiveTo   DateTime    @db.Date
  isCancelled   Boolean     @default(false)
  version       Int         @default(0)
  createdById   String      @db.Uuid
  createdAt
  updatedAt
  sections      TimetableEntrySection[]
  @@index([timetableId])
}

model TimetableEntryException {      // one date this entry does not meet (besides institution-wide holidays)
  id
  entryId     String   @db.Uuid
  date        DateTime @db.Date
  reason      String
  createdById String   @db.Uuid
  createdAt
  @@unique([entryId, date])
}

model TimetableEntrySection {        // several sections can share one meeting (combined class, D-20)
  entryId   String @db.Uuid
  sectionId String @db.Uuid
  @@id([entryId, sectionId])
  @@index([sectionId])
}

model TimetableChange {              // history of every timetable edit
  id
  timetableId String   @db.Uuid
  entryId     String?  @db.Uuid
  changeType  String   // CREATED | UPDATED | CANCELLED | PUBLISHED | SUPERSEDED
  before      Json?
  after       Json?
  reason      String?
  changedById String   @db.Uuid
  changedAt   DateTime @default(now())
  @@index([timetableId, changedAt])
}

model ClassSession {                 // one concrete meeting on one date
  id
  timetableEntryId String?       @db.Uuid   // null for make-up and replacement sessions
  kind             SessionKind   @default(REGULAR)
  lecturerId       String        @db.Uuid   // the lecturer expected to teach
  classroomId      String        @db.Uuid
  scheduledStart   DateTime
  scheduledEnd     DateTime
  expectedStart    DateTime?               // set when a delay is reported
  actualStart      DateTime?
  actualEnd        DateTime?
  status           ClassStatus   @default(SCHEDULED)
  statusChangedAt  DateTime      @default(now())
  cancelReason     CancelReason?
  cancelNote       String?
  cancelledById    String?       @db.Uuid
  cancelledByTimetableChange Boolean @default(false) // a timetable or calendar change cancelled it, not a person
  rescheduledFromId String?      @unique @db.Uuid  // on a replacement: the session it replaces
  version          Int           @default(0)
  createdAt
  updatedAt
  sections         ClassSessionSection[]
  @@unique([timetableEntryId, scheduledStart])      // generation can run twice safely
  @@index([status, scheduledStart])                 // monitoring sweeper
  @@index([lecturerId, scheduledStart])
  @@index([classroomId, scheduledStart])
  // exclusion constraints (SQL): no room or lecturer overlap between live sessions
}

model ClassSessionSection {
  classSessionId String @db.Uuid
  sectionId      String @db.Uuid
  @@id([classSessionId, sectionId])
  @@index([sectionId])
}

model ClassEvent {                   // append-only history of a session
  id
  classSessionId String         @db.Uuid
  type           ClassEventType
  fromStatus     ClassStatus?
  toStatus       ClassStatus?
  actorType      ActorType
  actorUserId    String?        @db.Uuid
  payload        Json?
  occurredAt     DateTime       @default(now())
  @@index([classSessionId, occurredAt])
}

model ClassIssueReport {             // Phase 3 step 5a; table class_issue_reports
  id
  classSessionId String            @db.Uuid
  reporterUserId String            @db.Uuid
  reporterRole   ReporterRole               // decided by the server: STUDENT, COURSE_REP or LECTURER
  type           IssueType
  note           String?                    // at most 500 characters (SQL check), plain text
  status         IssueReportStatus @default(OPEN)   // OPEN | ACKNOWLEDGED | RESOLVED | DISMISSED
  createdAt
  @@unique([classSessionId, reporterUserId, type])  // no duplicate reports
  @@index([classSessionId, createdAt])
  @@index([reporterUserId, createdAt])              // daily report limit
}

model ClassStatusReview {            // Phase 3 step 5a; table class_status_reviews
  id
  classSessionId String          @db.Uuid
  trigger        ReviewTrigger              // SYSTEM_ESCALATION | ADMIN_OPENED
  isPriority     Boolean         @default(false)   // a rep reported, or a verbal cancellation was reported
  reasons        Json                       // the engine's reasons, or the administrator's reason
  openedAt       DateTime
  status         ReviewStatus    @default(OPEN)    // OPEN | DECIDED
  decision       ReviewDecision?
  decisionNote   String?
  decidedById    String?         @db.Uuid
  decidedAt      DateTime?
  @@index([status, isPriority, openedAt])
  @@index([classSessionId])
  // partial unique index (SQL): one OPEN review per session
}

model RescheduleRequest {            // Phase 3 step 4b (D-11); table reschedule_requests
  id
  classSessionId       String           @db.Uuid           // the class to move
  requestedById        String           @db.Uuid
  proposedStart        DateTime
  proposedEnd          DateTime
  proposedClassroomId  String           @db.Uuid
  reason               String
  status               RescheduleStatus @default(PENDING)
  isDirect             Boolean          @default(false)    // an administrator rescheduled without a request
  decidedById          String?          @db.Uuid
  decidedAt            DateTime?
  decisionNote         String?
  replacementSessionId String?          @unique @db.Uuid   // set when approved
  createdAt
  @@index([status, createdAt])
  @@index([classSessionId])
  // partial unique index (SQL): one PENDING request per class
}

model MakeupSuggestion {             // from course reps; the lecturer decides
  id
  classSessionId String   @db.Uuid
  suggestedById  String   @db.Uuid
  proposedStart  DateTime
  proposedEnd    DateTime
  note           String?
  status         String   @default("OPEN")   // OPEN | ACCEPTED | DECLINED
  createdAt
}
```

### 3.4 Attendance and verification

```prisma
model VerificationPolicy {           // immutable: a change creates a new version
  id
  name          String
  scopeType     PolicyScope @default(INSTITUTION)
  scopeId       String?     @db.Uuid
  version       Int
  rules         Json        // validated by the shared Zod schema; fields in PRESENCE_VERIFICATION.md §9
  isActive      Boolean     @default(true)
  effectiveFrom DateTime
  createdById   String      @db.Uuid
  createdAt
  @@unique([scopeType, scopeId, version])
}

model AttendancePolicy {             // how attendance is counted (D-09); versioned the same way
  id
  scopeType     PolicyScope @default(INSTITUTION)
  scopeId       String?     @db.Uuid
  version       Int
  rules         Json        // minimum %, late weight, excused handling; ATTENDANCE_FLOW.md §9
  effectiveFrom DateTime
  createdById   String      @db.Uuid
  createdAt
  @@unique([scopeType, scopeId, version])
}

model AttendanceSession {
  id
  classSessionId       String                  @unique @db.Uuid
  status               AttendanceSessionStatus @default(OPEN)
  openedById           String                  @db.Uuid
  openedAt             DateTime                @default(now())
  lateAfter            DateTime
  closesAt             DateTime
  closedAt             DateTime?
  closedById           String?                 @db.Uuid
  closeReason          String?                 // MANUAL | AUTO | CLASS_CANCELLED
  qrSecretEnc          String                  // per-session HMAC key, encrypted at rest
  qrRotationSeconds    Int
  verificationPolicyId String                  @db.Uuid
  beaconDegraded       Boolean                 @default(false)
  version              Int                     @default(0)
}

model QRToken {                      // log of each issued rotation window
  id
  attendanceSessionId String   @db.Uuid
  windowIndex         Int
  issuedAt            DateTime
  expiresAt           DateTime
  @@unique([attendanceSessionId, windowIndex])
}

model AttendanceAttempt {            // every check-in try, including rejected ones
  id
  attendanceSessionId String              @db.Uuid
  studentId           String              @db.Uuid
  deviceId            String?             @db.Uuid
  idempotencyKey      String              @unique
  qrWindowIndex       Int?
  receivedAt          DateTime            @default(now())   // server time, the only time that counts
  clientCapturedAt    DateTime?                              // informational only
  outcome             VerificationOutcome
  reasonCodes         String[]
  retryAllowed        Boolean             @default(false)
  appVersion          String?
  @@index([attendanceSessionId, studentId])
  @@index([attendanceSessionId, outcome])
  @@index([deviceId, receivedAt])
}

model VerificationEvidence {
  id
  attemptId String         @db.Uuid
  type      EvidenceType
  result    EvidenceResult
  detail    Json            // minimal: beacon id + RSSI, or distance band + accuracy; raw coordinates purged after 30 days
  createdAt
  @@index([attemptId])
}

model VerificationDecision {         // append-only: engine decision, then any reviewer decision
  id
  attemptId   String              @db.Uuid
  outcome     VerificationOutcome
  decidedBy   DeciderType
  decidedById String?             @db.Uuid
  policyId    String              @db.Uuid
  ruleTrace   Json                // which rules fired, so the decision can be explained
  note        String?
  decidedAt   DateTime            @default(now())
  @@index([attemptId, decidedAt])
}

model AttendanceRecord {             // at most one per student per class session
  id
  classSessionId      String           @db.Uuid
  attendanceSessionId String           @db.Uuid
  studentId           String           @db.Uuid
  status              AttendanceStatus
  source              RecordSource
  checkedInAt         DateTime?        // receivedAt of the attempt that counted
  verifiedAttemptId   String?          @unique @db.Uuid
  version             Int              @default(0)
  createdAt
  updatedAt
  @@unique([classSessionId, studentId])
  @@index([studentId, status])
  @@index([attendanceSessionId, status])
}

model ManualAttendanceOverride {     // lecturer-assisted exceptions (dead phone, beacon failure)
  id
  attendanceSessionId String         @db.Uuid
  studentId           String         @db.Uuid
  recordId            String         @db.Uuid
  method              OverrideMethod
  reason              String
  performedById       String         @db.Uuid
  performedAt         DateTime       @default(now())
}

model AttendanceCorrection {         // append-only: every change to a record after creation
  id
  recordId      String           @db.Uuid
  fromStatus    AttendanceStatus
  toStatus      AttendanceStatus
  reason        String
  source        CorrectionSource
  sourceId      String?          @db.Uuid   // dispute, excuse or review that caused it
  requestedById String?          @db.Uuid   // null when the system applies it (session void)
  approvedById  String?          @db.Uuid
  status        CorrectionStatus
  createdAt
  appliedAt     DateTime?
  @@index([recordId, createdAt])
}

model AttendanceDispute {
  id
  recordId       String        @db.Uuid
  studentId      String        @db.Uuid
  reason         String
  status         RequestStatus @default(SUBMITTED)
  assignedToId   String?       @db.Uuid
  resolutionNote String?
  resolvedById   String?       @db.Uuid
  resolvedAt     DateTime?
  createdAt
  updatedAt
  // partial unique index (SQL): one open dispute per record
}

model ExcuseRequest {
  id
  studentId      String         @db.Uuid
  category       ExcuseCategory
  description    String
  startDate      DateTime       @db.Date
  endDate        DateTime       @db.Date
  status         RequestStatus  @default(SUBMITTED)
  reviewerId     String?        @db.Uuid
  resolutionNote String?
  resolvedAt     DateTime?
  createdAt
  updatedAt
}

model ExcuseRequestSession {         // the class sessions an excuse covers
  excuseRequestId String  @db.Uuid
  classSessionId  String  @db.Uuid
  approved        Boolean?
  @@id([excuseRequestId, classSessionId])
}

model DisputeAttachment { disputeId String @db.Uuid  fileId String @db.Uuid  @@id([disputeId, fileId]) }
model ExcuseAttachment  { excuseRequestId String @db.Uuid  fileId String @db.Uuid  @@id([excuseRequestId, fileId]) }
```

### 3.5 Communication

```prisma
model Notification {                 // Phase 3 step 6; table notifications
  id
  userId            String               @db.Uuid
  category          String               // NOTIFICATION_CATEGORIES in packages/shared (CLASS_CANCELLED, VENUE_CHANGED …)
  title             String
  body              String
  data              Json?                // deep-link path and lecturer action buttons
  priority          NotificationPriority @default(NORMAL)
  relatedEntityType String?
  relatedEntityId   String?              @db.Uuid
  dedupeKey         String?              // stops the same message being sent twice
  emailIfUnreadAt   DateTime?            // also emailed if still unread then (review alerts)
  readAt            DateTime?
  createdAt
  @@unique([userId, dedupeKey])
  @@index([userId, createdAt])
  @@index([emailIfUnreadAt])
}

model NotificationPreference {       // mandatory categories (cancellations, moves, room changes) ignore opt-outs
  userId    String              @db.Uuid
  category  String
  channel   NotificationChannel        // EMAIL or PUSH; IN_APP is always on
  enabled   Boolean
  updatedAt
  @@id([userId, category, channel])
}

model NotificationDelivery {
  id
  notificationId String              @db.Uuid
  channel        NotificationChannel
  status         DeliveryStatus      @default(QUEUED)   // QUEUED | SENT | FAILED | SUPPRESSED (account not active)
  attempts       Int                 @default(0)
  lastError      String?
  sentAt         DateTime?                               // set exactly when SENT (SQL check)
  createdAt
  updatedAt
  @@unique([notificationId, channel])
  @@index([status, createdAt])
}

model Announcement {
  id
  authorId     String             @db.Uuid
  authorRole   RoleKey            // LECTURER, COURSE_REP or an admin role
  isOfficial   Boolean            // false for course-rep messages; shown differently in the app
  scopeType    AnnouncementScope
  scopeId      String?            @db.Uuid
  title        String
  body         String             // plain text only; never rendered as HTML
  status       AnnouncementStatus @default(PUBLISHED)
  hiddenById   String?            @db.Uuid
  hiddenReason String?
  createdAt
  @@index([scopeType, scopeId, createdAt])
  @@index([authorId, createdAt])     // course-rep rate limits
}

model AnnouncementRecipient {
  announcementId String    @db.Uuid
  userId         String    @db.Uuid
  deliveredAt    DateTime?
  readAt         DateTime?
  @@id([announcementId, userId])
}

model MessageReport {
  id
  announcementId String       @db.Uuid
  reporterId     String       @db.Uuid
  reason         String
  status         ReportStatus @default(OPEN)
  reviewedById   String?      @db.Uuid
  reviewedAt     DateTime?
  createdAt
  @@unique([announcementId, reporterId])
}
```

### 3.6 System, files and imports

```prisma
model InstitutionSetting {           // e.g. "monitoring.unconfirmedAfterMinutes"
  key         String   @id
  value       Json
  version     Int      @default(0)
  updatedById String   @db.Uuid
  updatedAt
}

model FileObject {
  id
  bucket       String
  key          String      @unique
  purpose      FilePurpose
  mimeType     String                // checked from the file's bytes, not its name
  sizeBytes    Int
  sha256       String
  status       FileStatus  @default(PENDING_UPLOAD)
  uploadedById String      @db.Uuid
  createdAt
}

model ImportBatch {
  id
  type              ImportType
  fileId            String       @db.Uuid
  status            ImportStatus @default(UPLOADED)
  totalRows         Int          @default(0)
  validRows         Int          @default(0)
  invalidRows       Int          @default(0)
  duplicateRows     Int          @default(0)
  importedRows      Int          @default(0)
  errorReportFileId String?      @db.Uuid
  uploadedById      String       @db.Uuid
  confirmedById     String?      @db.Uuid
  startedAt         DateTime?
  completedAt       DateTime?
  createdAt
  @@index([type, createdAt])
}

model ImportRow {
  id
  batchId         String          @db.Uuid
  rowNumber       Int
  raw             Json
  normalized      Json?
  errors          Json?           // [{ column, code, message }]
  status          ImportRowStatus
  createdEntityId String?         @db.Uuid
  @@unique([batchId, rowNumber])
  @@index([batchId, status])
}

model ReportExport {
  id
  requestedById        String       @db.Uuid
  reportType           String
  params               Json
  format               ExportFormat
  status               ExportStatus @default(QUEUED)
  containsPersonalData Boolean
  fileId               String?      @db.Uuid
  rowCount             Int?
  createdAt
  completedAt          DateTime?
  expiresAt            DateTime?
  downloadedAt         DateTime?
}

model RiskFlag {                     // Phase 4 step 1; for human review only; never changes attendance by itself
  id
  type                RiskType
  severity            Severity
  status              FlagStatus @default(OPEN)
  studentId           String?    @db.Uuid
  deviceId            String?    @db.Uuid
  attemptId           String?    @db.Uuid
  attendanceSessionId String?    @db.Uuid
  evidence            Json
  reviewedById        String?    @db.Uuid
  reviewedAt          DateTime?
  reviewNote          String?
  createdAt
  @@index([status, createdAt])
  @@index([studentId, createdAt])
}

model SystemEvent {
  id
  type             String
  severity         Severity
  source           String
  message          String
  data             Json?
  acknowledgedById String?  @db.Uuid
  occurredAt       DateTime @default(now())
  @@index([severity, occurredAt])
}

model BackgroundJobRecord {
  id
  queue          String
  name           String
  jobId          String
  idempotencyKey String?   @unique
  status         JobStatus
  attempts       Int       @default(0)
  lastError      String?
  scheduledFor   DateTime?
  startedAt      DateTime?
  finishedAt     DateTime?
  createdAt
  @@index([queue, status])
}

model OutboxEvent {                  // written in the same transaction as the change it follows
  id
  type        String
  payload     Json
  createdAt
  publishedAt DateTime?
  attempts    Int       @default(0)
  @@index([publishedAt, createdAt])
}
```

## 4. Constraints written as SQL in migrations

Prisma cannot describe these, so they go into hand-written migration files. Phase 1 adds a CI check that later migrations do not drop them (risk R10).

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- No room holds two live sessions at once, and no lecturer teaches two at once.
ALTER TABLE class_sessions ADD CONSTRAINT class_sessions_room_no_overlap
  EXCLUDE USING gist (classroom_id WITH =, tstzrange(scheduled_start, scheduled_end, '[)') WITH &&)
  WHERE (status NOT IN ('CANCELLED', 'RESCHEDULED'));
ALTER TABLE class_sessions ADD CONSTRAINT class_sessions_lecturer_no_overlap
  EXCLUDE USING gist (lecturer_id WITH =, tstzrange(scheduled_start, scheduled_end, '[)') WITH &&)
  WHERE (status NOT IN ('CANCELLED', 'RESCHEDULED'));

ALTER TABLE class_sessions    ADD CONSTRAINT class_sessions_time_order CHECK (scheduled_end > scheduled_start);
ALTER TABLE timetable_entries ADD CONSTRAINT timetable_entries_minutes
  CHECK (start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute AND day_of_week BETWEEN 1 AND 7);
ALTER TABLE semesters         ADD CONSTRAINT semesters_dates CHECK (end_date > start_date);

-- Exactly one current academic year and at most one active semester.
CREATE UNIQUE INDEX academic_years_one_current ON academic_years ((true)) WHERE is_current;
CREATE UNIQUE INDEX semesters_one_active      ON semesters ((true)) WHERE status = 'ACTIVE';

-- One trusted attendance phone per user.
CREATE UNIQUE INDEX user_devices_one_trusted ON user_devices (user_id)
  WHERE status = 'TRUSTED' AND is_attendance_device;

-- One active grant per user, role and scope.
CREATE UNIQUE INDEX user_roles_active_unique ON user_roles
  (user_id, role_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;

-- One open review per class session; one open dispute per attendance record.
CREATE UNIQUE INDEX class_status_reviews_one_open ON class_status_reviews (class_session_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX attendance_disputes_one_open  ON attendance_disputes (record_id)
  WHERE status IN ('SUBMITTED', 'NEEDS_INFO');

-- History tables are append-only for the application's database user.
CREATE FUNCTION block_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION block_history_change();
-- Same trigger on class_events, attendance_corrections, verification_decisions, timetable_changes.
```

Retention purges of history tables run as a separate, privileged maintenance role. They drop whole monthly partitions, so routine application code can never alter history.

**Implemented so far** (migrations `20261108161435_identity` and `20261108161550_protect_permissions`):

| Rule | Enforced by |
| --- | --- |
| Emails stored lower-case | `users_email_lowercase` check |
| Scope ID present exactly when a grant is faculty- or department-scoped | `user_roles_scope_consistent` check |
| A revoked grant records who revoked it | `user_roles_revocation_complete` check |
| One active grant per user, role and scope | `user_roles_active_unique` partial unique index |
| One trusted attendance phone per user | `user_devices_one_trusted` partial unique index |
| Audit log is append-only | `audit_logs_append_only` trigger |
| Protected permissions only on SUPER_ADMIN, and cannot be marked protected while another role holds them | `role_permissions_protected` and `permissions_protected_flag` triggers |
| Optional links (revoker, approver, audit actor, device, rotated token) cannot vanish | `ON DELETE RESTRICT`, set explicitly because Prisma defaults optional links to `SET NULL` |

**Added in Phase 2, step 1** (migration `20261108193558_academic_structure`):

| Rule | Enforced by |
| --- | --- |
| Faculty, department, programme and level codes stored in capitals | `*_code_upper` checks |
| Programme duration 1–10 years when given | `programmes_duration_positive` check |
| Dates run forwards (years, semesters, calendar entries) | `*_dates` checks |
| Academic years never overlap; semesters never overlap | `academic_years_no_overlap`, `semesters_no_overlap` exclusion constraints |
| One current academic year; at most one active semester | `academic_years_one_current`, `semesters_one_active` partial unique indexes |

**Added in Phase 2, step 2** (migration `20261108200223_places`):

| Rule | Enforced by |
| --- | --- |
| Campus, building and classroom codes stored in capitals; unique within their parent | `*_code_upper` checks; `@@unique([campusId, code])`, `@@unique([buildingId, code])` |
| A geofence is complete or absent, with real coordinates and a 20–5,000 m radius | `campuses_geofence_valid`, `buildings_geofence_valid` checks |
| Classroom capacity 1–5,000 when given | `classrooms_capacity_positive` check |

**Added in Phase 2, step 3** (migration `20261108203337_courses_and_lecturers`):

| Rule | Enforced by |
| --- | --- |
| Course and section codes and staff numbers stored in capitals | `courses_code_upper`, `course_sections_code_upper`, `lecturer_profiles_staff_number_upper` checks |
| One offering per course per semester; section codes unique within an offering | `@@unique([courseId, semesterId])`, `@@unique([offeringId, code])` |
| One active assignment per lecturer and section; at most one active primary lecturer per section | `lecturer_assignments_active_unique`, `lecturer_assignments_one_primary` partial unique indexes |
| An ended assignment records who ended it | `lecturer_assignments_end_complete` check |

**Added in Phase 2, step 4** (migration `20261108211815_students`):

| Rule | Enforced by |
| --- | --- |
| One student profile per account; Student IDs unique | `student_profiles_user_id_key`, `student_profiles_student_number_key` unique indexes |
| A verified record says who verified it | `student_profiles_verification_complete` check |
| Student ID is exactly 8 digits (D-14) | The API (`StudentNumberSchema` in `packages/shared`), not the database, so a future format change needs no migration |
| Edits never overwrite each other | `version` column, compared with the `If-Match` header in the service |

**Added in Phase 2, step 5** (migration `20261108220000_files_and_imports`): tables `file_objects`, `import_batches`, `import_rows`, and `student_profiles.photo_file_id`.

| Rule | Enforced by |
| --- | --- |
| Storage keys are unique; one photo per student; one batch per uploaded file | `file_objects_key_key`, `student_profiles_photo_file_id_key`, `import_batches_file_id_key` unique indexes |
| Files are never empty; a removed file records when | `file_objects_size_positive`, `file_objects_removal_complete` checks |
| A confirmed or cancelled batch records who decided and when | `import_batches_decision_complete` check |
| Row counts are never negative and never exceed the total | `import_batches_counts_valid` check |
| Row numbers match the spreadsheet (header is row 1) and are unique per batch | `import_rows_row_number_valid` check, `@@unique([batchId, rowNumber])` |

**Added in Phase 2, step 6** (migration `20261108230000_enrollments_and_course_reps`): tables `course_enrollments` and `course_rep_assignments` (named `CourseRepAssignment` in Prisma; one table holds nominations and appointments, told apart by `status`), and the import type `ENROLLMENTS`.

| Rule | Enforced by |
| --- | --- |
| One active enrolment per student and offering; dropped and withdrawn rows stay as history | `course_enrollments_active_unique` partial unique index |
| An ended enrolment records when, by whom and why; an active one has none of these | `course_enrollments_end_complete` check |
| One open (nominated or active) rep assignment per student and section | `course_rep_assignments_open_unique` partial unique index |
| A nomination names its nominator; an appointment names who appointed and from when; an ended or rejected one records when, by whom and why | `course_rep_assignments_state_complete` check |
| Background job attempts are never negative; an acknowledged system event says who and when | `background_job_records_attempts_valid`, `system_events_ack_complete` checks (Phase 3 step 1, migration `20261109090000_jobs_outbox_settings`, which adds `institution_settings`, `outbox_events`, `background_job_records`, `system_events`) |
| The outbox relay finds unpublished rows quickly | `outbox_events_unpublished` partial index |
| At most one draft and one published timetable per semester | `timetables_one_draft`, `timetables_one_published` partial unique indexes (Phase 3 step 2, migration `20261109120000_timetables`) |
| A published timetable says who published it and when; a draft has neither | `timetables_publish_complete` check |
| Entry times, weekday and dates make sense; a one-time class has one date; only "selected weeks" lists weeks | `timetable_entries_times_valid`, `_day_valid`, `_dates_valid`, `_once_single_day`, `_selected_weeks` checks |
| One exception per entry and date | `@@unique([entryId, date])` |
| No room, lecturer or section booked twice at the same time | Service: the clash check runs on every publish and blocks it |
| No room and no lecturer has two live sessions at overlapping times | `class_sessions_room_no_overlap`, `class_sessions_lecturer_no_overlap` exclusion constraints, deferrable so a regeneration is checked as a whole at commit (Phase 3 step 3, migration `20261109150000_class_sessions`) |
| Generation never creates a session twice | `@@unique([timetableEntryId, scheduledStart])` |
| A session ends after it starts; a cancelled one has a reason, any other has none; regular sessions come from an entry, make-up and replacement sessions do not | `class_sessions_time_order`, `class_sessions_cancel_complete`, `class_sessions_kind_source` checks |
| Class history cannot be edited or deleted | `class_events_append_only` trigger |
| At most one waiting reschedule request per class | `reschedule_requests_one_pending` partial unique index (Phase 3 step 4b, migration `20261109180000_reschedules`) |
| A decided request says who decided and when; an approved one names its replacement; the new time ends after it starts | `reschedule_requests_decision_complete`, `reschedule_requests_time_order` checks |
| A student has at most one trusted attendance phone; a public key is 32 bytes in base64url | `user_devices_one_attendance_device` partial unique index, `user_devices_public_key_format` check (Phase 4 step 1, migration `20261110100000_trusted_devices_and_risk_flags`) |
| The same situation is flagged once while open; a reviewed flag has its reviewer, time and note | `risk_flags_one_open_per_key` partial unique index, `risk_flags_review_complete` check |
| At most one open review per class; a decided review has its decision, time and note, an open one none | `class_status_reviews_one_open` partial unique index, `class_status_reviews_decision_complete` check (Phase 3 step 5a, migration `20261109200000_class_monitoring`) |
| One report per person, type and class; notes at most 500 characters | `@@unique([classSessionId, reporterUserId, type])`, `class_issue_reports_note_length` check |
| Only a replacement session points to the session it replaces, and a session is replaced at most once | `class_sessions_replacement_link` check, unique `rescheduled_from_id` |
| A section never takes more students than its capacity, even with simultaneous requests | Service: the section row is locked (`SELECT … FOR UPDATE`) while counting and inserting |

`npm run db:drift -w @attendsure/api` confirms Prisma sees no difference between the migrations and `schema.prisma`, so it will not try to drop these. CI runs it on every push.

Rules that need data from several tables are checked in services inside the transaction:

- A course rep must be enrolled in the section they represent (checked on appointment and approval; ending the enrolment ends the rep role).
- A section's lecturer assignment must be within the offering's semester.
- Publishing a timetable is blocked when two entries share a section, room or lecturer at overlapping times. It warns when students enrolled in both of two overlapping sections would clash.
- A timetable entry's classroom must be active, and its sections must belong to offerings in the same semester.

## 5. Indexes for the busiest queries

| Query | Index |
| --- | --- |
| Monitoring sweeper: sessions past a checkpoint | `class_sessions (status, scheduled_start)` |
| Lecturer's timetable | `class_sessions (lecturer_id, scheduled_start)` |
| Student's timetable | `course_enrollments (student_id, status)` → `class_session_sections (section_id)` |
| Live roster | `course_enrollments (section_id, status)`, `attendance_records (attendance_session_id, status)` |
| Student attendance history | `attendance_records (student_id, status)` |
| Shared-device detection | `user_devices (installation_id)`, `attendance_attempts (device_id, received_at)` |
| Notification centre | `notifications (user_id, created_at)` |
| Audit search | `audit_logs (entity_type, entity_id)`, `(actor_user_id, occurred_at)`, `(action, occurred_at)` |
| Risk review queue | `risk_flags (status, created_at)` |

## 6. Operations that run in one transaction

| Operation | Everything inside the transaction |
| --- | --- |
| Check-in | Attempt, evidence rows, engine decision, record insert or upgrade, outbox row for the roster push |
| Close attendance | Session closed; `ABSENT` rows for eligible students with no record (`INSERT … ON CONFLICT DO NOTHING`); class event; outbox |
| Cancel a class | Conditional status update (`WHERE status IN (…) AND version = n`); class event; audit; if attendance had started, records set to `VOIDED` with one correction row each; outbox for notifications |
| Approve a reschedule | Conflict check repeated; replacement session insert (the exclusion constraints, checked at commit, reject a clash even if two approvals race); request set to `APPROVED` only if still pending; original set to `RESCHEDULED` only if unchanged; class events; audit. Notifications come with step 6 |
| Correct a record | Version-checked update; correction row; audit |
| Grant or revoke a role | User-role row; audit; session refresh forced |
| Confirm a bulk import | One transaction per batch of up to 5,000 rows, so the batch is all-or-nothing. Larger files run in chunks of 1,000 with per-row status, and each row is protected by the unique student number, so a resumed import cannot duplicate anyone. |

## 7. Data retention (proposals, pending D-18)

| Data | Proposed retention | Reason |
| --- | --- | --- |
| Raw GPS coordinates and BLE readings in evidence | 30 days, then reduced to pass/fail and a distance band | Needed only for disputes in the weeks after a class |
| Attendance records, corrections, decisions | Per Knutsford academic-records policy; proposed programme length + 5 years | Academic standing and appeals |
| Audit log | 7 years | Accountability for sensitive actions |
| IP addresses in audit and session rows | 12 months, then removed | Security investigations only |
| Import files and import rows | 90 days after the import | Error correction; the student record itself remains |
| Export files | 7 days (the export log itself is kept) | Downloads should not linger |
| Notifications | 12 months | Notification centre history |
| Refresh tokens and sessions | Expiry + 30 days | Security investigations |
| Device integrity verdicts | 90 days | Fraud review |

Retention runs as a nightly worker job, and every purge writes a `SystemEvent` with counts.
