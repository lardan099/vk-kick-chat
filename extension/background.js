// Фоновый воркер: держит сборщики (VK, Kick, dashboard) скрытыми, сам перезапускает их
// при ошибках/зависаниях, держит чат в попап-окне, проксирует GM_xmlhttpRequest
// и проверяет обновления.
//
// Где живут сборщики (настройка placement):
//   hidden — iframe в невидимом offscreen-документе расширения: ни окна, ни вкладки (по умолчанию)
//   window — отдельное свёрнутое окно
//   tabs   — закреплённые вкладки без фокуса
import { CONFIG, isFeedUrl, compareVersions, loadSettings, updateUrlOf } from './config.js';

const HELPER_NAMES = Object.keys(CONFIG.helpers);
const STALE_MS = 110000;          // сборщики пишут heartbeat раз в 30 с
const BOOT_MS = 45000;            // после (пере)загрузки сборщик должен ожить за это время
const GRACE_MS = 20000;           // сразу после (пере)загрузки не дёргаем
const RELOAD_LIMIT = 5;           // не больше стольких автоперезагрузок одного сборщика…
const RELOAD_WINDOW_MS = 15 * 60000; // …за это время, дальше — статус «не отвечает»
const AUTO_CLOSE_MS = 60000;      // чат закрыт столько — гасим свои сборщики
const XHR_HOSTS = ['api.live.vkvideo.ru', '7tv.io', 'pzdcflix.live', 'kick.com'];

const helperRe = Object.fromEntries(HELPER_NAMES.map(n => [n, new RegExp(CONFIG.helpers[n].match)]));
const matchesHelper = (name, url) => !!url && helperRe[name].test(url) && !(name === 'kick' && isFeedUrl(url));
const helperOfUrl = url => HELPER_NAMES.find(n => matchesHelper(n, url));

// ---------- состояние (storage.session переживает перезапуск воркера) ----------
async function session() {
    const { ext_session } = await chrome.storage.session.get('ext_session');
    return Object.assign({ owned: {}, windowId: null, touched: {}, reloads: {}, lastFeedAt: 0, errors: {} }, ext_session || {});
}
const saveSession = s => chrome.storage.session.set({ ext_session: s });

// Все операции со сборщиками идут по очереди, иначе два события подряд откроют дубли
let chain = Promise.resolve();
const serial = fn => (chain = chain.then(fn, fn));

const getTab = id => id == null ? Promise.resolve(null) : chrome.tabs.get(id).catch(() => null);
const allTabs = () => chrome.tabs.query({});
const feedTabs = async () => (await allTabs()).filter(t => isFeedUrl(t.url || t.pendingUrl));

// ---------- скрытый режим: offscreen-документ с iframe ----------
let offscreenCreating = null;
async function hasOffscreen() {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctx.length > 0;
}
async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    if (!offscreenCreating) {
        offscreenCreating = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['IFRAME_SCRIPTING'],
            justification: 'Скрытые страницы чатов Kick/VK: сборщики сообщений и токенов для общего чата'
        }).catch(e => { if (!/single offscreen/i.test(String(e))) throw e; })
            .finally(() => { offscreenCreating = null; });
    }
    await offscreenCreating;
}
async function frames(cmd = {}) {
    if (!await hasOffscreen()) {
        if (cmd.type !== 'add') return {};
        await ensureOffscreen();
    }
    for (let i = 0; i < 5; i++) {
        try { return await chrome.runtime.sendMessage({ target: 'offscreen', type: 'list', ...cmd }) || {}; }
        catch (e) { await new Promise(r => setTimeout(r, 150)); } // документ ещё грузится
    }
    return {};
}
async function closeOffscreen() {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => { });
}

// ---------- поиск/открытие сборщика ----------
// Возвращает { kind:'tab'|'frame', tab?, owned } или null
async function findHelper(name, s, settings, frameList) {
    // открытая пользователем вкладка с тем же чатом — второй сборщик не нужен (он путает очередь)
    const own = await getTab(s.owned[name]);
    if (own) return { kind: 'tab', tab: own, owned: true };
    delete s.owned[name];
    // в скрытом режиме открытая вкладка VK — не сборщик (только отдаёт токен), на неё не полагаемся
    const userTab = name === 'vk' && settings.placement === 'hidden' ? null
        : (await allTabs()).find(t => matchesHelper(name, t.url || t.pendingUrl));
    if (userTab) return { kind: 'tab', tab: userTab, owned: false };
    if (frameList && frameList[name]) return { kind: 'frame', frame: frameList[name], owned: true };
    return null;
}

