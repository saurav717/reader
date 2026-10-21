/**
 * Records one take, or several: node scripts/video/take.mjs <name> [<name>…]
 *
 * A take is scripts/video/takes/<name>.mjs. It may export setup(context)
 * for its routes and stand-ins, and prepare({ page }) to bring the app to
 * where the take begins (off camera); its default export runs on camera
 * with { page, pointer, mark }. Each take writes .video/takes/<name>/raw.mp4
 * and timeline.json, the marks it made, in seconds into the footage.
 *
 *   npm run build && npm start &
 *   node scripts/video/take.mjs showcase
 */
import path from 'node:path';
import { ROOT, openBrowser, newContext, sealNetwork, arrive, Pointer, startCamera } from './lib.mjs';

const names = process.argv.slice(2);
if (!names.length) {
  console.log('usage: node scripts/video/take.mjs <take> [<take>…]   (scripts/video/takes/*.mjs)');
  process.exit(1);
}
const browser = await openBrowser();
let failed = 0;
for (const name of names) {
  console.log(`\n== ${name} ==`);
  const take = await import(`./takes/${name}.mjs`);
  const context = await newContext(browser);
  await sealNetwork(context);
  await take.setup?.(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    if (take.prepare) await take.prepare({ page, arrive: (options) => arrive(page, options) });
    else await arrive(page);
    const camera = await startCamera(context, page, path.join(ROOT, '.video/takes', name));
    const pointer = new Pointer(page);
    if (take.pointer !== false) await pointer.show();
    camera.mark('start');
    try {
      await take.default({ page, pointer, mark: camera.mark });
    } finally {
      camera.mark('end');
      await camera.stop();
    }
  } catch (error) {
    failed++;
    console.log(`  FAILED: ${error.stack || error}`);
    await page.screenshot({ path: path.join(ROOT, '.video/takes', `${name}-failed.png`) }).catch(() => undefined);
  }
  if (errors.length) console.log(`  page errors:\n    ${errors.join('\n    ')}`);
  await context.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
