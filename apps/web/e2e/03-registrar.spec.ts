import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { generateSync } from 'otplib';
import { activationToken, clearMail, fieldLabel, PASSWORD, REGISTRAR_EMAIL } from './helpers';

// Phase 2 exit journey: a Registrar imports students from the template end to end. Bad rows and
// duplicates are held back with a downloadable error report; then the Registrar works with one record
// and enrols a student. Uses the structure 02-setup created. All data is obviously fake.
test.describe.configure({ mode: 'serial' });

const STUDENT_EMAILS = ['e2e.student1@example.test', 'e2e.student2@example.test'];
const MANUAL_EMAIL = 'e2e.student7@example.test';
// The smallest valid PNG (1×1 pixel), so the browser can display the uploaded photo.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function activateAndSignIn(page: Page, token: string, email: string) {
  await page.goto(`/activate?token=${token}`);
  await page.getByRole('textbox', { name: 'New password', exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat new password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate account' }).click();
  await expect(page.getByText('Your account is active.')).toBeVisible();
  await page.getByRole('link', { name: 'Go to sign in' }).click();
  await page.getByLabel('Email or Student ID').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Registrars use two-step sign-in, set up on first sign-in.
  await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('6-digit code').fill(generateSync({ secret }));
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await page.getByLabel('I have saved these codes somewhere safe.').check();
  await page.getByRole('button', { name: 'Continue to AttendSure' }).click();
}

test('Registrar imports students from the template and manages a record', async ({ page, request }) => {
  for (const to of STUDENT_EMAILS) await clearMail(request, to);

  // 1. The Registrar activates from the real email and signs in.
  await activateAndSignIn(page, await activationToken(request, REGISTRAR_EMAIL), REGISTRAR_EMAIL);
  await expect(page.getByRole('heading', { name: 'Welcome, E2E Registrar (test)' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const item of ['Students', 'Bulk import', 'Enrolments']) {
    await expect(nav.getByRole('link', { name: item })).toBeVisible();
  }

  // 2. Bulk import: download the template, upload a filled file.
  await nav.getByRole('link', { name: 'Bulk import' }).click();
  await expect(page.getByRole('heading', { name: 'Bulk import' })).toBeVisible();
  const templateDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel (.xlsx)' }).click();
  expect((await templateDownload).suggestedFilename()).toBe('students-import-template.xlsx');

  const csv = [
    'student_number,full_name,email,phone,programme_code,level_code,academic_year,semester_number,status',
    `99000001,E2E Student One,${STUDENT_EMAILS[0]},024 555 0101,e2ep,E2EL1,TEST-2030,1,`,
    `99000002,E2E Student Two,${STUDENT_EMAILS[1]},0245550102,E2EP,E2EL1,TEST-2030,1,`,
    '9900003,Short Number,short@example.test,0245550103,E2EP,E2EL1,TEST-2030,1,',
    '99000004,Twin A,twin.a@example.test,0245550104,E2EP,E2EL1,TEST-2030,1,',
    '99000004,Twin B,twin.b@example.test,0245550105,E2EP,E2EL1,TEST-2030,1,',
    '99000006,Unknown Programme,unknown@example.test,0245550106,NOPE,E2EL1,TEST-2030,1,',
  ].join('\n');
  await page
    .getByLabel('File')
    .setInputFiles({ name: 'intake.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Upload and check' }).click();

  // 3. Preview: nothing saved yet; bad rows and duplicates are explained row by row.
  await expect(page.getByRole('heading', { name: 'Students import' })).toBeVisible();
  await expect(page.getByText('Checked, waiting for confirmation')).toBeVisible();
  await expect(page.getByText(/Nothing has been saved yet/)).toBeVisible();
  const rows = page.getByRole('region', { name: 'Rows' });
  await expect(rows.getByRole('row').filter({ hasText: '9900003' })).toContainText('8-digit Student ID');
  await expect(rows.getByRole('row').filter({ hasText: 'twin.a@example.test' })).toContainText(
    'Same student_number as row 6',
  );
  await expect(rows.getByRole('row').filter({ hasText: 'unknown@example.test' })).toContainText(
    'No active programme has the code NOPE',
  );
  await page.screenshot({ path: 'test-results/screens/6-import-preview.png', fullPage: true });

  // 4. The error report lists exactly the rows that will not be imported, with reasons.
  const reportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Error report (CSV)' }).click();
  const report = readFileSync((await (await reportDownload).path())!, 'utf8');
  expect(report.split('\n')[0]).toContain('row_number,problems');
  for (const id of ['9900003', 'Twin A', 'Twin B', 'Unknown Programme']) expect(report).toContain(id);
  expect(report).not.toContain('E2E Student One');

  // 5. Confirm: the two good rows are saved and their activation emails go out.
  await page.getByRole('button', { name: 'Import 2 ready rows' }).click();
  // The status badge (the word also labels a count).
  await expect(
    page.getByRole('region', { name: 'Summary' }).locator('.badge', { hasText: 'Imported' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /ready rows?$/ })).toHaveCount(0);
  await expect(page.getByText(/2 sent · 0 waiting · 0 failed/)).toBeVisible({ timeout: 20_000 });
  for (const to of STUDENT_EMAILS) expect(await activationToken(request, to)).toBeTruthy();
  await page.screenshot({ path: 'test-results/screens/7-import-done.png', fullPage: true });

  // 6. The students are in the list; one record gets a photo and is verified, another a status change.
  await nav.getByRole('link', { name: 'Students' }).click();
  await expect(page.getByRole('link', { name: '99000001' })).toBeVisible();
  await expect(page.getByRole('link', { name: '99000004' })).toHaveCount(0);
  await page.getByRole('link', { name: '99000001' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Student One' })).toBeVisible();
  await page.getByLabel('Add photo').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByAltText('Photo of E2E Student One')).toBeVisible();
  await page.getByRole('button', { name: 'Mark record as verified' }).click();
  await expect(page.getByText(/^Verified /)).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/8-student-record.png', fullPage: true });

  await page.getByRole('link', { name: 'All students' }).click();
  await page.getByRole('link', { name: '99000002' }).click();
  await page.getByLabel('Change academic status').selectOption({ label: 'Deferred' });
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Reason/).fill('Deferred intake (e2e test)');
  await dialog.getByRole('button', { name: 'Change status' }).click();
  await expect(
    page.getByRole('region', { name: 'Status' }).getByText('Deferred', { exact: true }),
  ).toBeVisible();

  // 7. Enrolments: put the first student in the course section, then drop them with a reason.
  await nav.getByRole('link', { name: 'Enrolments' }).click();
  await page.getByLabel('Semester').selectOption({ label: 'TEST-2030 · First (test)' });
  await page.getByLabel('Course section').selectOption({ label: 'TST101 Test Course · section A' });
  await page.getByLabel('Enrol by Student ID').fill('99000001');
  await page.getByRole('button', { name: 'Enrol', exact: true }).click();
  await expect(page.getByText('E2E Student One (99000001) enrolled.')).toBeVisible();
  const enrolledRow = page.getByRole('row').filter({ hasText: '99000001' });
  await expect(enrolledRow).toBeVisible();
  await page.getByLabel('Enrol by Student ID').fill('99000002');
  await page.getByRole('button', { name: 'Enrol', exact: true }).click();
  await expect(page.getByText(/status is deferred/)).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/9-roster.png', fullPage: true });
  await enrolledRow.getByRole('button', { name: 'Drop' }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/Reason/)
    .fill('Changed course (e2e test)');
  await page.getByRole('dialog').getByRole('button', { name: 'Drop enrolment' }).click();
  await expect(page.getByText('No students enrolled yet.')).toBeVisible();

  // Enrolled again (the dropped enrolment stays as history), for the course-rep journey that follows.
  await page.getByLabel('Enrol by Student ID').fill('99000001');
  await page.getByRole('button', { name: 'Enrol', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '99000001' })).toBeVisible();

  // 8. Register one student by hand with the form.
  await clearMail(request, MANUAL_EMAIL);
  await nav.getByRole('link', { name: 'Students' }).click();
  await page.getByRole('link', { name: 'Register student' }).click();
  await page.getByLabel(fieldLabel('Student ID')).fill('99000007');
  await page.getByLabel(fieldLabel('Full name')).fill('E2E Student Seven');
  await page.getByLabel(fieldLabel('Email')).fill(MANUAL_EMAIL);
  await page.getByLabel(fieldLabel('Phone')).fill('024 555 0107');
  await page.getByLabel(fieldLabel('Programme')).selectOption({ label: 'E2EP · E2E Programme (test)' });
  await page.getByLabel(fieldLabel('Level')).selectOption({ label: 'E2E Level 1 (test)' });
  await page.getByLabel(fieldLabel('Academic year')).selectOption({ label: 'TEST-2030' });
  await page.getByLabel(fieldLabel('Semester')).selectOption({ label: 'First (test)' });
  await page.getByRole('button', { name: 'Register student' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Student Seven' })).toBeVisible();
  await expect(page.getByText('Student registered. An activation email was sent.')).toBeVisible();
  expect(await activationToken(request, MANUAL_EMAIL)).toBeTruthy();

  // 9. Bulk enrolment from a file: one good row, one refused because the student is deferred.
  await nav.getByRole('link', { name: 'Bulk import' }).click();
  await page
    .getByRole('navigation', { name: 'Import type' })
    .getByRole('link', { name: 'Enrolments' })
    .click();
  await expect(page.getByRole('heading', { name: 'Import enrolments' })).toBeVisible();
  const enrolCsv = [
    'student_number,course_code,academic_year,semester_number,section_code',
    '99000007,TST101,TEST-2030,1,A',
    '99000002,TST101,TEST-2030,1,A',
  ].join('\n');
  await page
    .getByLabel('File')
    .setInputFiles({ name: 'enrol.csv', mimeType: 'text/csv', buffer: Buffer.from(enrolCsv) });
  await page.getByRole('button', { name: 'Upload and check' }).click();
  await expect(page.getByRole('heading', { name: 'Enrolments import' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Rows' }).getByRole('row').filter({ hasText: '99000002' }),
  ).toContainText('deferred');
  await page.getByRole('button', { name: 'Import 1 ready row' }).click();
  await expect(
    page.getByRole('region', { name: 'Summary' }).locator('.badge', { hasText: 'Imported' }),
  ).toBeVisible();
  await nav.getByRole('link', { name: 'Enrolments' }).click();
  await page.getByLabel('Semester', { exact: true }).selectOption({ label: 'TEST-2030 · First (test)' });
  await page.getByLabel('Course section').selectOption({ label: 'TST101 Test Course · section A' });
  await expect(page.getByRole('row').filter({ hasText: '99000007' })).toBeVisible();
});
