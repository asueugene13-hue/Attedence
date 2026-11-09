import { expect, test } from '@playwright/test';
import { clearMail, fieldLabel, fillDialog, REGISTRAR_EMAIL, signInAsSuperAdmin } from './helpers';

// The Super Admin sets the university up through the setup screens, as an installer would:
// structure, calendar, places, a lecturer, a course with an open offering and a section, and a
// Registrar account. Everything here is obviously fake test data, never Knutsford's.
test.describe.configure({ mode: 'serial' });

test('Super Admin sets up the academic structure through the dashboard', async ({ page, request }) => {
  await clearMail(request, REGISTRAR_EMAIL);
  await signInAsSuperAdmin(page, 0);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // 1. Academic structure.
  await nav.getByRole('link', { name: 'Academic structure' }).click();
  await page.getByRole('button', { name: 'Add faculty' }).click();
  await fillDialog(page, 'Add faculty', { Code: 'e2ef', Name: 'E2E Faculty (test)' });
  await expect(
    page.getByRole('region', { name: 'Faculties' }).getByRole('cell', { name: 'E2EF' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add department' }).click();
  await fillDialog(page, 'Add department', {
    Faculty: { option: 'E2E Faculty (test)' },
    Code: 'E2ED',
    Name: 'E2E Department (test)',
  });
  await page.getByRole('button', { name: 'Add programme' }).click();
  await fillDialog(page, 'Add programme', {
    Department: { option: 'E2E Department (test)' },
    Code: 'E2EP',
    Name: 'E2E Programme (test)',
  });
  await page.getByRole('button', { name: 'Add level' }).click();
  await fillDialog(page, 'Add level', { Code: 'E2EL1', Name: 'E2E Level 1 (test)', Order: '1' });
  // A duplicate code is refused with the API's message, and nothing is added.
  await page.getByRole('button', { name: 'Add faculty' }).click();
  const duplicate = page.getByRole('dialog', { name: 'Add faculty' });
  await duplicate.getByLabel(fieldLabel('Code')).fill('E2EF');
  await duplicate.getByLabel(fieldLabel('Name')).fill('Second Faculty (test)');
  await duplicate.getByRole('button', { name: 'Save' }).click();
  await expect(duplicate.getByRole('alert')).toBeVisible();
  await duplicate.getByRole('button', { name: 'Cancel' }).click();
  await page.screenshot({ path: 'test-results/screens/4-academic-structure.png', fullPage: true });

  // 2. Academic calendar: a year, a semester and a holiday.
  await nav.getByRole('link', { name: 'Academic calendar' }).click();
  await page.getByRole('button', { name: 'Add academic year' }).click();
  await fillDialog(page, 'Add academic year', {
    Label: 'TEST-2030',
    Starts: '2030-08-01',
    Ends: '2031-07-31',
  });
  await page.getByRole('button', { name: 'Add semester' }).click();
  await fillDialog(page, 'Add semester to TEST-2030', {
    Number: '1',
    Name: 'First (test)',
    Starts: '2030-08-15',
    Ends: '2030-12-20',
  });
  await page.getByRole('button', { name: 'Add holiday or closure' }).click();
  await fillDialog(page, 'Add holiday or closure', {
    Name: 'Test Holiday (test)',
    Type: { option: 'Public holiday' },
    Starts: '2030-10-01',
    Ends: '2030-10-01',
  });
  await expect(page.getByRole('cell', { name: 'Test Holiday (test)' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'First (test)' })).toBeVisible();

  // 3. Places.
  await nav.getByRole('link', { name: 'Places' }).click();
  await page.getByRole('button', { name: 'Add campus' }).click();
  await fillDialog(page, 'Add campus', { Code: 'E2EC', Name: 'E2E Campus (test)' });
  await page.getByRole('button', { name: 'Add building' }).click();
  await fillDialog(page, 'Add building', {
    Campus: { option: 'E2E Campus (test)' },
    Code: 'E2EB',
    Name: 'E2E Building (test)',
    'Geofence centre latitude': '5.6',
    'Geofence centre longitude': '-0.18',
    'Geofence radius (metres)': '150',
  });
  await page.getByRole('button', { name: 'Add classroom' }).click();
  await fillDialog(page, 'Add classroom', {
    Building: { option: 'E2E Building (test) (E2E Campus (test))' },
    Code: 'E2E-R1',
    Name: 'E2E Room 1 (test)',
    Seats: '40',
  });
  // The room inherits its building's geofence.
  await expect(
    page.getByRole('region', { name: 'Classrooms' }).getByRole('row').filter({ hasText: 'E2E-R1' }),
  ).toContainText('5.6, -0.18 · 150 m');

  // 4. A lecturer.
  await nav.getByRole('link', { name: 'Lecturers' }).click();
  await page.getByRole('button', { name: 'Add lecturer' }).click();
  await fillDialog(page, 'Add lecturer', {
    'Full name': 'E2E Lecturer (test)',
    Email: 'e2e.lecturer@example.test',
    'Staff number': 'e2e-001',
    Department: { option: 'E2E Department (test)' },
    Title: 'Dr',
  });
  await expect(page.getByRole('cell', { name: 'E2E-001' })).toBeVisible();

  // 5. A course, offered this semester, opened, with a section and its lecturer.
  await nav.getByRole('link', { name: 'Courses' }).click();
  await page.getByRole('button', { name: 'Add course' }).click();
  await fillDialog(page, 'Add course', {
    Department: { option: 'E2E Department (test)' },
    Code: 'TST101',
    Title: 'Test Course',
  });
  await page.getByLabel('Semester', { exact: true }).selectOption({ label: 'TEST-2030 · First (test)' });
  await page.getByRole('button', { name: 'Offer a course this semester' }).click();
  await fillDialog(page, 'Offer a course this semester', { Course: { option: 'TST101 · Test Course' } });
  await page.getByRole('button', { name: 'Open for enrolment' }).click();
  await expect(page.getByText('Open', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add section' }).click();
  await fillDialog(page, 'Add section', { Code: 'A', Places: '30' });
  await page.getByRole('link', { name: 'Lecturers and reps' }).click();
  await expect(page.getByRole('heading', { name: 'TST101 · section A' })).toBeVisible();
  await page.getByRole('button', { name: 'Assign lecturer' }).click();
  await fillDialog(page, 'Assign lecturer', { Lecturer: { option: 'E2E Lecturer (test) (E2E-001)' } });
  await expect(page.getByRole('row').filter({ hasText: 'E2E Lecturer (test)' })).toContainText(
    'Primary lecturer',
  );
  await page.screenshot({ path: 'test-results/screens/5-section.png', fullPage: true });

  // 6. The Registrar's account (the activation email goes to Mailpit).
  await nav.getByRole('link', { name: 'Accounts' }).click();
  await page.getByRole('link', { name: 'New staff account' }).click();
  await page.getByLabel('Full name').fill('E2E Registrar (test)');
  await page.getByLabel('Email').fill(REGISTRAR_EMAIL);
  await page.getByLabel('Registrar').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Registrar (test)' })).toBeVisible();
});
