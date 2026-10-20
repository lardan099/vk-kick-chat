// Изолированный мир, document_start. Даёт chat.js то же окружение, что Tampermonkey:
// GM_getValue/GM_setValue (синхронные, поверх chrome.storage.local с кэшем),
// GM_addValueChangeListener (между вкладками), GM_xmlhttpRequest (через background),
// плюс MC_EXT — мост к фоновым вкладкам и page-hook.js.
(() => {
    'use strict';
    // метка для юзерскрипта в Tampermonkey: расширение стоит — ему запускаться не надо
    try { document.documentElement.dataset.mcExt = '1'; } catch (e) { }
    // Во фреймах работаем только как скрытый сборщик внутри расширения (offscreen.html),
    // а не в каждом iframe, который сайт вставил себе сам
    if (window !== window.top) {
        const anc = location.ancestorOrigins;
        if (!anc || !anc.length || anc[anc.length - 1] !== 'chrome-extension://' + chrome.runtime.id) {
            globalThis.MC_EXT = { skip: true, isFeed: false, ready: Promise.resolve() };
            return;
        }
    }
    const IS_FEED = location.hostname === 'kick.com' && location.hash.includes('feed') && window === window.top;
    // Скрытый фрейм-читатель VK: страница с адреса VK (честный Origin для сокета), но без приложения VK
    const IS_VK_DIRECT = location.hostname === 'live.vkvideo.ru' && location.hash.includes('mc-direct') && window !== window.top;
    // Виджет и читатель рисуют/делают всё сами — останавливаем загрузку сайта, пока его скрипты не скачались
    if (IS_FEED || IS_VK_DIRECT) { try { window.stop(); } catch (e) { } }
    // диагностика: фрейм-читатель VK ожил (воркер покажет, на каком шаге он застрял, если дальше не пойдёт)
    if (IS_VK_DIRECT) chrome.storage.local.set({ ext_vk_direct: { state: 'boot', t: Date.now() } }).catch(() => { });

    const cache = Object.create(null);
    const cacheJson = Object.create(null); // JSON последнего известного значения (лениво)
    const pending = Object.create(null);   // наши записи, чьё onChanged ещё не пришло
    const listeners = new Map();           // key -> Map(id -> fn)
    let listenerSeq = 0;
    let alive = true;

    const jsonOf = key => {
        if (!(key in cacheJson)) cacheJson[key] = key in cache ? JSON.stringify(cache[key]) : undefined;
        return cacheJson[key];
    };
    const copy = v => (v === null || typeof v !== 'object') ? v : structuredClone(v);
    const dead = e => /context invalidated/i.test(String(e && e.message || e));

    const ready = chrome.storage.local.get(null).then(all => {
        Object.assign(cache, all);
        importFromUserscript();
    }).catch(e => console.warn('[MergedChat ext] storage load failed', e));

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        for (const key of Object.keys(changes)) {
            const ch = changes[key];
            const p = pending[key];
            let remote = true;
            if (p && p.length) {
                const json = ch.newValue === undefined ? undefined : JSON.stringify(ch.newValue);
                const i = p.findIndex(x => x.json === json);
                if (i >= 0) { p.splice(0, i + 1); remote = false; }
                else p.length = 0;
            }
            // своя запись: в кэше уже это значение или более новое — не трогаем
            if (remote) {
                if (ch.newValue === undefined) delete cache[key];
                else cache[key] = ch.newValue;
                delete cacheJson[key];
            }
            const subs = listeners.get(key);
            if (!subs || !subs.size) continue;
            for (const fn of [...subs.values()]) {
                try { fn(key, copy(ch.oldValue), copy(ch.newValue), remote); } catch (e) { console.error(e); }
            }
        }
    });

    // ---------- переезд из Tampermonkey ----------
    // Юзерскрипт 6.43+ оставляет свои настройки в localStorage kick.com (mc_tm_export_v1).
    // Забираем их до старта чата: переименования и т.п. сливаем (наше важнее), остальное — если у нас пусто.
    function importFromUserscript() {
        if (location.hostname !== 'kick.com' || window !== window.top) return;
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem('mc_tm_export_v1') || 'null'); } catch (e) { }
        if (!raw || !raw.data || typeof raw.data !== 'object') return;
        const done = cache.ext_tm_import;
        if (done && done.t >= raw.t) return;
        const MERGE = ['mc_local_user_aliases_v1', 'mc_highlighted_users_v1', 'mc_user_colors', 'mc_privileged_chat_users_v1', 'mc_current_chat_users_v1'];
        const count = v => v && typeof v === 'object' ? Object.keys(v).length : 0;
        let aliases = 0;
        for (const [k, v] of Object.entries(raw.data)) {
            if (MERGE.includes(k) && v && typeof v === 'object' && !Array.isArray(v)) {
                GM_setValue(k, { ...v, ...(cache[k] || {}) });
                if (k === 'mc_local_user_aliases_v1') aliases = count(v);
            } else if (!(k in cache)) GM_setValue(k, v);
        }
        GM_setValue('ext_tm_import', { t: raw.t, aliases, at: Date.now() });
        console.log('[MergedChat ext] перенесено из Tampermonkey:', Object.keys(raw.data), 'переименований:', aliases);
    }

    function GM_getValue(key, def) {
        return key in cache ? copy(cache[key]) : def;
    }
    function GM_setValue(key, value) {
        if (value === undefined) return GM_deleteValue(key);
        const json = JSON.stringify(value);
        if (json === jsonOf(key)) return;
        cache[key] = JSON.parse(json);
        cacheJson[key] = json;
        const now = Date.now();
        const p = pending[key] || (pending[key] = []);
        while (p.length && now - p[0].t > 10000) p.shift();
        p.push({ json, t: now });
        if (!alive) return;
        chrome.storage.local.set({ [key]: cache[key] }).catch(e => { if (dead(e)) alive = false; });
    }
    function GM_deleteValue(key) {
        if (!(key in cache)) return;
        delete cache[key];
        cacheJson[key] = undefined;
        const p = pending[key] || (pending[key] = []);
        p.push({ json: undefined, t: Date.now() });
        if (alive) chrome.storage.local.remove(key).catch(e => { if (dead(e)) alive = false; });
    }
    function GM_addValueChangeListener(key, fn) {
        const id = ++listenerSeq;
        if (!listeners.has(key)) listeners.set(key, new Map());
        listeners.get(key).set(id, fn);
        return id;
    }
    function GM_removeValueChangeListener(id) {
        for (const subs of listeners.values()) subs.delete(id);
    }

    function send(type, data = {}) {
        if (!alive) return Promise.reject(new Error('Расширение обновилось — перезагрузи вкладку'));
        return chrome.runtime.sendMessage({ type, ...data }).catch(e => {
            if (dead(e)) alive = false;
            throw e;
        });
    }

    function GM_xmlhttpRequest(d) {
        let aborted = false;
        const req = {
            method: d.method || 'GET',
            url: String(d.url),
            headers: d.headers || {},
            data: d.data == null ? null : String(d.data),
            timeout: d.timeout || 0,
            anonymous: !!d.anonymous
        };
        send('mc:xhr', { req }).then(res => {
            if (aborted) return;
            if (!res || res.error) {
                const r = { status: 0, statusText: res && res.error || 'error', responseText: '', readyState: 4, finalUrl: req.url };
                if (res && res.error === 'timeout') (d.ontimeout || d.onerror || (() => { }))(r);
                else (d.onerror || (() => { }))(r);
                return;
            }
            const r = {
                status: res.status, statusText: res.statusText, readyState: 4,
                responseText: res.responseText, responseHeaders: res.responseHeaders, finalUrl: res.finalUrl
            };
            if (d.responseType === 'json') { try { r.response = JSON.parse(res.responseText); } catch (e) { r.response = null; } }
            else r.response = res.responseText;
            try { d.onload && d.onload(r); } catch (e) { console.error(e); }
        }, e => {
            if (!aborted && d.onerror) d.onerror({ status: 0, statusText: String(e && e.message || e), responseText: '', readyState: 4 });
        });
        return { abort() { aborted = true; } };
    }

    // ---------- мост от page-hook.js ----------
    const wsHandlers = [], hdrHandlers = [];
    const wsBuffer = [], hdrBuffer = [];
    document.addEventListener('mc-ext:ws', e => {
        let m; try { m = JSON.parse(e.detail); } catch (err) { return; }
        if (!wsHandlers.length) { if (wsBuffer.length < 500) wsBuffer.push(m); return; }
        for (const h of wsHandlers) { try { h(m.d, m.u); } catch (err) { } }
    });
    document.addEventListener('mc-ext:hdr', e => {
        let m; try { m = JSON.parse(e.detail); } catch (err) { return; }
        if (!hdrHandlers.length) { if (hdrBuffer.length < 200) hdrBuffer.push(m); return; }
        for (const h of hdrHandlers) { try { h(m.u, m.h); } catch (err) { } }
    });

    // ---------- самодиагностика сборщика: при ошибке просим воркер перезагрузить эту страницу ----------
    const reported = new Set();
    function reportError(reason) {
        if (IS_FEED || reported.has(reason)) return;
        reported.add(reason);
        console.warn('[MergedChat ext] сборщик сломался:', reason);
        send('helper:error', { reason }).catch(() => { });
    }
    const bootAt = Date.now();
    // при прямом чтении VK страница VK не сборщик — следить за её сокетом незачем
    const vkPageIsCollector = () => !((cache.ext_settings || {}).placement === 'hidden' || !(cache.ext_settings || {}).placement);
    if (!IS_FEED && !IS_VK_DIRECT && location.hostname.endsWith('vkvideo.ru')) ready.then(() => { if (vkPageIsCollector()) watchVkSocket(); });
    function watchVkSocket() {
        // сообщения VK идут только через pubsub-сокет страницы: нет сокета — нет чата
        let openCount = 0, everOpen = false, downTimer = null;
        document.addEventListener('mc-ext:wsstate', e => {
            let m; try { m = JSON.parse(e.detail); } catch (err) { return; }
            if (!String(m.u).includes('pubsub.live.vkvideo.ru')) return;
            if (m.s === 'open') { openCount++; everOpen = true; clearTimeout(downTimer); downTimer = null; return; }
            openCount = Math.max(0, openCount - 1);
            if (!openCount && !downTimer) downTimer = setTimeout(() => {
                if (!openCount) reportError('VK WebSocket закрылся и не переподключился за 30 с');
            }, 30000);
        });
        setTimeout(() => { if (!everOpen) reportError('VK WebSocket не подключился за 60 с'); }, 60000);
    }
    if (!IS_FEED) {
        // не догрузились скрипты сайта (обрыв сети, CDN) — страница мёртвая, нужна перезагрузка
        let failTimer = null;
        document.addEventListener('error', e => {
            const t = e.target;
            if (!t || t.tagName !== 'SCRIPT' || !t.src || Date.now() - bootAt > 120000) return;
            clearTimeout(failTimer);
            failTimer = setTimeout(() => reportError('не загрузился скрипт ' + String(t.src).slice(0, 80)), 3000);
        }, true);
    }

    // ---------- прямое чтение VK (скрытый режим): свой сокет к pubsub VK из виджета ----------
    // Origin live.vkvideo.ru подставляет правило declarativeNetRequest в background.js.
    const extSettings = () => cache.ext_settings || {};
    const directVkEnabled = () => IS_VK_DIRECT;
    const vkDirect = (() => {
        const me = Math.random().toString(36).slice(2);
        const OWNER_KEY = 'ext_vk_direct_owner';
        let ws = null, info = null, retry = 2000, started = false, retryTimer = null, fresh = false, lastMsg = 0;
        const state = (s, extra = {}) => GM_setValue('ext_vk_direct', { state: s, t: Date.now(), ...extra });
        // одно окно чата держит сокет, остальные ждут (иначе два писателя путают очередь VK)
        const isOwner = () => { const o = cache[OWNER_KEY]; return !o || o.id === me || Date.now() - o.t > 25000; };
        const claim = () => GM_setValue(OWNER_KEY, { id: me, t: Date.now() });
        const dispatch = d => { for (const h of wsHandlers) { try { h(d, info.url); } catch (e) { } } };
        async function connect() {
            clearTimeout(retryTimer); retryTimer = null;
            if (ws || !alive || !isOwner()) return;
            claim();
            state('connecting');
            try {
                if (!info) { info = await send('vk:wsinfo', { fresh }); fresh = false; }
                if (!info || info.error) throw new Error(info && info.error || 'нет данных для сокета');
            } catch (e) { info = null; state('error', { error: String(e.message || e) }); return schedule(); }
            const sock = new WebSocket(info.url);
            ws = sock;
            let id = 1;
            sock.onopen = () => {
                lastMsg = Date.now();
                sock.send(JSON.stringify({ connect: { token: info.token, name: 'js' }, id: id++ }));
                info.channels.forEach(channel => sock.send(JSON.stringify({ subscribe: { channel }, id: id++ })));
            };
            sock.onmessage = e => {
                lastMsg = Date.now();
                const d = typeof e.data === 'string' ? e.data : '';
                const lines = d.split('\n').filter(Boolean);
                if (lines.some(l => l.trim() === '{}')) { try { sock.send('{}'); } catch (err) { } } // ping → pong
                if (/"id":1,"connect"/.test(d)) { retry = 2000; state('open'); }
                if (/"id":1,"error"/.test(d)) { info = null; fresh = true; state('error', { error: 'токен сокета отклонён' }); try { sock.close(); } catch (err) { } return; }
                if (lines.every(l => l.trim() === '{}')) return;
                dispatch(d);
            };
            sock.onclose = () => { if (ws === sock) ws = null; state('closed'); schedule(); };
            sock.onerror = () => { try { sock.close(); } catch (err) { } };
        }
        function schedule() {
            if (retryTimer) return;
            retryTimer = setTimeout(connect, retry);
            retry = Math.min(30000, Math.round(retry * 1.7));
        }
        return {
            start() {
                if (started) return;
                started = true;
                connect();
                // держим «замок» и подхватываем сокет, если окно-владелец закрылось
                setInterval(() => {
                    if (!isOwner()) return;
                    claim();
                    if (!ws && !retryTimer) connect();
                    // сервер пингует каждые 25 с: тишина дольше 75 с — сокет мёртв, переподключаемся
                    else if (ws && ws.readyState === 1 && Date.now() - lastMsg > 75000) { try { ws.close(); } catch (e) { } }
                }, 8000);
                window.addEventListener('pagehide', () => { if ((cache[OWNER_KEY] || {}).id === me) GM_deleteValue(OWNER_KEY); });
            },
            reconnect() {
                info = null; fresh = true; retry = 2000;
                if (ws) { try { ws.close(); } catch (e) { } } else connect();
            }
        };
    })();


    const MC_EXT = {
        isFeed: IS_FEED,
        reportError,
        get directVk() {
            if (!directVkEnabled()) return false;
            vkDirect.start(); // chat.js сейчас зарегистрирует обработчик кадров (installWsTap)
            return true;
        },
        // включён скрытый режим с прямым чтением VK (для страниц VK: не быть вторым сборщиком)
        get directVkMode() { return !vkPageIsCollector() && !(extSettings().helpers && extSettings().helpers.vk === false); },
        syncTokens: () => send('tokens:sync').catch(() => null),
        version: chrome.runtime.getManifest().version,
        ready,
        send,
        get alive() { return alive; },
        onWsFrame(fn) {
            wsHandlers.push(fn);
            wsBuffer.splice(0).forEach(m => { try { fn(m.d, m.u); } catch (e) { } });
        },
        onRequestHeaders(fn) {
            hdrHandlers.push(fn);
            hdrBuffer.splice(0).forEach(m => { try { fn(m.u, m.h); } catch (e) { } });
        },
        ensureHelper: name => send('helper:ensure', { name }).catch(() => null),
        refreshHelper: name => send('helper:refresh', { name }).catch(() => null),
        showHelper: name => send('helper:show', { name }).catch(() => null)
    };

    Object.assign(globalThis, {
        MC_EXT,
        unsafeWindow: window,
        GM_getValue, GM_setValue, GM_deleteValue,
        GM_addValueChangeListener, GM_removeValueChangeListener,
        GM_xmlhttpRequest,
        GM_info: { script: { name: 'Merged Chat', version: MC_EXT.version }, scriptHandler: 'MergedChat extension' }
    });
})();
