import { type APIRequestContext, expect, test } from '@playwright/test';
import pg from 'pg';
import { PASSWORD, signInAsSuperAdmin } from './helpers';

// Phase 6 screens, end to end: a student's dispute decided by the lecturer on the Reviews page; an
// announcement written on the web, reported by a student and hidden by the lecturer; an excuse request
// decided by an administrator. Uses the class, lecturer and student from 07 (its attendance is closed
// and student 2 was approved present). Students act through the API, as their phone app does.
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3100/api/v1';
const LECTURER = 'e2e.lecturer@example.test';
const STUDENT = 'e2e.student2@example.test';

async function apiToken(request: APIRequestContext, identifier: string) {
  const res = await request.post(`${API}/auth/login`, {
    data: { identifier, password: PASSWORD, client: 'MOBILE' },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).accessToken as string;
}
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Journey 03 deferred student 2; set them back to an active student, so announcements reach them. */
async function reinstateStudent() {
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      `UPDATE student_profiles SET status = 'ACTIVE' WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [STUDENT],
    );
  } finally {
    await db.end();
  }
}

/** Student 2's record in the class 07 ran (the newest one). */
async function latestRecord(): Promise<{
  id: string;
  classSessionId: string;
  version: number;
  status: string;
}> {
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    const row = (
      await db.query(
        `SELECT r.id, r.class_session_id AS "classSessionId", r.version, r.status
           FROM attendance_records r
           JOIN student_profiles p ON p.id = r.student_id
           JOIN users u ON u.id = p.user_id
          WHERE u.email = $1
          ORDER BY r.created_at DESC LIMIT 1`,
        [STUDENT],
      )
    ).rows[0];
    return row;
  } finally {
    await db.end();
  }
}

test('a dispute, an announcement and an excuse request through the Phase 6 screens', async ({
  page,
  request,
}) => {
  await reinstateStudent();
  const lecturer = await apiToken(request, LECTURER);
  const student = await apiToken(request, STUDENT);

  // Setup through the real API: the lecturer corrects the record to absent (with a reason, as any
  // correction), so the student has something to dispute.
  const before = await latestRecord();
  expect(before.status).toBe('PRESENT');
  const corrected = await request.post(`${API}/attendance-records/${before.id}/correct`, {
    headers: as(lecturer),
    data: { status: 'ABSENT', reason: 'Set up for the e2e dispute journey (test)', version: before.version },
  });
  expect(corrected.status()).toBe(200);

  // 1. The student disputes the absence (as the phone does).
  const sent = await request.post(`${API}/disputes`, {
    headers: as(student),
    data: {
      classSessionId: before.classSessionId,
      reason: 'I was in the room and my check-in was approved (test).',
    },
  });
  expect(sent.status()).toBe(201);

  // 2. The lecturer sees it waiting on the dashboard, opens it on Reviews and approves it as present.
  await page.goto('/login');
  await page.getByLabel('Email or Student ID').fill(LECTURER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const tile = page.getByRole('link', { name: /Disputes to decide/ });
  await expect(tile).toContainText('1');
  await page.screenshot({ path: 'test-results/screens/22-lecturer-dashboard.png', fullPage: true });
  await tile.click();
  await page.getByRole('button', { name: /E2E Student Two/ }).click();
  await expect(page.getByText('I was in the room and my check-in was approved (test).')).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/23-dispute-review.png', fullPage: true });
  await page.getByRole('button', { name: 'Approve' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve the dispute' });
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toBeHidden();
  await expect(
    page.getByRole('region', { name: 'Details' }).getByText('Approved', { exact: true }),
  ).toBeVisible();
  expect((await latestRecord()).status).toBe('PRESENT');

  // 3. An announcement to the section, written on the web.
  await page.getByRole('link', { name: 'Announcements' }).click();
  const form = page.getByRole('form', { name: 'Write an announcement' });
  await form.getByRole('checkbox', { name: /TST101 · A/ }).check();
  await form.getByLabel(/^Title/).fill('Room change for the next class (test)');
  await form.getByLabel(/^Message/).fill('We meet in Room 2 next time (test).');
  await form.getByRole('button', { name: 'Send announcement' }).click();
  await expect(form.getByText(/Sent to \d+ students/)).toBeVisible();
  const card = page.getByRole('article').filter({ hasText: 'Room change for the next class (test)' });
  await expect(card).toContainText('Delivered');
  await page.screenshot({ path: 'test-results/screens/24-announcements.png', fullPage: true });

  // 4. The student reads it in the feed and reports it; the lecturer hides it from the Reported view.
  const feed = await request.get(`${API}/me/announcements`, { headers: as(student) });
  const item = (await feed.json()).data.find(
    (a: { title: string }) => a.title === 'Room change for the next class (test)',
  );
  expect(item).toBeTruthy();
  const report = await request.post(`${API}/announcements/${item.id}/report`, {
    headers: as(student),
    data: { reason: 'Reported to test moderation (test)' },
  });
  expect(report.ok()).toBe(true);
  await page.getByRole('button', { name: 'Reported' }).click();
  const reported = page.getByRole('article').filter({ hasText: 'Room change for the next class (test)' });
  await expect(reported).toContainText('Reported to test moderation (test)');
  await reported.getByRole('button', { name: 'Hide' }).click();
  const hide = page.getByRole('dialog', { name: 'Hide this announcement' });
  await hide.getByLabel('Why').fill('Hidden in the e2e journey (test)');
  await hide.getByRole('button', { name: 'Hide' }).click();
  await expect(reported).toContainText('Hidden: Hidden in the e2e journey (test)');
  const after = await request.get(`${API}/me/announcements`, { headers: as(student) });
  expect((await after.json()).data.some((a: { id: string }) => a.id === item.id)).toBe(false);

  // 5. The student asks to be excused for today; an administrator decides it. The class was attended,
  //    so the record stays present.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Accra' }).format(new Date());
  const excuse = await request.post(`${API}/excuse-requests`, {
    headers: as(student),
    data: {
      category: 'OTHER',
      startDate: today,
      endDate: today,
      description: 'A family matter (test only).',
    },
  });
  expect(excuse.status()).toBe(201);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signInAsSuperAdmin(page, 4);
  await page.goto('/reviews');
  await page.getByRole('tab', { name: 'Excuse requests' }).click();
  await page.getByRole('button', { name: /E2E Student Two/ }).click();
  await expect(page.getByText('A family matter (test only).')).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/25-excuse-review.png', fullPage: true });
  await page.getByRole('button', { name: 'Excuse classes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Excuse classes' });
  await dialog.getByRole('button', { name: /Excuse \d+ class/ }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('region', { name: 'Details' }).getByText('Approved', { exact: true }),
  ).toBeVisible();
  expect((await latestRecord()).status).toBe('PRESENT');
});
