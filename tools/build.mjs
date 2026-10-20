// Сборка расширения из юзерскрипта.
//   node tools/build.mjs                    — собрать
//   node tools/build.mjs --notes "что нового" — то же, с описанием обновления (видно в плашке)
//
// 1. src/merged-chat.user.js  -> extension/chat.js (обёрнут в ожидание кэша хранилища)
// 2. @version из юзерскрипта  -> extension/manifest.json
// 3. extension/update.json    — версия + список файлов с sha256 (по нему обновляются установленные копии)
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const args = process.argv.slice(2);
const notesIdx = args.indexOf('--notes');
const notes = notesIdx >= 0 ? String(args[notesIdx + 1] || '') : '';

const src = readFileSync(join(root, 'src', 'merged-chat.user.js'), 'utf8');
const m = /^\/\/\s*@version\s+([\d.]+)\s*$/m.exec(src);
if (!m) throw new Error('В юзерскрипте нет // @version');
const version = m[1].split('.').map(n => String(parseInt(n, 10))).slice(0, 4).join('.');

writeFileSync(join(ext, 'chat.js'),
    '// СГЕНЕРИРОВАНО tools/build.mjs из src/merged-chat.user.js — правь исходник, не этот файл.\n'
    + '// Код ждёт, пока gm-shim.js загрузит хранилище (GM_getValue синхронный).\n'
    + '// В iframe самого сайта (не в нашем скрытом) MC_EXT.skip — код не запускается.\n'
    + 'MC_EXT.ready.then(() => {\nif (MC_EXT.skip) return;\n' + src + '\n});\n');

const manifestPath = join(ext, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        const rel = relative(ext, p).split('\\').join('/');
        if (rel === 'update.json' || name.startsWith('.')) continue;
        const buf = readFileSync(p);
        files.push({ path: rel, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length });
    }
})(ext);

writeFileSync(join(ext, 'update.json'), JSON.stringify({ version, notes, files }, null, 2) + '\n');
console.log(`Собрано: версия ${version}, файлов ${files.length}.`);
console.log('Дальше: залей папку extension/ туда, куда смотрит updateUrl (например, git push) — у всех появится кнопка «Обновить».');