async function openHelper(name, s, settings) {
    const url = CONFIG.helpers[name].url;
    s.touched[name] = Date.now();
    if (settings.placement === 'hidden') {
        await frames({ type: 'add', name, url: await frameUrl(name) });
        return { kind: 'frame', owned: true };
    }
    let tab = null;
    if (settings.placement === 'tabs') {
        let windowId = null;
        for (const f of await feedTabs()) {
            const w = await chrome.windows.get(f.windowId).catch(() => null);
            if (w && w.type === 'normal') { windowId = w.id; break; }
        }
        if (windowId == null) {
            const normal = (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0];
            windowId = normal ? normal.id : null;
        }
        if (windowId != null) tab = await chrome.tabs.create({ windowId, url, active: false, pinned: true, index: 0 });
    }
    if (!tab) {
        const win = s.windowId != null ? await chrome.windows.get(s.windowId).catch(() => null) : null;
        if (win) tab = await chrome.tabs.create({ windowId: win.id, url, active: false });
        else {
            const created = await chrome.windows.create({ url, state: 'minimized', focused: false });
            s.windowId = created.id;
            if (created.state !== 'minimized') await chrome.windows.update(created.id, { state: 'minimized' }).catch(() => { });
            tab = created.tabs && created.tabs[0];
        }
    }
    if (!tab) throw new Error('не удалось открыть ' + url);
    s.owned[name] = tab.id;
    await keepAlive(tab.id);
    return { kind: 'tab', tab, owned: true };
}

async function keepAlive(tabId) {
    // «Экономия памяти» Chrome выгружает фоновые вкладки — запрещаем
    try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (e) { }
}

function reloadsLeft(name, s) {
    const list = (s.reloads[name] || []).filter(t => Date.now() - t < RELOAD_WINDOW_MS);
    s.reloads[name] = list;
    return RELOAD_LIMIT - list.length;
}

async function reloadHelper(name, found, s, { manual = false } = {}) {
    if (!manual) s.reloads[name] = [...(s.reloads[name] || []), Date.now()];
    else s.reloads[name] = []; // ручной перезапуск сбрасывает счётчик
    s.touched[name] = Date.now();
    if (found.kind === 'frame') await frames({ type: 'reload', name });
    else {
        await chrome.tabs.reload(found.tab.id).catch(() => { });
        await keepAlive(found.tab.id);
    }
}

// Убрать сборщики, которые не нужны: выключенные в настройках или в другом режиме
async function dropUnneeded(s, settings, frameList) {
    for (const name of HELPER_NAMES) {
        const wantFrame = settings.helpers[name] && settings.placement === 'hidden';
        if (frameList[name] && !wantFrame) await frames({ type: 'remove', name });
        if (s.owned[name] != null && (!settings.helpers[name] || settings.placement === 'hidden')) {
            await chrome.tabs.remove(s.owned[name]).catch(() => { });
            delete s.owned[name];
        }
    }
}

