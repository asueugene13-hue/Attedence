import { expect, test } from '@playwright/test';

// The dashboard's Content Security Policy (SECURITY.md §9): every page gets a fresh nonce, Next.js's own
// scripts carry it, and a script without it does not run, even when it is inside the page.

test('each page has a fresh script nonce, and its own scripts carry it', async ({ page }) => {
  const first = await page.goto('/login');
  const policy = first!.headers()['content-security-policy']!;
  const scriptSrc = policy.split(';').find((d) => d.trim().startsWith('script-src'))!;
  expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  expect(scriptSrc).not.toContain('unsafe-inline');
  const nonce = scriptSrc.match(/'nonce-([^']+)'/)![1]!;

  const html = await first!.text();
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`))).toEqual([]);

  const second = await page.goto('/login');
  expect(second!.headers()['content-security-policy']).not.toContain(`'nonce-${nonce}'`);
  // The page still works under the policy.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('a script injected into a page does not run, and the page still works', async ({ page }) => {
  const refused: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) refused.push(m.text());
  });
  // As if an attacker had got a script into the HTML: an inline script without the nonce.
  await page.route('**/login', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      '</body>',
      '<script>window.__injected = true</script></body>',
    );
    await route.fulfill({ response, body });
  });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(() => (window as { __injected?: boolean }).__injected)).toBeUndefined();
  expect(refused.length).toBeGreaterThan(0);
});
