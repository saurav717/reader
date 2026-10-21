/**
 * The welcome a first visit lands on: the night scenes turning behind
 * "Ask well. Read slowly." — the opening of the explainer, no pointer.
 */
import { BASE } from '../lib.mjs';

export const pointer = false;

export async function prepare({ page }) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(-10, -10);
}

export default async function ({ page, mark }) {
  mark('first');
  await page.waitForTimeout(9000);
  // The next scene, as the arrow beside the count turns it.
  const next = page.getByRole('button', { name: 'Next scene' });
  if (await next.isVisible().catch(() => false)) {
    mark('next');
    await next.click();
    await page.mouse.move(-10, -10);
  }
  await page.waitForTimeout(9000);
}
