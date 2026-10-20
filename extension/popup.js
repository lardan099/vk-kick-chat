import { CONFIG, loadSettings } from './config.js';

const $ = id => document.getElementById(id);
const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });
const STATE = {
    ok: ['работает', 'ok'], starting: ['запускается', 'wait'], login: ['нужен вход', 'bad'],
    error: ['не отвечает', 'bad'], off: ['выключен', ''], closed: ['не запущен', ''], idle: ['открыт', 'ok']
};
const WHERE = { frame: 'скрыто', direct: 'скрыто', tab: 'вкладка', 'user-tab': 'твоя вкладка' };
const KICK_ICON = 'https://www.google.com/s2/favicons?domain=kick.com&sz=64';
const VK_ICON = 'https://images.live.vkvideo.ru/smile/42502cfe-8cf9-4f13-aaa3-4f100359b6d1/icon/size/medium?change_time=1764532236';
const ICONS = { vk: VK_ICON, kick: KICK_ICON, dash: KICK_ICON };
const RELOAD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/></svg>';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s} с назад` : `${Math.round(s / 60)} мин назад`; };

$('ver').textContent = chrome.runtime.getManifest().version;

async function render() {
    const { ext_status: status, ext_update: upd } = await chrome.storage.local.get(['ext_status', 'ext_update']);
    const helpers = (status && status.helpers) || {};
    $('where').textContent = status && status.placement === 'hidden' ? 'без окон и вкладок' : '';
    $('helpers').innerHTML = Object.entries(CONFIG.helpers).filter(([name]) => (helpers[name] || {}).state !== 'off').map(([name, h]) => {
        const st = helpers[name] || {};
        const [text, cls] = STATE[st.state] || ['—', ''];
        const bits = [text];
        if (st.state === 'ok' && st.hb) bits.push(ago(st.hb));
        if (st.where === 'user-tab' || st.where === 'tab') bits.push(WHERE[st.where]);
        if (st.detail && st.state !== 'ok') bits.splice(1, 0, st.detail);
        return `<div class="row" title="${esc(h.why)}"><img src="${ICONS[name]}" alt=""><span class="name">${esc(h.label)}</span>
            <span class="state ${cls === 'bad' ? 'bad' : ''}"><i class="dot ${cls}"></i>${esc(bits.join(' · '))}</span>
            <button class="btn icon" data-refresh="${name}" title="Перезапустить">${RELOAD}</button></div>`;
    }).join('') || '<div class="note">Все сборщики выключены.</div>';

    const failing = Object.keys(CONFIG.helpers).find(n => ['error', 'login'].includes((helpers[n] || {}).state));
    $('failing').innerHTML = failing
        ? `<div class="note">${esc(CONFIG.helpers[failing].label)} не поднимается — открой обычной вкладкой, возможно, нужно войти.</div>
           <button class="btn" data-show="${failing}" style="margin-top:4px">Открыть ${esc(CONFIG.helpers[failing].label)}</button>`
        : '';

    let note = status && !status.feedOpen ? 'Чат закрыт — сборщики поднимутся, когда откроешь его.' : '';
    if (upd && upd.error === 'no-url') note = 'Адрес обновлений не задан — см. «Настройки».';
    else if (upd && upd.error) note = 'Не удалось проверить обновления: ' + upd.error;
    else if (upd && !upd.available && upd.checked) note = note || `Последняя версия, проверено ${ago(upd.checked)}`;
    $('note').textContent = note;

    $('upd').hidden = !(upd && upd.available);
    if (upd && upd.available) {
        $('upd-text').innerHTML = `<div class="versions">${esc(upd.current)} → <b>${esc(upd.latest)}</b></div>`
            + (upd.notes ? `<div class="note">${esc(upd.notes)}</div>` : '');
        $('upd-go').textContent = `Обновить до ${upd.latest}`;
    }
}

async function loadForm() {
    const s = await loadSettings();
    document.querySelectorAll('[data-helper]').forEach(el => { el.checked = !!s.helpers[el.dataset.helper]; });
    document.querySelectorAll('[name=placement]').forEach(el => { el.checked = el.value === s.placement; });
    $('autoclose').checked = !!s.autoClose;
    $('update-url').value = s.updateUrl || '';
    $('update-url').placeholder = CONFIG.updateUrl || 'https://…/update.json';
}

async function saveSettings() {
    const helpers = {};
    document.querySelectorAll('[data-helper]').forEach(el => { helpers[el.dataset.helper] = el.checked; });
    const placement = document.querySelector('[name=placement]:checked')?.value || 'hidden';
    await chrome.storage.local.set({ ext_settings: { helpers, placement, autoClose: $('autoclose').checked, updateUrl: $('update-url').value.trim() } });
    send('helpers:status').then(render).catch(() => { });
}

const busy = async (btn, text, fn) => {
    const old = btn.textContent;
    btn.textContent = text; btn.disabled = true;
    try { await fn(); } finally { btn.textContent = old; btn.disabled = false; render(); }
};

$('open').addEventListener('click', async () => { await send('feed:open'); window.close(); });
$('restart').addEventListener('click', () => busy($('restart'), 'Перезапускаю…', () => send('helpers:restart')));
$('check').addEventListener('click', () => busy($('check'), 'Проверяю…', () => send('update:check')));
$('upd-go').addEventListener('click', async () => { await send('update:open', { auto: true }); window.close(); });
$('folder').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('updater.html?setup=1') }));
document.body.addEventListener('click', async e => {
    const b = e.target.closest('button[data-show], button[data-refresh]');
    if (!b) return;
    if (b.dataset.show) { await send('helper:show', { name: b.dataset.show }); window.close(); return; }
    b.classList.remove('turn'); void b.offsetWidth; b.classList.add('turn');
    await send('helper:refresh', { name: b.dataset.refresh });
    send('helpers:status').then(render);
});
// переключатели сохраняются сразу
document.querySelectorAll('[data-helper], [name=placement], #autoclose').forEach(el => el.addEventListener('change', saveSettings));
$('save').addEventListener('click', async () => {
    await saveSettings();
    $('save').textContent = 'Сохранено';
    setTimeout(() => { $('save').textContent = 'Сохранить'; }, 1200);
    send('update:check').then(render);
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.ext_status || changes.ext_update)) render();
});
loadForm();
render();
send('helpers:status').then(render).catch(() => { });
