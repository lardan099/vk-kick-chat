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

async function readFile(root, path) {
    const parts = path.split('/');
    const name = parts.pop();
    try {
        let dir = root;
        for (const p of parts) dir = await dir.getDirectoryHandle(p);
        return await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
    } catch (e) { return null; } // файла нет
}

// Запись не прошла — почти всегда это Защитник Windows. Объясняем по-человечески, что нажать.
class WriteBlocked extends Error {
    constructor(path, cause, removed) {
        super(`Не удалось записать ${path}`);
        this.path = path; this.cause = cause; this.removed = removed;
    }
}
function showWriteHelp(err) {
    const tech = err.cause ? `${err.cause.name || ''} ${err.cause.message || err.cause}`.trim() : '';
    $('help').innerHTML = `<b>${err.removed
        ? `Файл ${esc(err.path)} записался, но сразу пропал — его убрал антивирус.`
        : `Windows не дал записать ${esc(err.path)}.`} Расширение осталось на старой версии, ничего не сломано.</b>`
        + 'Почти всегда это Защитник Windows. Что сделать:'
        + '<ol>'
        + '<li><b>Папка в «Документах», на «Рабочем столе» или в «Загрузках»?</b> Там её охраняет «Контролируемый доступ к папкам». '
        + 'Проще всего перенести папку расширения, например в <code>C:\\MergedChat</code>, в <code>chrome://extensions</code> удалить расширение и «Загрузить распакованное» уже оттуда '
        + '(переименования сохранить заранее: значок → «Настройки» → «Перенос и запасная копия»). '
        + 'Или оставить как есть: «Безопасность Windows» → «Защита от вирусов и угроз» → «Защита от программ-шантажистов» → '
        + '«Разрешить работу приложения через контролируемый доступ к папкам» → добавить <code>chrome.exe</code>.</li>'
        + '<li><b>Защитник показал «Обнаружены угрозы»?</b> Это ложное срабатывание на код чата (он перехватывает сообщения и токены сайтов — так и задумано). '
        + '«Безопасность Windows» → «Журнал защиты» → запись → «Разрешить», и добавить папку расширения в исключения: '
        + '«Параметры защиты от вирусов и угроз» → «Исключения» → «Добавить исключение» → «Папка».</li>'
        + '</ol>Потом нажми «Обновить» ещё раз.'
        + (tech ? `<div class="note">Техническая причина: ${esc(tech)}</div>` : '');
    $('help').hidden = false;
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

    // пробная запись: если Windows не пускает в папку, узнаём до того, как тронем настоящие файлы
    status('Проверяю, можно ли писать в папку…');
    const probe = '_mc_write_test.tmp';
    try {
        const bytes = new TextEncoder().encode('merged-chat ' + Date.now());
        await writeFile(dir, probe, bytes);
        const back = await readFile(dir, probe);
        if (!back) throw new WriteBlocked(probe, null, true);
    } catch (e) {
        throw e instanceof WriteBlocked ? e : new WriteBlocked('файлы в папку расширения', e, false);
    } finally {
        await removeFile(dir, probe);
    }

    // старые версии файлов — в память: если запись сорвётся на середине, вернём всё как было
    status('Записываю файлы…');
    const backup = new Map();
    for (const f of downloaded) backup.set(f.path, await readFile(dir, f.path));
    const written = [];
    try {
        for (const f of downloaded) {
            try { await writeFile(dir, f.path, f.buf); }
            catch (e) { throw new WriteBlocked(f.path, e, false); }
            written.push(f.path);
            // сверка: антивирус мог удалить или обнулить файл сразу после записи
            const back = await readFile(dir, f.path);
            if (!back || await sha256(back) !== await sha256(f.buf)) throw new WriteBlocked(f.path, null, true);
            progress(++step, total);
        }
    } catch (e) {
        status('Возвращаю прежние файлы…');
        for (const path of written.reverse()) {
            const old = backup.get(path);
            try { if (old) await writeFile(dir, path, old); else await removeFile(dir, path); } catch (err) { /* что смогли */ }
        }
        throw e;
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
    $('help').hidden = true;
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
        else if (e instanceof WriteBlocked) { status('Обновление не записалось', true); showWriteHelp(e); }
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