// В скрытом режиме фрейм VK — не страница VK, а лёгкий читатель: gm-shim видит #mc-direct,
// глушит приложение VK и сам держит сокет pubsub (Origin у фрейма родной, live.vkvideo.ru)
const readerUrls = name => CONFIG.helpers[name].readerUrls || [CONFIG.helpers[name].url];
// последний адрес, на котором читатель поднялся, иначе первый из списка
async function frameUrl(name) {
    const list = readerUrls(name);
    if (list.length < 2) return list[0];
    const ok = ((await chrome.storage.local.get('ext_reader_ok')).ext_reader_ok || {})[name];
    return list.includes(ok) ? ok : list[0];
}
async function rememberReader(name, url) {
    const all = (await chrome.storage.local.get('ext_reader_ok')).ext_reader_ok || {};
    if (all[name] !== url) await chrome.storage.local.set({ ext_reader_ok: { ...all, [name]: url } });
}
const shortUrl = url => String(url || '').replace(/^https:\/\/[^/]+\//, '').replace(/#.*/, '');

async function ensureHelper(name, { forceReload = false } = {}) {
    const settings = await loadSettings();
    if (name === 'vk') await syncTokens();
    const s = await session();
    const found = await findHelper(name, s, settings, await frames());
    let action = 'ok';
    if (!found) { await openHelper(name, s, settings); action = 'opened'; }
    else if (forceReload || (found.tab && found.tab.discarded)) { await reloadHelper(name, found, s, { manual: forceReload }); action = 'reloaded'; }
    else if (found.tab) await keepAlive(found.tab.id);
    await saveSession(s);
    return action;
}

async function readHeartbeat(name) {
    const k = CONFIG.helpers[name].heartbeatKey;
    return Number((await chrome.storage.local.get(k))[k] || 0);
}

async function probe(name) {
    const h = CONFIG.helpers[name];
    const at = Date.now();
    await chrome.storage.local.set({ [h.probeKey]: { t: at, nonce: Math.random() } });
    await new Promise(r => setTimeout(r, 4000));
    return await readHeartbeat(name) >= at;
}

// ---------- сторож: раз в 30 с, пока открыт чат ----------
async function watchdog() {
    const settings = await loadSettings();
    syncTokens();
    const s = await session();
    const feeds = await feedTabs();
    let frameList = await frames();
    const status = { t: Date.now(), feedOpen: feeds.length > 0, placement: settings.placement, helpers: {} };

    if (feeds.length) s.lastFeedAt = Date.now();
    else if (settings.autoClose && s.lastFeedAt && Date.now() - s.lastFeedAt > AUTO_CLOSE_MS) {
        await closeOwned(s);
        frameList = {};
    }
    await dropUnneeded(s, settings, frameList);
    frameList = await frames();

    for (const name of HELPER_NAMES) {
        if (!settings.helpers[name]) { status.helpers[name] = { state: 'off' }; continue; }
        let found = await findHelper(name, s, settings, frameList);
        // пользователь открыл свою вкладку с этим чатом — скрытый фрейм больше не нужен
        if (found && found.kind === 'tab' && !found.owned && frameList[name]) await frames({ type: 'remove', name });

        if (!feeds.length) {
            status.helpers[name] = { state: found ? 'idle' : 'closed', where: found && found.kind };
            continue;
        }
        if (!found) {
            await openHelper(name, s, settings);
            status.helpers[name] = { state: 'starting', where: settings.placement === 'hidden' ? 'frame' : 'tab' };
            continue;
        }
        const where = found.kind === 'frame' ? 'frame' : (found.owned ? 'tab' : 'user-tab');
        const st = { where, tabId: found.tab && found.tab.id };
        status.helpers[name] = st;

        if (found.tab) {
            const url = found.tab.url || found.tab.pendingUrl || '';
            if (!matchesHelper(name, url)) { st.state = 'login'; continue; } // своя вкладка ушла на вход
            if (found.tab.discarded) { await reloadHelper(name, found, s); st.state = 'starting'; continue; }
            if (found.tab.status === 'loading') { st.state = 'starting'; continue; }
        }
        const hb = await readHeartbeat(name);
        const touched = s.touched[name] || 0;
        st.hb = hb;
        // VK-читатель: кроме heartbeat смотрим, поднялся ли его сокет, и пишем, на каком шаге он застрял
        let vkSocketDown = false, vkOpen = false;
        if (name === 'vk' && found.kind === 'frame') {
            const d = (await chrome.storage.local.get('ext_vk_direct')).ext_vk_direct;
            const fr = frameList.vk || {};
            const since = Math.max(touched, fr.createdAt || 0);
            // load у фрейма не приходит (читатель сам останавливает загрузку), поэтому ждём его собственный сигнал
            if (!d || d.t < since - 1000) {
                const list = readerUrls(name);
                // пришёл load, а читатель молчит — во фрейме страница ошибки (VK не дал встроить адрес)
                const dead = Date.now() - since > (fr.loadedAt ? 12000 : 20000);
                if (dead && list.length > 1 && reloadsLeft(name, s) > 0) {
                    const next = list[(list.indexOf(fr.url) + 1) % list.length];
                    s.reloads[name] = [...(s.reloads[name] || []), Date.now()];
                    s.touched[name] = Date.now();
                    await frames({ type: 'add', name, url: next });
                    st.state = 'starting';
                    st.detail = `читатель VK не поднялся на ${shortUrl(fr.url)}, пробую ${shortUrl(next)}`;
                    continue;
                }
                st.detail = dead ? `читатель VK не ответил (${shortUrl(fr.url)})` : 'загружается';
            }
            else if (d.state === 'open') { st.detail = ''; vkOpen = true; if (fr.url) await rememberReader(name, fr.url); }
            else {
                st.detail = d.state === 'error' ? 'сокет VK: ' + (d.error || 'ошибка')
                    : d.state === 'closed' ? 'сокет VK закрылся, переподключаюсь' : 'подключаюсь к сокету VK';
                vkSocketDown = Date.now() - d.t > 90000; // дольше полутора минут без сокета — перезапуск
            }
        }
        if (Date.now() - touched < GRACE_MS && !vkOpen) { st.state = 'starting'; continue; }
        // после перезагрузки сборщик так и не ожил (страница ошибки, вход, капча)
        const neverBooted = (hb < touched && Date.now() - touched > BOOT_MS) || vkSocketDown;
        const stale = Date.now() - hb > STALE_MS;
        if (!neverBooted && (!stale || await probe(name))) {
            if (found.tab) await keepAlive(found.tab.id);
            st.state = st.detail ? 'starting' : 'ok';
            if (stale) st.hb = Date.now();
            continue;
        }
        if (hb < touched && Date.now() - touched <= BOOT_MS) { st.state = 'starting'; continue; }
        if (!found.owned) { st.state = 'error'; continue; } // чужую вкладку пользователя не трогаем
        if (reloadsLeft(name, s) <= 0) { st.state = 'error'; st.detail = st.detail || 'не поднимается'; continue; }
        await reloadHelper(name, found, s);
        st.state = 'starting';
        st.reason = neverBooted ? 'не загрузился' : 'замолчал';
    }
    status.errors = s.errors;
    await saveSession(s);
    await chrome.storage.local.set({ ext_status: status });
    return status;
}

// Сборщик сам сообщил об ошибке (упал WebSocket, не загрузились скрипты…) — перезагружаем его
async function onHelperError(msg, sender) {
    const name = helperOfUrl(sender.url || '');
    if (!name) return { ignored: 'unknown sender' };
    const s = await session();
    const settings = await loadSettings();
    s.errors[name] = { t: Date.now(), reason: String(msg.reason || '?').slice(0, 120) };
    const found = await findHelper(name, s, settings, await frames());
    let result = 'skipped';
    const fromHidden = !sender.tab;
    if (found && found.owned && (fromHidden ? found.kind === 'frame' : found.tab && found.tab.id === sender.tab.id)
        && Date.now() - (s.touched[name] || 0) > GRACE_MS && reloadsLeft(name, s) > 0) {
        await reloadHelper(name, found, s);
        result = 'reloaded';
    }
    await saveSession(s);
    console.log('[MergedChat] ошибка сборщика', name, msg.reason, '→', result);
    return { result };
}

async function closeOwned(s) {
    for (const id of Object.values(s.owned)) if (id != null) await chrome.tabs.remove(id).catch(() => { });
    s.owned = {};
    s.lastFeedAt = 0;
    await closeOffscreen();
}

async function showHelper(name) {
    const s = await session();
    const found = await findHelper(name, s, await loadSettings(), await frames());
    if (found && found.tab) {
        await chrome.tabs.update(found.tab.id, { active: true });
        await chrome.windows.update(found.tab.windowId, { focused: true, state: 'normal' }).catch(() => { });
        return true;
    }
    // скрытый фрейм не показать — открываем обычную вкладку (например, чтобы войти в аккаунт).
    // Пока она открыта, сборщиком работает она; закроешь — снова поднимется скрытый.
    await frames({ type: 'remove', name });
    await chrome.tabs.create({ url: CONFIG.helpers[name].url, active: true });
    return true;
}

async function restartAll() {
    const settings = await loadSettings();
    for (const name of HELPER_NAMES) if (settings.helpers[name]) await ensureHelper(name, { forceReload: true });
}

// ---------- чат всегда в попап-окне, размер и место запоминаются ----------
async function feedWindowOptions() {
    const { ext_feed_bounds: b } = await chrome.storage.local.get('ext_feed_bounds');
    const o = { type: 'popup', focused: true, width: 480, height: 820 };
    if (b && b.width >= 260 && b.height >= 300) Object.assign(o, { width: b.width, height: b.height, left: b.left, top: b.top });
    return o;
}

async function openFeed() {
    const existing = (await feedTabs())[0];
    if (existing) {
        const w = await chrome.windows.get(existing.windowId).catch(() => null);
        if (w && w.type !== 'popup') return toPopup(existing);
        await chrome.windows.update(existing.windowId, { focused: true, state: 'normal' }).catch(() => { });
        return;
    }
    await chrome.windows.create({ url: CONFIG.feedUrl, ...(await feedWindowOptions()) });
}

const movingTabs = new Set();
async function toPopup(tab) {
    if (movingTabs.has(tab.id)) return;
    movingTabs.add(tab.id);
    try {
        const w = await chrome.windows.get(tab.windowId).catch(() => null);
        if (!w || w.type === 'popup') return;
        // переносим саму вкладку (без перезагрузки) в окно без вкладок и адресной строки
        await chrome.windows.create({ tabId: tab.id, ...(await feedWindowOptions()) });
    } catch (e) {
        console.warn('[MergedChat] не удалось вынести чат в попап', e);
    } finally {
        movingTabs.delete(tab.id);
    }
}

chrome.windows.onBoundsChanged.addListener(async w => {
    if (w.type !== 'popup') return;
    const tabs = await chrome.tabs.query({ windowId: w.id });
    if (!tabs.some(t => isFeedUrl(t.url))) return;
    await chrome.storage.local.set({ ext_feed_bounds: { left: w.left, top: w.top, width: w.width, height: w.height } });
});

// ---------- токены прямо из кук сайтов (вкладка dashboard не нужна) ----------
// Kick: фронтенд шлёт Authorization: Bearer <куки session_token>.
// VK:   куки auth = JSON { accessToken, refreshToken, expiresAt }.
async function syncTokens() {
    const out = { kick: false, vk: false };
    const cur = await chrome.storage.local.get(['mc_kick_token', 'mc_vk_token', 'mc_vk_headers']);
    const set = {};
    try {
        const c = await chrome.cookies.get({ url: 'https://kick.com/', name: 'session_token' });
        const v = c && decodeURIComponent(c.value || '');
        if (v) {
            out.kick = true;
            if (cur.mc_kick_token !== 'Bearer ' + v) set.mc_kick_token = 'Bearer ' + v;
        }
    } catch (e) { }
    try {
        const c = await chrome.cookies.get({ url: 'https://live.vkvideo.ru/', name: 'auth' });
        const a = c && JSON.parse(decodeURIComponent(c.value || ''));
        if (a && a.accessToken && (!a.expiresAt || a.expiresAt > Date.now())) {
            out.vk = true;
            const bearer = 'Bearer ' + a.accessToken;
            if (cur.mc_vk_token !== bearer) set.mc_vk_token = bearer;
            const h = cur.mc_vk_headers || {};
            if (h.authorization !== bearer) set.mc_vk_headers = { ...h, authorization: bearer };
        }
    } catch (e) { }
    if (Object.keys(set).length) await chrome.storage.local.set(set);
    return out;
}
chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
    if (removed) return;
    const kick = cookie.name === 'session_token' && /(^|\.)kick\.com$/.test(cookie.domain.replace(/^\./, ''));
    const vk = cookie.name === 'auth' && /vkvideo\.ru$/.test(cookie.domain);
    if (kick || vk) syncTokens();
});

