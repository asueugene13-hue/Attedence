import { expect, type Page, test } from '@playwright/test';
import { fieldLabel, signInAsSuperAdmin } from './helpers';

// Phase 4 screens: register a beacon in the room from 02-setup, calibrate it from a three-phone
// survey, and try the verification policy. All data is obviously fake (E2E …, "(test)").
test.describe.configure({ mode: 'serial' });

async function addReading(page: Page, index: number, phone: string, where: string, rssi: string) {
  const dialog = page.getByRole('dialog', { name: 'Enter a calibration survey' });
  if (index > 0) await dialog.getByRole('button', { name: 'Add a reading' }).click();
  const row = dialog.getByRole('group', { name: `Reading ${index + 1}` });
  await row.getByLabel(fieldLabel('Phone model')).fill(phone);
  await row.getByLabel(fieldLabel('Where')).selectOption({ label: where });
  await row.getByLabel(fieldLabel('Signal (dBm)')).fill(rssi);
}

test('Super Admin registers and calibrates a beacon, then tries the verification policy', async ({
  page,
}) => {
  await signInAsSuperAdmin(page, 3);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // 1. A beacon in the e2e room.
  await nav.getByRole('link', { name: 'Beacons' }).click();
  await page
    .getByLabel('Classroom', { exact: true })
    .selectOption({ label: 'E2E-R1 · E2E Room 1 (test) (E2E Building (test))' });
  await expect(page.getByText('No beacons in this room yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Add a beacon' }).click();
  const add = page.getByRole('dialog', { name: 'Add a beacon' });
  await add.getByLabel(fieldLabel('Where it is')).fill('Front wall (e2e test)');
  await add.getByLabel(fieldLabel('Type')).selectOption({ label: 'Eddystone-UID (fixed, trials only)' });
  await add.getByLabel(fieldLabel('Identifier')).fill('e2e00000000000000000000000000001');
  await add.getByRole('button', { name: 'Add beacon' }).click();
  await expect(add).toBeHidden();
  await expect(page.getByRole('cell', { name: /Front wall \(e2e test\)/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Not calibrated/ })).toBeVisible();

  // 2. A survey with three phones, inside and outside the room.
  await page.getByRole('button', { name: 'Enter a survey' }).click();
  const readings: [string, string, string][] = [];
  for (const phone of ['Phone A (e2e)', 'Phone B (e2e)', 'Phone C (e2e)']) {
    readings.push([phone, 'Inside: back row', '-70'], [phone, 'Corridor', '-84']);
  }
  for (const [i, [phone, where, rssi]] of readings.entries()) await addReading(page, i, phone, where, rssi);
  await page.screenshot({ path: 'test-results/screens/16-survey-entry.png', fullPage: true });
  const surveyDialog = page.getByRole('dialog', { name: 'Enter a calibration survey' });
  await surveyDialog.getByRole('button', { name: 'Save survey' }).click();
  await expect(surveyDialog).toBeHidden();
  await expect(page.getByText(/threshold -77 dBm/)).toBeVisible();
  await page.getByRole('button', { name: 'Apply thresholds' }).click();
  await expect(page.getByText('Thresholds set from the survey.')).toBeVisible();
  await expect(page.getByRole('cell', { name: /-77 dBm/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/17-beacon-calibrated.png', fullPage: true });

  // 3. The verification policy: try the "GPS inaccurate indoors" case (§7).
  await nav.getByRole('link', { name: 'Verification policy' }).click();
  await expect(page.getByRole('heading', { name: 'Version 0 (defaults)' })).toBeVisible();
  const tryCase = page.getByRole('region', { name: 'Try a case' });
  await tryCase.getByLabel(fieldLabel('Beacon')).selectOption('STRONG');
  await tryCase.getByLabel(fieldLabel('GPS')).selectOption('UNCERTAIN');
  await tryCase.getByRole('button', { name: 'Decide' }).click();
  await expect(tryCase.getByText('Student sees: “You’re checked in.”')).toBeVisible();
  await tryCase.getByLabel(fieldLabel('Beacon')).selectOption('NONE');
  await tryCase.getByLabel(fieldLabel('GPS')).selectOption('OUTSIDE');
  await tryCase.getByRole('button', { name: 'Decide' }).click();
  await expect(tryCase.getByText(/You don’t appear to be in the classroom/)).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/18-verification-policy.png', fullPage: true });
});
