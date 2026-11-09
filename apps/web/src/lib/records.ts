/** Shapes of the Phase 2 API responses the Registrar screens use (docs/API_DOCUMENTATION.md). */

export interface Ref {
  id: string;
  code: string;
  name: string;
}

export interface Programme extends Ref {
  department: { id: string; code: string; name: string; facultyId: string };
}

export interface Level extends Ref {
  sortOrder: number;
}

export interface Semester {
  id: string;
  academicYearId: string;
  number: number;
  name: string;
  status: 'PLANNED' | 'ACTIVE' | 'CLOSED';
}

export interface AcademicYear {
  id: string;
  label: string;
  isCurrent: boolean;
  semesters: Semester[];
}

export type StudentStatus = 'ACTIVE' | 'DEFERRED' | 'SUSPENDED' | 'WITHDRAWN' | 'GRADUATED';

export interface StudentView {
  id: string;
  studentNumber: string;
  fullName: string;
  email: string;
  phone: string | null;
  accountStatus: 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  status: StudentStatus;
  programme: Ref;
  department: Ref;
  faculty: Ref;
  level: Ref;
  academicYear: { id: string; label: string };
  semester: { id: string; name: string; status: Semester['status'] };
  noDeviceExemption: boolean;
  hasPhoto: boolean;
  verifiedAt: string | null;
  version: number;
  createdAt: string;
}

export type ImportKind = 'students' | 'enrollments';

export interface ImportBatchView {
  id: string;
  type: 'STUDENTS' | 'ENROLLMENTS';
  format: 'CSV' | 'XLSX';
  fileName: string | null;
  status: 'VALIDATED' | 'IMPORTING' | 'COMPLETED' | 'CANCELLED';
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  importedRows: number;
  uploadedBy: { id: string; fullName: string };
  decidedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  activationEmails?: { pending: number; sent: number; failed: number };
}

export type ImportRowStatus = 'VALID' | 'INVALID' | 'DUPLICATE_IN_FILE' | 'DUPLICATE_EXISTING' | 'IMPORTED';

export interface ImportRowView {
  rowNumber: number;
  status: ImportRowStatus;
  raw: Record<string, string>;
  errors: { column: string | null; code: string; message: string }[] | null;
  emailStatus: 'PENDING' | 'SENT' | 'FAILED' | null;
}

export interface Section {
  id: string;
  code: string;
  name: string | null;
  capacity: number | null;
  isActive: boolean;
}

export interface Offering {
  id: string;
  status: 'DRAFT' | 'OPEN' | 'CLOSED';
  course: { id: string; code: string; title: string };
  semester: { id: string; name: string; status: Semester['status']; academicYear: { label: string } };
  sections: Section[];
}

export interface EnrollmentView {
  id: string;
  status: 'ENROLLED' | 'DROPPED' | 'WITHDRAWN';
  enrolledAt: string;
  endedAt: string | null;
  endReason: string | null;
  student: { id: string; studentNumber: string; fullName: string };
  section: { id: string; code: string };
  course: { id: string; code: string; title: string };
  semester: { id: string; name: string; status: Semester['status'] };
}

export interface Roster {
  section: { id: string; code: string; capacity: number | null; course: { code: string; title: string } };
  enrolledCount: number;
  students: {
    enrollmentId: string;
    studentId: string;
    studentNumber: string;
    fullName: string;
    programme: { code: string; name: string };
    level: { code: string; name: string };
    enrolledAt: string;
  }[];
}

export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  ACTIVE: 'Active',
  DEFERRED: 'Deferred',
  SUSPENDED: 'Suspended',
  WITHDRAWN: 'Withdrawn',
  GRADUATED: 'Graduated',
};

export const studentTone = (s: StudentStatus) =>
  s === 'ACTIVE' ? 'success' : s === 'GRADUATED' ? 'info' : s === 'SUSPENDED' ? 'error' : 'warning';

export const batchTone = (s: ImportBatchView['status']) =>
  s === 'COMPLETED' ? 'success' : s === 'CANCELLED' ? 'neutral' : 'warning';

export const IMPORT_STATUS_LABELS: Record<ImportBatchView['status'], string> = {
  VALIDATED: 'Checked, waiting for confirmation',
  IMPORTING: 'Importing',
  COMPLETED: 'Imported',
  CANCELLED: 'Cancelled',
};

export const ROW_STATUS_LABELS: Record<ImportRowStatus, string> = {
  VALID: 'Ready',
  INVALID: 'Has problems',
  DUPLICATE_IN_FILE: 'Repeated in file',
  DUPLICATE_EXISTING: 'Already exists',
  IMPORTED: 'Imported',
};

export const ENROLLMENT_STATUS_LABELS: Record<EnrollmentView['status'], string> = {
  ENROLLED: 'Enrolled',
  DROPPED: 'Dropped',
  WITHDRAWN: 'Withdrawn',
};

export const IMPORT_KINDS: Record<ImportKind, { label: string; noun: string; permission: string }> = {
  students: { label: 'Students', noun: 'students', permission: 'students.import' },
  enrollments: { label: 'Enrolments', noun: 'enrolments', permission: 'enrollments.manage' },
};

/** A section as the setup screens see it: hints and current lecturers included. */
export interface SetupSection extends Section {
  programme: { id: string; code: string; name: string } | null;
  level: { id: string; code: string; name: string } | null;
  assignments: {
    id: string;
    isPrimary: boolean;
    assignedAt: string;
    lecturer: { id: string; staffNumber: string; title: string | null; user: { fullName: string } };
  }[];
}

export interface SetupOffering extends Omit<Offering, 'sections'> {
  sections: SetupSection[];
}

export interface CourseRepView {
  id: string;
  status: 'NOMINATED' | 'ACTIVE' | 'ENDED' | 'REJECTED';
  student: { id: string; studentNumber: string; fullName: string };
  section: { id: string; code: string };
  course: { id: string; code: string; title: string };
  nominationNote: string | null;
  startsAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
}