// ---------- данные для прямого сокета VK ----------
async function vkWsInfo(fresh) {
    const { ext_vk_ws } = await chrome.storage.session.get('ext_vk_ws');
    if (!fresh && ext_vk_ws && ext_vk_ws.exp - Date.now() > 3600000) return ext_vk_ws;
    const slug = new URL(CONFIG.helpers.vk.url).pathname.split('/')[1];
    const api = await fetch(`https://api.live.vkvideo.ru/v1/blog/${slug}/public_video_stream`, { credentials: 'include', cache: 'no-store' });
    const apiText = await api.text();
    const pick = key => (new RegExp(`"${key}":"([^"]+)"`).exec(apiText) || [])[1];
    const channels = ['wsStreamChannel', 'wsStreamSlotChannel', 'wsChatChannel', 'wsChatSlotChannel'].map(pick).filter(Boolean);
    if (!channels.some(c => c.startsWith('channel-chat:'))) throw new Error('VK API не отдал канал чата');
    // гостевой токен сокета VK вшит в HTML страницы
    const html = await (await fetch(CONFIG.helpers.vk.url, { credentials: 'include', cache: 'no-store' })).text();
    const m = /"websocket":\{[^}]*?"token":"([^"]+)"/.exec(html);
    const u = /"websocket":"(wss:[^"]+)"/.exec(html);
    if (!m) throw new Error('не нашёл токен сокета в странице VK');
    let exp = Date.now() + 86400000;
    try { exp = JSON.parse(atob(m[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000 || exp; } catch (e) { }
    const info = {
        url: u ? u[1].replace(/\\u0026/g, '&') : 'wss://pubsub.live.vkvideo.ru/connection/websocket?cf_protocol_version=v2',
        token: m[1], channels: [...new Set(channels)], exp
    };
    await chrome.storage.session.set({ ext_vk_ws: info });
    return info;
}

// ---------- GM_xmlhttpRequest ----------
async function doXhr(req) {
    let host;
    try { host = new URL(req.url).hostname; } catch (e) { return { error: 'bad url' }; }
    if (!XHR_HOSTS.some(h => host === h || host.endsWith('.' + h))) return { error: 'host not allowed: ' + host };
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = req.timeout ? setTimeout(() => { timedOut = true; ctrl.abort(); }, req.timeout) : null;
    try {
        const r = await fetch(req.url, {
            method: req.method || 'GET',
            headers: req.headers || {},
            body: req.data == null || /^(GET|HEAD)$/i.test(req.method || 'GET') ? undefined : req.data,
            credentials: req.anonymous ? 'omit' : 'include',
            cache: 'no-store',
            signal: ctrl.signal
        });
        const text = await r.text();
        return {
            status: r.status, statusText: r.statusText, responseText: text, finalUrl: r.url,
            responseHeaders: [...r.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n')
        };
    } catch (e) {
        return { error: timedOut ? 'timeout' : String(e && e.message || e) };
    } finally {
        clearTimeout(timer);
    }
}

// Правила заголовков только для запросов самого расширения (не из вкладок):
//  1 — VK API ждёт запросы «с сайта»: Origin/Referer live.vkvideo.ru
//  2 — скрытым фреймам снимаем запрет на встраивание (X-Frame-Options / CSP frame-ancestors)
async function installHeaderRules() {
    const rules = [{
        id: 1,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            requestHeaders: [
                { header: 'origin', operation: 'set', value: 'https://live.vkvideo.ru' },
                { header: 'referer', operation: 'set', value: 'https://live.vkvideo.ru/' }
            ]
        },
        condition: { requestDomains: ['api.live.vkvideo.ru'], resourceTypes: ['xmlhttprequest', 'other'], tabIds: [chrome.tabs.TAB_ID_NONE] }
    }, {
        id: 2,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            responseHeaders: [
                { header: 'x-frame-options', operation: 'remove' },
                { header: 'content-security-policy', operation: 'remove' },
                { header: 'content-security-policy-report-only', operation: 'remove' }
            ]
        },
        condition: { requestDomains: ['kick.com', 'live.vkvideo.ru'], resourceTypes: ['sub_frame'], tabIds: [chrome.tabs.TAB_ID_NONE] }
    }];
    try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(r => r.id), addRules: rules }); }
    catch (e) { console.warn('[MergedChat] DNR', e); }
}

