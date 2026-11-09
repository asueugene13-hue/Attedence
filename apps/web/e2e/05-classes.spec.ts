import { expect, test } from '@playwright/test';
import { fieldLabel, signInAsSuperAdmin } from './helpers';

// Phase 3 exit check, scenario 18 in the browser: build and publish a timetable, find the generated
// class in the class monitor, refer it for review, and decide the review. Uses the semester, section,
// lecturer and room from 02-setup. All data is obviously fake (TEST-2030, E2E …).
test.describe.configure({ mode: 'serial' });

test('Super Admin publishes a timetable, reviews a class and decides it', async ({ page }) => {
  await signInAsSuperAdmin(page, 2);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // 1. A draft timetable with one weekly class.
  await nav.getByRole('link', { name: 'Timetables' }).click();
  await page.getByLabel('Semester', { exact: true }).selectOption({ label: 'TEST-2030 · First (test)' });
  await expect(page.getByText('No timetable for this semester yet.')).toBeVisible();
  await page.getByRole('button', { name: 'New draft' }).click();
  const draft = page.getByRole('dialog', { name: 'New timetable draft' });
  await draft.getByLabel(fieldLabel('Name')).fill('Semester 1 (e2e test)');
  await draft.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Semester 1 (e2e test)' })).toBeVisible();

  await page.getByRole('button', { name: 'Add a class' }).click();
  const entry = page.getByRole('dialog', { name: 'Add a class' });
  await entry.getByLabel(/TST101 Test Course · section A/).check();
  await entry.getByLabel(fieldLabel('Lecturer')).selectOption({ label: 'E2E Lecturer (test) (E2E-001)' });
  await entry.getByLabel(fieldLabel('Room')).selectOption({ label: 'E2E-R1 · E2E Room 1 (test)' });
  await entry.getByLabel(fieldLabel('Day')).selectOption({ label: 'Tuesday' });
  await entry.getByLabel(fieldLabel('Starts')).fill('10:00');
  await entry.getByLabel(fieldLabel('Ends')).fill('11:30');
  await entry.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(entry).toBeHidden();
  await expect(page.getByRole('cell', { name: 'TST101 A' })).toBeVisible();

  // 2. The clash check passes, and publishing creates the classes.
  await expect(page.getByText('No room, lecturer or section is booked twice.')).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/11-timetable-draft.png', fullPage: true });
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const publish = page.getByRole('dialog');
  await publish.getByLabel(/Reason/).fill('First timetable of the semester (e2e test)');
  await publish.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published', { exact: true })).toBeVisible();

  // 3. The first Tuesday's class appears in the class monitor (generation runs in the background).
  await nav.getByRole('link', { name: 'Class monitor' }).click();
  await page.getByLabel(fieldLabel('Day')).fill('2030-08-20');
  await expect(async () => {
    await page.getByRole('button', { name: 'Next day' }).click();
    await page.getByRole('button', { name: 'Previous day' }).click();
    await expect(page.getByRole('link', { name: 'TST101 A' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole('row').filter({ hasText: 'TST101 A' })).toContainText('Scheduled');
  await page.screenshot({ path: 'test-results/screens/12-class-monitor.png', fullPage: true });

  // 4. Refer the class for review from its page.
  await page.getByRole('link', { name: 'TST101 A' }).click();
  await expect(page.getByRole('heading', { name: 'TST101 A' })).toBeVisible();
  await page.getByRole('button', { name: 'Open a review' }).click();
  const review = page.getByRole('dialog', { name: 'Open a review' });
  await review.getByLabel(/Reason/).fill('Lecturer phoned in sick (e2e test)');
  await review.getByRole('button', { name: 'Open a review' }).click();
  await expect(page.getByText('The university is checking on this class.')).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/13-class-under-review.png', fullPage: true });

  // 5. Decide it from the review queue.
  await nav.getByRole('link', { name: 'Class reviews' }).click();
  await page.getByRole('link', { name: 'TST101 A' }).click();
  await expect(page.getByText('Lecturer phoned in sick (e2e test)')).toBeVisible();
  await page.getByRole('button', { name: 'Decide' }).click();
  const decide = page.getByRole('dialog', { name: 'Decide this review' });
  await decide.getByLabel(fieldLabel('Decision')).selectOption({ label: 'Cancelled' });
  await decide
    .getByLabel(fieldLabel('Cancellation reason'))
    .selectOption({ label: 'Lecturer absent without notice' });
  await decide.getByLabel(/Note/).fill('Confirmed with the department (e2e test)');
  await decide.getByRole('button', { name: 'Record decision' }).click();
  await expect(page.getByText(/Decided: Cancelled/)).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/14-review-decided.png', fullPage: true });

  await page.getByRole('link', { name: 'Open the class page' }).click();
  const summary = page.getByRole('region', { name: /Tue 20 Aug/ });
  await expect(summary.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(summary.getByText(/Lecturer absent without notice/)).toBeVisible();
  await expect(summary.getByText(/Confirmed with the department \(e2e test\)/)).toBeVisible();
  // A "cancelled" decision is the cancel action, so the history shows a cancellation.
  await expect(
    page.getByRole('region', { name: 'History' }).getByText('Cancelled', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/15-class-cancelled.png', fullPage: true });
});
