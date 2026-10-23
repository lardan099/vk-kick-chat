// Перенос настроек из Tampermonkey вручную: текст вкладки «Хранилище», файл экспорта
// (json) или наша запасная копия. Берём только настройки чата — не токены и не очереди.
const $ = id => document.getElementById(id);

const KEYS = {
    aliases: 'mc_local_user_aliases_v1',
    highlights: 'mc_highlighted_users_v1',
    colors: 'mc_user_colors',
    privileged: 'mc_privileged_chat_users_v1',
    current: 'mc_current_chat_users_v1',
    templates: 'mc_chat_templates_v1',
    platforms: 'mc_platforms_enabled_v1'
};
// словари сливаются по записям; остальное берём, только если у нас пусто
const MERGE = [KEYS.aliases, KEYS.highlights, KEYS.colors, KEYS.privileged, KEYS.current];
const ALL = Object.values(KEYS);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const plural = (n, one, few, many) => {
    const a = n % 10, b = n % 100;
    return `${n} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`;
};

// Tampermonkey местами хранит значения строками («o{…}», «s…» или просто JSON) — разворачиваем
function unwrap(v) {
    if (typeof v !== 'string') return v;
    const s = v.trim();
    const body = /^[osnb][{["\d-tf]/.test(s) ? s.slice(1) : s;
    try { return JSON.parse(body); } catch (e) { return v; }
}

// ищем объект, где лежат ключи чата: верх (вкладка «Хранилище»), .data (storage.json),
// scripts[].storage.data (json-экспорт), data (наша копия)
function findData(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    if (isObj(obj) && ALL.some(k => k in obj)) return obj;
    let best = null;
    for (const v of Object.values(obj)) {
        const found = findData(unwrap(v), depth + 1);
        if (found && (!best || aliasCount(found) > aliasCount(best))) best = found;
    }
    return best;
}
const aliasCount = d => isObj(unwrap(d[KEYS.aliases])) ? Object.keys(unwrap(d[KEYS.aliases])).length : 0;

// голый словарь переименований: { "kick:ник": "имя", … }
function asAliasMap(obj) {
    if (!isObj(obj)) return null;
    const entries = Object.entries(obj);
    if (!entries.length || !entries.every(([k, v]) => /^(kick|vk):/.test(k) && typeof v === 'string')) return null;
    return { [KEYS.aliases]: obj };
}

function parseText(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    let obj;
    try { obj = JSON.parse(s); }
    catch (e) {
        // скопировали не весь текст — подскажем
        throw new Error('Это не похоже на текст из «Хранилища»: скопируй его целиком (Ctrl+A, Ctrl+C)');
    }
    return asAliasMap(obj) || findData(obj);
}

async function parseFile(file) {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    if (head[0] === 0x50 && head[1] === 0x4b) throw new Error('Это zip. В Tampermonkey выбери «Экспорт» в строке «Файл» (не zip) — или скопируй текст из вкладки «Хранилище»');
    return parseText(new TextDecoder().decode(buf));
}

// ---------- слияние ----------
async function apply(data, theirsWins) {
    const cur = await chrome.storage.local.get(ALL);
    const set = {};
    const stat = { added: 0, kept: 0, replaced: 0, other: [] };
    for (const key of ALL) {
        if (!(key in data)) continue;
        const v = unwrap(data[key]);
        if (MERGE.includes(key)) {
            if (!isObj(v)) continue;
            const mine = isObj(cur[key]) ? cur[key] : {};
            const merged = theirsWins && key === KEYS.aliases ? { ...mine, ...v } : { ...v, ...mine };
            if (key === KEYS.aliases) {
                for (const k of Object.keys(v)) {
                    if (!(k in mine)) stat.added++;
                    else if (mine[k] === v[k]) continue;
                    else if (theirsWins) stat.replaced++;
                    else stat.kept++;
                }
            } else if (Object.keys(v).some(k => !(k in mine))) stat.other.push(key);
            set[key] = merged;
        } else if (cur[key] === undefined && v !== undefined) {
            set[key] = v;
            stat.other.push(key);
        }
    }
    set.ext_tm_import = { t: Date.now(), aliases: stat.added + stat.replaced, at: Date.now(), manual: true, shown: true };
    await chrome.storage.local.set(set);
    return stat;
}

const OTHER_LABEL = { [KEYS.highlights]: 'выделения', [KEYS.colors]: 'цвета ников', [KEYS.templates]: 'шаблоны',
    [KEYS.privileged]: 'модераторы', [KEYS.current]: 'свои ники', [KEYS.platforms]: 'вкл/выкл чатов' };

async function showNow() {
    const cur = await chrome.storage.local.get([KEYS.aliases, KEYS.highlights]);
    const a = isObj(cur[KEYS.aliases]) ? Object.keys(cur[KEYS.aliases]).length : 0;
    const h = isObj(cur[KEYS.highlights]) ? Object.keys(cur[KEYS.highlights]).length : 0;
    $('now').textContent = `Сейчас в расширении: ${plural(a, 'переименование', 'переименования', 'переименований')}, ${plural(h, 'выделение', 'выделения', 'выделений')}`;
}

function result(html, bad = false) {
    const el = $('result');
    el.innerHTML = html;
    el.classList.toggle('bad', bad);
    el.hidden = false;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
}

let pending = null; // разобранные данные, ждут «Перенести»
function preview(data) {
    pending = data;
    const n = aliasCount(data);
    const sample = Object.entries(unwrap(data[KEYS.aliases]) || {}).slice(0, 4)
        .map(([k, v]) => `<li><code>${esc(k.replace(/^(kick|vk):/, '$1 · '))}</code> → ${esc(v)}</li>`).join('');
    $('go').disabled = false;
    $('go').textContent = n ? `Перенести ${plural(n, 'переименование', 'переименования', 'переименований')}` : 'Перенести';
    result(n ? `Нашлось ${plural(n, 'переименование', 'переименования', 'переименований')}, например:<ul>${sample}</ul>`
        : 'Переименований тут нет, но есть другие настройки чата — их тоже можно перенести.');
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fail(e) {
    pending = null;
    $('go').disabled = true;
    $('go').textContent = 'Перенести';
    result(esc(e && e.message || e), true);
}
async function take(promise) {
    try {
        const data = await promise;
        if (!data) throw new Error('Не нашёл здесь настроек Merged Chat. Нужен текст вкладки «Хранилище» именно у скрипта Merged Chat.');
        preview(data);
    } catch (e) { fail(e); }
}

$('paste').addEventListener('input', () => {
    if (!$('paste').value.trim()) { pending = null; $('go').disabled = true; $('result').hidden = true; return; }
    take(Promise.resolve().then(() => parseText($('paste').value)));
});
$('file').addEventListener('change', () => { const f = $('file').files[0]; if (f) take(parseFile(f)); $('file').value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) take(parseFile(f));
});

$('go').addEventListener('click', async () => {
    if (!pending) return;
    $('go').disabled = true;
    try {
        const st = await apply(pending, $('theirs').checked);
        const bits = [`Добавлено ${plural(st.added, 'переименование', 'переименования', 'переименований')}`];
        if (st.replaced) bits.push(`заменено ${st.replaced}`);
        if (st.kept) bits.push(`${plural(st.kept, 'ник у тебя уже был переименован', 'ника у тебя уже были переименованы', 'ников у тебя уже были переименованы')} по-своему — оставлены твои имена`);
        const other = [...new Set(st.other)].map(k => OTHER_LABEL[k]).filter(Boolean);
        result(`<b>Готово.</b> ${esc(bits.join(', '))}.${other.length ? `<br>Ещё перенесено: ${esc(other.join(', '))}.` : ''}`
            + '<br>Открытый чат подхватит новые имена сам. Теперь выключи Merged Chat в Tampermonkey.');
        pending = null;
        $('go').textContent = 'Перенесено';
        showNow();
    } catch (e) { fail(e); $('go').disabled = false; }
});

$('backup').addEventListener('click', async () => {
    const data = await chrome.storage.local.get(ALL);
    const blob = new Blob([JSON.stringify({ app: 'merged-chat', saved: new Date().toISOString(), data }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `merged-chat-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

showNow();