// ---------- обновления ----------
const isStoreInstall = () => 'update_url' in chrome.runtime.getManifest();

async function checkUpdate() {
    const current = chrome.runtime.getManifest().version;
    const info = { checked: Date.now(), current, latest: current, available: false, notes: '', store: isStoreInstall() };
    try {
        if (info.store) {
            const res = await chrome.runtime.requestUpdateCheck();
            if ((res.status || res) === 'update_available') { info.available = true; info.latest = res.version || '?'; }
        } else {
            const url = updateUrlOf(await loadSettings());
            if (!url) info.error = 'no-url';
            else {
                const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const manifest = await r.json();
                info.latest = String(manifest.version || '');
                info.notes = String(manifest.notes || '');
                info.available = compareVersions(info.latest, current) > 0;
            }
        }
    } catch (e) {
        info.error = String(e && e.message || e);
    }
    await chrome.storage.local.set({ ext_update: info });
    await chrome.action.setBadgeText({ text: info.available ? '↑' : '' });
    if (info.available) await chrome.action.setBadgeBackgroundColor({ color: '#2d8cff' });
    return info;
}

// страница ручного переноса из Tampermonkey — одна вкладка, повторно не плодим
async function openTransfer() {
    const url = chrome.runtime.getURL('transfer.html');
    const [tab] = await chrome.tabs.query({ url });
    if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => { });
    } else await chrome.tabs.create({ url, active: true });
    return true;
}

