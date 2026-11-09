import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page } from '@playwright/test';

// Shared by the journeys. All data they create is obviously fake (TEST-*, E2E …, example.test).
export const PASSWORD = 'river-mango-lantern-42';
export const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';
export const REGISTRAR_EMAIL = 'e2e.registrar@example.test';

/** Saved by 01-super-admin: the Super Admin's sign-in and single-use recovery codes. */
export function savedState() {
  return JSON.parse(readFileSync('test-results/e2e-state.json', 'utf8')) as {
    adminEmail: string;
    password: string;
    recoveryCodes: string[];
  };
}

/** Signs the Super Admin in through the dashboard with recovery code number `codeIndex`. */
export async function signInAsSuperAdmin(page: Page, codeIndex: number) {
  const state = savedState();
  await page.goto('/login');
  await page.getByLabel('Email or Student ID').fill(state.adminEmail);
  await page.getByLabel('Password').fill(state.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Lost your phone? Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(state.recoveryCodes[codeIndex]!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, E2E Admin (test)' })).toBeVisible();
}

export async function clearMail(request: APIRequestContext, to: string) {
  await request.delete(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
}

/** Waits for the activation email to arrive in Mailpit and returns the link's token. */
export async function activationToken(request: APIRequestContext, to: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const search = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = (await search.json()) as { messages: { ID: string }[] };
    if (messages.length > 0) {
      const message = (await (await request.get(`${MAILPIT}/api/v1/message/${messages[0]!.ID}`)).json()) as {
        Text: string;
      };
      const token = message.Text.match(/activate\?token=([A-Za-z0-9_-]+)/)?.[1];
      if (token) return token;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No activation email reached ${to} in Mailpit (${MAILPIT}).`);
}

/** A field label exactly, with or without the "*" that marks a required field. */
export function fieldLabel(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}( \\*)?$`);
}

/** Fills and saves one of the setup screens' Add/Edit dialogs. Values are by field label. */
export async function fillDialog(
  page: Page,
  title: string,
  values: Record<string, string | { option: string }>,
) {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  for (const [label, value] of Object.entries(values)) {
    const field = dialog.getByLabel(fieldLabel(label));
    if (typeof value === 'string') await field.fill(value);
    else await field.selectOption({ label: value.option });
  }
  await dialog.getByRole('button', { name: /^(Save|Create offering|Assign|Appoint|Nominate)$/ }).click();
  await expect(dialog).toBeHidden();
}
