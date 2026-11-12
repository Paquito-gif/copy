// Intègre les fichiers du site (public/) dans le Worker : src/site.gen.ts.
// Le Worker les sert lui-même (pas de Workers Static Assets). Liste = ce que la page charge réellement.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILES = [
  'index.html', 'app.js', 'page.css',
  'assets/system.css', 'assets/system.js',
  'assets/ui/cards.css', 'assets/ui/base.css', 'assets/ui/ui.js', 'assets/ui/window/fragment.css',
  'assets/motion/motion.css', 'assets/motion/motion.js',
  'assets/backgrounds/backgrounds.css', 'assets/backgrounds/backgrounds.js',
  'assets/layout/layout.css', 'assets/layout/layout.js', 'assets/layout/demo.css',
  'assets/icons/icon.css', 'assets/icons/solana.svg',
  'assets/effects/fx.js', 'assets/effects/grain-gradient/effect.js',
];
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', json: 'application/json' };

const out = {};
for (const f of FILES) {
  const body = fs.readFileSync(path.join('public', f), 'utf8');
  const etag = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
  out['/' + f] = { type: TYPES[path.extname(f).slice(1)] ?? 'application/octet-stream', etag, body };
}
fs.writeFileSync('src/site.gen.ts',
  '// Généré par scripts/build-site.mjs — ne pas modifier à la main.\n' +
  'export const SITE: Record<string, { type: string; etag: string; body: string }> = ' + JSON.stringify(out) + ';\n');
console.log(`site intégré : ${FILES.length} fichiers, ${Math.round(Object.values(out).reduce((s, f) => s + f.body.length, 0) / 1024)} Ko`);