async function openUpdater(auto) {
    if (isStoreInstall()) {
        // из Web Store: Chrome скачает обновление сам, onUpdateAvailable перезапустит
        await chrome.runtime.requestUpdateCheck().catch(() => { });
        return;
    }
    await chrome.windows.create({
        url: chrome.runtime.getURL('updater.html'),
        type: 'popup', width: 520, height: 560, focused: true
    });
}

chrome.runtime.onUpdateAvailable.addListener(() => chrome.runtime.reload());

// ---------- события ----------
function setupAlarms() {
    chrome.alarms.create('mc-watchdog', { periodInMinutes: 0.5 });
    chrome.alarms.create('mc-update', { periodInMinutes: CONFIG.updateCheckMinutes, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async details => {
    setupAlarms();
    await installHeaderRules();
    if (details.reason === 'update') {
        // старые скрипты во вкладках отключились от расширения — перезагружаем (без фокуса)
        for (const t of await allTabs()) {
            const url = t.url || '';
            if (isFeedUrl(url) || helperOfUrl(url)) chrome.tabs.reload(t.id).catch(() => { });
        }
        await chrome.storage.local.set({ ext_just_updated: { from: details.previousVersion, to: chrome.runtime.getManifest().version, t: Date.now() } });
    }
    checkUpdate();
    serial(watchdog);
});

chrome.runtime.onStartup.addListener(() => {
    setupAlarms();
    installHeaderRules();
    checkUpdate();
});

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'mc-watchdog') serial(watchdog);
    if (alarm.name === 'mc-update') checkUpdate();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (!isFeedUrl(tab.url)) return;
    if (info.url || info.status === 'loading') toPopup(tab);
    if (info.status === 'complete') serial(watchdog); // чат открыли — сразу поднимаем сборщики
});
chrome.tabs.onRemoved.addListener(async tabId => {
    const s = await session();
    let changed = false;
    for (const n of Object.keys(s.owned)) if (s.owned[n] === tabId) { delete s.owned[n]; changed = true; }
    if (changed) await saveSession(s);
    // закрыли свою вкладку «показать» (например, после входа) — вернуть скрытый сборщик
    serial(watchdog);
});
chrome.windows.onRemoved.addListener(async windowId => {
    const s = await session();
    if (s.windowId === windowId) { s.windowId = null; await saveSession(s); }
});

