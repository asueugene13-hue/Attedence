import { REQUEST_ATTACHMENT_LIMITS } from '@attendsure/shared';
import * as DocumentPicker from 'expo-document-picker';

/** Disputes and excuse requests as the API returns them (Phase 6 steps 2–3). */
export type RequestStatus = 'SUBMITTED' | 'INFO_REQUESTED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
export type RequestKind = 'dispute' | 'excuse';

export interface Message {
  kind: 'QUESTION' | 'REPLY';
  body: string;
  by: string;
  at: string;
}
export interface Attachment {
  fileId: string;
  name: string | null;
  mimeType: string;
  sizeBytes: number;
}

export interface Dispute {
  id: string;
  status: RequestStatus;
  reason: string;
  submittedAt: string;
  decidedAt: string | null;
  outcome: 'PRESENT' | 'LATE' | null;
  decisionNote: string | null;
  record: { id: string; statusWhenDisputed: string; status: string | null };
  class: { id: string; scheduledStart: string; course: { code: string; title: string } | null } | null;
  messages?: Message[];
  attachments?: Attachment[];
  attempts?: { receivedAt: string; outcome: string; reason: string | null }[];
}

export interface Excuse {
  id: string;
  status: RequestStatus;
  category: ExcuseCategory;
  description: string;
  startDate: string;
  endDate: string;
  submittedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  classCount: number;
  excusedCount: number;
  classes?: {
    classSessionId: string;
    scheduledStart: string | null;
    course: { code: string; title: string } | null;
    included: boolean | null;
    recordStatus: string | null;
  }[];
  messages?: Message[];
  attachments?: Attachment[];
}

export type ExcuseCategory = 'MEDICAL' | 'BEREAVEMENT' | 'OFFICIAL_UNIVERSITY_DUTY' | 'OTHER';
export const EXCUSE_CATEGORY_LABELS: Record<ExcuseCategory, string> = {
  MEDICAL: 'Medical',
  BEREAVEMENT: 'Bereavement',
  OFFICIAL_UNIVERSITY_DUTY: 'Official university duty',
  OTHER: 'Other',
};

/** What each status means to the student, with a tone for its badge. */
export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  SUBMITTED: { label: 'Waiting for a decision', tone: 'info' },
  INFO_REQUESTED: { label: 'Your reply needed', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Not approved', tone: 'error' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
};
export type Tone = 'info' | 'warning' | 'success' | 'error' | 'neutral';

export const isOpen = (status: RequestStatus) => status === 'SUBMITTED' || status === 'INFO_REQUESTED';

export const RECORD_STATUS_LABELS: Record<string, string> = {
  PRESENT: 'Present',
  LATE: 'Late',
  ABSENT: 'Absent',
  REJECTED: 'Rejected',
  PENDING: 'Waiting for a decision',
  UNDER_REVIEW: 'Under review',
  EXCUSED: 'Excused',
  VOIDED: 'Voided',
};

/** "Tue 3 Nov · 10:00" in the phone's time zone. */
export function classWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Lets the student choose a PDF or photo and returns it as a multipart form (field `file`), or null if
 * they cancelled. The server checks the real type from the bytes; this only narrows the picker.
 */
export async function pickAttachment(): Promise<{ form: FormData; name: string } | { tooBig: true } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [...REQUEST_ATTACHMENT_LIMITS.types],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || result.assets.length === 0) return null;
  const file = result.assets[0]!;
  if (file.size !== undefined && file.size > REQUEST_ATTACHMENT_LIMITS.maxFileBytes) return { tooBig: true };
  const form = new FormData();
  // React Native's FormData takes a { uri, name, type } object for a file.
  form.append('file', {
    uri: file.uri,
    name: file.name,
    type: file.mimeType ?? 'application/octet-stream',
  } as never);
  return { form, name: file.name };
}
