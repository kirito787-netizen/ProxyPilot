// Keeps the extension's shared logic in step with the desktop app.
// web/lib/{model,pac,site,i18n}.js are verbatim copies of their app/
// counterparts. Styles intentionally diverge (the extension appends popup
// sizing rules) and web/lib/ui.js is extension-specific, so neither is
// synced here. Run npm run sync:web after editing the shared desktop
// sources; the drift check inside npm run test:web fails until the
// copies match.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  ['app/model.js', 'web/lib/model.js'],
  ['app/pac.js', 'web/lib/pac.js'],
  ['app/site.js', 'web/lib/site.js'],
  ['app/i18n.js', 'web/lib/i18n.js'],
  ['app/stats.js', 'web/lib/stats.js'],
  ['app/subs.js', 'web/lib/subs.js'],
];

let changed = 0;
for (const [source, target] of pairs) {
  const from = join(root, source);
  const to = join(root, target);
  if (!existsSync(to) || readFileSync(from, 'utf8') !== readFileSync(to, 'utf8')) {
    copyFileSync(from, to);
    changed++;
    console.log('synced: ' + target);
  } else {
    console.log('in sync: ' + target);
  }
}
console.log(changed ? changed + ' file(s) updated' : 'web/lib already matches the app sources');
