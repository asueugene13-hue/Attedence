import { expect, test } from '@playwright/test';
import { signInAsSuperAdmin } from './helpers';

// Phase 7 screens, end to end: the administrator's dashboard, analytics, a report file made by the
// background job and downloaded, the audit log in plain words (the export is in it), and background
// jobs on System health. Uses the data from journeys 01–08.
test.describe.configure({ mode: 'serial' });

test('an administrator uses the dashboard, analytics, a report file, the audit log and system health', async ({
  page,
}) => {
  await signInAsSuperAdmin(page, 5);
  await expect(page.getByText('Today’s classes')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for a decision' })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/26-admin-dashboard.png', fullPage: true });

  // Analytics: no semester is active in the test data, so it says so; choosing the semester shows it.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click();
  const attendance = page.getByRole('region', { name: 'Attendance' });
  await expect(attendance.getByText(/no active semester/)).toBeVisible();
  await attendance.getByLabel('Semester').selectOption({ label: 'First (test) · TEST-2030' });
  // No test class has finished, so nothing is counted yet (the API tests cover the arithmetic).
  await expect(attendance.getByText('First (test) · overall — · no minimum set yet')).toBeVisible();
  await expect(attendance.getByText('No attendance counted yet.')).toBeVisible();
  // Class operations does have rows: the test department's scheduled and cancelled classes.
  await expect(
    page
      .getByRole('region', { name: 'Class operations' })
      .getByRole('row')
      .filter({ hasText: 'E2E Department (test)' }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/27-analytics.png', fullPage: true });

  // A CSV of it, made by the background job, then downloaded (a short-lived link).
  await attendance.getByRole('button', { name: 'CSV' }).click();
  await expect(attendance.getByText(/Asked for/)).toBeVisible();
  const files = page.getByRole('region', { name: 'Your files' });
  const row = files.getByRole('row').filter({ hasText: 'Attendance analytics' }).first();
  await expect(row).toContainText('Ready', { timeout: 20_000 });
  // The button asks the server for a short-lived link and opens it; fetch that link to check the file.
  const linkResponse = page.waitForResponse(
    (r) => r.url().includes('/reports/exports/') && r.url().endsWith('/download'),
  );
  await row.getByRole('button', { name: 'Download' }).click();
  const link = (await (await linkResponse).json()) as { url: string };
  const file = await page.request.get(link.url);
  expect(file.ok()).toBe(true);
  const csv = await file.text();
  expect(csv).toContain('Students,Present,Late,Absences');
  expect(csv).toContain('by AttendSure');
  await expect(page.getByRole('region', { name: 'Export log' })).toContainText('Attendance analytics');
  await page.screenshot({ path: 'test-results/screens/28-report-files.png', fullPage: true });

  // The audit log in plain words, filtered to reports: the request and the download are there.
  await page.goto('/admin/audit');
  await page.getByLabel('Area').selectOption({ label: 'Reports' });
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('Report file asked for').first()).toBeVisible();
  await expect(page.getByText('Report file downloaded').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/29-audit-plain-words.png', fullPage: true });

  // Background jobs on System health.
  await page.goto('/admin/system-health');
  await expect(page.getByRole('heading', { name: 'Background jobs' })).toBeVisible();
  await expect(page.getByText('monitoring/attendance-sweep')).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/30-system-health.png', fullPage: true });
});