// читатель VK сменил состояние — сразу обновляем статус, не дожидаясь сторожа
let vkStateTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
    const ch = area === 'local' && changes.ext_vk_direct;
    if (!ch || (ch.oldValue && ch.newValue && ch.oldValue.state === ch.newValue.state)) return;
    clearTimeout(vkStateTimer);
    vkStateTimer = setTimeout(() => serial(watchdog), 1500);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.target === 'offscreen') return false;
    const handlers = {
        'mc:xhr': () => doXhr(msg.req),
        'vk:wsinfo': () => vkWsInfo(!!msg.fresh).catch(async e => {
            await chrome.storage.session.remove('ext_vk_ws');
            return { error: String(e && e.message || e) };
        }),
        'tokens:sync': () => syncTokens(),
        'feed:hello': () => serial(watchdog),
        'helper:ensure': () => serial(() => ensureHelper(msg.name)),
        'helper:refresh': () => serial(() => ensureHelper(msg.name, { forceReload: true })),
        'helper:show': () => serial(() => showHelper(msg.name)),
        'helper:error': () => serial(() => onHelperError(msg, sender)),
        'helpers:restart': () => serial(restartAll).then(() => serial(watchdog)),
        'helpers:status': () => serial(watchdog),
        'feed:open': () => openFeed(),
        'transfer:open': () => openTransfer(),
        'update:check': () => checkUpdate(),
        'update:open': () => openUpdater(!!msg.auto)
    };
    const h = handlers[msg.type];
    if (!h) return false;
    Promise.resolve().then(h).then(
        r => reply(r === undefined ? { ok: true } : r),
        e => reply({ error: String(e && e.message || e) })
    );
    return true;
});

installHeaderRules();
