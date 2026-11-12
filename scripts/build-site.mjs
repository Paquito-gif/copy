// Intègre le site (public/) dans le Worker : src/site.gen.ts.
// - chaque page .html reçoit les éléments communs : <!--#include head|header|footer--> (public/_partials/)
// - tous les autres fichiers de public/ (hors _partials) sont servis tels quels
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = 'public';
const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', json: 'application/json', txt: 'text/plain; charset=utf-8',
};

const partials = Object.fromEntries(fs.readdirSync(path.join(ROOT, '_partials'))
  .map((f) => [path.basename(f, '.html'), fs.readFileSync(path.join(ROOT, '_partials', f), 'utf8').trim()]));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === '_partials' ? [] : walk(p);
    return [p];
  });
}

// Version du site = empreinte de tous les fichiers sources. Elle est ajoutée à chaque URL de CSS / JS
// (dans les pages et dans les imports entre modules) : un déploiement change toutes les URLs,
// donc aucun navigateur ne peut mélanger une page neuve avec un ancien script ou une ancienne feuille de style.
const files = walk(ROOT);
const hash = crypto.createHash('sha1');
for (const f of files.concat(fs.readdirSync(path.join(ROOT, '_partials')).map((f) => path.join(ROOT, '_partials', f)))) hash.update(f).update(fs.readFileSync(f));
const V = hash.digest('hex').slice(0, 10);
const versioned = (body) => body
  .replace(/(href|src)="(\/(?:css|js)\/[\w./-]+\.(?:css|js))"/g, `$1="$2?v=${V}"`)
  .replace(/(from\s+|import\()(['"])(\.\/[\w./-]+\.js)\2/g, `$1$2$3?v=${V}$2`);

const out = {};
for (const file of files) {
  const ext = path.extname(file).slice(1);
  if (!TYPES[ext]) throw new Error(`Type de fichier non géré : ${file}`);
  let body = fs.readFileSync(file, 'utf8');
  if (ext === 'html') {
    body = body.replace(/<!--#include (\w+)-->/g, (_, name) => {
      if (!(name in partials)) throw new Error(`Partiel inconnu « ${name} » dans ${file}`);
      return partials[name];
    });
  }
  if (ext === 'html' || ext === 'js') body = versioned(body);
  const etag = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
  out['/' + path.relative(ROOT, file).split(path.sep).join('/')] = { type: TYPES[ext], etag, body };
}
fs.writeFileSync('src/site.gen.ts',
  '// Généré par scripts/build-site.mjs — ne pas modifier à la main.\n' +
  'export const SITE: Record<string, { type: string; etag: string; body: string }> = ' + JSON.stringify(out) + ';\n');
console.log(`site intégré (v${V}) : ${Object.keys(out).length} fichiers, ${Math.round(Object.values(out).reduce((s, f) => s + f.body.length, 0) / 1024)} Ko`);
