// Ручное обновление: показываем, что вышло, даём архив с GitHub и кнопку перезапуска.
// Файлы на диск расширение само не пишет.
import { CONFIG, compareVersions, loadSettings, updateUrlOf } from './config.js';

const $ = id => document.getElementById(id);
const running = chrome.runtime.getManifest();
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const status = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };
$('ver').textContent = running.version;

$('download').addEventListener('click', () => chrome.tabs.create({ url: CONFIG.downloadUrl }));
$('reload').addEventListener('click', () => chrome.runtime.reload());

(async () => {
    try {
        const url = updateUrlOf(await loadSettings());
        if (!url) throw new Error('Адрес обновлений не задан');
        const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const info = await r.json();
        if (compareVersions(info.version, running.version) <= 0) {
            $('title').textContent = `Установлена последняя версия (${running.version})`;
            return;
        }
        $('title').textContent = 'Вышла новая версия';
        $('versions').innerHTML = `<div class="versions">${esc(running.version)} → <b>${esc(info.version)}</b></div>`;
        $('notes').textContent = info.notes || '';
        $('steps').hidden = false;
    } catch (e) {
        $('title').textContent = 'Не удалось проверить обновления';
        status(String(e && e.message || e), true);
    }
})();
