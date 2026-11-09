import { expect, test } from '@playwright/test';
import { fillDialog, signInAsSuperAdmin } from './helpers';

// D-12: an administrator appoints a course rep from the section's enrolled students, then ends the
// role with a reason. Uses the section from 02-setup and the student enrolled by 03-registrar.
test.describe.configure({ mode: 'serial' });

test('Super Admin appoints and ends a course rep', async ({ page }) => {
  await signInAsSuperAdmin(page, 1);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Courses' }).click();
  await page.getByLabel('Semester', { exact: true }).selectOption({ label: 'TEST-2030 · First (test)' });
  await page.getByRole('link', { name: 'Lecturers and reps' }).click();

  const reps = page.getByRole('region', { name: 'Course reps' });
  await expect(reps.getByText('No course reps or nominations yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Appoint course rep' }).click();
  await fillDialog(page, 'Appoint a course rep', {
    'Enrolled student': { option: 'E2E Student One (99000001)' },
  });
  const row = reps.getByRole('row').filter({ hasText: '99000001' });
  await expect(row).toContainText('Course rep');
  await page.screenshot({ path: 'test-results/screens/10-course-rep.png', fullPage: true });

  await row.getByRole('button', { name: 'End role' }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/Reason/)
    .fill('End of term (e2e test)');
  await page.getByRole('dialog').getByRole('button', { name: 'End role' }).click();
  await expect(row).toContainText('Ended');
  await expect(row).toContainText('End of term (e2e test)');
});
