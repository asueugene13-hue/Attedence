import { expect, test } from '@playwright/test';
import { generateSync } from 'otplib';

// One journey, in order: the installer's first Super Admin activates, sets up two-step sign-in,
// creates a Registrar account, suspends it with a reason, finds that in the audit log, and signs out.
test.describe.configure({ mode: 'serial' });

const ADMIN_EMAIL = 'e2e.admin@example.test';
const PASSWORD = 'river-mango-lantern-42';

test('first Super Admin journey through the dashboard', async ({ page }) => {
  const token = process.env.E2E_ACTIVATION_TOKEN;
  expect(token, 'global setup should have created an activation link').toBeTruthy();

  // 1. Activation link from the one-time command.
  await page.goto(`/activate?token=${token}`);
  await expect(page.getByRole('heading', { name: 'Activate your account' })).toBeVisible();
  await page.getByRole('textbox', { name: 'New password', exact: true }).fill('Password123');
  await page.getByLabel('Repeat new password').fill('Password123');
  await page.getByRole('button', { name: 'Activate account' }).click();
  await expect(page.getByText(/too common/)).toBeVisible();
  await page.getByRole('textbox', { name: 'New password', exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat new password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate account' }).click();
  await expect(page.getByText('Your account is active.')).toBeVisible();

  // 2. Sign in: a Super Admin must set up two-step sign-in first.
  await page.getByRole('link', { name: 'Go to sign in' }).click();
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  await expect(page.getByAltText(/QR code/)).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/1-two-step-setup.png', fullPage: true });
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.getByLabel('6-digit code').fill(generateSync({ secret }));
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();

  // 3. Recovery codes are shown once and must be acknowledged.
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
  const continueButton = page.getByRole('button', { name: 'Continue to AttendSure' });
  await expect(continueButton).toBeDisabled();
  await page.getByLabel('I have saved these codes somewhere safe.').check();
  await continueButton.click();

  // 4. The dashboard shows only the Super Admin's tools.
  await expect(page.getByRole('heading', { name: 'Welcome, E2E Admin (test)' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link')).toHaveText(['Home', 'Accounts', 'Roles and permissions', 'Audit log']);

  // 5. A reload keeps the session (refresh cookie through the dashboard's own origin).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome, E2E Admin (test)' })).toBeVisible();

  // 6. Create a Registrar account.
  await nav.getByRole('link', { name: 'Accounts' }).click();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await page.getByRole('link', { name: 'New staff account' }).click();
  await page.getByLabel('Full name').fill('Test Registrar');
  await page.getByLabel('Email').fill('test.registrar@example.test');
  await page.getByLabel('Phone number').fill('024 555 0123');
  await page.getByLabel('Registrar').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Test Registrar' })).toBeVisible();
  // The activation email is sent if an SMTP server is running (Mailpit locally); either outcome is reported.
  await expect(page.getByText(/^Account created/)).toBeVisible();
  await expect(page.getByText('Awaiting activation')).toBeVisible();

  // 7. Suspend it, with a reason.
  await page.getByRole('button', { name: 'Suspend account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Suspend account' }).click();
  await expect(dialog.getByText(/at least 5 characters/)).toBeVisible();
  await dialog.getByLabel(/Reason/).fill('E2E check of the suspension flow');
  await dialog.getByRole('button', { name: 'Suspend account' }).click();
  await expect(page.getByText(/Account suspended/)).toBeVisible();
  await expect(page.getByText('Suspended', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/2-account-detail.png', fullPage: true });

  // 8. The audit log shows it, with the reason.
  await nav.getByRole('link', { name: 'Audit log' }).click();
  await page.getByLabel('Action starts with').fill('users.');
  await page.getByRole('button', { name: 'Search' }).click();
  const row = page.getByRole('row').filter({ hasText: 'users.suspended' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('E2E check of the suspension flow');
  await expect(row).toContainText(ADMIN_EMAIL);
  await page.screenshot({ path: 'test-results/screens/3-audit-log.png', fullPage: true });

  // 9. Sign out: protected pages send you back to sign in.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
