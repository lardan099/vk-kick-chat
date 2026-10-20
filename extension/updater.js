// Самообновление распакованного расширения.
// Один раз пользователь выбирает папку расширения (File System Access API), ручка
// хранится в IndexedDB. Дальше: качаем файлы из update.json, сверяем sha256,
// записываем поверх и делаем chrome.runtime.reload() — Chrome перечитывает папку.
import { compareVersions, loadSettings, updateUrlOf } from './config.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SETUP = params.has('setup');
const AUTO = params.has('auto');
const running = chrome.runtime.getManifest();

// ---------- IndexedDB: ручка папки ----------
function db() {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open('mc-updater', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}
async function kv(mode, key, value) {
    const d = await db();
    return new Promise((resolve, reject) => {
        const store = d.transaction('kv', mode).objectStore('kv');
        const q = mode === 'readonly' ? store.get(key) : store.put(value, key);
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
    });
}
const getDir = () => kv('readonly', 'dir').catch(() => null);
const saveDir = dir => kv('readwrite', 'dir', dir);

// ---------- UI ----------
const status = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
$('ver').textContent = running.version;
function progress(done, total) {
    $('progress').hidden = false;
    $('progress').firstElementChild.style.width = Math.round(100 * done / Math.max(1, total)) + '%';
}
function showFolder(dir) { $('folder').textContent = dir ? `Папка расширения: …\\${dir.name}` : ''; }

async function readManifest(dir) {
    try {
        const fh = await dir.getFileHandle('manifest.json');
        return JSON.parse(await (await fh.getFile()).text());
    } catch (e) { return null; }
}

async function pickFolder() {
    const dir = await window.showDirectoryPicker({ id: 'mc-extension', mode: 'readwrite' });
    const m = await readManifest(dir);
    if (!m || m.name !== running.name) {
        throw new Error('В этой папке нет manifest.json от Merged Chat. Выбери папку, где лежит manifest.json расширения.');
    }
    if (m.version !== running.version
        && !confirm(`В выбранной папке версия ${m.version}, а в Chrome запущена ${running.version}.\nЭто точно та папка, что загружена в Chrome?`)) {
        throw new Error('Отменено');
    }
    await saveDir(dir);
    showFolder(dir);
    return dir;
}

async function permitted(dir, ask) {
    const opts = { mode: 'readwrite' };
    if (await dir.queryPermission(opts) === 'granted') return true;
    if (!ask) return false;
    return (await dir.requestPermission(opts)) === 'granted';
}

// ---------- обновление ----------
let info = null;
let updateUrl = '';

async function fetchInfo() {
    updateUrl = updateUrlOf(await loadSettings());
    if (!updateUrl) throw new Error('Адрес обновлений не задан (значок расширения → «Ещё» → адрес update.json).');
    const r = await fetch(updateUrl + (updateUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('update.json: HTTP ' + r.status);
    const j = await r.json();
    if (!j.version || !Array.isArray(j.files) || !j.files.length) throw new Error('update.json без версии или списка файлов');
    return j;
}

function safePath(p) {
    const s = String(p || '');
    if (!s || s.startsWith('/') || s.includes('\\') || s.split('/').some(x => !x || x === '.' || x === '..')) {
        throw new Error('Подозрительный путь в update.json: ' + s);
    }
    return s;
}

async function sha256(buf) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function writeFile(root, path, buf) {
    const parts = path.split('/');
    const name = parts.pop();
    let dir = root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(buf);
    await w.close();
}

async function removeFile(root, path) {
    const parts = path.split('/');
    const name = parts.pop();
    let dir = root;
    try {
        for (const p of parts) dir = await dir.getDirectoryHandle(p);
        await dir.removeEntry(name);
    } catch (e) { /* уже нет */ }
}

async function apply(dir) {
    // manifest.json пишем последним: если что-то упадёт раньше, версия не сменится
    const files = info.files.map(f => ({ ...f, path: safePath(f.path) }))
        .sort((a, b) => (a.path === 'manifest.json') - (b.path === 'manifest.json'));
    const total = files.length * 2;
    let step = 0;
    progress(0, total);

    status('Скачиваю…');
    const downloaded = [];
    for (const f of files) {
        const r = await fetch(new URL(f.path, updateUrl).href + '?v=' + encodeURIComponent(info.version), { cache: 'no-store' });
        if (!r.ok) throw new Error(`${f.path}: HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        if (f.sha256 && await sha256(buf) !== f.sha256) throw new Error(`${f.path}: файл повреждён (не совпал sha256) — попробуй ещё раз через пару минут`);
        downloaded.push({ path: f.path, buf });
        progress(++step, total);
    }
    const newManifest = JSON.parse(new TextDecoder().decode(downloaded.find(f => f.path === 'manifest.json')?.buf || new ArrayBuffer(0)) || '{}');
    if (newManifest.name !== running.name) throw new Error('В обновлении чужой manifest.json — отменено');

    status('Записываю файлы…');
    for (const f of downloaded) {
        await writeFile(dir, f.path, f.buf);
        progress(++step, total);
    }
    for (const p of info.remove || []) await removeFile(dir, safePath(p));

    status('');
    $('go').hidden = true;
    $('done-text').textContent = `Готово: ${running.version} → ${newManifest.version}. Перезапускаю…`;
    $('done').hidden = false;
    setTimeout(() => chrome.runtime.reload(), 1100);
}

async function run() {
    $('go').disabled = true;
    try {
        let dir = await getDir();
        if (!dir) dir = await pickFolder();
        if (!await permitted(dir, true)) throw new Error('Без разрешения на изменение файлов обновить не получится');
        const m = await readManifest(dir);
        if (!m || m.name !== running.name) {
            // папку перенесли/удалили — забываем, следующий клик спросит заново
            await kv('readwrite', 'dir', null);
            showFolder(null);
            throw new Error('Папка расширения не найдена на старом месте. Нажми ещё раз и выбери её.');
        }
        await apply(dir);
    } catch (e) {
        if (e && e.name === 'AbortError') status('Папка не выбрана', true);
        else status(String(e && e.message || e), true);
        $('go').disabled = false;
    }
}

async function checkAndShow() {
    $('update').hidden = false;
    try {
        info = await fetchInfo();
    } catch (e) {
        $('title').textContent = 'Не удалось проверить обновления';
        status(String(e.message || e), true);
        return;
    }
    if (compareVersions(info.version, running.version) <= 0) {
        $('title').textContent = `Установлена последняя версия (${running.version})`;
        return;
    }
    $('title').textContent = 'Доступно обновление';
    $('versions').innerHTML = `<div class="versions">${esc(running.version)} → <b>${esc(info.version)}</b></div>`;
    $('notes').textContent = info.notes || '';
    $('go').hidden = false;
    $('go').textContent = `Обновить до ${info.version}`;
    const dir = await getDir();
    if (AUTO && dir && await permitted(dir, false).catch(() => false)) run();
    else if (dir) status('Нажми кнопку — Chrome может один раз спросить разрешение на изменение файлов.');
    else status('При первом обновлении нужно выбрать папку расширения (один раз).');
}

$('go').addEventListener('click', run);
$('pick').addEventListener('click', async () => {
    try {
        await pickFolder();
        $('setup').hidden = true;
        $('done-text').textContent = 'Готово! Теперь обновления ставятся одной кнопкой — в чате или в значке расширения.';
        $('done').hidden = false;
        status('');
    } catch (e) {
        status(e && e.name === 'AbortError' ? 'Папка не выбрана' : String(e && e.message || e), true);
    }
});

(async () => {
    if (!('showDirectoryPicker' in window)) {
        status('Этот браузер не умеет давать доступ к папке (нужен Chrome/Edge/Opera/Яндекс на Chromium).', true);
        return;
    }
    const dir = await getDir();
    showFolder(dir);
    if (SETUP || !dir) $('setup').hidden = false;
    if (!SETUP) checkAndShow();
})();
