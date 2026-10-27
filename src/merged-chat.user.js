// ==UserScript==
// @name         Merged Chat (Kick + VK Play Live)
// @namespace    grpzdc.mergedchat
// @version      6.59
// @description  Перехватывает WebSocket реальных чатов Kick и VK Play Live, собирает все сообщения и рисует единую ленту своим дизайном. Сохраняет весь функционал родных чатов (авторизация, бан и т.д.).
// @match        https://kick.com/popout/*/chat*
// @match        https://dashboard.kick.com/*
// @match        https://live.vkvideo.ru/*/only-chat*
// @match        https://live.vkvideo.ru/*/stream/*only-chat*
// @match        https://live.vkvideo.ru/*/studio*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      api.live.vkvideo.ru
// @connect      7tv.io
// @connect      pzdcflix.live
// @downloadURL https://update.greasyfork.org/scripts/580853/Merged%20Chat%20%28Kick%20%2B%20VK%20Play%20Live%29.user.js
// @updateURL https://update.greasyfork.org/scripts/580853/Merged%20Chat%20%28Kick%20%2B%20VK%20Play%20Live%29.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // РЕЖИМ СТРАНИЦЫ
    //   #feed в URL  -> страница-ВИДЖЕТ (рисует общую ленту)
    //   kick.com     -> сборщик Kick
    //   vkvideo      -> сборщик VK Play Live
    // Чтобы открыть виджет: добавь #feed к адресу Kick-попаута, напр.:
    //   https://kick.com/popout/grpzdc/chat#feed
    // ============================================================
    const IS_FEED = location.hash.includes('feed');
    const HOST = location.hostname;

    // ---- КОНФИГ КАНАЛА (для модерки Kick) ----
    const KICK_SLUG = 'grpzdc';
    const KICK_CHANNEL_ID = 713405;
    const KICK_CHATROOM_ID = 713152;
    const VK_DOM_FALLBACK = false;
    const VK_ICON_URL = 'https://images.live.vkvideo.ru/smile/42502cfe-8cf9-4f13-aaa3-4f100359b6d1/icon/size/medium?change_time=1764532236';
    const REPLY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/></svg>';
    const KICK_ICON_URL = 'https://www.google.com/s2/favicons?domain=kick.com&sz=64';
    const SITE_ONLINE_URL = 'https://pzdcflix.live/api/online';
    const SITE_ICON_URL = 'https://cdn.7tv.app/emote/01F6QWHR20000EB9BSAR8G1DKZ/4x.avif';
    // 10.2026: Kick сменил ключ Pusher (старый 32cbd69e… отвечает 4001 «not in this cluster»)
    // и теперь выдаёт его через web.kick.com/api/v1/realtime/.../chat/connection.
    // Сам сайт по умолчанию ходит в Centrifugo, Pusher отдаётся, только если просить его одного.
    const KICK_PUSHER_FALLBACK = { app_key: '34bf7a0ff419a2a775b9', cluster: 'us2' };
    const KICK_PUSHER_CFG_KEY = 'mc_kick_pusher_cfg';

    // Общий «эфир» между вкладками. У каждой платформы своя очередь, чтобы
    // два сборщика не перетирали друг друга. Виджет слушает обе.
    const Q_KEYS = { kick: 'mc_q_kick', vk: 'mc_q_vk' };
    const SEQ_KEYS = { kick: 'mc_seq_kick', vk: 'mc_seq_vk' };
    const COLLECTOR_HEARTBEAT_KEYS = { kick: 'mc_collector_kick_heartbeat', vk: 'mc_collector_vk_heartbeat' };
    const COLLECTOR_OPEN_ATTEMPT_KEYS = { kick: 'mc_collector_kick_open_attempt', vk: 'mc_collector_vk_open_attempt' };
    const COLLECTOR_PROBE_KEY = 'mc_collector_probe';
    const COLLECTOR_RELOAD_KEY = 'mc_collector_reload';
    const KICK_AUTH_HEARTBEAT_KEY = 'mc_kick_auth_heartbeat';
    const KICK_AUTH_PROBE_KEY = 'mc_kick_auth_probe';
    const KICK_AUTH_RELOAD_KEY = 'mc_kick_auth_reload';
    const KICK_AUTH_OPEN_ATTEMPT_KEY = 'mc_kick_auth_open_attempt';
    const TOKEN_KEY = 'mc_kick_token';   // Bearer-токен Kick, перехваченный из запросов дашборда
    const VK_TOKEN_KEY = 'mc_vk_token';
    const VK_HEADERS_KEY = 'mc_vk_headers';
    const VK_DEBUG_KEY = 'mc_vk_debug';
    const META_KEY = 'mc_meta';
    const USER_COLORS_KEY = 'mc_user_colors';
    const LOCAL_ALIASES_KEY = 'mc_local_user_aliases_v1';
    const HIGHLIGHT_USERS_KEY = 'mc_highlighted_users_v1';
    const SEVENTV_CACHE_KEY = 'mc_7tv_emotes';
    const CHAT_TEMPLATES_KEY = 'mc_chat_templates_v1';
    const CURRENT_USERS_KEY = 'mc_current_chat_users_v1';
    const PRIVILEGED_USERS_KEY = 'mc_privileged_chat_users_v1';
    const PLATFORMS_KEY = 'mc_platforms_enabled_v1'; // { kick:bool, vk:bool } — какие чаты включены (общий для всех вкладок)
    const SEVENTV_CACHE_TTL = 6 * 60 * 60 * 1000;
    const QUEUE_CAP = 120;
    const KICK_MAX_TIMEOUT_MINUTES = 10080;
    const DEFAULT_CHAT_TEMPLATES = [{
        title: 'Верховная рада',
        vkText: 'ВЕРХОВНАЯ РАДА c гайдом по тг, записью стримов +комменты в основе :zhmilJamba: на 1, 3, 6, 12 месяцев (400р/месяц) +НИК ИЗ ТГ через "@" +ЗАПУСТИТЕ БОТА https://t.me/vipgrpzdc_bot :grpzdcPUZ: https://new.donatepay.ru/@GRPZDC',
        kickText: 'ВЕРХОВНАЯ РАДА c гайдом по тг, записью стримов +комменты в основе [emote:51522:grpzdcXDD] на 1, 3, 6, 12 месяцев (400р/месяц) +НИК ИЗ ТГ через "@" +ЗАПУСТИТЕ БОТА https://t.me/vipgrpzdc_bot [emote:51529:grpzdcCL] https://new.donatepay.ru/@GRPZDC'
    }];
    // Палитра ников VK — та же, что в коде live.vkvideo.ru: nickColor — номер 0–15,
    // без номера VK берёт цвет по хешу ника (тот же хеш, что у них)
    const VK_NICK_COLORS = ['#D66E34','#B8AAFF','#1D90FF','#9961F9','#59A840','#E73629','#DE6489','#20BBA1',
        '#F8B301','#0099BB','#7BBEFF','#E542FF','#A36C59','#8BA259','#00A9FF','#A20BFF'];
    function vkColorCode(code) {
        const n = code === '' || code === null || code === undefined ? NaN : Number(code);
        return Number.isInteger(n) && n >= 0 && n < VK_NICK_COLORS.length ? n : -1;
    }
    function vkNickColor(code, nick = '') {
        const n = vkColorCode(code);
        if (n >= 0) return VK_NICK_COLORS[n];
        if (!nick) return '';
        const hash = String(nick).split('').reduce((h, ch) => { h = (h << 5) - h + ch.charCodeAt(0); return h & h; }, 0);
        return VK_NICK_COLORS[Math.min(VK_NICK_COLORS.length - 1, Math.floor(Math.abs(hash) / (2147483647 / VK_NICK_COLORS.length)))];
    }

    // Отключать можно только одну платформу: если обе выключены (ручная правка
    // хранилища), считаем включёнными обе, иначе лента молча опустеет.
    function normalizePlatforms(value) {
        const v = value && typeof value === 'object' ? value : {};
        const out = { kick: v.kick !== false, vk: v.vk !== false };
        return out.kick || out.vk ? out : { kick: true, vk: true };
    }
    function platformSettings() {
        return normalizePlatforms(GM_getValue(PLATFORMS_KEY, null));
    }
    function broadcast(platform, msg) {
        // отключённая в виджете платформа: сборщик не гоняет её сообщения через очередь.
        // Удаления пропускаем — они зачёркивают уже нарисованные (скрытые) строки.
        if (!platformSettings()[platform] && msg.type !== 'delete') return;
        const seq = (GM_getValue(SEQ_KEYS[platform], 0) || 0) + 1;
        GM_setValue(SEQ_KEYS[platform], seq);
        msg._seq = seq;
        const q = GM_getValue(Q_KEYS[platform], []);
        q.push(msg);
        while (q.length > QUEUE_CAP) q.shift();
        GM_setValue(Q_KEYS[platform], q);
    }
    function startCollectorHeartbeat(platform) {
        const heartbeat = () => GM_setValue(COLLECTOR_HEARTBEAT_KEYS[platform], Date.now());
        heartbeat();
        setInterval(heartbeat, 30000);
        GM_addValueChangeListener(COLLECTOR_PROBE_KEY, heartbeat);
    }
    function startKickAuthCollector() {
        captureKickToken();
        const heartbeat = () => GM_setValue(KICK_AUTH_HEARTBEAT_KEY, Date.now());
        heartbeat();
        setInterval(heartbeat, 30000);
        GM_addValueChangeListener(KICK_AUTH_PROBE_KEY, heartbeat);
        console.log('[MergedChat] Kick dashboard auth collector started');
    }
    function vkDebug(state, data = {}) {
        try {
            GM_setValue(VK_DEBUG_KEY, { t: Date.now(), state, data });
        } catch (e) { }
    }
    function setMeta(partial) {
        try {
            GM_setValue(META_KEY, Object.assign({}, GM_getValue(META_KEY, {}) || {}, partial));
        } catch (e) { }
    }
    function userColorKey(platform, name, userId='') {
        return `${platform}:${userId || String(name || '').toLowerCase()}`;
    }
    function getUserColor(platform, name, userId='') {
        const colors = GM_getValue(USER_COLORS_KEY, {}) || {};
        return colors[userColorKey(platform, name, userId)] || colors[userColorKey(platform, name, '')] || '';
    }
    function rememberUserColor(platform, name, userId, color) {
        if(!color) return;
        const colors = GM_getValue(USER_COLORS_KEY, {}) || {};
        if(colors[userColorKey(platform, name, userId)] === color && colors[userColorKey(platform, name, '')] === color) return;
        colors[userColorKey(platform, name, userId)] = color;
        colors[userColorKey(platform, name, '')] = color;
        GM_setValue(USER_COLORS_KEY, colors);
    }
    function getUserHighlight(platform, name, userId='') {
        const map = GM_getValue(HIGHLIGHT_USERS_KEY, {}) || {};
        return map[userColorKey(platform, name, userId)] || map[userColorKey(platform, name, '')] || '';
    }
    function saveUserHighlight(platform, name, userId, color) {
        const map = GM_getValue(HIGHLIGHT_USERS_KEY, {}) || {};
        const keys = [userColorKey(platform, name, userId), userColorKey(platform, name, '')];
        keys.forEach(key => {
            if(color) map[key] = color;
            else delete map[key];
        });
        GM_setValue(HIGHLIGHT_USERS_KEY, map);
    }
    function localAliasKey(platform, name, userId='') {
        // Ник уникален внутри платформы; ключ по нику позволяет одинаково
        // переименовать сообщения, ответы и упоминания, где userId бывает пустым.
        return `${platform}:${String(name || '').trim().toLowerCase()}`;
    }
    function getLocalAlias(platform, name, userId='') {
        const aliases = GM_getValue(LOCAL_ALIASES_KEY, {}) || {};
        return aliases[localAliasKey(platform, name, userId)]
            || aliases[localAliasKey(platform, name, '')]
            || '';
    }
    function saveLocalAlias(platform, name, userId, alias) {
        const aliases = GM_getValue(LOCAL_ALIASES_KEY, {}) || {};
        const value = String(alias || '').trim();
        const keys = [localAliasKey(platform, name, userId), localAliasKey(platform, name, '')];
        keys.forEach(key => {
            if(value) aliases[key] = value;
            else delete aliases[key];
        });
        GM_setValue(LOCAL_ALIASES_KEY, aliases);
    }
    function cleanChatText(value) {
        return String(value || '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n');
    }
    function formatModerationDuration(minutes) {
        const n = Math.max(1, Math.round(Number(minutes) || 0));
        if(n % 10080 === 0) return `${n / 10080} нед.`;
        if(n % 1440 === 0) return `${n / 1440} дн.`;
        if(n % 60 === 0) return `${n / 60} ч.`;
        return `${n} мин.`;
    }
    function kickModerationInfo(eventName, data={}) {
        const event = String(eventName || '').toLowerCase();
        const user = data?.user || data?.banned_user || data?.bannedUser || data?.sender || {};
        const moderator = data?.moderator || data?.created_by || data?.createdBy || {};
        const name = user.username || user.name || data?.username || data?.banned_username || '???';
        const userId = user.id || user.user_id || data?.user_id || data?.banned_user_id || data?.bannedUserId || '';
        const actor = moderator.username || moderator.name || data?.moderator_username || data?.created_by_username || '';
        if(/unban|unmute/.test(event)) return { name, userId, actor, action:'ограничение снято' };
        const temporary = /timeout/.test(event)
            || data?.permanent === false || data?.isPermanent === false
            || data?.is_temporary === true || data?.isTemporary === true
            || !!(data?.expires_at || data?.expiresAt);
        if(!temporary) return { name, userId, actor, action:'бан' };
        let minutes = Number(data?.duration_minutes ?? data?.durationMinutes ?? data?.duration ?? 0);
        if(!minutes && (data?.expires_at || data?.expiresAt)) {
            const expires = Date.parse(data.expires_at || data.expiresAt);
            if(Number.isFinite(expires)) minutes = Math.max(1, Math.round((expires - Date.now()) / 60000));
        }
        return { name, userId, actor, action:`тайм-аут${minutes > 0 ? ' на ' + formatModerationDuration(minutes) : ''}` };
    }
    function compactTextPart(value) {
        const text = cleanChatText(value);
        return text.trim() ? text : '';
    }
    function sevenTvRequest(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'json',
                timeout: 10000,
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`7TV HTTP ${response.status}`));
                        return;
                    }
                    try {
                        resolve(typeof response.response === 'string'
                            ? JSON.parse(response.response)
                            : response.response);
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: reject,
                ontimeout: () => reject(new Error('7TV request timed out'))
            });
        });
    }
    function sevenTvEmoteUrl(emote) {
        const data = emote?.data || emote || {};
        const host = data.host || {};
        const files = Array.isArray(host.files) ? host.files : [];
        const file = files.find(f => f.name === '2x.webp')
            || files.filter(f => f.format === 'WEBP' || /\.webp$/i.test(f.name || '')).sort((a, b) => (b.width || 0) - (a.width || 0))[0]
            || files.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
        if (host.url && file?.name) {
            const base = String(host.url).startsWith('//') ? 'https:' + host.url : host.url;
            return `${base}/${file.name}`;
        }
        const id = data.id || emote?.id;
        return id ? `https://cdn.7tv.app/emote/${id}/2x.webp` : '';
    }
    function addSevenTvSet(target, payload) {
        const emotes = payload?.emote_set?.emotes || payload?.emotes || [];
        emotes.forEach(emote => {
            const name = emote?.name || emote?.data?.name || '';
            const url = sevenTvEmoteUrl(emote);
            if (name && url) target.set(name, url);
        });
    }

    // ============================================================
    // ПЕРЕХВАТ WEBSOCKET (только в режиме сборщика)
    // ============================================================
    const _wsHandlers = [];
    function installWsTap(onFrame) {
        // В расширении WebSocket страницы подменяет page-hook.js (мир страницы), кадры приходят через MC_EXT
        if (typeof MC_EXT !== 'undefined') { MC_EXT.onWsFrame(onFrame); return; }
        _wsHandlers.push(onFrame);
        const W = unsafeWindow || window;
        const Native = W.WebSocket;
        if (!Native || Native.__mcTapped) return; // перехват уже стоит — добавили обработчик и хватит

        const Tapped = function (url, protocols) {
            const ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
            try {
                ws.addEventListener('message', ev => {
                    for (const h of _wsHandlers) { try { h(ev.data, url); } catch (e) { /* не мешаем странице */ } }
                });
            } catch (e) { }
            return ws;
        };
        Tapped.prototype = Native.prototype;
        Tapped.CONNECTING = Native.CONNECTING;
        Tapped.OPEN = Native.OPEN;
        Tapped.CLOSING = Native.CLOSING;
        Tapped.CLOSED = Native.CLOSED;
        Tapped.__mcTapped = true;
        W.WebSocket = Tapped;
        console.log('%c[MergedChat] WebSocket-перехват установлен на ' + HOST, 'color:#53fc18');
    }

    // ============================================================
    // ПРЯМОЕ ПОДКЛЮЧЕНИЕ К PUSHER KICK (ключ берём у самого Kick)
    // ============================================================
    async function fetchKickPusherConfig() {
        try {
            const r = await fetch(`https://web.kick.com/api/v1/realtime/channels/${KICK_CHANNEL_ID}/chat/connection`, {
                method: 'POST',
                credentials: 'omit',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({
                    client: { id: crypto.randomUUID(), type: 'web' },
                    capabilities: { accepted_providers: [{ provider: 'pusher' }] }
                })
            });
            const j = await r.json();
            const conn = (j?.data?.connections || []).find(c => c?.provider === 'pusher');
            const c = conn?.credentials;
            if (c?.app_key && c?.cluster) {
                const cfg = { app_key: String(c.app_key), cluster: String(c.cluster) };
                GM_setValue(KICK_PUSHER_CFG_KEY, cfg);
                return cfg;
            }
            console.warn('[MergedChat] Kick realtime: pusher не выдан', j);
        } catch (e) {
            console.warn('[MergedChat] Kick realtime config error', e);
        }
        return GM_getValue(KICK_PUSHER_CFG_KEY, null) || KICK_PUSHER_FALLBACK;
    }
    // onRaw получает сырые кадры Pusher (строки) — тот же формат, что ловил перехват WebSocket.
    function openKickPusher(onRaw, tag) {
        let ws = null;
        let retry = 1000;
        let closedByUs = false;
        let cfg = GM_getValue(KICK_PUSHER_CFG_KEY, null);
        const connect = async () => {
            if (closedByUs) return;
            if (!cfg) cfg = await fetchKickPusherConfig();
            const url = `wss://ws-${cfg.cluster}.pusher.com/app/${cfg.app_key}?protocol=7&client=js&version=8.5.0&flash=false`;
            try { ws = new WebSocket(url); } catch (e) { schedule(); return; }
            ws.addEventListener('open', () => {
                ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${KICK_CHATROOM_ID}.v2` } }));
            });
            ws.addEventListener('message', e => {
                if (typeof e.data !== 'string') return;
                let ev;
                try { ev = JSON.parse(e.data); } catch { return; }
                if (ev.event === 'pusher:ping') {
                    try { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch (err) { }
                    return;
                }
                if (ev.event === 'pusher_internal:subscription_succeeded') {
                    retry = 1000;
                    console.log(`[MergedChat] Kick Pusher (${tag}) подключён, ключ ${cfg.app_key}`);
                    return;
                }
                if (ev.event === 'pusher:error') {
                    let d = ev.data;
                    try { if (typeof d === 'string') d = JSON.parse(d); } catch { }
                    console.warn(`[MergedChat] Kick Pusher (${tag}) error`, d);
                    // 4000–4099: неверный ключ/кластер — перезапрашиваем у Kick
                    if (d?.code >= 4000 && d?.code < 4100) { cfg = null; GM_setValue(KICK_PUSHER_CFG_KEY, null); }
                    return;
                }
                onRaw(e.data);
            });
            ws.addEventListener('close', schedule);
            ws.addEventListener('error', () => {
                try { ws.close(); } catch (e) { }
            });
        };
        const schedule = () => {
            if (closedByUs) return;
            const delay = retry;
            retry = Math.min(15000, Math.floor(retry * 1.7));
            setTimeout(connect, delay);
        };
        window.addEventListener('beforeunload', () => { closedByUs = true; try { ws?.close(); } catch (e) { } });
        connect();
    }

    // ---------- утилита: рекурсивный поиск объекта по предикату ----------
    function deepFind(obj, pred, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 6) return null;
        if (pred(obj)) return obj;
        for (const k in obj) {
            const v = obj[k];
            if (v && typeof v === 'object') {
                const r = deepFind(v, pred, depth + 1);
                if (r) return r;
            }
        }
        return null;
    }

    // ============================================================
    // ПЕРЕХВАТ BEARER-ТОКЕНА KICK из запросов страницы (для модерки).
    // Дашборд сам шлёт авторизованные запросы к kick.com/api — забираем токен.
    // ============================================================
    function captureKickToken() {
        const W = unsafeWindow || window;
        const headerMap = (headers) => {
            const out = {};
            if (!headers) return out;
            try {
                if (headers instanceof Headers || typeof headers.get === 'function') {
                    headers.forEach((v, k) => out[String(k).toLowerCase()] = String(v));
                } else if (Array.isArray(headers)) {
                    headers.forEach(h => { if (h) out[String(h[0]).toLowerCase()] = String(h[1]); });
                } else if (typeof headers.forEach === 'function') {
                    headers.forEach((v, k) => out[String(k).toLowerCase()] = String(v));
                } else if (typeof headers === 'object') {
                    Object.keys(headers).forEach(k => out[String(k).toLowerCase()] = String(headers[k]));
                }
            } catch (e) { }
            return out;
        };
        const storeVk = (url, headers) => {
            if (!String(url || '').includes('api.live.vkvideo.ru')) return;
            const h = headerMap(headers);
            const saved = GM_getValue(VK_HEADERS_KEY, {}) || {};
            ['authorization','x-app','x-from-id','x-referer','x-super-referer','x-trans-path','x-trans-source','x-trans-target','x-trans-via'].forEach(k => {
                if (h[k] !== undefined) saved[k] = h[k];
            });
            if (saved.authorization && saved.authorization.startsWith('Bearer ')) GM_setValue(VK_TOKEN_KEY, saved.authorization);
            GM_setValue(VK_HEADERS_KEY, saved);
        };
        const grab = (headers) => {
            try {
                let auth = '';
                if (!headers) return;
                if (headers instanceof Headers || typeof headers.get === 'function') {
                    auth = headers.get('authorization') || headers.get('Authorization') || '';
                } else if (Array.isArray(headers)) {
                    const pair = headers.find(h => h && String(h[0]).toLowerCase() === 'authorization');
                    auth = pair ? pair[1] : '';
                } else if (typeof headers.forEach === 'function') {
                    headers.forEach((v, k) => {
                        if (!auth && String(k).toLowerCase() === 'authorization') auth = v;
                    });
                } else if (headers && typeof headers === 'object') {
                    auth = headers.authorization || headers.Authorization || '';
                }
                if (auth && auth.startsWith('Bearer ')) {
                    if (GM_getValue(TOKEN_KEY, '') !== auth) {
                        GM_setValue(TOKEN_KEY, auth);
                        console.log('%c[MergedChat] Kick-токен перехвачен', 'color:#53fc18');
                    }
                }
            } catch (e) { }
        };
        // В расширении fetch/XHR страницы перехватывает page-hook.js и присылает url + заголовки
        if (typeof MC_EXT !== 'undefined') {
            MC_EXT.onRequestHeaders((url, headers) => { storeVk(url, headers); grab(headers); });
            return;
        }
        const of = W.fetch;
        if (of && !of.__mcWrapped) {
            const wf = function (input, init) {
                const url = typeof input === 'string' ? input : (input && input.url);
                try { if (input && input.headers) storeVk(url, input.headers); } catch (e) { }
                try { if (init && init.headers) storeVk(url, init.headers); } catch (e) { }
                try { if (input && input.headers) grab(input.headers); } catch (e) { }
                try { if (init && init.headers) grab(init.headers); } catch (e) { }
                return of.apply(this, arguments);
            };
            wf.__mcWrapped = true; W.fetch = wf;
        }
        const XHR = W.XMLHttpRequest;
        if (XHR && !XHR.prototype.__mcWrapped) {
            const oo = XHR.prototype.open;
            XHR.prototype.open = function (method, url) {
                this.__mcUrl = url;
                this.__mcHeaders = {};
                return oo.apply(this, arguments);
            };
            const osr = XHR.prototype.setRequestHeader;
            XHR.prototype.setRequestHeader = function (k, v) {
                try { this.__mcHeaders[String(k).toLowerCase()] = v; } catch (e) { }
                try { if (String(k).toLowerCase() === 'authorization' && /^Bearer /.test(v)) grab({ authorization: v }); } catch (e) { }
                return osr.apply(this, arguments);
            };
            const os = XHR.prototype.send;
            XHR.prototype.send = function () {
                try { storeVk(this.__mcUrl, this.__mcHeaders); } catch (e) { }
                return os.apply(this, arguments);
            };
            XHR.prototype.__mcWrapped = true;
        }
    }

    // ============================================================
    // СБОРЩИК KICK — Pusher (WebSocket) + парсинг вкладки (DOM).
    // Оба источника шлют один и тот же id (kick_<messageId>), поэтому
    // общий sentKickIds глушит дубли между пушером и DOM.
    // ============================================================
    function startKickCollector() {
        startCollectorHeartbeat('kick');
        captureKickToken();
        const sentKickIds = new Set();
        const seenKick = (id) => {
            if (!id) return false;
            if (sentKickIds.has(id)) return true;
            sentKickIds.add(id);
            if (sentKickIds.size > 8000) { const a = [...sentKickIds]; a.slice(0, 3000).forEach(x => sentKickIds.delete(x)); }
            return false;
        };
        const chatroomFromChannel = (channel) => {
            const m = String(channel || '').match(/^chatrooms\.(\d+)\.v2$/);
            return m ? m[1] : String(KICK_CHATROOM_ID);
        };
        const messageIdFrom = (d) => d?.id || d?.message_id || d?.message?.id || d?.data?.id || '';
        const onKickFrame = (raw) => {
            if (typeof raw !== 'string') return;
            let ev;
            try { ev = JSON.parse(raw); } catch { return; }
            if (!ev || typeof ev.event !== 'string') return;

            let d;
            try { d = JSON.parse(ev.data); } catch { return; }

            const chatroomId = chatroomFromChannel(ev.channel);

            if (ev.event.includes('MessageDeletedEvent')) {
                const deletedId = messageIdFrom(d);
                if (deletedId) {
                    broadcast('kick', {
                        platform: 'kick',
                        type: 'delete',
                        id: 'kick_deleted_' + deletedId,
                        targetId: 'kick_' + deletedId,
                        rawId: deletedId,
                        chatroomId
                    });
                    console.log('[MergedChat] Kick delete event', { deletedId, chatroomId, channel: ev.channel, data: d });
                }
                return;
            }

            if (/ban|timeout|unban|unmute/i.test(ev.event) && !ev.event.includes('ChatMessageEvent')) {
                const mod = kickModerationInfo(ev.event, d);
                broadcast('kick', {
                    platform:'kick',
                    type:'mod_event',
                    id:`kick_mod_${ev.event}_${mod.name}_${d?.id || d?.created_at || Date.now()}`,
                    name:mod.name,
                    userId:mod.userId,
                    actor:mod.actor,
                    action:mod.action
                });
                return;
            }

            if (!ev.event.includes('ChatMessageEvent')) return;
            if (!d || !d.sender) return;

            const msgId = messageIdFrom(d);
            if (!msgId) console.warn('[MergedChat] Kick message without id', { channel: ev.channel, event: ev.event, data: d });
            if (msgId && seenKick('kick_' + msgId)) return; // уже прислал DOM-сборщик

            const ident = d.sender.identity || {};
            broadcast('kick', {
                platform: 'kick',
                id: msgId ? 'kick_' + msgId : 'kick_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                rawId: msgId,
                chatroomId,
                name: d.sender.username || '???',
                color: ident.color || '',
                content: d.content || '',
                badges_v2: (ident.badges_v2 || []).map(b => ({ url: b.image_url, name: b.name })),
                badges_txt: (ident.badges || []).map(b => b.type),
                reply: (d.type === 'reply' && d.metadata && d.metadata.original_sender)
                    ? {
                        id: d.metadata.original_message?.id ? 'kick_' + d.metadata.original_message.id : '',
                        rawId: d.metadata.original_message?.id || '',
                        name: d.metadata.original_sender.username,
                        content: d.metadata.original_message?.content || ''
                    }
                    : null
            });
        };
        // страница Kick теперь слушает чат через Centrifugo — перехват ничего не видит,
        // поэтому держим и своё подключение к Pusher (дубли глушит seenKick)
        installWsTap(onKickFrame);
        openKickPusher(onKickFrame, 'сборщик');
        startKickDomCollector(seenKick);
    }

    // ---- парсер сообщений Kick прямо со вкладки чата (DOM) ----
    // Ловит то, что пушер мог не отдать (история при заходе, пропуски WS).
    function startKickDomCollector(seenKick) {
        const ENTRY_SEL = '[data-chat-entry]';
        const reEmote = /emotes\/(\d+)/;
        const extract = (entry) => {
            const rawId = entry.getAttribute('data-chat-entry') || '';
            if (!rawId || seenKick('kick_' + rawId)) return; // дедуп с пушером и между сканами
            const entryText = cleanChatText(entry.textContent || '').trim().replace(/^\d{1,2}:\d{2}\s*/, '');
            const timeoutMatch = /^(.+?)\s+отправил(?:а)?\s+в\s+тайм-аут\s+(.+?)\s+на\s+(.+)$/i.exec(entryText);
            if(timeoutMatch){
                broadcast('kick', {
                    platform:'kick',
                    type:'mod_event',
                    id:'kick_dom_mod_' + rawId,
                    actor:timeoutMatch[1].trim(),
                    name:timeoutMatch[2].trim(),
                    action:'тайм-аут на ' + timeoutMatch[3].trim()
                });
                return;
            }
            const userBtn = entry.querySelector('[data-chat-entry-user-id]');
            const nameEl = userBtn?.querySelector('span[style*="color"]') || userBtn?.querySelector('span') || userBtn;
            const name = nameEl?.textContent?.replace(/:\s*$/, '').trim() || '';
            const color = nameEl?.style?.color || '';
            const userId = userBtn?.getAttribute('data-chat-entry-user-id') || '';

            const badges_v2 = [];
            entry.querySelectorAll('[class*="badge" i] img, [class*="Badge"] img').forEach(img => {
                const src = img.getAttribute('src') || '';
                if (src && !reEmote.test(src)) badges_v2.push({ url: src, name: img.getAttribute('alt') || img.getAttribute('title') || '' });
            });

            // тело сообщения: текстовые куски + эмоуты в порядке появления
            let content = '';
            entry.querySelectorAll('.chat-entry-content, [class*="chat-entry-content"], img').forEach(node => {
                if (node.tagName === 'IMG') {
                    const src = node.getAttribute('src') || '';
                    const m = src.match(reEmote);
                    if (m) {
                        const nm = node.getAttribute('data-emote-name') || node.getAttribute('alt') || node.getAttribute('title') || '';
                        content += `[emote:${m[1]}:${nm}]`;
                    }
                } else {
                    content += node.textContent || '';
                }
            });
            content = cleanChatText(content);
            if (!name || !content.trim()) {
                console.log('[MergedChat] Kick DOM skipped', { rawId, name, html: entry.innerHTML.slice(0, 200) });
                return;
            }

            broadcast('kick', {
                platform: 'kick',
                id: 'kick_' + rawId,
                rawId,
                chatroomId: String(KICK_CHATROOM_ID),
                name,
                color,
                content,
                badges_v2,
                badges_txt: [],
                reply: null
            });
            console.log('[MergedChat] Kick DOM message', { rawId, name });
        };
        const scan = () => document.querySelectorAll(ENTRY_SEL).forEach(extract);
        if (document.body) {
            scan();
            new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
            setInterval(scan, 1500);
            console.log('%c[MergedChat] Kick DOM-сборщик запущен', 'color:#53fc18;font-weight:bold');
        } else {
            document.addEventListener('DOMContentLoaded', () => startKickDomCollector(seenKick), { once: true });
        }
    }

    // ============================================================
    // СБОРЩИК VK PLAY LIVE — из реального Centrifugo/WebSocket страницы.
    // ============================================================
    // opts.direct — сборщик запущен прямо в виджете: кадры идут из своего сокета расширения,
    // страницы VK нет (токены и цвета из DOM брать неоткуда)
    function startVkCollector(opts = {}) {
        startCollectorHeartbeat('vk');
        if (!opts.direct) captureKickToken();
        vkDebug('collector-start', { href: location.href });
        const sentIds = new Set();
        const vkMsgUsers = new Map();
        function jsonFrames(raw) {
            if (raw instanceof ArrayBuffer) raw = new TextDecoder('utf-8').decode(new Uint8Array(raw));
            if (ArrayBuffer.isView(raw)) raw = new TextDecoder('utf-8').decode(raw);
            if (typeof raw !== 'string') return [];
            const s = raw.trim();
            if (!s) return [];
            const chunks = s.includes('\n') ? s.split(/\n+/).filter(Boolean) : [s];
            const out = [];
            chunks.forEach(ch => {
                try {
                    const json = ch[0] === '{' ? ch.slice(0, ch.lastIndexOf('}') + 1) : ch;
                    const v = JSON.parse(json);
                    if (Array.isArray(v)) out.push(...v);
                    else out.push(v);
                } catch (e) { }
            });
            return out;
        }
        function vkPushes(obj, out = []) {
            if (!obj || typeof obj !== 'object') return out;
            const channel = obj.channel || obj.push?.channel;
            const data = obj.push?.pub?.data || obj.pub?.data || obj.publication?.data || obj.data;
            if (channel && data) out.push({ channel, data });
            Object.keys(obj).forEach(k => {
                const v = obj[k];
                if (v && typeof v === 'object') vkPushes(v, out);
            });
            return out;
        }
        function asParts(value) {
            const parts = [];
            const addText = t => { const text = compactTextPart(t); if (text) parts.push({ t: 'text', v: text }); };
            const walk = v => {
                if (v == null) return;
                if (typeof v === 'string') {
                    let parsed = null;
                    try { parsed = JSON.parse(v); } catch (e) { }
                    if (!parsed && v.includes('[')) {
                        try { parsed = JSON.parse(v.slice(v.indexOf('['))); } catch (e) { }
                    }
                    if (parsed) walk(parsed);
                    else addText(v);
                } else if (Array.isArray(v)) {
                    if (typeof v[0] === 'string') addText(v[0]);
                    else v.forEach(walk);
                } else if (typeof v === 'object') {
                    if (v.modificator === 'BLOCK_END' || v.type === 'BLOCK_END') return;
                    if (v.type === 'mention' || v.type === 'user_mention' || v.mentionId || v.userId || v.user_id) {
                        parts.push({ t: 'mention', v: v.displayName || v.nick || v.name || v.content || '', id: v.mentionId || v.userId || v.user_id || v.id || '' });
                    } else if (v.type === 'smile' || v.type === 'emote' || v.mediumUrl || v.largeUrl || v.smallUrl || v.src) {
                        const smileId = String(v.id || v.smileId || v.smile_id || '');
                        const src = v.smallUrl || v.mediumUrl || v.largeUrl || v.url || v.src
                            || (/^[0-9a-f-]{36}$/i.test(smileId)
                                ? `https://images.live.vkvideo.ru/smile/${smileId}/icon/size/medium`
                                : '');
                        if (/^https?:\/\//.test(src)) parts.push({ t: 'emote', v: src, id: smileId, name: v.name || v.displayName || '' });
                        else addText(v.text || v.content || '');
                    } else if (v.url) {
                        addText(v.url);
                    } else if (Array.isArray(v.data)) {
                        walk(v.data);
                    } else if ('content' in v) walk(v.content);
                    else if ('text' in v) walk(v.text);
                    else if ('message' in v) walk(v.message);
                }
            };
            walk(value);
            return parts.length ? parts : [{ t: 'text', v: cleanChatText(JSON.stringify(value)) }];
        }
        function vkTextFromParts(parts) {
            return (parts || []).map(p => p.t === 'mention' ? '@' + (p.v || '') : (p.v || '')).join('');
        }
        function msgId(d) { return d?.id || d?.messageId || d?.message_id || d?.chatMessageId || d?.data?.id || d?.message?.id || ''; }
        function userFrom(d) { return d?.user || d?.author || d?.sender || d?.from || d?.profile || d?.message?.user || d?.data?.user || d?.data?.author || {}; }
        function replyFrom(d) {
            const p = d?.parentMessage || d?.parent || d?.replyMessage || d?.reply || null;
            if (!p || typeof p !== 'object') return null;
            const id = msgId(p);
            const u = userFrom(p);
            const name = u.displayName || u.nick || u.name || p.displayName || p.nick || p.name || '';
            const content = p.content ?? p.text ?? p.message ?? p.data ?? p.data?.content ?? p.data?.text ?? '';
            if (!name && content === '') return null;
            const parts = asParts(content);
            return {
                id: id ? 'vk_' + id : '',
                rawId: id || '',
                name,
                content: vkTextFromParts(parts),
                parts
            };
        }
        function handleVkData(d) {
            if (!d || typeof d !== 'object') return;
            const type = String(d.type || d.event || d.kind || '');
            if (type === 'message' && d.data && typeof d.data === 'object') d = d.data;
            if (type.includes('delete')) {
                const id = msgId(d);
                if (id) broadcast('vk', { platform: 'vk', type: 'delete', id: 'vk_deleted_' + id, targetId: 'vk_' + id, rawId: id });
                return;
            }
            if (type === 'chat_ban') {
                const u = d.bannedUser || {};
                broadcast('vk', {
                    platform: 'vk',
                    type: 'mod_event',
                    id: 'vk_mod_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                    name: u.displayName || u.nick || u.name || '???',
                    userId: u.id || '',
                    action: d.isPermanent ? 'banned' : (d.isTemporary ? 'timeout ' + Math.round((d.remainingTime || 0) / 60) + 'm' : 'timeout'),
                    raw: d
                });
                return;
            }
            const id = msgId(d);
            const u = userFrom(d);
            const name = u.displayName || u.nick || u.name || d.displayName || d.nick || d.name || '';
            const content = d.content ?? d.text ?? d.message ?? d.data ?? d.data?.content ?? d.data?.text ?? '';
            if (!id || !name || content === '') {
                if (type && type !== 'system') {
                    console.log('[MergedChat] VK WS skipped', d);
                    vkDebug('ws-skipped', { type, keys: Object.keys(d || {}), sample: JSON.stringify(d).slice(0, 500) });
                }
                return;
            }
            if (sentIds.has(id)) return;
            sentIds.add(id);
            if (sentIds.size > 6000) { const a = [...sentIds]; a.slice(0, 2000).forEach(x => sentIds.delete(x)); }
            const userId = u.id || d.userId || d.user_id || '';
            vkMsgUsers.set(String(id), { name, userId });
            if(vkMsgUsers.size > 6000) { const keys = [...vkMsgUsers.keys()]; keys.slice(0, 2000).forEach(k => vkMsgUsers.delete(k)); }
            console.log('[MergedChat] VK WS message', { id, name, content });
            vkDebug('ws-message', { id, name });
            broadcast('vk', {
                platform: 'vk',
                id: 'vk_' + id,
                rawId: id,
                userId,
                name,
                // цвет, который VK прислал сейчас, важнее запомненного: человек мог сменить цвет
                color: vkColorCode(u.nickColor) >= 0 ? vkNickColor(u.nickColor) : (getUserColor('vk', name, userId) || vkNickColor('', name)),
                colorExact: vkColorCode(u.nickColor) >= 0,
                nickColor: u.nickColor,
                badges: (u.badges || []).map(b => ({ url: b.smallUrl || b.mediumUrl || b.largeUrl || '', name: b.achievement?.name || b.name || '' })),
                isMod: !!(u.isChatModerator || u.isChannelModerator),
                isOwner: !!u.isOwner,
                parts: asParts(content),
                reply: replyFrom(d)
            });
        }
        function handleVkMetaData(d) {
            if (!d || typeof d !== 'object') return;
            const type = String(d.type || d.event || '');
            const stream = d.data?.stream || d.stream || d.data || {};
            const blogUrl = d.blogUrl || stream.blogUrl || stream.channelUrl || '';
            const viewers = d.viewers ?? stream.viewers;
            if ((type === 'stream_online_status' || type === 'stream_slot_online_status') && String(blogUrl).toLowerCase() === KICK_SLUG && viewers !== undefined) {
                setMeta({ vkOnline: Number(viewers) || 0 });
            }
        }
        function startVkColorSync(){
            const SEL = '[data-test-id="ChatMessage:root"][data-message-id]';
            const synced = new Set();
            const scan = () => {
                document.querySelectorAll(SEL).forEach(node => {
                    const rawId = node.getAttribute('data-message-id') || '';
                    if(!rawId || synced.has(rawId)) return;
                    const info = vkMsgUsers.get(String(rawId));
                    if(!info) return;
                    const nameEl = node.querySelector('[data-role="messageAuthor"] span[style*="color"], [data-test-id="ChatMessage:author"] span[style*="color"]');
                    const color = nameEl?.style?.color || '';
                    if(!color) return;
                    synced.add(rawId);
                    rememberUserColor('vk', info.name, info.userId || '', color);
                    broadcast('vk', {
                        platform:'vk',
                        type:'color_update',
                        id:'vk_color_' + rawId + '_' + Date.now(),
                        targetId:'vk_' + rawId,
                        rawId,
                        name:info.name,
                        userId:info.userId || '',
                        color
                    });
                });
                if(synced.size > 6000) { const a = [...synced]; a.slice(0, 2000).forEach(x => synced.delete(x)); }
            };
            if(document.body){
                scan();
                new MutationObserver(scan).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['data-message-id', 'style'] });
                setInterval(scan, 1500);
            } else {
                document.addEventListener('DOMContentLoaded', startVkColorSync, { once:true });
            }
        }
        installWsTap((raw, url) => {
            if (!String(url || '').includes('pubsub.live.vkvideo.ru')) return;
            if (raw instanceof Blob) {
                raw.text().then(text => {
                    const frames = jsonFrames(text);
                    const pushes = frames.flatMap(frame => vkPushes(frame));
                    const chatPushes = pushes.filter(p => String(p.channel).startsWith('channel-chat:'));
                    if (pushes.length) {
                        console.log('[MergedChat] VK WS pushes', pushes.map(p => p.channel));
                        vkDebug('ws-pushes', { channels: pushes.map(p => p.channel) });
                    }
                    pushes.forEach(p => String(p.channel).startsWith('channel-chat:') ? handleVkData(p.data) : handleVkMetaData(p.data));
                }).catch(e => console.warn('[MergedChat] VK WS blob decode failed', e));
                return;
            }
            const frames = jsonFrames(raw);
            const pushes = frames.flatMap(frame => vkPushes(frame));
            if (pushes.length) {
                console.log('[MergedChat] VK WS pushes', pushes.map(p => p.channel));
                vkDebug('ws-pushes', { channels: pushes.map(p => p.channel) });
            }
            else {
                console.log('[MergedChat] VK WS raw no push', typeof raw, String(raw).slice(0, 180));
                vkDebug('ws-raw-no-push', { type: typeof raw, sample: String(raw).slice(0, 180) });
            }
            pushes.forEach(p => String(p.channel).startsWith('channel-chat:') ? handleVkData(p.data) : handleVkMetaData(p.data));
        });
        function startDomFallback(){
            const SEL = '[data-test-id="ChatMessage:root"]';
            const extract = node => {
                const id = node?.getAttribute('data-message-id');
                if(!id || sentIds.has(id)) return;
                const authorPanel = node.querySelector('[data-role="messageAuthor"], [data-test-id="ChatMessage:author"]');
                const nameEl = authorPanel?.querySelector('span[style*="color"]') || authorPanel?.querySelector('span');
                const name = nameEl?.textContent?.replace(/:\s*$/, '').trim() || '';
                const color = nameEl?.style?.color || '';
                const badges = [];
                authorPanel?.querySelectorAll('img').forEach(img => {
                    const src = img.getAttribute('src') || '';
                    if(src) badges.push({ url: src, name: img.closest('[title]')?.getAttribute('title') || '' });
                });
                let isMod = false, isOwner = false;
                authorPanel?.querySelectorAll('[title]').forEach(el => {
                    const t = (el.getAttribute('title') || '').toLowerCase();
                    if(t.includes('модератор')) isMod = true;
                    if(t.includes('владел') || t.includes('канал')) isOwner = true;
                });
                const markup = node.querySelector('[data-role="markup"]');
                const parts = [];
                markup?.childNodes.forEach(ch => {
                    if(ch.nodeType === 3){
                        if(ch.textContent.trim()) parts.push({ t:'text', v:ch.textContent });
                    } else if(ch.nodeType === 1 && ch.tagName === 'IMG'){
                        const src = (ch.getAttribute('src') || '').replace('/size/small', '/size/medium');
                        if(src) parts.push({ t:'emote', v:src });
                    } else if(ch.nodeType === 1 && ch.getAttribute('data-role') === 'messageMentionContent'){
                        const display = ch.getAttribute('data-display-name') || ch.textContent || '';
                        const id = ch.getAttribute('data-mention-id') || ch.getAttribute('data-id') || '';
                        if(display.trim()) parts.push({ t:'mention', v:display.trim(), id });
                    } else if(ch.nodeType === 1){
                        const t = ch.getAttribute('href') || ch.textContent || '';
                        if(t.trim()) parts.push({ t:'text', v:t });
                    }
                });
                if(!name || !parts.length) return;
                let reply = null;
                const parentNode = node.querySelector('[data-role="messageParentMessage"]');
                if(parentNode){
                    const parentAuthor = parentNode.querySelector('[class*="parentMessageAuthor"]')?.textContent?.replace(/:\s*$/, '').trim() || '';
                    const parentText = parentNode.querySelector('[data-role="markup"]')?.textContent?.trim() || parentNode.getAttribute('title') || '';
                    if(parentAuthor || parentText) reply = { name: parentAuthor, content: parentText };
                }
                sentIds.add(id);
                vkDebug('dom-message', { id, name });
                broadcast('vk', { platform:'vk', id:'vk_'+id, rawId:id, userId:'', name, color, badges, isMod, isOwner, parts, reply });
            };
            const scan = () => document.querySelectorAll(SEL).forEach(extract);
            if(document.body){
                scan();
                new MutationObserver(scan).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['data-message-id'] });
                setInterval(scan, 1500);
            } else {
                document.addEventListener('DOMContentLoaded', startDomFallback, { once:true });
            }
        }
        if (opts.direct) { console.log('%c[MergedChat] VK читается напрямую (без вкладки VK)', 'color:#0af;font-weight:bold'); return; }
        if(VK_DOM_FALLBACK) startDomFallback();
        else vkDebug('dom-fallback-disabled', { reason: 'WS only; DOM history panels must not enter live feed' });
        startVkColorSync();
        console.log('%c[MergedChat] VK WS-сборщик запущен' + (VK_DOM_FALLBACK ? ' + DOM fallback' : ' · DOM fallback off'), 'color:#0af;font-weight:bold');
    }

    // ============================================================
    // ВИДЖЕТ (режим #feed)
    // ============================================================
    function startFeed() {
        captureKickToken();
        // -------- стили + разметка --------
        // полностью заменяем страницу Kick на нашу (с head и body)
        document.documentElement.innerHTML = '<head></head><body></body>';
        const fontLink = document.createElement('link');
        fontLink.rel = 'stylesheet';
        fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap';
        document.head.appendChild(fontLink);
        const style = document.createElement('style');
        style.textContent = `
            :root{--fs:14px;--bar-h:34px;--settings-h:auto;--accent:#7a6337;--accent-rgb:122 99 55;--accent-soft:rgba(122,99,55,.12);--accent-medium:rgba(122,99,55,.22);--accent-strong:rgba(122,99,55,.45);--accent-bright:#947b48;--accent-dark:#5c4825;--accent-contrast:#fff;--pz-glow:rgba(122,99,55,.2);--bg:#f9f3e7;--panel:#fdfbf6;--border:#b4a98f;--text:#28251f;--muted:#6d6659;--surface-0:#fbf7ef;--surface-1:#fcf9f3;--surface-2:#f5e9d1;--surface-3:#f1e1c1;--surface-4:#eddaaf;--bg-color:var(--bg);--text-color:var(--text)}
            *{box-sizing:border-box}
            html,body{margin:0;height:100%;background:var(--bg-color);color:var(--text-color);font-family:'Inter',system-ui,Arial,sans-serif;overflow:hidden}
            body{display:flex;flex-direction:column}
            #bar{height:var(--bar-h);flex:0 0 var(--bar-h);display:grid;grid-template-columns:minmax(92px,1fr) auto minmax(92px,1fr);align-items:center;gap:10px;padding:5px 8px;font-size:12px;background:rgba(0,0,0,.7);border-bottom:1px solid #333}
            .bar-left{display:flex;justify-content:flex-start;min-width:0}
            .bar-center{display:flex;align-items:center;justify-content:center;gap:10px;min-width:0;white-space:nowrap}
            .bar-right{display:flex;justify-content:flex-end;min-width:0}
            #dot{width:9px;height:9px;border-radius:50%;background:#53fc18;box-shadow:0 0 6px #53fc18}
            #st{font-weight:700;color:#fff;letter-spacing:0;overflow:hidden;text-overflow:ellipsis}
            #platform-stats{display:flex;gap:9px;padding-left:10px;border-left:1px solid #444;align-items:center}
            .platform-stat{display:inline-flex;align-items:center;gap:4px;color:#ccc}
            .platform-stat img{width:1.25em;height:1.25em;opacity:.85}
            .platform-stat span{color:#fff;font-weight:700}
            .sum-mark{font-weight:800;color:#d9d9d9}
            .platform-stat[hidden]{display:none}
            .bar-btn,.links-btn{background:transparent;border:1px solid #444;color:#aaa;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px}
            .bar-btn:hover,.links-btn:hover{background:#333;color:#fff}
            #settings-panel{display:none;height:var(--settings-h);align-items:center;gap:10px;padding:8px 15px;background:rgba(0,0,0,.5);border-bottom:1px solid #2a2a2a;font-size:11px;color:#aaa}
            #settings-panel.open{display:flex;flex:0 0 var(--settings-h)}
            #settings-panel input[type=range]{width:160px}
            .links-btn{margin-left:auto;background:#2d5a27;border-color:#3d7a37;color:#fff}
            .links-btn:hover{background:#3d7a37}
            #chat{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px;scroll-behavior:smooth}
            #chat::-webkit-scrollbar{width:0}
            #stale-wrap{position:relative;height:0;flex:0 0 0;z-index:5}
            #stale-banner{display:none;position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:#c0392b;color:#fff;font-weight:700;font-size:12px;letter-spacing:.5px;padding:7px 14px;border-radius:16px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.5);white-space:nowrap;user-select:none;animation:f .15s ease-out}
            #stale-banner:hover{background:#e74c3c}
            .msg{background:rgba(0,0,0,.647);border-radius:4px;padding:4px 8px;margin-bottom:2px;font-size:var(--fs);line-height:1.4;word-wrap:break-word;animation:f .15s ease-out}
            .msg.removed{opacity:.35;text-decoration:line-through}
            .msg.awaiting{background:rgba(255,176,0,.16);box-shadow:inset 3px 0 0 #ffb000}
            .msg.awaiting .name::before{content:'⏳ ';font-weight:400}
            @keyframes f{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}
            .reply{display:block;color:#a8a8b3;font-size:.8em;margin:0 0 2px 1.55em;border-left:2px solid #6f54ff;padding-left:7px;line-height:1.25;max-width:92%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .reply[data-parent-id]{cursor:pointer}
            .reply[data-parent-id]:hover{color:#ddd;border-left-color:#9f86ff}
            .reply-label{color:#8d8d96}.reply-name{font-weight:700;color:#b89cff}.reply-text{color:#b8b8c0}
            .msg.reply-target{outline:1px solid #9f86ff;background:rgba(111,84,255,.2)}
            .msg.reply-to-me{background:rgba(83,252,24,.12);box-shadow:inset 3px 0 0 #53fc18}
            .msg.reply-to-me:hover{background:rgba(83,252,24,.18)}
            .msg.reply-to-me .reply{border-left-color:#53fc18}
            .msg.reply-to-me .reply-name::after{content:' • вам';color:#53fc18;font-weight:700}
            .plat{display:inline-flex;width:1.15em;height:1.15em;border-radius:2px;vertical-align:middle;margin-right:4px;align-items:center;justify-content:center;overflow:hidden}
            .plat.kick{background:#53fc18}
            .plat.vk{background:transparent}
            .plat img{width:100%;height:100%;object-fit:cover}
            .badge{vertical-align:middle;margin-right:3px}
            .badge.img{height:1.1em;width:1.1em;border-radius:2px}
            .name{font-weight:700;margin-right:4px;vertical-align:middle}
            .name::after{content:':';color:#888}
            .emote{vertical-align:-.25em;height:1.35em;max-width:1.55em;width:auto;object-fit:contain;margin:-.12em .08em}
            .text{white-space:pre-wrap;vertical-align:middle}
            .text a{color:#3a8bfd;text-decoration:none}
            .text a:hover{text-decoration:underline}
            .mention{color:#ffd700;font-weight:600;cursor:pointer}
            .msg{position:relative}
            .timeout-pop{position:fixed;z-index:999999;background:#181a1b;color:#fff;border:1px solid #3a3d3f;border-radius:6px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);font-size:13px;min-width:220px}
            .timeout-pop .tp-title{font-weight:700;color:#ffb000;margin-bottom:7px}
            .timeout-pop .tp-presets{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px}
            .timeout-pop button{cursor:pointer;border:0;border-radius:4px;background:#2a2d2f;color:#fff;padding:6px 8px;font-weight:700}
            .timeout-pop button:hover{background:#3a3d3f}
            .timeout-pop .tp-custom{display:grid;grid-template-columns:1fr 88px 1fr;gap:5px}
            .timeout-pop input,.timeout-pop select{min-width:0;border:1px solid #3a3d3f;border-radius:4px;background:#101112;color:#fff;padding:6px}
            .timeout-pop .tp-set{background:#53fc18;color:#071007}
            .nick-menu{position:fixed;z-index:999999;background:#181a1b;color:#fff;border:1px solid #3a3d3f;border-radius:6px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.45);min-width:180px;display:flex;flex-direction:column;gap:4px}
            .nick-menu .nm-title{font-weight:700;padding:2px 4px 5px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid #2a2d2f;margin-bottom:2px}
            .nick-menu button{cursor:pointer;border:0;border-radius:4px;background:#2a2d2f;color:#fff;padding:7px 9px;font-weight:700;text-align:left;font-size:13px}
            .nick-menu button:hover{background:#3a3d3f}
            .nick-menu button.nm-wait.on{background:#5a4500}
            .nick-menu button.nm-wait.on:hover{background:#6a5200}
            .nick-menu .nm-hl{display:flex;align-items:center;gap:5px;padding:3px 4px}
            .nick-menu .nm-hl-label{font-size:13px}
            .nick-menu .nm-hl-dot{width:18px;height:18px;min-width:18px;border-radius:50%;padding:0;background:var(--c);border:2px solid transparent}
            .nick-menu .nm-hl-dot:hover{background:var(--c);transform:scale(1.15)}
            .nick-menu .nm-hl-dot.on{border-color:#fff;box-shadow:0 0 0 2px var(--c)}
            .nick-menu .nm-hl-off{width:18px;height:18px;min-width:18px;border-radius:50%;padding:0;font-size:11px;line-height:1}
            #composer{flex:0 0 auto;border-top:1px solid #333;background:#101112;padding:5px 7px;display:flex;flex-direction:column;gap:4px;position:relative}
            #reply-compose{display:none;min-height:18px;color:#b8b8c0;font-size:11px;border-left:2px solid #6f54ff;padding-left:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            #reply-compose.on{display:flex;align-items:center;gap:6px}
            #reply-compose button{margin-left:auto;border:0;background:transparent;color:#aaa;cursor:pointer}
            .compose-row{display:grid;grid-template-columns:auto auto 1fr auto;gap:5px;min-height:34px}
            #template-toggle,#emote-toggle,#send-message,.send-choice button,.template-menu button{border:1px solid #444;border-radius:5px;background:#242628;color:#eee;cursor:pointer;padding:5px 8px}
            #emote-toggle{font-size:18px;line-height:1}
            #emote-toggle.active{border-color:#53fc18;background:#263523}
            #send-message{background:#2d5a27;border-color:#3d7a37;font-weight:700}
            #message-input{resize:none;min-width:0;border:1px solid #444;border-radius:5px;background:#181a1b;color:#fff;padding:7px;font:13px Inter,system-ui}
            .send-choice,.template-menu{position:absolute;z-index:999998;bottom:calc(100% + 4px);background:#181a1b;border:1px solid #444;border-radius:7px;padding:6px;box-shadow:0 8px 24px #000a;display:none;gap:5px}
            .send-choice.open,.template-menu.open{display:flex}
            .send-choice{right:7px}
            .template-menu{left:7px;max-width:min(520px,calc(100vw - 14px));flex-wrap:wrap}
            .template-menu .template-edit-toggle{color:#888}
            #emote-picker{position:absolute;z-index:999998;left:7px;right:7px;bottom:calc(100% + 4px);height:min(330px,55vh);display:none;flex-direction:column;background:#181a1b;border:1px solid #444;border-radius:7px;box-shadow:0 8px 24px #000a;overflow:hidden}
            #emote-picker.open{display:flex}
            .emote-head{display:flex;gap:4px;padding:6px;border-bottom:1px solid #333;overflow-x:auto}
            .emote-head button{flex:0 0 auto;border:0;border-radius:4px;background:#242628;color:#aaa;padding:6px 8px;cursor:pointer}
            .emote-head button.active{background:#365b31;color:#fff}
            #emote-search{margin:6px;border:1px solid #444;border-radius:5px;background:#101112;color:#fff;padding:7px}
            #emote-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(42px,1fr));gap:3px;padding:3px 6px 8px;overflow:auto}
            #emote-list button{height:42px;min-width:0;border:0;border-radius:5px;background:transparent;cursor:pointer}
            #emote-list button:hover{background:#ffffff17}
            #emote-list img{width:34px;height:34px;object-fit:contain}
            .emote-empty{grid-column:1/-1;color:#999;text-align:center;padding:20px 8px;font-size:12px}
            #template-editor{display:none;position:fixed;z-index:999999;inset:10%;background:#181a1b;border:1px solid #555;border-radius:8px;padding:10px;box-shadow:0 14px 50px #000;overflow:auto}
            #template-editor.open{display:block}
            #template-editor textarea,#template-editor input{width:100%;margin:3px 0 7px;background:#101112;border:1px solid #444;border-radius:4px;color:#fff;padding:6px}
            #template-editor textarea{min-height:70px;resize:vertical}
            .template-edit-row{border-bottom:1px solid #333;padding:7px 0}
            .template-field-head{display:flex;align-items:center;justify-content:space-between;color:#bbb;font-size:12px;font-weight:700}
            .template-emote-toggle{border:1px solid #444;border-radius:4px;background:#242628;color:#eee;padding:3px 7px;cursor:pointer}
            .template-emote-picker{display:none;grid-template-columns:repeat(auto-fill,minmax(38px,1fr));gap:3px;max-height:160px;overflow:auto;padding:6px;margin:-3px 0 7px;border:1px solid #3a3a3a;border-radius:5px;background:#111214}
            .template-emote-picker.open{display:grid}
            .template-emote-picker button{height:36px;border:0;border-radius:4px;background:transparent;cursor:pointer}
            .template-emote-picker button:hover{background:#ffffff17}
            .template-emote-picker img{width:30px;height:30px;object-fit:contain}
            .template-preview{min-height:28px;margin:-3px 0 7px;padding:5px 7px;border:1px dashed #3a3a3a;border-radius:5px;color:#ddd;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
            .template-preview:empty::before{content:'Предпросмотр';color:#666}
            .template-preview img{height:1.65em;max-width:2em;vertical-align:-.35em;object-fit:contain}
            .template-actions{display:flex;align-items:center;gap:8px;position:sticky;bottom:-10px;padding:10px 0;background:#181a1b}
            #template-save-status{font-weight:700;color:#53fc18;opacity:0;transition:opacity .15s}
            #template-save-status.show{opacity:1}
            #template-save-status.dirty{color:#ffb000}
            .thread-panel{position:fixed;left:0;top:0;width:min(380px,92vw);max-height:min(62vh,520px);background:#18181b;border:1px solid #3a3a40;border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.62);z-index:999997;display:none;flex-direction:column;overflow:hidden}
            .thread-panel.open{display:flex;animation:thread-pop .12s ease-out}
            @keyframes thread-pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
            .thread-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #33333a;background:#202024}
            .thread-head strong{font-size:13px}
            .thread-head button{background:none;border:0;color:#999;font-size:20px;line-height:1;cursor:pointer;padding:0 2px}
            .thread-head button:hover{color:#fff}
            .thread-body{flex:1 1 auto;overflow-y:auto;padding:8px 10px}
            .thread-body .thread-msg{margin:5px 0 5px calc(min(var(--depth,0),8) * 14px);border-left:2px solid #38383f;padding:5px 8px;background:rgba(0,0,0,.38)}
            .thread-body .thread-msg.thread-current{background:rgba(83,252,24,.10);border-left-color:#53fc18}
            .thread-jump{margin-left:6px;background:none;border:0;color:#999;cursor:pointer;font-size:13px;padding:0 4px;vertical-align:middle}
            .thread-jump:hover{color:#53fc18}
            @media(max-width:700px){.thread-panel{width:min(94vw,420px);max-height:72vh}}
            .mod-event{opacity:.82;border-left:3px solid #ffb000;background:rgba(255,176,0,.1)}
            #mention-suggest{position:absolute;z-index:999998;left:92px;right:82px;bottom:calc(100% + 4px);display:none;flex-direction:column;background:#181a1b;border:1px solid #444;border-radius:7px;padding:4px;box-shadow:0 8px 24px #000a;max-height:210px;overflow:auto}
            #mention-suggest.open{display:flex}
            .mention-option{display:flex;align-items:center;gap:7px;width:100%;border:0;border-radius:4px;background:transparent;color:#eee;padding:6px 8px;text-align:left;cursor:pointer}
            .mention-option.active,.mention-option:hover{background:rgba(83,252,24,.14)}
            .mention-option img{width:17px;height:17px;border-radius:3px;object-fit:cover}
            .mention-option span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

            /* Unified website theme/palette layer. */
            html,body{background:var(--bg);color:var(--text)}
            #bar{background:color-mix(in srgb,var(--panel) 90%,transparent);border-color:var(--border);color:var(--text)}
            #dot{background:var(--accent);box-shadow:0 0 7px var(--pz-glow)}
            #st,.platform-stat span{color:var(--text)}
            #platform-stats{border-color:var(--border)}.platform-stat,.sum-mark{color:var(--muted)}
            .bar-btn,.links-btn{border-color:var(--border);background:var(--surface-2);color:var(--text)}
            .bar-btn:hover,.links-btn:hover{background:var(--surface-3);color:var(--text)}
            #settings-panel{height:auto;max-height:min(62vh,520px);flex-wrap:wrap;align-items:flex-start;gap:8px;padding:9px;background:var(--panel);border-color:var(--border);color:var(--muted);overflow:auto}
            #settings-panel.open{display:flex;flex:0 0 auto}
            .theme-config{flex:1 1 100%;display:grid;gap:8px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface-0)}
            .theme-row,.palette-head,.custom-row,.palette-key-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
            .theme-row>strong,.palette-head>strong{min-width:58px;color:var(--text)}
            .theme-choice,.palette-swatch,.custom-palette summary,.palette-key-actions button{border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);cursor:pointer;padding:5px 8px}
            .theme-choice.active{border-color:var(--accent-strong);background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent-medium)}
            .platform-toggle img{width:14px;height:14px;border-radius:3px;vertical-align:-2px;margin-right:5px}
            .platform-toggle .platform-state{margin-left:5px;font-size:10px;font-weight:700;color:var(--muted)}
            .platform-toggle.active .platform-state{color:var(--text)}
            .platform-toggle:not(.active){opacity:.6}.platform-toggle:not(.active) img{filter:grayscale(1)}
            /* Отключённая платформа: её строки прячутся (не удаляются), при включении возвращаются на свои места */
            html[data-kick-off] #chat .msg[data-plat="kick"],html[data-vk-off] #chat .msg[data-plat="vk"]{display:none}
            #palette-current{margin-left:auto;color:var(--muted);font-weight:700}
            #palette-swatches{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
            .palette-swatch{width:30px;height:30px;padding:0;border-radius:7px;background:var(--swatch);position:relative}
            .palette-swatch.active{outline:2px solid var(--text);outline-offset:2px}
            .palette-swatch span{font-size:9px;font-weight:900;color:#2b261e;text-shadow:0 1px rgba(255,255,255,.7)}
            .custom-palette{color:var(--text)}.custom-palette[open]{padding:7px;border:1px solid var(--border);border-radius:7px;background:var(--surface-1)}
            .custom-palette summary{width:max-content}.custom-grid{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:7px;margin-top:8px}
            .custom-grid label{display:grid;grid-template-columns:1fr auto;align-items:center;gap:5px;color:var(--muted)}
            .custom-grid input[type=text],#palette-key{min-width:0;border:1px solid var(--border);border-radius:5px;background:var(--surface-0);color:var(--text);padding:5px 7px;font:11px ui-monospace,monospace}
            .custom-grid input[type=color]{width:30px;height:28px;padding:1px;border:1px solid var(--border);border-radius:5px;background:var(--surface-2)}
            #palette-key{flex:1 1 230px;text-transform:uppercase}.palette-status{font-size:10px;color:var(--muted)}
            input.invalid{border-color:#e34242!important}
            #chat{background:var(--bg)}
            .msg{margin:0;padding:4px 6px;border-radius:8px;background:transparent;color:var(--text);box-shadow:none;font-size:var(--fs);line-height:1.45;overflow-wrap:anywhere}
            .msg:hover{background:rgba(255,255,255,.045)}
            .msg.reply-to-me{background:linear-gradient(90deg,var(--accent-medium),var(--accent-soft));box-shadow:inset 3px 0 0 var(--accent)}
            .msg.reply-to-me:hover{background:linear-gradient(90deg,var(--accent-medium),var(--accent-soft))}
            .msg.reply-to-me .reply{border-left-color:var(--accent)}.msg.reply-to-me .reply-name::after{color:var(--accent)}
            .reply{display:block;max-width:94%;margin:0 0 3px 24px;padding-left:7px;border-left:2px solid #6f54ff;color:#a8a8b3;font-size:.82em;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .reply-label{color:#8d8d96}.reply-name{color:#b89cff;font-weight:700}.reply-text{color:#b8b8c0}
            .reply[data-parent-id]:hover{border-left-color:#9f86ff;color:#ddd}
            .name,.reply-name{text-shadow:0 1px 2px rgba(0,0,0,.78),0 0 1px rgba(0,0,0,.92)}
            html[data-theme="light"] .msg:hover{background:rgba(18,24,33,.055)}
            html[data-theme="light"] .reply{border-left-color:var(--accent);color:#565047}
            html[data-theme="light"] .reply-label{color:#6d665c}html[data-theme="light"] .reply-text{color:#49453e}
            html[data-theme="light"] .reply[data-parent-id]:hover{border-left-color:var(--accent-dark);background:var(--accent-soft);color:#28251f}
            html[data-theme="light"] .name{color:var(--nick-light-color)!important;text-shadow:none}
            html[data-theme="light"] .reply-name{color:var(--accent);text-shadow:none}
            html[data-theme="aero"] .name{color:var(--nick-light-color)!important;text-shadow:none}
            html[data-theme="aero"] .reply-name{color:var(--accent);text-shadow:none}
            .name::after{color:var(--muted)}.text a{color:#4d9fff}.mention{color:var(--accent-dark);background:var(--accent-soft);border-radius:4px;padding:0 3px}
            #composer{border-color:var(--border);background:var(--surface-0)}
            #template-toggle,#emote-toggle,#send-message,.send-choice button,.template-menu button{border-color:var(--border);background:var(--surface-2);color:var(--text)}
            #emote-toggle.active{border-color:var(--accent);background:var(--accent-soft)}
            #send-message{border-color:var(--accent-strong);background:linear-gradient(135deg,var(--accent-bright),var(--accent-dark));color:var(--accent-contrast);box-shadow:0 2px 9px var(--pz-glow)}
            #message-input,#emote-search{border-color:var(--border);background:var(--surface-1);color:var(--text)}
            .send-choice,.template-menu,#emote-picker,#template-editor,.thread-panel,#mention-suggest,.timeout-pop,.nick-menu{border-color:var(--border);background:var(--panel);color:var(--text);box-shadow:0 12px 36px color-mix(in srgb,var(--text) 24%,transparent)}
            .emote-head{border-color:var(--border)}.emote-head button{background:var(--surface-2);color:var(--muted)}.emote-head button.active{background:var(--accent-soft);color:var(--text);box-shadow:inset 0 -2px var(--accent)}
            #emote-list button:hover,.template-emote-picker button:hover{background:var(--accent-soft)}
            #template-editor textarea,#template-editor input,.timeout-pop input,.timeout-pop select{border-color:var(--border);background:var(--surface-0);color:var(--text)}
            .template-emote-toggle,.timeout-pop button,.nick-menu button{border-color:var(--border);background:var(--surface-2);color:var(--text)}
            .template-emote-picker,.template-preview,.template-edit-row,.thread-head,.thread-body .thread-msg{border-color:var(--border);background:var(--surface-1);color:var(--text)}
            .template-actions,.thread-head{background:var(--surface-2)}
            .thread-body .thread-msg.thread-current{background:var(--accent-soft);border-left-color:var(--accent)}
            .mention-option{color:var(--text)}.mention-option.active,.mention-option:hover{background:var(--accent-soft)}

            /* PANTONE 7506 uses the chat surfaces from the site, not its pale outer shell. */
            html[data-color-scheme="pantone"] body{background:linear-gradient(180deg,var(--surface-4) 0%,var(--surface-3) 44%,var(--surface-2) 100%)}
            html[data-color-scheme="pantone"] #chat{background:color-mix(in srgb,var(--surface-3) 72%,transparent)}
            html[data-color-scheme="pantone"] #bar,html[data-color-scheme="pantone"] #composer{background:var(--surface-2)}
            html[data-color-scheme="pantone"] #settings-panel{background:var(--panel)}
            html[data-color-scheme="pantone"] #message-input,html[data-color-scheme="pantone"] #emote-search,html[data-color-scheme="pantone"] .theme-config{background:var(--surface-1)}
            html[data-color-scheme="pantone"] .msg{background:transparent;box-shadow:none}
            html[data-color-scheme="pantone"] .mention{background:var(--surface-4);color:#3d3729;box-shadow:inset 0 0 0 1px var(--border)}

            html[data-theme="aero"],html[data-theme="aero"] body{background:radial-gradient(circle at 10% 12%,#fff9 0 3%,transparent 7%),radial-gradient(circle at 78% 20%,#fff7 0 2%,transparent 6%),linear-gradient(180deg,#37bde9 0%,#9ceaff 48%,#eaffff 65%,#6ed267 66%,#2b9d48 100%);background-attachment:fixed}
            html[data-theme="aero"] #chat{background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(224,250,253,.14))}
            html[data-theme="aero"] #bar,html[data-theme="aero"] #settings-panel,html[data-theme="aero"] #composer{background:linear-gradient(180deg,rgba(255,255,255,.46),rgba(181,235,246,.20));backdrop-filter:blur(12px) saturate(1.5)}
            html[data-theme="aero"] .msg{background:rgba(245,254,255,.20);box-shadow:inset 0 1px rgba(255,255,255,.46)}
            html[data-theme="aero"] .text{color:#173744}html[data-theme="aero"] .reply,html[data-theme="aero"] .reply-label,html[data-theme="aero"] .reply-text{color:#5a747c}
            html[data-theme="aero"] .send-choice,html[data-theme="aero"] .template-menu,html[data-theme="aero"] #emote-picker,html[data-theme="aero"] #template-editor,html[data-theme="aero"] .thread-panel,html[data-theme="aero"] #mention-suggest,html[data-theme="aero"] .timeout-pop,html[data-theme="aero"] .nick-menu{background:linear-gradient(145deg,rgba(245,254,255,.58),rgba(173,230,241,.30));border-color:rgba(255,255,255,.84);backdrop-filter:blur(16px) saturate(1.6)}
            @media(max-width:700px){.custom-grid{grid-template-columns:1fr}.theme-config{min-width:100%}}
            /* ---- Кнопки: одни состояния во всех темах (наведение, нажатие, фокус, активная) ---- */
            .bar-btn,.links-btn,#template-toggle,#emote-toggle,#send-message,.send-choice button,.template-menu button,
            .theme-choice,.palette-key-actions button,.custom-palette summary,.timeout-pop button,.nick-menu button,
            .template-emote-toggle,.emote-head button,#template-editor button,#reply-compose button,.thread-head button{
                transition:background-color .14s ease,border-color .14s ease,color .14s ease,box-shadow .14s ease,opacity .14s ease,transform .1s cubic-bezier(.2,.8,.2,1)}
            .bar-btn,.links-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:24px;font-weight:600}
            .bar-btn:active,.links-btn:active,#template-toggle:active,#emote-toggle:active,#send-message:active,.send-choice button:active,
            .template-menu button:active,.theme-choice:active,.palette-key-actions button:active,.timeout-pop button:active,.nick-menu button:active,
            .template-emote-toggle:active,.emote-head button:active,#template-editor button:active{transform:translateY(1px) scale(.97)}
            .bar-btn:focus-visible,.links-btn:focus-visible,#template-toggle:focus-visible,#emote-toggle:focus-visible,#send-message:focus-visible,
            .send-choice button:focus-visible,.template-menu button:focus-visible,.theme-choice:focus-visible,.timeout-pop button:focus-visible,
            .nick-menu button:focus-visible,.emote-head button:focus-visible,#template-editor button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
            button:disabled{opacity:.5;cursor:default;transform:none!important}
            #template-toggle:hover,#emote-toggle:hover,.send-choice button:hover,.template-menu button:hover,.theme-choice:hover,
            .palette-key-actions button:hover,.custom-palette summary:hover,.timeout-pop button:hover,.nick-menu button:hover,
            .template-emote-toggle:hover,#template-editor button:hover{background:var(--surface-3);border-color:var(--accent-strong)}
            .emote-head button:hover{color:var(--text)}
            /* «Отправить» — сплошной акцент, без градиента и свечения */
            #send-message{background:var(--accent);border-color:var(--accent-dark);color:var(--accent-contrast);box-shadow:none;font-weight:700}
            #send-message:hover{background:var(--accent-bright);border-color:var(--accent-dark)}
            #send-message:active{background:var(--accent-dark)}
            /* активные: ⚙ при открытых настройках, ☺ при открытых смайлах — как выбранная тема */
            #emote-toggle.active,#bar:has(~#settings-panel.open) #settings-toggle{border-color:var(--accent-strong);background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent-medium)}
            #settings-toggle .gear{display:inline-block;transition:transform .35s cubic-bezier(.2,.8,.2,1)}
            #bar:has(~#settings-panel.open) #settings-toggle .gear{transform:rotate(90deg)}
            #emote-toggle{transition-property:background-color,border-color,box-shadow,transform}
            #emote-toggle.active{transform:none}
            /* меню выезжают от своей кнопки */
            @keyframes mc-pop-up{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}
            @keyframes mc-pop-down{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
            .send-choice.open,.template-menu.open,#emote-picker.open,#mention-suggest.open{animation:mc-pop-up .13s ease-out}
            .send-choice.open{transform-origin:bottom right}.template-menu.open,#emote-picker.open{transform-origin:bottom left}
            .nick-menu,.timeout-pop{animation:mc-pop-down .13s ease-out;transform-origin:top left}
            #settings-panel.open{animation:mc-pop-down .14s ease-out}
            /* меню ника — обычное контекстное меню: пункты строками, одинаковые линейные иконки */
            .nick-menu{min-width:224px;padding:4px;gap:1px;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.28)}
            .nick-menu .nm-head{display:flex;align-items:center;gap:9px;padding:7px 9px 9px;margin-bottom:3px;border-bottom:1px solid var(--border)}
            .nick-menu .nm-plat{width:20px;height:20px;border-radius:5px;flex:0 0 auto}
            .nick-menu .nm-who{min-width:0;display:grid;gap:1px}
            .nick-menu .nm-title{padding:0;margin:0;border:0;font-size:13px;font-weight:700;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .nick-menu .nm-sub{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .nick-menu button.nm-item{display:flex;align-items:center;gap:10px;width:100%;height:32px;padding:0 9px;border:0;border-radius:6px;
                background:transparent;color:var(--text);font-size:13px;font-weight:500;text-align:left;box-shadow:none}
            .nick-menu button.nm-item svg,.nick-menu .nm-hl>svg{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.7;
                stroke-linecap:round;stroke-linejoin:round;color:var(--muted);transition:color .14s ease,transform .14s ease}
            .nick-menu button.nm-item:hover,.nick-menu button.nm-item:focus-visible{background:var(--accent-soft);border:0;outline:none}
            .nick-menu button.nm-item:hover svg,.nick-menu button.nm-item:focus-visible svg{color:var(--accent);transform:translateX(1px)}
            .nick-menu button.nm-item:active{transform:scale(.98)}
            .nick-menu button.nm-wait.on{background:var(--accent-soft);color:var(--text)}
            .nick-menu button.nm-wait.on svg{color:var(--accent)}
            .nick-menu .nm-sep{height:1px;margin:3px 7px;background:var(--border);opacity:.6}
            .nick-menu .nm-hl{display:flex;align-items:center;gap:10px;height:32px;padding:0 9px}
            .nick-menu .nm-hl-label{flex:1;font-size:13px;color:var(--text)}
            .nick-menu .nm-hl-dots{display:grid;grid-template-columns:repeat(9,16px);gap:7px 6px;justify-content:space-between;padding:2px 11px 9px}
            .nick-menu .nm-hl-dot{width:16px;height:16px;min-width:16px;padding:0;border:0;border-radius:50%;background:var(--c);
                box-shadow:inset 0 0 0 1px rgba(0,0,0,.18);transition:transform .12s cubic-bezier(.2,.8,.2,1),box-shadow .12s}
            .nick-menu .nm-hl-dot:hover{background:var(--c);transform:scale(1.2)}
            .nick-menu .nm-hl-dot:active{transform:scale(.9)}
            .nick-menu .nm-hl-dot.on{border:0;box-shadow:0 0 0 2px var(--panel),0 0 0 3.5px var(--c)}
            .nick-menu .nm-hl-off{width:auto;min-width:0;height:22px;flex:0 0 auto;display:inline-flex;align-items:center;padding:0 8px;border:1px solid var(--border);border-radius:6px;
                background:transparent;color:var(--muted);font-size:11px;font-weight:600;line-height:1;white-space:nowrap}
            .nick-menu .nm-hl-off:hover{color:var(--text);background:var(--accent-soft)}
            /* подтверждение действия (flash: «Скопировано» и т.п.) */
            @keyframes mc-done{0%{transform:scale(1)}40%{transform:scale(1.06)}100%{transform:scale(1)}}
            button.done{animation:mc-done .25s ease-out;border-color:var(--accent-strong);background:var(--accent-soft)}
            @media (prefers-reduced-motion:reduce){
                .send-choice.open,.template-menu.open,#emote-picker.open,#mention-suggest.open,.nick-menu,.timeout-pop,#settings-panel.open,button.done{animation:none}
                #settings-toggle .gear{transition:none}
            }
            /* ---- Лента: ровные строки, время по наведению, спокойные состояния во всех темах ---- */
            #chat{padding:8px 6px 10px}
            #chat::-webkit-scrollbar{width:6px}
            #chat::-webkit-scrollbar-thumb{background:transparent;border-radius:6px}
            #chat:hover::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--text) 22%,transparent)}
            .msg{padding:3px 8px;border-radius:6px;transition:background-color .12s ease;animation:mc-msg-in .16s ease-out}
            .msg+.msg{margin-top:1px}
            .msg:hover{background:color-mix(in srgb,var(--text) 6%,transparent)}
            @keyframes mc-msg-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
            .plat{width:20px;height:20px;border-radius:5px;margin-right:6px;vertical-align:-5px}
            .platform-stat img{width:18px;height:18px;opacity:.9}
            .badge.img{border-radius:3px}
            .name{margin-right:3px}
            /* время — поверх строки при наведении: в разметке строки места не занимает, текст не двигает */
            .msg .ts{position:absolute;top:3px;right:32px;z-index:1;padding:1px 6px;border:1px solid var(--border);border-radius:6px;
                background:var(--panel);color:var(--muted);font-size:11px;line-height:18px;font-variant-numeric:tabular-nums;
                pointer-events:none;user-select:none;opacity:0;transition:opacity .1s ease}
            .msg:hover>.ts{opacity:1}
            .msg:not(:has(>.msg-reply))>.ts{right:4px}
            .thread-msg .ts{position:static;opacity:1;border:0;background:none;padding:0;margin-left:6px}
            html[data-no-time] .msg .ts{display:none}
            .reply,html[data-theme="light"] .reply{margin-left:26px;border-left:2px solid var(--accent-strong);color:var(--muted)}
            .reply-label,.reply-text,html[data-theme="light"] .reply-label,html[data-theme="light"] .reply-text{color:inherit}
            .reply[data-parent-id]:hover,html[data-theme="light"] .reply[data-parent-id]:hover{border-left-color:var(--accent);color:var(--text);background:transparent}
            .msg.reply-target{outline:0;background:var(--accent-medium);box-shadow:inset 3px 0 0 var(--accent)}
            .msg.reply-to-me,.msg.reply-to-me:hover{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
            .msg.awaiting{background:color-mix(in srgb,#f0a400 14%,transparent);box-shadow:inset 3px 0 0 #f0a400}
            .msg.mod-event{opacity:1;border-left:0;font-size:calc(var(--fs) - 1px);color:var(--muted);
                background:color-mix(in srgb,#f0a400 9%,transparent);box-shadow:inset 3px 0 0 #f0a400}
            .msg.removed{opacity:1;text-decoration:none}.msg.removed .text{opacity:.45;text-decoration:line-through}
            #stale-banner{background:var(--accent);color:var(--accent-contrast);letter-spacing:0;font-weight:600;padding:6px 14px;border-radius:999px;
                box-shadow:0 6px 18px color-mix(in srgb,var(--text) 22%,transparent);transition:background-color .14s ease,transform .1s ease}
            #stale-banner:hover{background:var(--accent-bright)}
            #stale-banner:active{transform:translateX(-50%) scale(.97)}
            @media (prefers-reduced-motion:reduce){.msg{animation:none}}
            /* свой срок тайм-аута в меню ленты: поле, ползунок, кнопка на всю ширину */
            .timeout-pop:has(.tp-custom){width:260px}
            .timeout-pop .tp-custom{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--border)}
            .timeout-pop .tp-sub{font-size:11px;color:var(--muted)}
            .timeout-pop .dp{display:flex;flex-direction:column;gap:6px}
            .timeout-pop .dp-row{display:flex;align-items:center;gap:5px}
            .timeout-pop .dp-num{width:64px}
            .timeout-pop .dp-num,.timeout-pop .dp-unit{height:28px;padding:0 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface-0);color:var(--text);font:inherit;font-size:13px}
            .timeout-pop .dp-human{min-width:0;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .timeout-pop .dp-range{width:100%}
            .timeout-pop .tp-set{width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--accent);border-color:var(--accent-dark);color:var(--accent-contrast)}
            .timeout-pop .tp-set:hover{background:var(--accent-bright)}
            .timeout-pop .tp-set:disabled{background:var(--surface-2);border-color:var(--border);color:var(--muted);opacity:1}
            .timeout-pop .dp-range{-webkit-appearance:none;appearance:none;height:20px;margin:0;background:transparent;cursor:pointer}
            .timeout-pop .dp-range::-webkit-slider-runnable-track{height:4px;border-radius:4px;background:linear-gradient(to right,var(--accent) var(--p,0%),color-mix(in srgb,var(--text) 16%,transparent) var(--p,0%))}
            .timeout-pop .dp-range::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;background:var(--panel);border:2px solid var(--accent);transition:transform .1s ease}
            .timeout-pop .dp-range:hover::-webkit-slider-thumb{transform:scale(1.12)}
            .timeout-pop .dp-range:active::-webkit-slider-thumb{transform:scale(.95)}
            .timeout-pop .dp-range:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}

            /* ---- Ответ на сообщение и растущее поле ввода ---- */
            .msg-reply{position:absolute;top:2px;right:4px;width:24px;height:22px;display:none;place-items:center;padding:0;border:1px solid var(--border);
                border-radius:6px;background:var(--panel);color:var(--muted);cursor:pointer;transition:color .12s,background-color .12s,transform .1s}
            .msg-reply svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
            .msg:hover>.msg-reply,.msg-reply:focus-visible{display:grid}
            .msg-reply:hover{color:var(--accent);background:var(--accent-soft)}
            .msg-reply:active{transform:scale(.92)}
            .msg.replying{box-shadow:inset 3px 0 0 var(--accent);background:var(--accent-soft)}
            #reply-compose{min-height:20px;border-left-color:var(--accent);color:var(--muted);font-size:12px}
            #reply-compose b{color:var(--text);font-weight:700;flex:0 0 auto}
            #reply-compose .rc-preview{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            #reply-compose-text{display:flex;gap:6px;min-width:0;overflow:hidden}
            .compose-row{align-items:end}
            #message-input{min-height:34px;max-height:150px;line-height:1.35;overflow-y:hidden;transition:height .08s ease-out}
            .compose-row>button{height:34px}
            @media (prefers-reduced-motion:reduce){#message-input{transition:none}}
            /* ---- Скины ---- */
            .skin-choice[data-skin-choice]:not([data-skin-choice=""])::before{content:'';display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:50%;
                background:var(--sw);vertical-align:-1px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.15)}
            html[data-skin] #chat{background:transparent}
            html[data-skin] :where(.msg){background:transparent;box-shadow:none}
            html[data-skin] :where(.msg:not(.awaiting):not(.reply-to-me):not(.reply-target)):hover{background:var(--accent-soft)}

            /* розовый гламур: блёстки, розовая шапка, пузырьки */
            html[data-skin="glam"] body{background:
                radial-gradient(circle at 20% 30%,#fff 0 1px,transparent 2px) 0 0/34px 34px,
                radial-gradient(circle at 70% 65%,#ffd1ea 0 1.3px,transparent 2.3px) 0 0/52px 52px,
                radial-gradient(circle at 45% 80%,#fff8 0 .8px,transparent 1.8px) 0 0/23px 23px,
                linear-gradient(160deg,#ffd6eb 0%,#ffeef6 45%,#ffc8e4 100%);background-attachment:fixed}
            html[data-skin="glam"] #bar{background:linear-gradient(90deg,#ff5cae,#ff2d95 55%,#ff6fd0);border-bottom:0;box-shadow:0 4px 18px rgba(255,45,149,.35)}
            html[data-skin="glam"] #st,html[data-skin="glam"] .platform-stat span,html[data-skin="glam"] .sum-mark{color:#fff}
            html[data-skin="glam"] #platform-stats{border-color:rgba(255,255,255,.45)}
            html[data-skin="glam"] #bar .bar-btn{background:rgba(255,255,255,.22);border-color:rgba(255,255,255,.55);color:#fff}
            html[data-skin="glam"] #bar .bar-btn:hover{background:rgba(255,255,255,.34)}
            html[data-skin="glam"] #dot{background:#fff;box-shadow:0 0 8px #fff}
            html[data-skin="glam"] .msg{border-radius:14px}
            html[data-skin="glam"] :where(.msg:not(.awaiting):not(.reply-to-me):not(.reply-target)):hover{background:rgba(255,255,255,.55)}
            html[data-skin="glam"] #composer{background:rgba(255,245,250,.85);border-top:1px solid #f4a6cd;backdrop-filter:blur(6px)}
            html[data-skin="glam"] #send-message{background:linear-gradient(135deg,#ff5cae,#ff2d95);border-color:#d4006f;box-shadow:0 3px 12px rgba(255,45,149,.4)}
            html[data-skin="glam"] #message-input{border-radius:12px}
            html[data-skin="glam"] ::selection{background:#ff6fb5;color:#fff}
            html[data-skin="glam"] #chat:hover::-webkit-scrollbar-thumb{background:#ff8cc6}

            /* неон: синтвейв-сетка, свечение */
            html[data-skin="neon"] body{background:
                linear-gradient(transparent 0 calc(100% - 1px),rgba(255,43,214,.07) 0) 0 0/100% 32px,
                linear-gradient(90deg,transparent 0 calc(100% - 1px),rgba(0,240,255,.05) 0) 0 0/32px 100%,
                radial-gradient(ellipse at 50% -10%,#3a0d7a 0%,#0a0420 60%);background-attachment:fixed}
            html[data-skin="neon"] #bar{background:rgba(10,4,32,.85);border-bottom:1px solid #ff2bd6;box-shadow:0 0 14px rgba(255,43,214,.45)}
            html[data-skin="neon"] #st{color:#00f0ff;text-shadow:0 0 6px #00f0ff,0 0 14px rgba(0,240,255,.6);letter-spacing:.08em}
            html[data-skin="neon"] .name{text-shadow:0 0 6px currentColor}
            html[data-skin="neon"] .text a{color:#00f0ff}
            html[data-skin="neon"] #dot{background:#00f0ff;box-shadow:0 0 8px #00f0ff}
            html[data-skin="neon"] #composer{background:rgba(18,10,46,.9);border-top:1px solid #3b1f6e}
            html[data-skin="neon"] #send-message{box-shadow:0 0 12px rgba(255,43,214,.6)}
            html[data-skin="neon"] .msg.highlighted{text-shadow:none}

            /* матрица: моноширинный зелёный терминал со строками развёртки */
            html[data-skin="matrix"] body{font-family:Consolas,'Courier New',monospace;background:
                repeating-linear-gradient(0deg,rgba(0,255,65,.035) 0 1px,transparent 1px 3px),#000}
            html[data-skin="matrix"] .text{color:#9dffad}
            html[data-skin="matrix"] .name{text-shadow:0 0 4px rgba(0,255,65,.45)}
            html[data-skin="matrix"] #bar{background:#000;border-bottom:1px solid #00ff41}
            html[data-skin="matrix"] #st{color:#00ff41;text-shadow:0 0 6px #00ff41}
            html[data-skin="matrix"] .msg,html[data-skin="matrix"] .bar-btn,html[data-skin="matrix"] #message-input,
            html[data-skin="matrix"] #send-message,html[data-skin="matrix"] .nick-menu,html[data-skin="matrix"] .timeout-pop{border-radius:2px}
            html[data-skin="matrix"] #composer{background:#000;border-top:1px solid #0f3d17}
            html[data-skin="matrix"] #message-input{font-family:inherit}

            /* люкс: PANTONE 7506 в тёмной теме — как на pzdcflix (тёплый графит, кремовый акцент 7506) */
            html[data-skin="lux"] body{background:#0f0e0c}
            html[data-skin="lux"] #bar{background:#171512;border-bottom:1px solid rgba(239,219,178,.08)}
            html[data-skin="lux"] #st{color:#f2ece1;font-weight:820;letter-spacing:-.02em}
            html[data-skin="lux"] #dot{background:#7bc47f;box-shadow:none}
            html[data-skin="lux"] .bar-btn{background:#1e1b17;border-color:#2c2822;border-radius:9px;color:#f2ece1}
            html[data-skin="lux"] .bar-btn:hover{background:#27231e}
            html[data-skin="lux"] #composer{background:#0f0e0c;border-top:1px solid rgba(239,219,178,.08)}
            html[data-skin="lux"] #message-input{background:#171512;border-color:#2c2822;border-radius:12px}
            html[data-skin="lux"] #message-input:focus{border-color:rgba(239,219,178,.45);outline:none}
            html[data-skin="lux"] #send-message{background:#efdbb2;border-color:#efdbb2;color:#1b170f;border-radius:9px;font-weight:800}
            html[data-skin="lux"] #send-message:hover{background:#f6e7c8}
            html[data-skin="lux"] .msg{border-radius:9px}
            html[data-skin="lux"] :where(.msg:not(.awaiting):not(.reply-to-me):not(.reply-target)):hover{background:#171512}
            html[data-skin="lux"] .nick-menu,html[data-skin="lux"] .timeout-pop,html[data-skin="lux"] #emote-picker,
            html[data-skin="lux"] .send-choice,html[data-skin="lux"] .template-menu,html[data-skin="lux"] #mention-suggest{
                background:#171512;border-color:#2c2822;border-radius:12px;box-shadow:0 1px 2px rgb(0 0 0/.3),0 10px 30px rgb(0 0 0/.35)}

            /* сакура: светлая, лепестки по фону */
            html[data-skin="sakura"] body{background:
                radial-gradient(ellipse 9px 5px at 15% 20%,rgba(247,182,200,.55) 55%,transparent 62%) 0 0/170px 150px,
                radial-gradient(ellipse 7px 4px at 70% 55%,rgba(251,202,215,.6) 55%,transparent 62%) 0 0/210px 190px,
                linear-gradient(180deg,#fff7f9,#ffeef3);background-attachment:fixed}
            html[data-skin="sakura"] #bar{background:rgba(255,250,251,.9);border-bottom:1px solid #f2c6d0}
            html[data-skin="sakura"] .msg{border-radius:10px}
            html[data-skin="sakura"] #composer{background:rgba(255,250,251,.92);border-top:1px solid #f2c6d0}
            /* Выделение сообщений человека: тонировка поверх фона любой темы (inset-слой не трогает background) */
            .msg.highlighted:not(.awaiting):not(.reply-to-me){box-shadow:inset 3px 0 0 var(--mc-hl,#ffd700),inset 0 0 0 999px color-mix(in srgb,var(--mc-hl,#ffd700) 26%,transparent)!important}
        `;
        document.head.appendChild(style);
        document.body.innerHTML = `
            <div id="bar">
                <span class="bar-left"><button id="clear-chat" class="bar-btn" title="Очистить текущую ленту">Очистить</button></span>
                <span class="bar-center">
                    <span id="dot"></span>
                    <span id="st">ДУРКА</span>
                    <span id="platform-stats">
                        <span class="platform-stat total" title="Общий онлайн"><span class="sum-mark">Σ</span><span id="total-online">?</span></span>
                        <span class="platform-stat" title="Kick online"><img src="${KICK_ICON_URL}" alt="Kick"><span id="kick-online">?</span></span>
                        <span class="platform-stat" title="VK online"><img src="${VK_ICON_URL}" alt="VK"><span id="vk-online">?</span></span>
                        <span class="platform-stat" title="pzdcflix.live online"><img src="${SITE_ICON_URL}" alt="Сайт"><span id="site-online">?</span></span>
                    </span>
                </span>
                <span class="bar-right">
                    <button id="settings-toggle" class="bar-btn" title="Настройки"><span class="gear">⚙</span></button>
                </span>
            </div>
            <div id="settings-panel">
                <section class="theme-config" aria-label="Платформы">
                    <div class="theme-row">
                        <strong>Чаты</strong>
                        <button type="button" class="theme-choice platform-toggle" data-platform-toggle="kick" aria-pressed="true"><img src="${KICK_ICON_URL}" alt="">Kick<span class="platform-state">вкл</span></button>
                        <button type="button" class="theme-choice platform-toggle" data-platform-toggle="vk" aria-pressed="true"><img src="${VK_ICON_URL}" alt="">VK<span class="platform-state">вкл</span></button>
                        <small id="platform-status" class="palette-status">Отключённый чат пропадает из ленты, онлайна и отправки</small>
                    </div>
                    <div class="theme-row">
                        <strong>Время</strong>
                        <button type="button" class="theme-choice" id="time-toggle" aria-pressed="true">При наведении</button>
                    </div>
                </section>
                <section class="theme-config" aria-label="Тема и палитра">
                    <div class="theme-row">
                        <strong>Тема</strong>
                        <button type="button" class="theme-choice" data-theme-choice="dark">Тёмная</button>
                        <button type="button" class="theme-choice" data-theme-choice="light">Светлая</button>
                        <button type="button" class="theme-choice" data-theme-choice="aero">Aero</button>
                    </div>
                    <div class="theme-row skin-row">
                        <strong>Скин</strong>
                        <button type="button" class="theme-choice skin-choice" data-skin-choice="">Без скина</button>
                        <button type="button" class="theme-choice skin-choice" data-skin-choice="glam" style="--sw:linear-gradient(135deg,#ff5cae,#ffc4e1)">Розовый гламур</button>
                        <button type="button" class="theme-choice skin-choice" data-skin-choice="neon" style="--sw:linear-gradient(135deg,#ff2bd6,#00f0ff)">Неон</button>
                        <button type="button" class="theme-choice skin-choice" data-skin-choice="matrix" style="--sw:linear-gradient(135deg,#00ff41,#003b10)">Матрица</button>
                        <button type="button" class="theme-choice skin-choice" data-skin-choice="lux" style="--sw:linear-gradient(135deg,#efdbb2 50%,#171512 50%)" title="PANTONE 7506 в тёмной теме, как на pzdcflix">Люкс</button>
                        <button type="button" class="theme-choice skin-choice" data-skin-choice="sakura" style="--sw:linear-gradient(135deg,#f07a9c,#fde8ee)">Сакура</button>
                    </div>
                    <div class="palette-head"><strong>Палитра</strong><output id="palette-current">PANTONE 7506 C · светлая</output></div>
                    <div id="palette-swatches" role="group" aria-label="Цветовая палитра"></div>
                    <details id="custom-palette" class="custom-palette">
                        <summary>Своя палитра</summary>
                        <div class="custom-grid">
                            <label><span>Акцент</span><input id="custom-accent-hex" type="text" maxlength="7"><input id="custom-accent" type="color"></label>
                            <label><span>Фон</span><input id="custom-background-hex" type="text" maxlength="7"><input id="custom-background" type="color"></label>
                            <label><span>Панели</span><input id="custom-panel-hex" type="text" maxlength="7"><input id="custom-panel" type="color"></label>
                        </div>
                        <div class="custom-row">
                            <input id="palette-key" type="text" maxlength="32" placeholder="PZ1-…" spellcheck="false">
                            <span class="palette-key-actions"><button id="palette-copy" type="button">Копировать</button><button id="palette-apply" type="button">Применить</button><button id="palette-reset" type="button">Сбросить</button></span>
                            <small id="palette-status" class="palette-status">Изменения применяются сразу</small>
                        </div>
                    </details>
                </section>
                <label>Размер текста:</label>
                <input type="range" id="font-slider" min="10" max="50" value="14">
                <span id="font-val">14px</span>
                <button id="links-btn" class="links-btn" title="Показать все ссылки из текущего буфера">Получить все ссылки</button>
            </div>
            <div id="chat"></div>
            <div id="stale-wrap"><div id="stale-banner" title="Лента остановлена, пока ты листаешь вверх">↓ К новым сообщениям</div></div>
            <div id="composer">
                <div id="reply-compose"><span id="reply-compose-text"></span><button id="reply-cancel" title="Отменить ответ">×</button></div>
                <div class="compose-row">
                    <button id="template-toggle" title="Шаблоны">Шаблоны</button>
                    <button id="emote-toggle" title="Смайлы">☺</button>
                    <textarea id="message-input" rows="1" placeholder="Сообщение…"></textarea>
                    <button id="send-message" title="Выбрать чат и отправить">Отправить</button>
                </div>
                <div id="send-choice" class="send-choice"><button data-send="kick">Kick</button><button data-send="vk">VK</button><button data-send="both">Оба</button></div>
                <div id="mention-suggest"></div>
                <div id="template-menu" class="template-menu"></div>
                <div id="emote-picker">
                    <div class="emote-head"></div>
                    <input id="emote-search" type="search" placeholder="Поиск смайлов">
                    <div id="emote-list"></div>
                </div>
            </div>
            <div id="template-editor"></div>
            <aside id="thread-panel" class="thread-panel" role="dialog" aria-label="Ветка ответов" aria-hidden="true">
                <div class="thread-head">
                    <strong id="thread-title">Ветка ответов</strong>
                    <button id="thread-close" type="button" aria-label="Закрыть">×</button>
                </div>
                <div id="thread-body" class="thread-body"></div>
            </aside>`;
        document.title = 'Merged Chat';

        const chat = document.getElementById('chat');
        const st = document.getElementById('st');
        const settingsPanel = document.getElementById('settings-panel');
        const fontSlider = document.getElementById('font-slider');
        const fontVal = document.getElementById('font-val');
        const totalOnlineEl = document.getElementById('total-online');
        const siteOnlineEl = document.getElementById('site-online');
        const kickOnlineEl = document.getElementById('kick-online');
        const vkOnlineEl = document.getElementById('vk-online');
        const messageInput = document.getElementById('message-input');
        const sendChoice = document.getElementById('send-choice');
        const templateMenu = document.getElementById('template-menu');
        const templateEditor = document.getElementById('template-editor');
        const emoteToggle = document.getElementById('emote-toggle');
        const emotePicker = document.getElementById('emote-picker');
        const emoteSearch = document.getElementById('emote-search');
        const emoteList = document.getElementById('emote-list');
        const mentionSuggest = document.getElementById('mention-suggest');
        const replyCompose = document.getElementById('reply-compose');
        const replyComposeText = document.getElementById('reply-compose-text');
        const threadPanel = document.getElementById('thread-panel');
        const threadBody = document.getElementById('thread-body');
        const threadTitle = document.getElementById('thread-title');

        // Same theme and palette model as pzdcflix.live. Defaults intentionally
        // match the site: Light + PANTONE 7506 C.
        const THEME_KEY = 'grpzdc-theme-v1';
        const ACCENT_KEY = 'grpzdc-accent-v1';
        const CUSTOM_PALETTE_KEY = 'grpzdc-custom-palette-v1';
        const DEFAULT_ACCENT = 'pantone-7506';
        const DEFAULT_CUSTOM_PALETTE = { accent:'#53fc18', background:'#0a0a10', panel:'#13131a' };
        const ACCENT_PRESETS = [
            { id:'pantone-7506', name:'PANTONE 7506 C · светлая', code:'7506', color:'#7a6337', preview:'#efdbb2', base:'#efdbb2', scheme:'pantone' },
            { id:'kick', name:'Kick', color:'#53fc18' },
            { id:'vk', name:'VK', color:'#2d8cff' },
            { id:'grpzdc', name:'GRPZDC', color:'#16824a' },
            { id:'logicalstack', name:'LogicalStack', color:'#6495ed' },
            { id:'lev', name:'lev · старый тёмный', color:'#53fc18', preview:'#3a3a44', scheme:'legacy' },
            { id:'a_nana_z', name:'a_nana_z', color:'#e01050' },
            { id:'whahappen', name:'whahappen', color:'#3b6ae8' },
            { id:'matte', name:'Матовый чёрный', color:'#dedede', preview:'#050505', scheme:'matte' },
        ];
        const rgb = value => {
            const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(value || '').trim());
            return match ? { r:parseInt(match[1],16), g:parseInt(match[2],16), b:parseInt(match[3],16) } : null;
        };
        const hex = value => {
            const raw = String(value || '').trim().replace(/^#/,'');
            if(/^[\da-f]{3}$/i.test(raw)) return '#' + [...raw].map(char => char + char).join('').toLowerCase();
            return /^[\da-f]{6}$/i.test(raw) ? '#' + raw.toLowerCase() : '';
        };
        const rgbHex = value => '#' + [value.r,value.g,value.b].map(item => Math.round(item).toString(16).padStart(2,'0')).join('');
        const mix = (first, second, amount) => {
            const a = rgb(first), b = rgb(second);
            return rgbHex({ r:a.r+(b.r-a.r)*amount, g:a.g+(b.g-a.g)*amount, b:a.b+(b.b-a.b)*amount });
        };
        const hsl = ({r,g,b}) => {
            const values = [r,g,b].map(value => value/255), max=Math.max(...values), min=Math.min(...values), light=(max+min)/2;
            if(max===min) return {h:0,s:0,l:light*100};
            const delta=max-min, saturation=delta/(1-Math.abs(2*light-1));
            let hue=max===values[0] ? 60*(((values[1]-values[2])/delta)%6) : max===values[1] ? 60*(((values[2]-values[0])/delta)+2) : 60*(((values[0]-values[1])/delta)+4);
            if(hue<0) hue+=360;
            return {h:hue,s:saturation*100,l:light*100};
        };
        const hslColor = (h,s,l) => `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
        const luminance = color => { const c=rgb(color); return (0.2126*c.r+0.7152*c.g+0.0722*c.b)/255; };
        let customPalette = (() => {
            try {
                const saved=JSON.parse(localStorage.getItem(CUSTOM_PALETTE_KEY)||'{}');
                return Object.fromEntries(Object.entries(DEFAULT_CUSTOM_PALETTE).map(([key,fallback]) => [key,hex(saved[key])||fallback]));
            } catch(error) { return {...DEFAULT_CUSTOM_PALETTE}; }
        })();
        const customIsLight = () => luminance(customPalette.background)*.35+luminance(customPalette.panel)*.65>.58;
        const presetFor = value => {
            const id=String(value||'').toLowerCase();
            if(id==='custom') return {id:'custom',name:'Своя палитра',color:customPalette.accent,preview:customPalette.background,scheme:'custom'};
            return ACCENT_PRESETS.find(item => item.id===id || item.color.toLowerCase()===id) || ACCENT_PRESETS[0];
        };
        // Скины — готовые оформления поверх темы и палитры: свои цвета (ниже, SKINS) и своё оформление (CSS по html[data-skin]).
        // Выбрал тему или палитру руками — скин снимается.
        const SKIN_KEY = 'grpzdc-skin-v1';
        const SKINS = {
            glam: { base:'light', vars:{ '--bg':'#ffe6f2','--panel':'#fff5fa','--border':'#f4a6cd','--text':'#4a1235','--muted':'#a0587f',
                '--surface-0':'#fff0f7','--surface-1':'#fff8fb','--surface-2':'#ffd9ec','--surface-3':'#ffc4e1','--surface-4':'#ffadd5',
                '--accent':'#ff2d95','--accent-bright':'#ff5cae','--accent-dark':'#d4006f','--accent-contrast':'#fff','--accent-rgb':'255 45 149',
                '--accent-soft':'rgba(255,45,149,.12)','--accent-medium':'rgba(255,45,149,.22)','--accent-strong':'rgba(255,45,149,.45)','--pz-glow':'rgba(255,45,149,.4)' } },
            neon: { base:'dark', vars:{ '--bg':'#0a0420','--panel':'#120a2e','--border':'#3b1f6e','--text':'#f3eaff','--muted':'#a48cd0',
                '--surface-0':'#0d0626','--surface-1':'#140b33','--surface-2':'#1b0f42','--surface-3':'#261558','--surface-4':'#321c70',
                '--accent':'#ff2bd6','--accent-bright':'#ff6be4','--accent-dark':'#b8009a','--accent-contrast':'#fff','--accent-rgb':'255 43 214',
                '--accent-soft':'rgba(255,43,214,.13)','--accent-medium':'rgba(255,43,214,.24)','--accent-strong':'rgba(255,43,214,.5)','--pz-glow':'rgba(255,43,214,.55)' } },
            matrix: { base:'dark', vars:{ '--bg':'#000','--panel':'#020a03','--border':'#0f3d17','--text':'#b6ffbf','--muted':'#3fa04f',
                '--surface-0':'#010601','--surface-1':'#031005','--surface-2':'#051a08','--surface-3':'#08260c','--surface-4':'#0c3412',
                '--accent':'#00ff41','--accent-bright':'#5cff7f','--accent-dark':'#00b32d','--accent-contrast':'#001a07','--accent-rgb':'0 255 65',
                '--accent-soft':'rgba(0,255,65,.1)','--accent-medium':'rgba(0,255,65,.2)','--accent-strong':'rgba(0,255,65,.42)','--pz-glow':'rgba(0,255,65,.5)' } },
            // тёмная редакция PANTONE 7506 с сайта (pz-palette.js, схема heritage)
            lux: { base:'dark', vars:{ '--bg':'#0f0e0c','--panel':'#171512','--border':'#2c2822','--text':'#f2ece1','--muted':'#a69d8d',
                '--surface-0':'#121110','--surface-1':'#171512','--surface-2':'#1e1b17','--surface-3':'#27231e','--surface-4':'#322d26',
                '--accent':'#efdbb2','--accent-bright':'hsl(40 65% 88%)','--accent-dark':'hsl(40 39% 54%)','--accent-contrast':'#1b170f','--accent-rgb':'239 219 178',
                '--accent-soft':'rgba(239,219,178,.12)','--accent-medium':'rgba(239,219,178,.22)','--accent-strong':'rgba(239,219,178,.45)','--pz-glow':'rgba(239,219,178,.22)' } },
            sakura: { base:'light', vars:{ '--bg':'#fff4f6','--panel':'#fffafb','--border':'#f2c6d0','--text':'#3d2a2f','--muted':'#8d6f77',
                '--surface-0':'#fff7f9','--surface-1':'#fffbfc','--surface-2':'#fde8ee','--surface-3':'#fad8e2','--surface-4':'#f6c6d4',
                '--accent':'#e75480','--accent-bright':'#f07a9c','--accent-dark':'#c13a64','--accent-contrast':'#fff','--accent-rgb':'231 84 128',
                '--accent-soft':'rgba(231,84,128,.11)','--accent-medium':'rgba(231,84,128,.2)','--accent-strong':'rgba(231,84,128,.42)','--pz-glow':'rgba(231,84,128,.35)' } }
        };
        const currentSkin = () => SKINS[localStorage.getItem(SKIN_KEY)] ? localStorage.getItem(SKIN_KEY) : '';
        function applySkin(id, save=true){
            const skin = SKINS[id] ? id : '';
            if(save){ if(skin) localStorage.setItem(SKIN_KEY, skin); else localStorage.removeItem(SKIN_KEY); }
            document.querySelectorAll('[data-skin-choice]').forEach(b => b.classList.toggle('active', b.dataset.skinChoice === skin));
            if(skin){
                document.documentElement.dataset.skin = skin;
                applyTheme(SKINS[skin].base, false);
            } else {
                delete document.documentElement.dataset.skin;
                const saved = localStorage.getItem(THEME_KEY);
                applyTheme(['dark','light','aero'].includes(saved) ? saved : 'light', false);
            }
            applyPalette(localStorage.getItem(ACCENT_KEY)||DEFAULT_ACCENT, false);
        }
        function applyTheme(value, save=true){
            if(save && currentSkin()){ localStorage.removeItem(SKIN_KEY); delete document.documentElement.dataset.skin; document.querySelectorAll('[data-skin-choice]').forEach(b => b.classList.toggle('active', b.dataset.skinChoice === '')); }
            const theme=['dark','light','aero'].includes(value) ? value : 'light';
            document.documentElement.dataset.theme=theme;
            document.querySelectorAll('[data-theme-choice]').forEach(button => button.classList.toggle('active',button.dataset.themeChoice===theme && !document.documentElement.dataset.skin));
            if(save) localStorage.setItem(THEME_KEY,theme);
        }
        function applyPalette(value, save=true){
            if(save && currentSkin()){ localStorage.removeItem(SKIN_KEY); delete document.documentElement.dataset.skin; document.querySelectorAll('[data-skin-choice]').forEach(b => b.classList.toggle('active', b.dataset.skinChoice === '')); }
            const skinNow = currentSkin();
            const preset=presetFor(value);
            if(skinNow){ /* тему держит скин */ }
            else if(preset.scheme==='pantone'){
                if(!['light','aero'].includes(document.documentElement.dataset.theme)) applyTheme('light');
            } else if(preset.scheme==='custom'){
                if(document.documentElement.dataset.theme!=='aero') applyTheme(customIsLight()?'light':'dark');
            } else if(preset.scheme && !['dark','aero'].includes(document.documentElement.dataset.theme)) applyTheme('dark');
            const color=rgb(preset.color)||rgb('#7a6337'), tone=hsl(color), light=['light','aero'].includes(document.documentElement.dataset.theme), saturation=Math.min(30,Math.max(4,tone.s*.28));
            const root=document.documentElement.style, accent=rgbHex(color), lum=luminance(accent);
            const set=(key,val)=>root.setProperty(key,val);
            set('--accent',accent);set('--accent-rgb',`${color.r} ${color.g} ${color.b}`);set('--pz-glow',`rgba(${color.r},${color.g},${color.b},.35)`);set('--accent-soft',`rgba(${color.r},${color.g},${color.b},.12)`);set('--accent-medium',`rgba(${color.r},${color.g},${color.b},.22)`);set('--accent-strong',`rgba(${color.r},${color.g},${color.b},.45)`);
            set('--accent-bright',hslColor(tone.h,Math.max(45,tone.s),Math.min(72,tone.l+9)));set('--accent-dark',hslColor(tone.h,Math.max(35,tone.s),Math.max(24,tone.l-12)));set('--accent-contrast',lum>.62?'#071007':'#fff');
            set('--bg',hslColor(tone.h,saturation,light?96:5));set('--panel',hslColor(tone.h,saturation,light?99:8));set('--border',hslColor(tone.h,saturation*.7,light?84:17));set('--text',hslColor(tone.h,light?12:10,light?10:94));set('--muted',hslColor(tone.h,light?10:9,light?42:66));
            set('--surface-0',hslColor(tone.h,saturation,light?97:6));set('--surface-1',hslColor(tone.h,saturation,light?99:9));set('--surface-2',hslColor(tone.h,saturation,light?94:12));set('--surface-3',hslColor(tone.h,saturation,light?90:16));set('--surface-4',hslColor(tone.h,saturation,light?86:21));
            if(preset.scheme==='legacy') Object.entries({'--bg':'#0a0a10','--panel':'#13131a','--border':'#262630','--text':'#efeff1','--muted':'#9d9dae','--surface-0':'#0d0d13','--surface-1':'#101016','--surface-2':'#15151d','--surface-3':'#222226','--surface-4':'#2d2d34'}).forEach(([key,val])=>set(key,val));
            if(preset.scheme==='matte') Object.entries({'--bg':'#030303','--panel':'#080808','--border':'#202020','--text':'#ededed','--muted':'#8b8b8b','--surface-0':'#050505','--surface-1':'#090909','--surface-2':'#0d0d0d','--surface-3':'#171717','--surface-4':'#222','--accent-bright':'#f2f2f2','--accent-dark':'#8a8a8a','--accent-contrast':'#050505','--pz-glow':'rgba(255,255,255,.08)'}).forEach(([key,val])=>set(key,val));
            if(preset.scheme==='pantone') { const base=preset.base; Object.entries({'--bg':mix(base,'#ffffff',.68),'--panel':mix(base,'#ffffff',.88),'--border':mix(base,'#4c463b',.28),'--text':'#28251f','--muted':'#6d6659','--surface-0':mix(base,'#ffffff',.77),'--surface-1':mix(base,'#ffffff',.84),'--surface-2':mix(base,'#ffffff',.64),'--surface-3':mix(base,'#ffffff',.48),'--surface-4':mix(base,'#ffffff',.32)}).forEach(([key,val])=>set(key,val)); }
            if(preset.scheme==='custom') { const isLight=customIsLight(), toward=isLight?'#000000':'#ffffff', text=isLight?'#151515':'#f1f1f1'; Object.entries({'--bg':customPalette.background,'--panel':customPalette.panel,'--border':mix(customPalette.panel,toward,isLight?.16:.14),'--text':text,'--muted':mix(text,customPalette.background,.43),'--surface-0':mix(customPalette.background,customPalette.panel,.38),'--surface-1':customPalette.panel,'--surface-2':mix(customPalette.panel,toward,.04),'--surface-3':mix(customPalette.panel,toward,.09),'--surface-4':mix(customPalette.panel,toward,.15)}).forEach(([key,val])=>set(key,val)); }
            if(document.documentElement.dataset.theme==='aero') Object.entries({'--bg':'#bcecff','--panel':'#f7feff','--border':'#70bdd2','--text':'#143747','--muted':'#537783','--surface-0':'#dff8ff','--surface-1':'#f4fdff','--surface-2':'#cceff7','--surface-3':'#afe4ef','--surface-4':'#8bd7e6'}).forEach(([key,val])=>set(key,val));
            document.documentElement.dataset.colorScheme=preset.scheme||'tinted';
            if(skinNow){
                Object.entries(SKINS[skinNow].vars).forEach(([key,val])=>set(key,val));
                document.documentElement.dataset.colorScheme='skin';
            }
            document.getElementById('palette-current').textContent=skinNow ? 'скин: ' + document.querySelector(`[data-skin-choice="${skinNow}"]`).textContent : preset.name;
            document.querySelectorAll('.palette-swatch').forEach(button=>button.classList.toggle('active',button.dataset.accentId===preset.id));
            document.getElementById('custom-palette').classList.toggle('active',preset.id==='custom');
            if(save) localStorage.setItem(ACCENT_KEY,preset.id);
        }
        function paletteKey(){ return `PZ1-${customPalette.accent.slice(1)}-${customPalette.background.slice(1)}-${customPalette.panel.slice(1)}`.toUpperCase(); }
        function parsePaletteKey(value){ const match=/^PZ1-([\dA-F]{6})-([\dA-F]{6})-([\dA-F]{6})$/i.exec(String(value||'').trim()); return match?{accent:'#'+match[1].toLowerCase(),background:'#'+match[2].toLowerCase(),panel:'#'+match[3].toLowerCase()}:null; }
        function syncCustom(){
            ['accent','background','panel'].forEach(key=>{ document.getElementById(`custom-${key}`).value=customPalette[key];document.getElementById(`custom-${key}-hex`).value=customPalette[key]; });
            document.getElementById('palette-key').value=paletteKey();
        }
        function updateCustom(key,value){
            const normalized=hex(value), text=document.getElementById(`custom-${key}-hex`); text.classList.toggle('invalid',!normalized);if(!normalized)return;
            customPalette={...customPalette,[key]:normalized};localStorage.setItem(CUSTOM_PALETTE_KEY,JSON.stringify(customPalette));syncCustom();applyPalette('custom');
        }
        const swatches=document.getElementById('palette-swatches');
        ACCENT_PRESETS.forEach(preset=>{ const button=document.createElement('button');button.type='button';button.className='palette-swatch';button.dataset.accentId=preset.id;button.title=preset.name;button.style.setProperty('--swatch',preset.preview||preset.color);button.innerHTML=preset.code?`<span>${preset.code}</span>`:'';button.addEventListener('click',()=>applyPalette(preset.id));swatches.appendChild(button); });
        document.querySelectorAll('[data-theme-choice]').forEach(button=>button.addEventListener('click',()=>{applyTheme(button.dataset.themeChoice);applyPalette(localStorage.getItem(ACCENT_KEY)||DEFAULT_ACCENT,false);}));
        document.querySelectorAll('[data-skin-choice]').forEach(button=>button.addEventListener('click',()=>applySkin(button.dataset.skinChoice)));
        ['accent','background','panel'].forEach(key=>{ const picker=document.getElementById(`custom-${key}`),text=document.getElementById(`custom-${key}-hex`);picker.addEventListener('input',()=>updateCustom(key,picker.value));text.addEventListener('input',()=>updateCustom(key,text.value));text.addEventListener('focus',()=>text.select()); });
        document.getElementById('palette-key').addEventListener('input',event=>{ const parsed=parsePaletteKey(event.target.value);if(!parsed)return;customPalette=parsed;localStorage.setItem(CUSTOM_PALETTE_KEY,JSON.stringify(customPalette));syncCustom();applyPalette('custom');document.getElementById('palette-status').textContent='Палитра применена'; });
        document.getElementById('palette-apply').addEventListener('click',()=>{ const parsed=parsePaletteKey(document.getElementById('palette-key').value);if(!parsed){document.getElementById('palette-status').textContent='Неверный ключ';return;}customPalette=parsed;localStorage.setItem(CUSTOM_PALETTE_KEY,JSON.stringify(customPalette));syncCustom();applyPalette('custom'); });
        document.getElementById('palette-copy').addEventListener('click',async()=>{syncCustom();try{await navigator.clipboard.writeText(paletteKey());}catch(error){document.getElementById('palette-key').select();document.execCommand('copy');}document.getElementById('palette-status').textContent='Ключ скопирован';});
        document.getElementById('palette-reset').addEventListener('click',()=>{customPalette={...DEFAULT_CUSTOM_PALETTE};localStorage.setItem(CUSTOM_PALETTE_KEY,JSON.stringify(customPalette));syncCustom();applyPalette('custom');document.getElementById('palette-status').textContent='Палитра сброшена';});
        syncCustom();
        applyTheme(['dark','light','aero'].includes(localStorage.getItem(THEME_KEY))?localStorage.getItem(THEME_KEY):'light',false);
        applyPalette(localStorage.getItem(ACCENT_KEY)||DEFAULT_ACCENT,false);
        if(currentSkin()) applySkin(currentSkin(), false);
        else document.querySelectorAll('[data-skin-choice]').forEach(b => b.classList.toggle('active', b.dataset.skinChoice === ''));
        if(localStorage.getItem(ACCENT_KEY)==='custom') document.getElementById('custom-palette').open=true;
        let selectedReply = null;
        let selectedMention = null;
        let selectedTemplate = null;
        let emoteTab = 'kickChannel';
        let emoteCatalog = { kickChannel:[], kickGlobal:[], kickEmoji:[], kickRecent:[], sevenTv:[], vkChannel:[], vkRecent:[] };
        let composeEmotePlatform = '';
        let canSendBoth = false;
        let platformsEnabled = platformSettings();
        const platformOn = platform => platformsEnabled[platform] !== false;
        const platformLabel = platform => platform === 'kick' ? 'Kick' : 'VK';
        function soleEnabledPlatform(){
            const on = ['kick','vk'].filter(platformOn);
            return on.length === 1 ? on[0] : '';
        }
        function defaultSendTitle(){
            const sole = soleEnabledPlatform();
            return sole ? `Отправить в ${platformLabel(sole)}` : 'Выбрать чат и отправить';
        }
        const currentUsers = GM_getValue(CURRENT_USERS_KEY, {}) || {};
        const privilegedUsers = GM_getValue(PRIVILEGED_USERS_KEY, {}) || {};
        const chatUsers = new Map();
        let mentionItems = [];
        let mentionActive = -1;
        let mentionAnchor = null;
        const KICK_BADGE_EMOJI = { broadcaster:'🎬', moderator:'⚔️', vip:'💎', og:'🏅', founder:'👑', subscriber:'⭐', sub_gifter:'🎁' };
        // Оригинальные SVG значков Kick (вытащены из бандла kick.com), зашиты как data-URI
        const KICK_BADGE_SVG = {
            broadcaster: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.6773 22.1533C17.3698 22.1533 18.8182 21.5507 20.0233 20.3461C21.2282 19.1415 21.8307 17.6924 21.8307 16V6.15401C21.8307 4.46162 21.2286 3.01305 20.0233 1.80784C18.8182 0.602907 17.3698 0 15.6773 0C13.9849 0 12.5363 0.602907 11.3311 1.80784C10.1259 3.01285 9.52344 4.46162 9.52344 6.15401V16C9.52344 17.6923 10.1262 19.1415 11.3311 20.3461C12.5361 21.5507 13.9849 22.1533 15.6773 22.1533Z" fill="url(#paint0_linear_209_29909)"/><path d="M15.6773 22.1533C17.3698 22.1533 18.8182 21.5507 20.0233 20.3461C21.2282 19.1415 21.8307 17.6924 21.8307 16V6.15401C21.8307 4.46162 21.2286 3.01305 20.0233 1.80784C18.8182 0.602907 17.3698 0 15.6773 0C13.9849 0 12.5363 0.602907 11.3311 1.80784C10.1259 3.01285 9.52344 4.46162 9.52344 6.15401V16C9.52344 17.6923 10.1262 19.1415 11.3311 20.3461C12.5361 21.5507 13.9849 22.1533 15.6773 22.1533Z" fill="white" fill-opacity="0.3"/><path d="M26.3888 12.6731C26.1459 12.4295 25.8568 12.3076 25.5234 12.3076C25.1904 12.3076 24.902 12.4295 24.6581 12.6731C24.4147 12.9167 24.293 13.2051 24.293 13.5383V16C24.293 18.3718 23.4498 20.4006 21.7639 22.0864C20.0785 23.7723 18.0495 24.6153 15.6775 24.6153C13.3057 24.6153 11.2769 23.7723 9.59089 22.0864C7.90509 20.401 7.06226 18.3719 7.06226 16V13.5383C7.06226 13.2051 6.94041 12.9167 6.69692 12.6731C6.45329 12.4295 6.16514 12.3076 5.83159 12.3076C5.49804 12.3076 5.20956 12.4295 4.96606 12.6731C4.72237 12.9167 4.60059 13.2051 4.60059 13.5383V16C4.60059 18.8333 5.54627 21.2981 7.4371 23.3941C9.32799 25.4901 11.6645 26.6919 14.4467 26.9994V29.5381H9.52373C9.19038 29.5381 8.90196 29.6601 8.6584 29.9037C8.41477 30.1472 8.29293 30.4357 8.29293 30.7691C8.29293 31.1019 8.41477 31.391 8.6584 31.6344C8.90196 31.8778 9.19038 32 9.52373 32H21.831C22.1643 32 22.4531 31.8779 22.6963 31.6344C22.9402 31.391 23.0622 31.1019 23.0622 30.7691C23.0622 30.4358 22.9402 30.1472 22.6963 29.9037C22.4532 29.6601 22.1644 29.5381 21.831 29.5381H16.9086V26.9994C19.6904 26.6919 22.0267 25.4901 23.9178 23.3941C25.8089 21.2981 26.7548 18.8333 26.7548 16V13.5383C26.7548 13.2051 26.6327 12.9169 26.3888 12.6731Z" fill="url(#paint1_linear_209_29909)"/><defs><linearGradient id="paint0_linear_209_29909" x1="5.22969e-08" y1="-5.22969e-08" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop stop-color="#FF1CD2"/><stop offset="1" stop-color="#B20DFF"/></linearGradient><linearGradient id="paint1_linear_209_29909" x1="-5.88081e-07" y1="-8.98822e-07" x2="4.72839" y2="35.6202" gradientUnits="userSpaceOnUse"><stop stop-color="#FF1CD2"/><stop offset="1" stop-color="#B20DFF"/></linearGradient></defs></svg>',
            moderator: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_817_50667)"><path d="M30 0C31.1046 0 32 0.895431 32 2V30C32 31.1046 31.1046 32 30 32H2C0.895431 32 0 31.1046 0 30V2C0 0.895431 0.895431 0 2 0H30ZM16.2197 2.99316C15.8292 2.60266 15.1962 2.60265 14.8057 2.99316L8.36328 9.43555C7.97294 9.82608 7.97284 10.4591 8.36328 10.8496L10.0918 12.5781C10.4823 12.9686 11.1153 12.9685 11.5059 12.5781L11.585 12.499L13.9414 14.8564L3.57129 25.2275C2.70357 26.0954 2.7035 27.5023 3.57129 28.3701C4.43911 29.2376 5.84612 29.2377 6.71387 28.3701L17.084 17.999L19.4414 20.3564L19.3633 20.4346C18.9728 20.8251 18.9728 21.4581 19.3633 21.8486L21.0918 23.5771C21.4823 23.9676 22.1154 23.9676 22.5059 23.5771L28.9482 17.1348C29.3386 16.7443 29.3386 16.1112 28.9482 15.7207L27.2197 13.9922C26.8293 13.6017 26.1962 13.6018 25.8057 13.9922L25.7266 14.0703L23.3701 11.7139C24.2377 10.8461 24.2376 9.4391 23.3701 8.57129C22.5023 7.7035 21.0954 7.70357 20.2275 8.57129L17.8701 6.21387L17.9482 6.13574C18.3388 5.74522 18.3388 5.11221 17.9482 4.72168L16.2197 2.99316Z" fill="url(#paint0_linear_817_50667)"/><path d="M30 0C31.1046 0 32 0.895431 32 2V30C32 31.1046 31.1046 32 30 32H2C0.895431 32 0 31.1046 0 30V2C0 0.895431 0.895431 0 2 0H30ZM16.2197 2.99316C15.8292 2.60266 15.1962 2.60265 14.8057 2.99316L8.36328 9.43555C7.97294 9.82608 7.97284 10.4591 8.36328 10.8496L10.0918 12.5781C10.4823 12.9686 11.1153 12.9685 11.5059 12.5781L11.585 12.499L13.9414 14.8564L3.57129 25.2275C2.70357 26.0954 2.7035 27.5023 3.57129 28.3701C4.43911 29.2376 5.84612 29.2377 6.71387 28.3701L17.084 17.999L19.4414 20.3564L19.3633 20.4346C18.9728 20.8251 18.9728 21.4581 19.3633 21.8486L21.0918 23.5771C21.4823 23.9676 22.1154 23.9676 22.5059 23.5771L28.9482 17.1348C29.3386 16.7443 29.3386 16.1112 28.9482 15.7207L27.2197 13.9922C26.8293 13.6017 26.1962 13.6018 25.8057 13.9922L25.7266 14.0703L23.3701 11.7139C24.2377 10.8461 24.2376 9.4391 23.3701 8.57129C22.5023 7.7035 21.0954 7.70357 20.2275 8.57129L17.8701 6.21387L17.9482 6.13574C18.3388 5.74522 18.3388 5.11221 17.9482 4.72168L16.2197 2.99316Z" fill="url(#paint1_linear_817_50667)"/><path d="M30 0C31.1046 0 32 0.895431 32 2V30C32 31.1046 31.1046 32 30 32H2C0.895431 32 0 31.1046 0 30V2C0 0.895431 0.895431 0 2 0H30ZM16.2197 2.99316C15.8292 2.60266 15.1962 2.60265 14.8057 2.99316L8.36328 9.43555C7.97294 9.82608 7.97284 10.4591 8.36328 10.8496L10.0918 12.5781C10.4823 12.9686 11.1153 12.9685 11.5059 12.5781L11.585 12.499L13.9414 14.8564L3.57129 25.2275C2.70357 26.0954 2.7035 27.5023 3.57129 28.3701C4.43911 29.2376 5.84612 29.2377 6.71387 28.3701L17.084 17.999L19.4414 20.3564L19.3633 20.4346C18.9728 20.8251 18.9728 21.4581 19.3633 21.8486L21.0918 23.5771C21.4823 23.9676 22.1154 23.9676 22.5059 23.5771L28.9482 17.1348C29.3386 16.7443 29.3386 16.1112 28.9482 15.7207L27.2197 13.9922C26.8293 13.6017 26.1962 13.6018 25.8057 13.9922L25.7266 14.0703L23.3701 11.7139C24.2377 10.8461 24.2376 9.4391 23.3701 8.57129C22.5023 7.7035 21.0954 7.70357 20.2275 8.57129L17.8701 6.21387L17.9482 6.13574C18.3388 5.74522 18.3388 5.11221 17.9482 4.72168L16.2197 2.99316Z" fill="url(#paint2_linear_817_50667)"/></g><defs><linearGradient id="paint0_linear_817_50667" x1="18.8102" y1="-12.7222" x2="2.88536" y2="39.1063" gradientUnits="userSpaceOnUse"><stop stop-color="#FF6A4A"/><stop offset="1" stop-color="#C70C00"/></linearGradient><linearGradient id="paint1_linear_817_50667" x1="15.7467" y1="-4.75575" x2="16.321" y2="39.0672" gradientUnits="userSpaceOnUse"><stop stop-color="#FFC900"/><stop offset="0.99" stop-color="#FF9500"/></linearGradient><linearGradient id="paint2_linear_817_50667" x1="-14.9543" y1="46.9544" x2="32.0001" y2="-0.000509222" gradientUnits="userSpaceOnUse"><stop stop-color="#0095FF"/><stop offset="0.99" stop-color="#00C7FF"/></linearGradient><clipPath id="clip0_817_50667"><rect width="32" height="32" fill="white"/></clipPath></defs></svg>',
            vip: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_746_28171)"><path d="M30 0C31.1046 0 32 0.895431 32 2V30C32 31.1046 31.1046 32 30 32H2C0.895431 32 0 31.1046 0 30V2C0 0.895431 0.895431 4.10637e-08 2 0H30ZM15.9648 5C15.7748 5.00005 15.588 5.05204 15.4238 5.15039C15.2596 5.24878 15.124 5.39057 15.0303 5.56055L9.82812 15.0176L3.55078 11.8906C3.36913 11.7985 3.16534 11.7607 2.96387 11.7822C2.76241 11.8038 2.57048 11.8842 2.41113 12.0127C2.25235 12.1408 2.13185 12.3126 2.06348 12.5078C1.99511 12.7031 1.98143 12.9144 2.02441 13.1172L4.58301 25.127C4.63544 25.3782 4.77165 25.6034 4.96777 25.7627C5.16376 25.9217 5.40762 26.0056 5.65723 26H26.251C26.5009 26.0057 26.7453 25.9219 26.9414 25.7627C27.1376 25.6034 27.2737 25.3782 27.3262 25.127L29.9697 13.1172C30.0187 12.9103 30.0086 12.6932 29.9404 12.4922C29.8722 12.2912 29.7485 12.1151 29.585 11.9844C29.4215 11.8537 29.2249 11.7743 29.0186 11.7559C28.8122 11.7374 28.6049 11.7802 28.4219 11.8799L22.1025 15.0283L16.9004 5.56055C16.8066 5.39054 16.6701 5.24878 16.5059 5.15039C16.3416 5.05207 16.1549 5 15.9648 5Z" fill="url(#paint0_linear_746_28171)"/><path d="M30 0C31.1046 0 32 0.895431 32 2V30C32 31.1046 31.1046 32 30 32H2C0.895431 32 0 31.1046 0 30V2C0 0.895431 0.895431 4.10637e-08 2 0H30ZM15.9648 5C15.7748 5.00005 15.588 5.05204 15.4238 5.15039C15.2596 5.24878 15.124 5.39057 15.0303 5.56055L9.82812 15.0176L3.55078 11.8906C3.36913 11.7985 3.16534 11.7607 2.96387 11.7822C2.76241 11.8038 2.57048 11.8842 2.41113 12.0127C2.25235 12.1408 2.13185 12.3126 2.06348 12.5078C1.99511 12.7031 1.98143 12.9144 2.02441 13.1172L4.58301 25.127C4.63544 25.3782 4.77165 25.6034 4.96777 25.7627C5.16376 25.9217 5.40762 26.0056 5.65723 26H26.251C26.5009 26.0057 26.7453 25.9219 26.9414 25.7627C27.1376 25.6034 27.2737 25.3782 27.3262 25.127L29.9697 13.1172C30.0187 12.9103 30.0086 12.6932 29.9404 12.4922C29.8722 12.2912 29.7485 12.1151 29.585 11.9844C29.4215 11.8537 29.2249 11.7743 29.0186 11.7559C28.8122 11.7374 28.6049 11.7802 28.4219 11.8799L22.1025 15.0283L16.9004 5.56055C16.8066 5.39054 16.6701 5.24878 16.5059 5.15039C16.3416 5.05207 16.1549 5 15.9648 5Z" fill="url(#paint1_linear_746_28171)"/></g><defs><linearGradient id="paint0_linear_746_28171" x1="18.8102" y1="-12.7222" x2="2.88536" y2="39.1063" gradientUnits="userSpaceOnUse"><stop stop-color="#FF6A4A"/><stop offset="1" stop-color="#C70C00"/></linearGradient><linearGradient id="paint1_linear_746_28171" x1="15.7467" y1="-4.75575" x2="16.321" y2="39.0672" gradientUnits="userSpaceOnUse"><stop stop-color="#FFC900"/><stop offset="0.99" stop-color="#FF9500"/></linearGradient><clipPath id="clip0_746_28171"><rect width="32" height="32" fill="white"/></clipPath></defs></svg>',
            og: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_614_6266)"><path d="M22.8226 17.2693V28.0037C22.8226 28.2177 22.8929 28.383 23.0336 28.4996C23.1742 28.5969 23.3969 28.6455 23.7017 28.6455H24.5104V32H21.838C19.9627 32 18.6265 31.6694 17.8294 31.0082C17.0559 30.347 16.6691 29.472 16.6691 28.383V16.8901C16.6691 15.8011 17.0559 14.926 17.8294 14.2648C18.6265 13.6036 19.9627 13.273 21.838 13.273H24.6511V16.6276H23.7017C23.3969 16.6276 23.1742 16.6859 23.0336 16.8026C22.8929 16.8998 22.8226 17.0554 22.8226 17.2693ZM32.0002 21.6447V24.8826H24.0885V21.6447H32.0002ZM25.8466 19.6904V17.2693C25.8466 17.0554 25.7763 16.8998 25.6357 16.8026C25.495 16.6859 25.2723 16.6276 24.9676 16.6276H24.0182V13.273H26.8312C28.7066 13.273 30.031 13.6036 30.8046 14.2648C31.6017 14.926 32.0002 15.8011 32.0002 16.8901V19.6904H25.8466ZM25.8466 28.0037V23.8908H32.0002V28.383C32.0002 29.472 31.6017 30.347 30.8046 31.0082C30.031 31.6694 28.7066 32 26.8312 32H24.1588V28.6455H24.9676C25.2723 28.6455 25.495 28.5969 25.6357 28.4996C25.7763 28.383 25.8466 28.2177 25.8466 28.0037Z" fill="white"/><path d="M22.8226 17.2693V28.0037C22.8226 28.2177 22.8929 28.383 23.0336 28.4996C23.1742 28.5969 23.3969 28.6455 23.7017 28.6455H24.5104V32H21.838C19.9627 32 18.6265 31.6694 17.8294 31.0082C17.0559 30.347 16.6691 29.472 16.6691 28.383V16.8901C16.6691 15.8011 17.0559 14.926 17.8294 14.2648C18.6265 13.6036 19.9627 13.273 21.838 13.273H24.6511V16.6276H23.7017C23.3969 16.6276 23.1742 16.6859 23.0336 16.8026C22.8929 16.8998 22.8226 17.0554 22.8226 17.2693ZM32.0002 21.6447V24.8826H24.0885V21.6447H32.0002ZM25.8466 19.6904V17.2693C25.8466 17.0554 25.7763 16.8998 25.6357 16.8026C25.495 16.6859 25.2723 16.6276 24.9676 16.6276H24.0182V13.273H26.8312C28.7066 13.273 30.031 13.6036 30.8046 14.2648C31.6017 14.926 32.0002 15.8011 32.0002 16.8901V19.6904H25.8466ZM25.8466 28.0037V23.8908H32.0002V28.383C32.0002 29.472 31.6017 30.347 30.8046 31.0082C30.031 31.6694 28.7066 32 26.8312 32H24.1588V28.6455H24.9676C25.2723 28.6455 25.495 28.5969 25.6357 28.4996C25.7763 28.383 25.8466 28.2177 25.8466 28.0037Z" fill="url(#paint0_linear_614_6266)"/><path d="M22.8228 3.99625V14.7307C22.8228 14.9446 22.8931 15.1099 23.0338 15.2266C23.1744 15.3238 23.3971 15.3724 23.7019 15.3724H24.5106V18.727H21.8382C19.9629 18.727 18.6267 18.3964 17.8296 17.7352C17.056 17.074 16.6693 16.1989 16.6693 15.1099V3.61704C16.6693 2.52804 17.056 1.65295 17.8296 0.99177C18.6267 0.33059 19.9629 0 21.8382 0H24.6513V3.35452H23.7019C23.3971 3.35452 23.1744 3.41286 23.0338 3.52953C22.8931 3.62677 22.8228 3.78234 22.8228 3.99625ZM32.0004 8.37171V11.6095H24.0887V8.37171H32.0004ZM25.8468 6.41734V3.99625C25.8468 3.78234 25.7765 3.62677 25.6358 3.52953C25.4952 3.41286 25.2725 3.35452 24.9677 3.35452H24.0183V0H26.8314C28.7067 0 30.0312 0.33059 30.8048 0.99177C31.6018 1.65295 32.0004 2.52804 32.0004 3.61704V6.41734H25.8468ZM25.8468 14.7307V10.6178H32.0004V15.1099C32.0004 16.1989 31.6018 17.074 30.8048 17.7352C30.0312 18.3964 28.7067 18.727 26.8314 18.727H24.159V15.3724H24.9677C25.2725 15.3724 25.4952 15.3238 25.6358 15.2266C25.7765 15.1099 25.8468 14.9446 25.8468 14.7307Z" fill="#00FFF2"/><path d="M9.38855 7.81748V4.28795C9.38855 4.07404 9.31822 3.91846 9.17757 3.82123C9.03691 3.70455 8.81421 3.64621 8.50947 3.64621H7.34909V0H10.3731C12.2485 0 13.573 0.33059 14.3465 0.99177C15.1436 1.65295 15.5421 2.52804 15.5421 3.61704V7.81748H9.38855ZM9.38855 14.439V7.43828H15.5421V15.1099C15.5421 16.1989 15.1436 17.074 14.3465 17.7352C13.573 18.3964 12.2485 18.727 10.3731 18.727H7.34909V15.0807H8.50947C8.81421 15.0807 9.03691 15.0321 9.17757 14.9349C9.31822 14.8182 9.38855 14.6529 9.38855 14.439ZM6.15354 4.28795V7.81748H0V3.61704C0 2.52804 0.386794 1.65295 1.16038 0.99177C1.95741 0.33059 3.29361 0 5.16897 0H8.193V3.64621H7.03262C6.72787 3.64621 6.50517 3.70455 6.36452 3.82123C6.22387 3.91846 6.15354 4.07404 6.15354 4.28795ZM6.15354 7.43828V14.439C6.15354 14.6529 6.22387 14.8182 6.36452 14.9349C6.50517 15.0321 6.72787 15.0807 7.03262 15.0807H8.193V18.727H5.16897C3.29361 18.727 1.95741 18.3964 1.16038 17.7352C0.386794 17.074 0 16.1989 0 15.1099V7.43828H6.15354Z" fill="white"/><path d="M9.38855 7.81748V4.28795C9.38855 4.07404 9.31822 3.91846 9.17757 3.82123C9.03691 3.70455 8.81421 3.64621 8.50947 3.64621H7.34909V0H10.3731C12.2485 0 13.573 0.33059 14.3465 0.99177C15.1436 1.65295 15.5421 2.52804 15.5421 3.61704V7.81748H9.38855ZM9.38855 14.439V7.43828H15.5421V15.1099C15.5421 16.1989 15.1436 17.074 14.3465 17.7352C13.573 18.3964 12.2485 18.727 10.3731 18.727H7.34909V15.0807H8.50947C8.81421 15.0807 9.03691 15.0321 9.17757 14.9349C9.31822 14.8182 9.38855 14.6529 9.38855 14.439ZM6.15354 4.28795V7.81748H0V3.61704C0 2.52804 0.386794 1.65295 1.16038 0.99177C1.95741 0.33059 3.29361 0 5.16897 0H8.193V3.64621H7.03262C6.72787 3.64621 6.50517 3.70455 6.36452 3.82123C6.22387 3.91846 6.15354 4.07404 6.15354 4.28795ZM6.15354 7.43828V14.439C6.15354 14.6529 6.22387 14.8182 6.36452 14.9349C6.50517 15.0321 6.72787 15.0807 7.03262 15.0807H8.193V18.727H5.16897C3.29361 18.727 1.95741 18.3964 1.16038 17.7352C0.386794 17.074 0 16.1989 0 15.1099V7.43828H6.15354Z" fill="url(#paint1_linear_614_6266)"/><path d="M9.38839 21.0905V17.561C9.38839 17.3471 9.31807 17.1915 9.17741 17.0943C9.03676 16.9776 8.81406 16.9193 8.50932 16.9193H7.34893V13.273H10.373C12.2483 13.273 13.5728 13.6036 14.3464 14.2648C15.1434 14.926 15.5419 15.8011 15.5419 16.8901V21.0905H9.38839ZM9.38839 27.712V20.7113H15.5419V28.383C15.5419 29.472 15.1434 30.347 14.3464 31.0082C13.5728 31.6694 12.2483 32 10.373 32H7.34893V28.3538H8.50932C8.81406 28.3538 9.03676 28.3052 9.17741 28.2079C9.31807 28.0913 9.38839 27.926 9.38839 27.712ZM6.15339 17.561V21.0905H-0.000152588V16.8901C-0.000152588 15.8011 0.386641 14.926 1.16023 14.2648C1.95726 13.6036 3.29346 13.273 5.16882 13.273H8.19285V16.9193H7.03247C6.72772 16.9193 6.50502 16.9776 6.36437 17.0943C6.22371 17.1915 6.15339 17.3471 6.15339 17.561ZM6.15339 20.7113V27.712C6.15339 27.926 6.22371 28.0913 6.36437 28.2079C6.50502 28.3052 6.72772 28.3538 7.03247 28.3538H8.19285V32H5.16882C3.29346 32 1.95726 31.6694 1.16023 31.0082C0.386641 30.347 -0.000152588 29.472 -0.000152588 28.383V20.7113H6.15339Z" fill="#00FFF2"/></g><defs><linearGradient id="paint0_linear_614_6266" x1="23.9622" y1="0.695162" x2="24.4274" y2="31.9986" gradientUnits="userSpaceOnUse"><stop stop-color="#00FFF2"/><stop offset="1" stop-color="#006399"/></linearGradient><linearGradient id="paint1_linear_614_6266" x1="7.77104" y1="0" x2="7.91062" y2="32.567" gradientUnits="userSpaceOnUse"><stop stop-color="#00FFF2"/><stop offset="1" stop-color="#006399"/></linearGradient><clipPath id="clip0_614_6266"><rect width="32" height="32" fill="white"/></clipPath></defs></svg>',
            founder: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_209_29912)"><path d="M16 32C24.8366 32 32 24.8366 32 16C32 7.16344 24.8366 0 16 0C7.16344 0 0 7.16344 0 16C0 24.8366 7.16344 32 16 32Z" fill="url(#paint0_linear_209_29912)"/><path d="M16 32C24.8366 32 32 24.8366 32 16C32 7.16344 24.8366 0 16 0C7.16344 0 0 7.16344 0 16C0 24.8366 7.16344 32 16 32Z" fill="url(#paint1_linear_209_29912)"/><path d="M16 29.0375C23.2004 29.0375 29.0375 23.2004 29.0375 16C29.0375 8.79958 23.2004 2.96249 16 2.96249C8.79959 2.96249 2.9625 8.79958 2.9625 16C2.9625 23.2004 8.79959 29.0375 16 29.0375Z" fill="#FEB635"/><path d="M16 29.0375C23.2004 29.0375 29.0375 23.2004 29.0375 16C29.0375 8.79958 23.2004 2.96249 16 2.96249C8.79959 2.96249 2.9625 8.79958 2.9625 16C2.9625 23.2004 8.79959 29.0375 16 29.0375Z" fill="url(#paint2_linear_209_29912)"/><path d="M29.0375 16C29.0375 23.1875 23.1875 29.0375 16 29.0375C13.6563 29.0375 11.4625 28.4187 9.5625 27.3312C11.3125 28.2062 13.2875 28.7 15.375 28.7C22.5625 28.7 28.4125 22.85 28.4125 15.6625C28.4125 10.8188 25.75 6.58125 21.8125 4.3375C26.0938 6.475 29.0375 10.8938 29.0375 16ZM16.8875 3.575C19.4563 3.575 21.85 4.325 23.8625 5.60625C21.675 3.95625 18.95 2.96875 16 2.96875C8.8125 2.96875 2.9625 8.8125 2.9625 16.0063C2.9625 20.6437 5.4 24.7313 9.0625 27.0312C5.9 24.65 3.85 20.8687 3.85 16.6125C3.85 9.425 9.7 3.575 16.8875 3.575Z" fill="black" fill-opacity="0.05"/><path d="M18.5966 9.45456V24H14.6477V13.0909H14.5625L11.3807 14.9943V11.6421L14.9602 9.45456H18.5966Z" fill="black" fill-opacity="0.8"/><path d="M18.5966 9.45456V24H14.6477V13.0909H14.5625L11.3807 14.9943V11.6421L14.9602 9.45456H18.5966Z" fill="url(#paint3_linear_209_29912)" fill-opacity="0.5"/><path d="M18.5966 9.45456V24H14.6477V13.0909H14.5625L11.3807 14.9943V11.6421L14.9602 9.45456H18.5966Z" stroke="black" strokeOpacity="0.1" stroke-width="0.350269"/></g><defs><linearGradient id="paint0_linear_209_29912" x1="15.7467" y1="-4.46667" x2="16.2533" y2="36.6933" gradientUnits="userSpaceOnUse"><stop stop-color="#FFC900"/><stop offset="0.99" stop-color="#FF9500"/></linearGradient><linearGradient id="paint1_linear_209_29912" x1="16" y1="0" x2="16" y2="32" gradientUnits="userSpaceOnUse"><stop stop-color="white" stop-opacity="0.3"/><stop offset="1" stop-color="white" stop-opacity="0.15"/></linearGradient><linearGradient id="paint2_linear_209_29912" x1="15.7936" y1="-0.677142" x2="16.2064" y2="32.8618" gradientUnits="userSpaceOnUse"><stop stop-color="#FFC900"/><stop offset="0.99" stop-color="#FF9500"/></linearGradient><linearGradient id="paint3_linear_209_29912" x1="18.5966" y1="16.7273" x2="11.3807" y2="16.7273" gradientUnits="userSpaceOnUse"><stop stop-color="white" stop-opacity="0.1"/><stop offset="0.3" stop-color="white" stop-opacity="0.2"/><stop offset="0.65" stop-color="white" stop-opacity="0.05"/><stop offset="1" stop-color="white" stop-opacity="0.2"/></linearGradient><clipPath id="clip0_209_29912"><rect width="32" height="32" fill="white"/></clipPath></defs></svg>',
            subscriber: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_209_29946)"><path d="M17.0284 2.91378L16.2357 0.667951C16.1573 0.445558 15.8427 0.445558 15.7643 0.667951L14.9716 2.91378C12.9003 8.78263 8.78263 12.9003 2.91378 14.9716L0.667951 15.7643C0.445558 15.8427 0.445558 16.1573 0.667951 16.2357L2.91378 17.0284C8.78263 19.0998 12.9003 23.2174 14.9716 29.0862L15.7643 31.3321C15.8427 31.5544 16.1573 31.5544 16.2357 31.3321L17.0284 29.0862C19.0998 23.2174 23.2174 19.0998 29.0862 17.0284L31.3321 16.2357C31.5544 16.1573 31.5544 15.8427 31.3321 15.7643L29.0862 14.9716C23.2174 12.9003 19.0998 8.78263 17.0284 2.91378Z" fill="black"/><path d="M17.0284 2.91378L16.2357 0.667951C16.1573 0.445558 15.8427 0.445558 15.7643 0.667951L14.9716 2.91378C12.9003 8.78263 8.78263 12.9003 2.91378 14.9716L0.667951 15.7643C0.445558 15.8427 0.445558 16.1573 0.667951 16.2357L2.91378 17.0284C8.78263 19.0998 12.9003 23.2174 14.9716 29.0862L15.7643 31.3321C15.8427 31.5544 16.1573 31.5544 16.2357 31.3321L17.0284 29.0862C19.0998 23.2174 23.2174 19.0998 29.0862 17.0284L31.3321 16.2357C31.5544 16.1573 31.5544 15.8427 31.3321 15.7643L29.0862 14.9716C23.2174 12.9003 19.0998 8.78263 17.0284 2.91378Z" fill="url(#paint0_radial_209_29946)"/></g><defs><radialGradient id="paint0_radial_209_29946" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(16 16) rotate(90) scale(16)"><stop stop-color="#E1FF00"/><stop offset="1" stop-color="#2AA300"/></radialGradient><clipPath id="clip0_209_29946"><rect width="32" height="32" fill="white"/></clipPath></defs></svg>',
            sub_gifter: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 32 32"><g clip-path="url(#SubGifterBadgeA)"><path fill="#FF5008" d="M16 13.3 1 6.7v6l1.3.6v12.2L16 32V13.2Z"/><path fill="#FF5008" d="M16 21.5v-2.3l-13.7-6v2.2l13.7 6Z"/><path fill="#FFC800" d="M31 6.7v6l-1.3.6v12.2L16 32V13.4l-6.4-2.8-3-1.4L1 6.7 7.3 4l2.9-1.3L16 0l5.8 2.6 2.8 1.3L31 6.7Z"/><path fill="#FF5008" d="M29.7 13.3v2.1l-13.7 6v-2.2l13.7-6Z"/></g><defs><clipPath id="SubGifterBadgeA"><path fill="#fff" d="M0 0h32v32H0z"/></clipPath></defs></svg>',
            sidekick: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_746_28161)"><path d="M30 0C31.1046 0 32 0.895431 32 2V30C32 31.1046 31.1046 32 30 32H2C0.895431 32 0 31.1046 0 30V2C0 0.895431 0.895431 4.10637e-08 2 0H30ZM29.5244 11.3008C29.5244 11.3008 25.2627 10.4758 21.0332 11.5596C18.8953 12.1069 16.3789 14.1719 16.3789 14.1719C16.1704 14.343 15.8296 14.343 15.6211 14.1719C15.6211 14.1719 13.1047 12.1069 10.9668 11.5596C6.74733 10.4784 2.4957 11.2969 2.47559 11.3008C2.20629 11.353 1.99226 11.6104 2 11.873C2 11.873 2.25315 20.0384 8.10938 21.7568C11.2306 22.6722 15.5488 20.7051 15.5488 20.7051C15.7969 20.5923 16.2029 20.5923 16.4512 20.7051C16.4512 20.7051 20.7698 22.6722 23.8896 21.7568C29.7469 20.0382 30 11.873 30 11.873C30.0076 11.6104 29.7937 11.353 29.5244 11.3008ZM21.5322 14.3301C24.071 13.2488 26.4385 14.1729 26.4385 14.1729C26.7938 14.3116 26.9784 14.7083 26.8486 15.0537C26.839 15.0791 25.9689 17.3603 23.4443 18.4355C20.9228 19.5093 18.5704 18.6049 18.5391 18.5928C18.1836 18.4541 17.9991 18.0573 18.1289 17.7119C18.138 17.688 19.007 15.4058 21.5322 14.3301ZM5.43652 14.1162C5.43652 14.1162 7.80404 13.1921 10.3428 14.2734C12.8674 15.3488 13.7366 17.6302 13.7461 17.6553C13.8761 18.0007 13.6914 18.3975 13.3359 18.5361C13.3029 18.5489 10.9514 19.4515 8.43066 18.3779C5.89367 17.2966 5.02734 14.9961 5.02734 14.9961C4.89754 14.6507 5.08139 14.2549 5.43652 14.1162Z" fill="url(#paint0_linear_746_28161)"/></g><defs><linearGradient id="paint0_linear_746_28161" x1="18.8102" y1="-12.7222" x2="2.88536" y2="39.1063" gradientUnits="userSpaceOnUse"><stop stop-color="#FF6A4A"/><stop offset="1" stop-color="#C70C00"/></linearGradient><clipPath id="clip0_746_28161"><rect width="32" height="32" fill="white"/></clipPath></defs></svg>',
            verified: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_614_6275)"><path d="M30.8598 19.2368C30.1977 18.2069 29.5356 17.2138 28.8736 16.1839C28.7264 15.9632 28.7264 15.8161 28.8736 15.5954C29.5356 14.6023 30.1609 13.6092 30.823 12.6161C31.5954 11.4391 31.1908 10.2989 29.8667 9.82069C28.7632 9.41609 27.6598 8.97471 26.5563 8.57012C26.3356 8.49656 26.2253 8.34943 26.2253 8.09196C26.1885 6.87816 26.1149 5.66437 26.0414 4.48736C25.9678 3.2 24.9747 2.46437 23.7241 2.7954C22.5471 3.08966 21.3701 3.42069 20.2299 3.75173C19.9724 3.82529 19.8253 3.75173 19.6414 3.56782C18.9057 2.61149 18.1333 1.69195 17.3977 0.772414C16.5885 -0.257472 15.3379 -0.257472 14.492 0.772414C13.7563 1.69195 12.9839 2.61149 12.2851 3.53103C12.1012 3.7885 11.9172 3.82529 11.623 3.75173C10.4828 3.42069 9.34253 3.12644 8.53334 2.90575C6.95173 2.53793 5.99541 3.16322 5.92184 4.48736C5.84828 5.70115 5.77472 6.91495 5.73794 8.16552C5.73794 8.42299 5.62759 8.53333 5.4069 8.64368C4.26667 9.08506 3.12644 9.52644 1.98621 9.96782C0.809203 10.446 0.441387 11.5862 1.14023 12.6529C1.8023 13.6828 2.46437 14.6759 3.12644 15.7057C3.27356 15.9264 3.27356 16.0736 3.12644 16.331C2.42759 17.3609 1.76552 18.3908 1.10345 19.4575C0.478165 20.4506 0.882759 21.6276 1.98621 22.069C3.12644 22.5104 4.30345 22.9517 5.44368 23.3931C5.70115 23.4667 5.77471 23.6138 5.77471 23.8713C5.81149 25.0483 5.95862 26.1885 5.95862 27.3655C5.95862 28.5425 6.9885 29.6092 8.42298 29.1678C9.56321 28.8 10.7034 28.5425 11.8437 28.2115C12.0644 28.1379 12.2115 28.1747 12.3586 28.3954C13.131 29.3517 13.8667 30.2713 14.6391 31.2276C15.485 32.2575 16.6988 32.2575 17.508 31.2276C18.2805 30.2713 19.0161 29.3517 19.7885 28.3954C19.9356 28.2115 20.046 28.1379 20.3034 28.2115C21.4804 28.5425 22.6575 28.8368 23.8345 29.1678C25.0483 29.4988 26.0781 28.7632 26.1149 27.5126C26.1885 26.2989 26.2621 25.0851 26.2988 23.8345C26.2988 23.5402 26.446 23.4299 26.6667 23.3563C27.7701 22.9517 28.9103 22.5104 30.0138 22.069C31.1908 21.4805 31.5586 20.3034 30.8598 19.2368ZM22.069 13.2046L14.7127 20.5609C14.5287 20.7448 14.2713 20.892 14.0138 20.9287C13.9402 20.9287 13.8299 20.9655 13.7563 20.9655C13.4253 20.9655 13.0575 20.8184 12.8 20.5609L9.78392 17.5448C9.26898 17.0299 9.26898 16.1839 9.78392 15.669C10.2989 15.154 11.1448 15.154 11.6598 15.669L13.7196 17.7287L20.1196 11.3287C20.6345 10.8138 21.4805 10.8138 21.9954 11.3287C22.5839 11.8437 22.5839 12.6897 22.069 13.2046Z" fill="url(#paint0_linear_614_6275)"/></g><defs><linearGradient id="paint0_linear_614_6275" x1="8.14138" y1="32.3591" x2="24.4968" y2="0.904884" gradientUnits="userSpaceOnUse"><stop stop-color="#1EFF00"/><stop offset="0.99" stop-color="#00FF8C"/></linearGradient><clipPath id="clip0_614_6275"><rect width="32" height="32" fill="white"/></clipPath></defs></svg>',
            staff: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_209_29919)"><path d="M30 0C31.1046 0 32 0.895431 32 2V30C32 31.1046 31.1046 32 30 32H2C0.895431 32 0 31.1046 0 30V2C0 0.895431 0.895431 4.10637e-08 2 0H30ZM6 5V27H13.5029V22.1162H16V24.5576H18.4971V27H26V19.6631H23.5029V17.2207H20.9941V14.7793H23.5029V12.3369H26V5H18.4971V7.44238H16V9.88379H13.5029V5H6Z" fill="url(#paint0_linear_209_29919)"/></g><defs><linearGradient id="paint0_linear_209_29919" x1="8.99888" y1="34.208" x2="20.0805" y2="-2.27173" gradientUnits="userSpaceOnUse"><stop stop-color="#1EFF00"/><stop offset="0.99" stop-color="#00FF8C"/></linearGradient><clipPath id="clip0_209_29919"><rect width="32" height="32" fill="white"/></clipPath></defs></svg>',
        };
        const KICK_BADGE_IMG = {};
        for(const t in KICK_BADGE_SVG) KICK_BADGE_IMG[t] = 'data:image/svg+xml;utf8,' + encodeURIComponent(KICK_BADGE_SVG[t]);
        function kickTextBadgeHtml(t){
            const type = String(t || '').toLowerCase();
            if(type === 'level') return '';
            if(KICK_BADGE_IMG[type]) return `<img class="badge img" src="${KICK_BADGE_IMG[type]}" title="${esc(type)}">`;
            if(KICK_BADGE_EMOJI[type]) return `<span class="badge" title="${esc(type)}">${KICK_BADGE_EMOJI[type]}</span>`;
            return '';
        }
        const MAX = 200;
        let total = 0;
        // Буфер отрисованной ленты в GM-хранилище: без него после релоада
        // пропадало всё, что пришло напрямую по pusher (мимо очередей сборщиков).
        // При старте буфер реиграется через render(); дедуп по id не даёт дублей.
        const FEED_BUFFER_KEY = 'mc_feed_buffer_v1';
        const FEED_SEEN_KEY = 'mc_feed_lastseen_v1';
        const FEED_BUFFER_CAP = 150;
        let feedBuffer = [];
        let feedSaveTimer = null;
        let restoringFeed = false;
        function saveFeedState(){
            try {
                GM_setValue(FEED_BUFFER_KEY, feedBuffer);
                // lastSeen тоже сохраняем: иначе после релоада очередь сборщика
                // реиграется целиком, старый бэклог дорисуется В КОНЕЦ ленты и
                // обрезка по MAX снесёт свежевосстановленные сообщения сверху.
                GM_setValue(FEED_SEEN_KEY, { kick: lastSeen.kick, vk: lastSeen.vk });
            } catch(e) { }
        }
        function rememberFeedMsg(msg){
            if(restoringFeed) return;
            feedBuffer.push(msg);
            while(feedBuffer.length > FEED_BUFFER_CAP) feedBuffer.shift();
            if(feedSaveTimer) return;
            feedSaveTimer = setTimeout(() => {
                feedSaveTimer = null;
                saveFeedState();
            }, 400);
        }
        window.addEventListener('beforeunload', () => {
            if(!feedSaveTimer) return;
            clearTimeout(feedSaveTimer);
            feedSaveTimer = null;
            saveFeedState();
        });
        const seenIds = new Set();      // дедуп по id сообщения (между источниками/вкладками)
        const seenModEvents = new Map();
        const history = [];             // вся лента для истории по клику (id, platform, name, html)
        const HIST_CAP = 4000;
        const PALETTE = ['#ff4d4d','#ff9f1c','#ffd23f','#7cd992','#48cae4','#a78bfa','#f78fb3','#06d6a0','#ef476f','#118ab2'];
        function updateBothAccess(){
            ['kick','vk'].forEach(platform => {
                const button = sendChoice.querySelector(`[data-send="${platform}"]`);
                if(button) button.hidden = !platformOn(platform);
            });
            const both = sendChoice.querySelector('[data-send="both"]');
            if(both) both.hidden = !canSendBoth || !platformOn('kick') || !platformOn('vk');
        }
        function grantBothAccess(reason){
            if(canSendBoth) return;
            canSendBoth = true;
            updateBothAccess();
            console.log('[MergedChat] Both-chat sending enabled:', reason);
        }
        function rememberCurrentUser(platform, name){
            const normalized = String(name || '').trim().toLowerCase();
            if(!normalized) return;
            currentUsers[platform] = normalized;
            GM_setValue(CURRENT_USERS_KEY, currentUsers);
            if(privilegedUsers[`${platform}:${normalized}`] || normalized === KICK_SLUG) {
                grantBothAccess(`${platform}:${normalized}`);
            }
        }
        function rememberPrivilegedUser(platform, name){
            const normalized = String(name || '').trim().toLowerCase();
            if(!normalized) return;
            privilegedUsers[`${platform}:${normalized}`] = Date.now();
            GM_setValue(PRIVILEGED_USERS_KEY, privilegedUsers);
            if(currentUsers[platform] === normalized) grantBothAccess(`${platform}:${normalized}`);
        }
        function messageIsPrivileged(msg){
            if(msg.platform === 'vk') return Boolean(msg.isMod || msg.isOwner);
            const badgeNames = [
                ...(msg.badges_txt || []),
                ...(msg.badges_v2 || []).map(b => b?.name)
            ].map(name => String(name || '').toLowerCase());
            return badgeNames.some(name => ['moderator','broadcaster','owner'].includes(name));
        }
        updateBothAccess();
        for(const [platform, name] of Object.entries(currentUsers)) {
            if(privilegedUsers[`${platform}:${name}`] || name === KICK_SLUG) grantBothAccess(`${platform}:${name}`);
        }
        function colorFor(name){ let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))>>>0; return PALETTE[h%PALETTE.length]; }
        function accessibleNickColor(color){
            const safe=/^#[0-9a-f]{3,8}$/i.test(String(color||''))?String(color):'#ffffff';
            const normalized=safe.length===4?'#'+[...safe.slice(1)].map(digit=>digit+digit).join(''):safe.slice(0,7);
            let channels=[1,3,5].map(offset=>parseInt(normalized.slice(offset,offset+2),16));
            const relative=values=>values.map(channel=>{const value=channel/255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
            const ivory=relative([0xef,0xdb,0xb2]);
            const maximum=(ivory+.05)/4.7-.05;
            while(relative(channels)>maximum) channels=channels.map(channel=>channel*.94);
            return '#'+channels.map(channel=>Math.round(channel).toString(16).padStart(2,'0')).join('');
        }
        function nickColorStyle(color){
            const safe=/^#[0-9a-f]{3,8}$/i.test(String(color||''))?String(color):'#ffffff';
            return `color:${safe};--nick-light-color:${accessibleNickColor(safe)}`;
        }
        function colorKey(platform, name, userId=''){
            return userColorKey(platform, name, userId);
        }
        function rememberedColor(platform, name, userId=''){
            return getUserColor(platform, name, userId);
        }
        function rememberColor(platform, name, userId, color){
            rememberUserColor(platform, name, userId, color);
        }
        function displayName(platform, name, userId=''){
            return getLocalAlias(platform, name, userId) || String(name || '');
        }
        function applyAliasToElement(el){
            if(!el) return;
            const row = el.closest('.msg');
            const platform = el.dataset.plat || row?.dataset.plat || 'vk';
            const name = el.dataset.name || '';
            if(!name) return;
            const userId = el.dataset.userid || '';
            const alias = getLocalAlias(platform, name, userId);
            el.textContent = `${el.classList.contains('mention') ? '@' : ''}${alias || name}`;
            if(alias) el.title = `Локальное имя: ${alias} · настоящий ник: ${name}`;
            else if(el.classList.contains('mention')) el.title = `Действия с ${name}`;
            else el.title = `Действия с ${name}`;
        }
        // переименования пришли извне (перенос из Tampermonkey, другое окно) — переписываем видимые ники
        GM_addValueChangeListener(LOCAL_ALIASES_KEY, (key, oldValue, newValue, remote) => {
            if(remote) document.querySelectorAll('.name[data-name],.mention[data-name],.mod-name[data-name],.reply-name[data-name]').forEach(applyAliasToElement);
        });
        function refreshLocalAliases(platform, name, userId=''){
            document.querySelectorAll('.name[data-name],.mention[data-name],.mod-name[data-name],.reply-name[data-name]').forEach(el => {
                const elPlatform = el.dataset.plat || el.closest('.msg')?.dataset.plat || 'vk';
                const elName = el.dataset.name || '';
                const elUserId = el.dataset.userid || '';
                if(elPlatform === platform && (elUserId && userId ? String(elUserId) === String(userId) : elName.toLowerCase() === String(name).toLowerCase())) {
                    applyAliasToElement(el);
                }
            });
        }

        const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const sevenTvEmotes = new Map();
        const cachedSevenTv = GM_getValue(SEVENTV_CACHE_KEY, null);
        if(Array.isArray(cachedSevenTv?.emotes)) {
            cachedSevenTv.emotes.forEach(([name, url]) => {
                if(name && url) sevenTvEmotes.set(name, url);
            });
        }
        async function refreshSevenTvEmotes(){
            if(cachedSevenTv?.updated && Date.now() - cachedSevenTv.updated < SEVENTV_CACHE_TTL) {
                console.log(`[MergedChat] 7TV loaded from cache: ${sevenTvEmotes.size}`);
                return;
            }
            const results = await Promise.allSettled([
                sevenTvRequest('https://7tv.io/v3/emote-sets/global'),
                sevenTvRequest(`https://7tv.io/v3/users/kick/${KICK_CHANNEL_ID}`)
            ]);
            const fresh = new Map();
            results.forEach(result => {
                if(result.status === 'fulfilled') addSevenTvSet(fresh, result.value);
            });
            if(fresh.size) {
                sevenTvEmotes.clear();
                fresh.forEach((url, name) => sevenTvEmotes.set(name, url));
                GM_setValue(SEVENTV_CACHE_KEY, { updated:Date.now(), emotes:[...sevenTvEmotes] });
                console.log(`[MergedChat] 7TV loaded: ${sevenTvEmotes.size}`);
                syncSevenTvCatalog();
                renderEmotePicker();
            } else {
                console.warn('[MergedChat] 7TV emotes could not be loaded');
            }
        }
        refreshSevenTvEmotes().catch(error => console.warn('[MergedChat] 7TV error', error));
        function sevenTvHtml(name){
            const url = sevenTvEmotes.get(name);
            return url ? `<img class="emote seventv" src="${esc(url)}" title="7TV: ${esc(name)}" alt="${esc(name)}">` : '';
        }
        const EMOTE_TABS = [
            ['kickChannel','GRPZDC','kick'], ['kickRecent','Kick недавние','kick'],
            ['kickGlobal','Kick','kick'], ['kickEmoji','Kick 🙂','kick'],
            ['sevenTv','7TV','kick'], ['vkChannel','VK','vk'], ['vkRecent','VK недавние','vk']
        ];
        function syncSevenTvCatalog(){
            emoteCatalog.sevenTv = [...sevenTvEmotes].map(([name, url]) => ({ name, url }));
        }
        function allowedEmoteTabs(){
            const platform = selectedReply?.platform || composeEmotePlatform;
            const tabs = EMOTE_TABS.filter(tab => platformOn(tab[2]));
            return platform ? tabs.filter(tab => tab[2] === platform) : tabs;
        }
        function renderEmotePicker(){
            if(!emotePicker) return;
            const tabs = allowedEmoteTabs();
            if(!tabs.length){
                // в поле уже есть смайл платформы, которую отключили в настройках
                emotePicker.querySelector('.emote-head').innerHTML = '';
                emoteList.innerHTML = `<div class="emote-empty">${esc(platformLabel(composeEmotePlatform || selectedReply?.platform))} отключён в настройках — убери его смайл из сообщения</div>`;
                emoteList.__items = [];
                return;
            }
            if(!tabs.some(tab => tab[0] === emoteTab)) emoteTab = tabs[0]?.[0] || 'kickChannel';
            emotePicker.querySelector('.emote-head').innerHTML = tabs.map(([key, label]) =>
                `<button type="button" data-emote-tab="${key}" class="${key === emoteTab ? 'active' : ''}">${esc(label)}</button>`
            ).join('');
            const query = emoteSearch.value.trim().toLowerCase();
            const items = (emoteCatalog[emoteTab] || [])
                .filter(item => !query || String(item.name || '').toLowerCase().includes(query))
                .slice(0, 400);
            emoteList.innerHTML = items.length ? items.map((item, index) =>
                `<button type="button" data-emote-index="${index}" title="${esc(item.name || '')}"><img src="${esc(item.url || '')}" alt="${esc(item.name || '')}" loading="lazy"></button>`
            ).join('') : '<div class="emote-empty">Смайлы не найдены</div>';
            emoteList.__items = items;
        }
        async function loadEmoteCatalog(){
            syncSevenTvCatalog();
            try {
                const data = await sevenTvRequest('https://pzdcflix.live/api/chat/emotes');
                ['kickChannel','kickGlobal','kickEmoji','kickRecent','vkChannel','vkRecent'].forEach(key => {
                    if(Array.isArray(data?.[key])) emoteCatalog[key] = data[key];
                });
            } catch(error) {
                console.warn('[MergedChat] Emote catalog could not be loaded', error);
            }
            renderEmotePicker();
        }
        function setEmotePickerOpen(open){
            emotePicker.classList.toggle('open', open);
            emoteToggle.classList.toggle('active', open);
            if(open){
                renderEmotePicker();
                setTimeout(() => emoteSearch.focus(), 0);
            }
        }
        loadEmoteCatalog();
        function applyFontSize(val){
            const n = Math.max(10, Math.min(50, Number(val) || 14));
            document.documentElement.style.setProperty('--fs', n + 'px');
            fontSlider.value = String(n);
            fontVal.textContent = n + 'px';
            localStorage.setItem('mergedChatFontSize', String(n));
        }
        applyFontSize(localStorage.getItem('mergedChatFontSize') || 14);
        // время у сообщений: показывать у всех или не показывать вовсе
        const timeToggle = document.getElementById('time-toggle');
        function applyTimeShown(on){
            if(on) delete document.documentElement.dataset.noTime; else document.documentElement.dataset.noTime = '1';
            timeToggle.classList.toggle('active', on);
            timeToggle.setAttribute('aria-pressed', String(on));
            timeToggle.textContent = on ? 'При наведении' : 'Не показывать';
        }
        applyTimeShown(localStorage.getItem('mergedChatTime') !== 'off');
        timeToggle.addEventListener('click', () => {
            const on = !!document.documentElement.dataset.noTime;
            localStorage.setItem('mergedChatTime', on ? 'on' : 'off');
            applyTimeShown(on);
        });
        fontSlider.addEventListener('input', e => applyFontSize(e.target.value));
        document.getElementById('settings-toggle').addEventListener('click', () => settingsPanel.classList.toggle('open'));
        document.getElementById('clear-chat').addEventListener('click', () => {
            chat.innerHTML = '';
            olderRows.length = 0;
            seenIds.clear();
            history.length = 0;
            total = 0;
            feedBuffer.length = 0;
            try { GM_setValue(FEED_BUFFER_KEY, []); } catch(e) { }
            st.textContent = 'ДУРКА';
        });
        document.getElementById('links-btn').addEventListener('click', openLinksWindow);
        let lastMeta = {};
        function applyMeta(meta){
            if(!meta) return;
            lastMeta = meta;
            if(meta.siteOnline !== undefined) siteOnlineEl.textContent = String(meta.siteOnline);
            if(meta.kickOnline !== undefined) kickOnlineEl.textContent = String(meta.kickOnline);
            if(meta.vkOnline !== undefined) vkOnlineEl.textContent = String(meta.vkOnline);
            kickOnlineEl.closest('.platform-stat').hidden = !platformOn('kick');
            vkOnlineEl.closest('.platform-stat').hidden = !platformOn('vk');
            const s = Number(meta.siteOnline);
            const k = platformOn('kick') ? Number(meta.kickOnline) : NaN;
            const v = platformOn('vk') ? Number(meta.vkOnline) : NaN;
            totalOnlineEl.textContent = Number.isFinite(s) || Number.isFinite(k) || Number.isFinite(v)
                ? String((Number.isFinite(s) ? s : 0) + (Number.isFinite(k) ? k : 0) + (Number.isFinite(v) ? v : 0))
                : '?';
        }
        applyMeta(GM_getValue(META_KEY, {}) || {});
        function refreshSiteOnline(){
            GM_xmlhttpRequest({
                method:'GET',
                url:SITE_ONLINE_URL,
                responseType:'json',
                timeout:10000,
                onload: response => {
                    if(response.status < 200 || response.status >= 300) return;
                    try {
                        const data = typeof response.response === 'string'
                            ? JSON.parse(response.response)
                            : response.response;
                        setMeta({
                            siteOnline:Number(data?.site) || 0,
                            kickOnline:Number(data?.kick) || 0,
                            vkOnline:Number(data?.vk) || 0
                        });
                    } catch(e) { }
                },
                onerror: () => {},
                ontimeout: () => {}
            });
        }
        refreshSiteOnline();
        setInterval(refreshSiteOnline, 15000);
        async function refreshKickOnline(){
            if(!platformOn('kick')) return;
            try{
                const r = await fetch(`https://kick.com/api/v2/channels/${KICK_SLUG}`, { credentials:'include' });
                if(!r.ok) return;
                const d = await r.json();
                const n = d?.livestream?.viewer_count ?? d?.livestream?.viewers ?? d?.viewer_count ?? d?.viewers;
                if(n !== undefined && n !== null) {
                    kickOnlineEl.textContent = String(n);
                    setMeta({ kickOnline:Number(n) || 0 });
                }
            }catch(e){ }
        }
        refreshKickOnline();
        setInterval(refreshKickOnline, 30000);

        // --- Включение/отключение чатов Kick и VK (⚙ → «Чаты») ---
        // Флаг лежит в GM-хранилище: его видят все вкладки виджета и сборщики.
        function updatePlatformControls(){
            ['kick','vk'].forEach(platform => {
                const on = platformOn(platform);
                document.documentElement.toggleAttribute(`data-${platform}-off`, !on);
                const button = settingsPanel.querySelector(`[data-platform-toggle="${platform}"]`);
                if(!button) return;
                button.classList.toggle('active', on);
                button.setAttribute('aria-pressed', String(on));
                button.querySelector('.platform-state').textContent = on ? 'вкл' : 'выкл';
                button.title = `${platformLabel(platform)} ${on ? 'включён — нажми, чтобы отключить' : 'отключён — нажми, чтобы включить'}`;
            });
            updateBothAccess();
            if(!selectedReply) document.getElementById('send-message').title = defaultSendTitle();
        }
        const platformStatus = document.getElementById('platform-status');
        const platformHint = platformStatus.textContent;
        function applyPlatforms(value){
            const prev = platformsEnabled;
            platformsEnabled = normalizePlatforms(value);
            updatePlatformControls();
            applyMeta(lastMeta);
            if(prev.kick === platformsEnabled.kick && prev.vk === platformsEnabled.vk) return;
            platformStatus.textContent = platformHint; // клик в этом окне перепишет, изменение из другого окна — нет
            if(selectedReply && !platformOn(selectedReply.platform)) setComposeReply(null);
            releaseDisabledEmoteLock();
            // всплывашки со строками отключённого чата (при переключении из другого окна они не закрываются кликом)
            if(threadPanel.classList.contains('open') && [...threadBody.querySelectorAll('.thread-msg')].some(row => !platformOn(row.dataset.plat))) closeThread();
            if(nickMenu && !platformOn(nickMenu.dataset.plat)) closeNickMenu();
            sendChoice.classList.remove('open');
            if(emotePicker.classList.contains('open')) renderEmotePicker();
            if(mentionSuggest.classList.contains('open')) renderMentionSuggest();
            if(platformsEnabled.kick && !prev.kick) refreshKickOnline();
            scroll();
        }
        function setPlatformEnabled(platform, on){
            const next = { ...platformsEnabled, [platform]:on };
            if(!next.kick && !next.vk){
                platformStatus.textContent = 'Хотя бы один чат должен остаться включённым';
                return;
            }
            GM_setValue(PLATFORMS_KEY, next);
            applyPlatforms(next);
            platformStatus.textContent = `${platformLabel(platform)} ${on ? 'включён' : 'отключён'}`;
        }
        settingsPanel.querySelectorAll('[data-platform-toggle]').forEach(button => button.addEventListener('click', () => {
            const platform = button.dataset.platformToggle;
            setPlatformEnabled(platform, !platformOn(platform));
        }));
        GM_addValueChangeListener(PLATFORMS_KEY, (_k, _old, value) => applyPlatforms(value));
        updatePlatformControls();

        let paused=false;
        // Баннер «чат не актуален»: если лента стоит на паузе (промотана вверх)
        // дольше STALE_DELAY_MS — показываем плашку, клик проматывает вниз.
        const STALE_DELAY_MS = 6000;
        const staleBanner = document.getElementById('stale-banner');
        let staleTimer = null;
        function updateStaleBanner(){
            if(paused){
                if(!staleTimer && staleBanner.style.display !== 'block'){
                    staleTimer = setTimeout(()=>{
                        staleTimer = null;
                        if(paused) staleBanner.style.display = 'block';
                    }, STALE_DELAY_MS);
                }
            } else {
                if(staleTimer){ clearTimeout(staleTimer); staleTimer = null; }
                staleBanner.style.display = 'none';
            }
        }
        staleBanner.addEventListener('click', ()=>{
            paused = false;
            chat.scrollTop = chat.scrollHeight;
            updateStaleBanner();
        });
        chat.addEventListener('scroll',()=>{
            paused = chat.scrollHeight-(chat.scrollTop+chat.clientHeight) > 250;
            updateStaleBanner();
            if(chat.scrollTop < 120) showOlder();
            else if(!paused) trimFeed();
        });
        const scroll=()=>{ if(!paused) chat.scrollTop=chat.scrollHeight; };

        // Прокрутка вверх подгружает старые сообщения: в ленте внизу держим MAX строк,
        // вытесненные лежат в памяти (всего не больше FEED_SCROLLBACK) и возвращаются, когда листаешь вверх.
        // ответ на сообщение: из строки ленты (кнопка ↩ или пункт меню ника)
        function replyToRow(row){
            if(!row || !row.dataset.rawid) return;
            if(!platformOn(row.dataset.plat)) return;
            setComposeReply({
                platform:row.dataset.plat, name:row.dataset.name || '', userId:row.dataset.userid || '',
                rawId:row.dataset.rawid, id:row.dataset.id || '', preview:row.dataset.preview || ''
            });
        }
        const FEED_SCROLLBACK = 1000;
        const olderRows = [];   // вытесненные строки, старые первыми
        function trimFeed(){
            // пока человек читает выше (лента на паузе), строки не трогаем — иначе текст уедет из-под глаз
            const keep = paused ? FEED_SCROLLBACK : MAX;
            while(chat.children.length > keep) olderRows.push(chat.removeChild(chat.firstChild));
            const room = FEED_SCROLLBACK - chat.children.length;
            if(olderRows.length > room) olderRows.splice(0, olderRows.length - Math.max(0, room));
        }
        function showOlder(){
            if(!olderRows.length) return;
            const batch = olderRows.splice(Math.max(0, olderRows.length - 50));
            const fragment = document.createDocumentFragment();
            batch.forEach(row => {
                // пока строка лежала в памяти, могли поменять имя, выделение или «ждём ответа»
                row.querySelectorAll('.name[data-name],.mention[data-name],.reply-name[data-name],.mod-name[data-name]').forEach(applyAliasToElement);
                applyWaitingClass(row);
                applyHighlightClass(row);
                fragment.appendChild(row);
            });
            const before = chat.scrollHeight, top = chat.scrollTop;
            chat.style.scrollBehavior = 'auto';
            chat.insertBefore(fragment, chat.firstChild);
            chat.scrollTop = top + (chat.scrollHeight - before); // текст на экране остаётся на месте
            chat.style.scrollBehavior = '';
        }

        // [emote:ID:NAME] -> img (Kick); ссылки и @ — подсветка
        function kickContent(content){
            content = cleanChatText(content);
            const out=[]; const re=/\[emote:(\d+):([^\]]+)\]/g; let last=0,m;
            const pushText=t=>cleanChatText(t).split(/(\s+)/).forEach(w=>{
                if(!w.trim()){out.push(w);return;}
                if(/^https?:\/\//.test(w)){const s=w.length>45?w.slice(0,42)+'…':w;out.push(`<a href="${esc(w)}" target="_blank" rel="noopener">${esc(s)}</a>`);}
                else if(w[0]==='@'){
                    const original = w.slice(1);
                    const alias = displayName('kick', original);
                    out.push(`<span class="mention" data-plat="kick" data-name="${esc(original)}" title="Действия с ${esc(original)}">@${esc(alias)}</span>`);
                }
                else out.push(sevenTvHtml(w) || esc(w));
            });
            while((m=re.exec(content))){ if(m.index>last)pushText(content.slice(last,m.index)); out.push(`<img class="emote" src="https://files.kick.com/emotes/${m[1]}/fullsize" title="${esc(m[2])}">`); last=re.lastIndex; }
            if(last<content.length)pushText(content.slice(last));
            return out.join('').replace(/^[\s\u200B]+|[\s\u200B]+$/g, '');
        }
        function vkContent(parts){
            const list = parts || [];
            return list.map((p, index)=>{
                if(p.t==='emote') return `<img class="emote" src="${esc(p.v)}">`;
                if(p.t==='mention') {
                    const next = list[index + 1];
                    const needsSpace = next && next.t !== 'emote' && !/^[\s.,!?:;)\]}]/.test(String(next.v || ''));
                    const alias = displayName('vk', p.v || '', p.id || '');
                    return `<span class="mention" data-plat="vk" data-userid="${esc(p.id || '')}" data-name="${esc(p.v || '')}" title="Действия с ${esc(p.v || '')}">@${esc(alias)}</span>${needsSpace ? ' ' : ''}`;
                }
                return cleanChatText(p.v).split(/(\s+)/).map(w=>{
                    if(!w.trim())return w;
                    if(/^https?:\/\//.test(w)){const s=w.length>45?w.slice(0,42)+'…':w;return `<a href="${esc(w)}" target="_blank" rel="noopener">${esc(s)}</a>`;}
                    if(w[0]==='@'){
                        const original = w.slice(1);
                        const alias = displayName('vk', original);
                        return `<span class="mention" data-plat="vk" data-name="${esc(original)}" title="Действия с ${esc(original)}">@${esc(alias)}</span>`;
                    }
                    return sevenTvHtml(w) || esc(w);
                }).join('');
            }).join('').replace(/^[\s\u200B]+|[\s\u200B]+$/g, '');
        }
        function partsText(parts){
            return cleanChatText((parts || []).map(part => {
                if(part.t === 'mention') return `@${part.v || ''}`;
                if(part.t === 'emote') return `:${part.name || 'смайл'}:`;
                return part.v || '';
            }).join(''));
        }
        function asVkParts(value){
            const parts = [];
            const addText = t => { const text = compactTextPart(t); if(text) parts.push({ t:'text', v:text }); };
            const walk = v => {
                if(v == null) return;
                if(typeof v === 'string'){
                    let parsed = null;
                    try { parsed = JSON.parse(v); } catch(e) { }
                    if(!parsed && v.includes('[')){
                        try { parsed = JSON.parse(v.slice(v.indexOf('['))); } catch(e) { }
                    }
                    if(parsed) walk(parsed);
                    else addText(v);
                } else if(Array.isArray(v)){
                    if(typeof v[0] === 'string') addText(v[0]);
                    else v.forEach(walk);
                } else if(typeof v === 'object'){
                    if(v.modificator === 'BLOCK_END' || v.type === 'BLOCK_END') return;
                    if(v.type === 'mention' || v.type === 'user_mention' || v.mentionId || v.userId || v.user_id) {
                        parts.push({ t:'mention', v:v.displayName || v.nick || v.name || v.content || '', id:v.mentionId || v.userId || v.user_id || v.id || '' });
                    } else {
                        const smileId = String(v.id || v.smileId || v.smile_id || '');
                        const src = v.smallUrl || v.mediumUrl || v.largeUrl || v.url || v.src
                            || (/^[0-9a-f-]{36}$/i.test(smileId)
                                ? `https://images.live.vkvideo.ru/smile/${smileId}/icon/size/medium`
                                : '');
                        if((v.type === 'smile' || v.type === 'emote' || src) && /^https?:\/\//.test(src)) {
                            parts.push({ t:'emote', v:src, id:smileId, name:v.name || v.displayName || '' });
                        }
                        else if('content' in v) walk(v.content);
                        else if('text' in v) walk(v.text);
                        else if('message' in v) walk(v.message);
                    }
                }
            };
            walk(value);
            return parts.length ? parts : [{ t:'text', v:cleanChatText(value) }];
        }

        function render(msg, force=false){
            // отключённый чат в ленту не пускаем. Исключения: удаление лишь зачёркивает
            // уже нарисованную (скрытую) строку и добавляет пометку о нём (force), а буфер
            // после релоада рисуем целиком — строки отключённого чата прячет CSS,
            // при включении они вернутся
            if(!force && !restoringFeed && msg.type !== 'delete'
                && !platformOn(msg.platform === 'kick' ? 'kick' : 'vk')) return;
            if(msg.type === 'delete'){
                rememberFeedMsg(msg);
                const row = chat.querySelector(`.msg[data-id="${CSS.escape(msg.targetId || ('kick_' + msg.rawId))}"]`);
                if(row){
                    row.classList.add('removed');
                    status(row, 'deleted');
                    render({
                        platform:row.dataset.plat || msg.platform || 'kick',
                        type:'mod_event',
                        name:row.dataset.name || 'сообщение',
                        action:'сообщение удалено'
                    }, true);
                }
                return;
            }
            if(msg.type === 'color_update'){
                rememberColor(msg.platform || 'vk', msg.name, msg.userId || '', msg.color || '');
                const row = chat.querySelector(`.msg[data-id="${CSS.escape(msg.targetId || ('vk_' + msg.rawId))}"]`);
                const nameEl = row?.querySelector('.name');
                if(nameEl && msg.color){
                    nameEl.style.color=msg.color;
                    nameEl.style.setProperty('--nick-light-color',accessibleNickColor(msg.color));
                }
                return;
            }
            function renderModerationText(textEl, item){
                if(!textEl || !item) return;
                const platform = item.platform === 'kick' ? 'kick' : 'vk';
                const color = rememberedColor(platform, item.name, item.userId || '') || colorFor(item.name || '');
                const actor = item.actor ? `${esc(item.actor)} → ` : '';
                const shownName = displayName(platform, item.name || '', item.userId || '');
                textEl.innerHTML = `Модерация: ${actor}<span class="mod-name" data-name="${esc(item.name || '')}" data-plat="${platform}" data-userid="${esc(item.userId || '')}" style="color:${esc(color)};cursor:pointer" title="История ${esc(item.name || '')}">${esc(shownName)}</span> · ${esc(item.action || '')}`;
            }
            if(msg.type === 'mod_event'){
                const rawAction = String(msg.action || '').toLowerCase();
                const actionKey = /unban|unmut|снят|разбан/.test(rawAction)
                    ? 'clear'
                    : /timeout|тайм-аут/.test(rawAction) ? 'timeout'
                    : /ban|бан/.test(rawAction) ? 'ban' : rawAction;
                const key = `${msg.platform || 'vk'}:${String(msg.name || '').toLowerCase()}:${actionKey}`;
                const now = Date.now();
                const previous = seenModEvents.get(key);
                if(previous && now - previous.ts < 5000) {
                    const richerActor = msg.actor && !previous.actor;
                    const richerAction = String(msg.action || '').length > String(previous.action || '').length;
                    const richerUserId = msg.userId && !previous.userId;
                    if(richerActor || richerAction || richerUserId) {
                        previous.actor = msg.actor || previous.actor;
                        previous.action = richerAction ? msg.action : previous.action;
                        previous.userId = richerUserId ? msg.userId : previous.userId;
                        const text = previous.el?.querySelector('.text');
                        renderModerationText(text, previous);
                    }
                    return;
                }
                if(seenModEvents.size > 500) {
                    for(const [k, item] of seenModEvents) if(now - item.ts > 60000) seenModEvents.delete(k);
                }
                const div=document.createElement('div');
                div.className='msg mod-event';
                const platform = msg.platform === 'kick' ? 'kick' : 'vk';
                div.dataset.plat = platform;
                div.innerHTML = `<span class="plat ${platform}"><img src="${esc(platform === 'kick' ? KICK_ICON_URL : VK_ICON_URL)}" alt="${platform}"></span><span class="text"></span>`;
                const item = { ts:now, el:div, platform, name:msg.name || '', userId:msg.userId || '', actor:msg.actor || '', action:msg.action || '' };
                renderModerationText(div.querySelector('.text'), item);
                seenModEvents.set(key, item);
                rememberFeedMsg(msg);
                chat.appendChild(div);
                trimFeed();
                scroll();
                return;
            }
            // ДЕДУП по id сообщения — главный фикс дублей (один и тот же id больше не рисуется)
            if(msg.id){
                if(seenIds.has(msg.id)) return;
                seenIds.add(msg.id);
                if(seenIds.size>8000){ const a=[...seenIds]; a.slice(0,3000).forEach(x=>seenIds.delete(x)); }
            }
            rememberFeedMsg(msg);
            total++;
            const div=document.createElement('div');
            div.className='msg';
            div.dataset.id = msg.id || '';
            const normalizedRawId = msg.rawId || (msg.id ? String(msg.id).replace(/^(kick|vk)_/, '') : '');
            div.dataset.chatroomid = msg.chatroomId || '';
            div.dataset.userid = msg.userId || '';
            const color = (msg.colorExact && msg.color) || rememberedColor(msg.platform, msg.name, msg.userId) || msg.color || colorFor(msg.name);
            rememberColor(msg.platform, msg.name, msg.userId || '', color);
            if(messageIsPrivileged(msg)) rememberPrivilegedUser(msg.platform, msg.name);

            let badges='';
            if(msg.platform==='kick'){
                (msg.badges_v2||[]).forEach(b=>{
                    const badgeName = String(b.name || '').toLowerCase();
                    if(badgeName === 'level') return;
                    if(b.url) badges+=`<img class="badge img" src="${esc(b.url)}" title="${esc(b.name||'')}">`;
                });
                (msg.badges_txt||[]).forEach(t=>{ badges += kickTextBadgeHtml(t); });
            } else {
                (msg.badges||[]).forEach(b=>{ if(b.url) badges+=`<img class="badge img" src="${esc(b.url)}" title="${esc(b.name||'')}">`; });
                if(msg.isOwner && !badges) badges+='<span class="badge" title="owner">🎬</span>';
                else if(msg.isMod && !badges) badges+='<span class="badge" title="moderator">⚔️</span>';
            }

            let reply='';
            if(msg.reply && msg.reply.name){
                // рендерим смайлы картинками (а не голым :NAME:/ссылкой)
                const rcHtml = (msg.platform==='vk' && Array.isArray(msg.reply.parts))
                    ? vkContent(msg.reply.parts)
                    : msg.platform==='kick'
                        ? kickContent(msg.reply.content||'')
                        : esc((msg.reply.content||'').replace(/\[emote:\d+:([^\]]+)\]/g,':$1:')).slice(0,140);
                const parentId = msg.reply.id || (msg.reply.rawId ? `${msg.platform}_${msg.reply.rawId}` : '');
                const parentAttr = parentId ? ` data-parent-id="${esc(parentId)}" title="Перейти к исходному сообщению"` : '';
                const replyShownName = displayName(msg.platform, msg.reply.name, msg.reply.userId || '');
                reply=`<span class="reply"${parentAttr}><span class="reply-label">Ответ </span><span class="reply-name" data-name="${esc(msg.reply.name)}" data-plat="${msg.platform}" data-userid="${esc(msg.reply.userId || '')}">${esc(replyShownName)}</span><span class="reply-text">: ${rcHtml}</span></span>`;
            }

            const body = msg.platform==='kick' ? kickContent(msg.content||'') : vkContent(msg.parts);
            div.dataset.plat = msg.platform;
            div.dataset.name = msg.name;
            div.dataset.rawid = normalizedRawId;
            div.dataset.sentAt = String(Number(msg.ts || msg.createdAt || msg.created_at) || Date.now());
            div.dataset.preview = cleanChatText(msg.platform === 'kick' ? (msg.content || '') : partsText(msg.parts || [])).slice(0, 140);
            if(msg.name){
                chatUsers.set(`${msg.platform}:${String(msg.name).toLowerCase()}`, {
                    platform:msg.platform,
                    name:msg.name,
                    userId:msg.userId || '',
                    ts:Date.now()
                });
                if(chatUsers.size > 1000){
                    const oldest = [...chatUsers.entries()].sort((a,b) => a[1].ts - b[1].ts).slice(0, 200);
                    oldest.forEach(([key]) => chatUsers.delete(key));
                }
            }
            const sentAt = new Date(Number(div.dataset.sentAt));
            const timeHtml = isNaN(sentAt) ? '' : `<span class="ts" title="${esc(sentAt.toLocaleString('ru-RU'))}">${esc(sentAt.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }))}</span>`;
            div.innerHTML = timeHtml + reply +
                `<span class="plat ${msg.platform}"><img src="${esc(msg.platform==='kick' ? KICK_ICON_URL : VK_ICON_URL)}" alt="${msg.platform==='kick'?'Kick':'VK'}"></span>` +
                badges +
                `<span class="name" data-name="${esc(msg.name)}" data-plat="${msg.platform}" data-userid="${esc(msg.userId || '')}" style="${nickColorStyle(color)};cursor:pointer" title="Действия с ${esc(msg.name)}">${esc(displayName(msg.platform, msg.name, msg.userId || ''))}</span>` +
                `<span class="text">${body}</span>` +
                (normalizedRawId ? `<button class="msg-reply" type="button" title="Ответить" aria-label="Ответить ${esc(msg.name)}">${REPLY_ICON}</button>` : '');
            if(msg.reply?.name && currentUsers[msg.platform]
                && String(msg.reply.name).trim().toLowerCase() === currentUsers[msg.platform]){
                div.classList.add('reply-to-me');
            }
            applyWaitingClass(div);
            applyHighlightClass(div);
            chat.appendChild(div);

            // история
            history.push({ platform: msg.platform, name: msg.name, color, html: body, reply: reply, ts: Number(div.dataset.sentAt) || Date.now() });
            while(history.length>HIST_CAP) history.shift();

            trimFeed();
            scroll();
        }

        // --- Окна истории, модерации и ссылок: та же тема и палитра, что у ленты ---
        const HIST_THEME_VARS = ['--bg','--panel','--border','--text','--muted','--surface-0','--surface-1','--surface-2','--surface-3','--surface-4',
            '--accent','--accent-soft','--accent-medium','--accent-strong','--accent-bright','--accent-dark','--accent-contrast'];
        const HIST_ICONS = {
            trash:'<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
            clock:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
            ban:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>',
            undo:'<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>'
        };
        const HIST_CSS = `
            *{box-sizing:border-box}
            html{--danger:#c62f3b}
            html[data-theme="dark"]{--danger:#ff6b76}
            body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 Inter,system-ui,"Segoe UI",Arial,sans-serif;-webkit-font-smoothing:antialiased}
            [hidden]{display:none!important}
            .hd{position:sticky;top:0;z-index:2;padding:14px 16px 12px;background:var(--panel);border-bottom:1px solid var(--border);
                box-shadow:0 6px 18px color-mix(in srgb,var(--text) 8%,transparent)}
            .hd-top{display:flex;align-items:center;gap:11px;min-width:0}
            .hp{width:30px;height:30px;border-radius:8px;flex:0 0 auto;object-fit:cover}
            .hp.kick{background:#53fc18}
            .hp.vk{object-fit:contain;border-radius:0}
            .hwho{min-width:0}
            .hn{font-size:17px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            html[data-theme="light"] .hn,html[data-theme="aero"] .hn{color:var(--nick-light-color)!important}
            .hm{font-size:12px;color:var(--muted);margin-top:2px;font-variant-numeric:tabular-nums}
            .badge{vertical-align:middle;margin-right:5px}.badge.img{height:1.05em;width:1.05em;border-radius:3px}
            button{font:inherit;font-size:13px;font-weight:600;color:var(--text);cursor:pointer;
                transition:background-color .14s ease,border-color .14s ease,color .14s ease,opacity .14s ease,transform .1s cubic-bezier(.2,.8,.2,1)}
            button svg{width:15px;height:15px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
            button:active{transform:translateY(1px) scale(.97)}
            button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
            button:disabled{opacity:.5;cursor:default;transform:none}
            .hist-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:12px}
            .seg{display:inline-flex;align-items:stretch;height:30px;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--surface-1)}
            .seg-l{display:inline-flex;align-items:center;gap:6px;padding:0 10px;font-size:12px;color:var(--muted);border-right:1px solid var(--border)}
            .seg-l svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
            .seg button{border:0;border-right:1px solid var(--border);border-radius:0;background:transparent;padding:0 10px;min-width:36px}
            .seg button:last-child{border-right:0}
            .seg button:hover{background:var(--accent-soft)}
            .seg button:active{transform:none;background:var(--accent-medium)}
            .sp{flex:1}
            .hist-actions>button,#more{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 11px;
                border:1px solid var(--border);border-radius:8px;background:var(--surface-1)}
            .hist-actions>button:hover,#more:hover{background:var(--surface-3)}
            .hist-actions .danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,var(--border))}
            .hist-actions .danger:hover,.hist-actions .danger.armed{background:var(--danger);border-color:var(--danger);color:#fff}
            /* ползунок — своей строкой во всю ширину: текст кнопки и подпись меняются, пока его крутишь, и не должны его двигать */
            .custom-to{display:grid;grid-template-columns:auto auto minmax(0,1fr);grid-template-areas:"l row go" "r r r";align-items:center;gap:8px 10px;
                margin-top:10px;font-size:12px;color:var(--muted)}
            .custom-to .ct-l{grid-area:l}
            .custom-to .dp{display:contents}
            .custom-to .dp-row{grid-area:row;min-width:0}
            .custom-to .dp-range{grid-area:r;width:100%}
            .custom-to .go{grid-area:go;width:100%;min-width:0;height:30px;padding:0 12px;border:1px solid var(--accent-dark);border-radius:8px;background:var(--accent);color:var(--accent-contrast);
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .custom-to .go:hover{background:var(--accent-bright)}
            .custom-to .go:disabled{background:var(--surface-1);border-color:var(--border);color:var(--muted);opacity:1}
            .dp-row{display:flex;align-items:center;gap:6px}
            .dp-num,.dp-unit{height:30px;border:1px solid var(--border);border-radius:8px;background:var(--surface-0);color:var(--text);font:inherit;font-size:13px;padding:0 8px}
            .dp-num{width:72px}
            .dp-num:focus,.dp-unit:focus{outline:2px solid var(--accent);outline-offset:1px}
            .dp-num.invalid{border-color:var(--danger);outline-color:var(--danger)}
            .dp-human{min-width:0;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .dp-human:empty{display:none}
            .dp-range{-webkit-appearance:none;appearance:none;height:20px;margin:0;background:transparent;cursor:pointer}
            .dp-range::-webkit-slider-runnable-track{height:4px;border-radius:4px;background:linear-gradient(to right,var(--accent) var(--p,0%),color-mix(in srgb,var(--text) 16%,transparent) var(--p,0%))}
            .dp-range::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;background:var(--panel);border:2px solid var(--accent);transition:transform .1s ease}
            .dp-range:hover::-webkit-slider-thumb{transform:scale(1.12)}
            .dp-range:active::-webkit-slider-thumb{transform:scale(.95)}
            .dp-range:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
            #notice{margin-top:10px;padding:7px 10px;border-radius:8px;font-size:12.5px;border:1px solid var(--accent-medium);background:var(--accent-soft);
                animation:hist-in .18s ease-out}
            #notice.bad{border-color:color-mix(in srgb,var(--danger) 40%,transparent);background:color-mix(in srgb,var(--danger) 12%,transparent)}
            .wrap{padding:6px 8px 4px;max-width:860px;margin:0 auto}
            .day{display:flex;align-items:center;gap:10px;margin:14px 8px 6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
            .day::after{content:'';flex:1;height:1px;background:var(--border);opacity:.6}
            .hr{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:10px;align-items:start;padding:5px 8px;border-radius:8px;
                transition:background-color .12s ease;animation:hist-in .16s ease-out both}
            .hr:hover{background:color-mix(in srgb,var(--text) 5%,transparent)}
            .htime{font-size:12px;line-height:20px;color:var(--muted);font-variant-numeric:tabular-nums}
            .hbody{min-width:0;overflow-wrap:anywhere;line-height:20px}
            .ht{white-space:pre-wrap}
            .hrow-mod{display:inline-flex;align-items:center;gap:6px;min-height:20px;opacity:0;transition:opacity .12s ease}
            .hr:hover .hrow-mod,.hrow-mod:focus-within,.hrow-mod.show{opacity:1}
            .hrow-mod button{width:28px;height:24px;display:grid;place-items:center;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--muted)}
            .hrow-mod button:hover{color:var(--danger);background:color-mix(in srgb,var(--danger) 12%,transparent);border-color:color-mix(in srgb,var(--danger) 35%,transparent)}
            .hstatus{font-size:12px;color:var(--accent);white-space:nowrap}.hstatus.bad{color:var(--danger)}
            .hr.removed .hbody{opacity:.45;text-decoration:line-through}
            .reply{display:block;margin:0 0 2px;padding-left:8px;border-left:2px solid var(--accent-strong);color:var(--muted);font-size:12.5px;line-height:1.35;
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .reply-label,.reply-text{color:inherit}.reply-name{font-weight:700;color:var(--text)}
            .empty{padding:44px 12px;text-align:center;color:var(--muted)}
            img.emote{vertical-align:-.25em;height:1.35em;max-width:1.55em;width:auto;object-fit:contain;margin:-.12em .08em}
            a{color:#3a8bfd;text-decoration:none}a:hover{text-decoration:underline}
            #more{display:flex;margin:10px auto 22px}
            .link-row{display:grid;grid-template-columns:22px minmax(0,1fr);gap:8px;align-items:start;padding:7px 8px;border-radius:8px}
            .link-row:hover{background:color-mix(in srgb,var(--text) 5%,transparent)}
            .link-row img{width:16px;height:16px;border-radius:4px;margin-top:2px}
            .link-row .nick{font-weight:700;margin-right:6px}
            html[data-theme="light"] .link-row .nick,html[data-theme="aero"] .link-row .nick{color:var(--nick-light-color)!important}
            .link-row a{word-break:break-all}
            ::-webkit-scrollbar{width:10px}::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--text) 18%,transparent);border-radius:10px;border:3px solid var(--bg)}
            @keyframes hist-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
            @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;
        function histPage(title, head, body, foot=''){
            const cs = getComputedStyle(document.documentElement);
            const vars = HIST_THEME_VARS.map(v => [v, cs.getPropertyValue(v).trim()]).filter(([, val]) => val && !/[<>{};]/.test(val));
            const root = document.documentElement.dataset;
            return `<!DOCTYPE html><html lang="ru" data-theme="${esc(root.theme || 'dark')}" data-color-scheme="${esc(root.colorScheme || '')}"><head><meta charset="UTF-8">`
                + `<title>${esc(title)}</title><style>:root{${vars.map(([k, val]) => `${k}:${val}`).join(';')}}${HIST_CSS}</style></head>`
                + `<body>${head}<main id="wrap" class="wrap">${body}</main>${foot}</body></html>`;
        }
        function histHead({ name, color, platform, meta, actions='' }){
            const icon = platform === 'kick' ? KICK_ICON_URL : platform === 'vk' ? VK_ICON_URL : '';
            return `<header class="hd"><div class="hd-top">${icon ? `<img class="hp ${esc(platform)}" src="${esc(icon)}" alt="">` : ''}`
                + `<div class="hwho"><div class="hn" style="${color ? nickColorStyle(color) : ''}">${esc(name)}</div><div id="meta" class="hm">${esc(meta)}</div></div></div>`
                + `${actions}<div id="notice" role="status" hidden></div></header>`;
        }
        function histActions(presets, unbanAct){
            const buttons = presets.map(([min, label]) => `<button data-uact="${min === 'stream' ? 'stream-timeout' : 'timeout'}" data-min="${esc(min)}">${esc(label)}</button>`).join('');
            return `<div class="hist-actions"><div class="seg" role="group" aria-label="Тайм-аут"><span class="seg-l">${HIST_ICONS.clock}Тайм-аут</span>${buttons}`
                + `</div><span class="sp"></span>`
                + `<button data-uact="${unbanAct}" title="Снять бан и тайм-аут">${HIST_ICONS.undo}Снять</button>`
                + `<button class="danger" data-uact="ban" title="Забанить навсегда (нажать два раза)">${HIST_ICONS.ban}<span>Бан</span></button></div>`
                + `<form class="custom-to"><span class="ct-l">Свой срок</span>${durationPickerHtml()}<button type="submit" class="go" disabled>Тайм-аут</button></form>`;
        }
        // строка «свой срок»: вводится в самом окне (prompt из окна ленты Chrome глушит, пока в фокусе это окно)
        function histWireCustomTimeout(w, run){
            const form = w.document.querySelector('.custom-to');
            if(!form) return;
            const go = form.querySelector('.go');
            const picker = wireDurationPicker(form, m => {
                go.disabled = !m;
                go.textContent = m ? `Тайм-аут на ${humanDuration(m)}` : 'Тайм-аут';
            });
            form.addEventListener('submit', e => {
                e.preventDefault();
                if(!picker.minutes) return;
                go.dataset.uact = 'timeout';
                go.dataset.min = String(picker.minutes);
                run(go); // действие читает срок сразу, до первого await
                delete go.dataset.uact; delete go.dataset.min;
            });
        }
        const HISTORY_LIMIT = 1000; // сообщений в одном окне истории
        function histTime(raw){
            let d = null;
            if(raw !== undefined && raw !== null && raw !== ''){
                const n = Number(raw);
                d = Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(raw);
            }
            if(!d || isNaN(d)) return { day:'', time:'', full:'' };
            return { day:d.toDateString(), time:d.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }), full:d.toLocaleString('ru-RU') };
        }
        function histRow({ id='', when='', reply='', html='', removed=false }){
            const t = histTime(when);
            return `<div class="hr${removed ? ' removed' : ''}" data-mid="${esc(id)}" data-day="${esc(t.day)}">`
                + `<time class="htime" title="${esc(t.full)}">${esc(t.time || '—')}</time>`
                + `<div class="hbody">${reply}<span class="ht">${html}</span></div>`
                + `<span class="hrow-mod"><span class="hstatus" hidden></span>${id ? `<button data-hact="delete" title="Удалить сообщение" aria-label="Удалить сообщение">${HIST_ICONS.trash}</button>` : ''}</span></div>`;
        }
        // разделители дней между сообщениями (пересчитываются после каждой подгрузки)
        function histMarkDays(wrap){
            wrap.querySelectorAll(':scope > .day').forEach(el => el.remove());
            const today = new Date(), yesterday = new Date(Date.now() - 86400000);
            let last = null;
            wrap.querySelectorAll(':scope > .hr').forEach(row => {
                const day = row.dataset.day;
                if(!day || day === last) return;
                last = day;
                const d = new Date(day);
                const label = day === today.toDateString() ? 'Сегодня' : day === yesterday.toDateString() ? 'Вчера'
                    : d.toLocaleDateString('ru-RU', d.getFullYear() === today.getFullYear() ? { day:'numeric', month:'long' } : { day:'numeric', month:'long', year:'numeric' });
                row.insertAdjacentHTML('beforebegin', `<div class="day">${esc(label)}</div>`);
            });
        }
        function histNotice(w, text, bad=false){
            const el = w.document.getElementById('notice');
            if(!el) return;
            el.textContent = text;
            el.classList.toggle('bad', bad);
            el.hidden = false;
            el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
        }
        function histRowStatus(row, text, bad=false){
            const el = row.querySelector('.hstatus');
            if(!el) return;
            el.textContent = text;
            el.hidden = false;
            el.classList.toggle('bad', bad);
            row.querySelector('.hrow-mod')?.classList.add('show');
        }
        // «Бан» срабатывает со второго нажатия: первое только взводит кнопку на 3 секунды
        function histArmed(btn){
            if(btn.dataset.uact !== 'ban' || btn.classList.contains('armed')) return true;
            const label = btn.querySelector('span');
            btn.classList.add('armed');
            if(label) label.textContent = 'Точно бан?';
            clearTimeout(btn._disarm);
            btn._disarm = setTimeout(() => histDisarm(btn), 3000);
            return false;
        }
        function histDisarm(btn){
            clearTimeout(btn._disarm);
            btn.classList.remove('armed');
            const label = btn.querySelector('span');
            if(btn.dataset.uact === 'ban' && label) label.textContent = 'Бан';
        }

        // --- ИСТОРИЯ по клику на ник ---
        function openLinksWindow(){
            const rows = [];
            const seen = new Set();
            history.filter(item => platformOn(item.platform === 'kick' ? 'kick' : 'vk')).forEach(item => {
                const doc = new DOMParser().parseFromString(`<div>${item.html || ''}</div>`, 'text/html');
                doc.querySelectorAll('a[href]').forEach(a => {
                    const href = a.getAttribute('href') || '';
                    if(!/^https?:\/\//.test(href) || seen.has(href)) return;
                    seen.add(href);
                    rows.push({ href, name:item.name, platform:item.platform, color:item.color || '#fff' });
                });
            });
            const body = rows.map(r => `<div class="link-row"><img src="${esc(r.platform === 'kick' ? KICK_ICON_URL : VK_ICON_URL)}" alt="${esc(r.platform)}"><div><span class="nick" style="${nickColorStyle(r.color)}">${esc(r.name)}</span><a href="${esc(r.href)}" target="_blank" rel="noopener">${esc(r.href)}</a></div></div>`).join('')
                || '<div class="empty">В текущей ленте ссылок нет</div>';
            const page = histPage('Ссылки чата', histHead({ name:'Ссылки из чата', meta:`найдено: ${rows.length}` }), body);
            const w = window.open('', '_blank', 'width=760,height=720,scrollbars=yes,resizable=yes');
            if(w){ w.document.open(); w.document.write(page); w.document.close(); }
        }

        function openHistory(name, platform, userId){
            if(platform === 'kick') return openKickHistory(name);
            if(platform === 'vk' && userId) return openVkHistory(name, userId);
            return openBufferHistory(name, platform);
        }

        function popupFeatures(key, fallback){
            let cfg = {};
            try { cfg = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch(e) { }
            const width = Math.max(420, Math.min(screen.availWidth || 1920, Number(cfg.width) || fallback.width));
            const height = Math.max(420, Math.min(screen.availHeight || 1080, Number(cfg.height) || fallback.height));
            const left = Math.max(0, Math.min((screen.availWidth || 1920) - 80, Number(cfg.left) || fallback.left || 80));
            const top = Math.max(0, Math.min((screen.availHeight || 1080) - 80, Number(cfg.top) || fallback.top || 60));
            return `width=${Math.floor(width)},height=${Math.floor(height)},left=${Math.floor(left)},top=${Math.floor(top)},scrollbars=yes,resizable=yes`;
        }
        function rememberPopup(w, key){
            if(!w) return;
            const save = () => {
                if(w.closed) return;
                try {
                    localStorage.setItem(key, JSON.stringify({
                        left: w.screenX,
                        top: w.screenY,
                        width: w.outerWidth,
                        height: w.outerHeight
                    }));
                } catch(e) { }
            };
            const timer = setInterval(() => {
                if(w.closed) clearInterval(timer);
                else save();
            }, 1200);
            try { w.addEventListener('beforeunload', save); } catch(e) { }
        }

        function openBufferHistory(name, platform){
            const items = history.filter(h => h.name===name && h.platform===platform);
            const color = items.length ? items[items.length-1].color : '#fff';
            const rows = items.map(h => histRow({ when:h.ts, reply:h.reply, html:h.html })).join('') || '<div class="empty">В ленте нет его сообщений</div>';
            const platLabel = platform==='kick' ? 'Kick' : 'VK Play Live';
            const page = histPage(`История: ${name}`, histHead({ name, color, platform, meta:`${platLabel} · сообщений в ленте: ${items.length}` }), rows);
            const w = window.open('', '_blank', popupFeatures('mcBufferHistoryWindow', { width:560, height:720, left:80, top:60 }));
            if(w){
                rememberPopup(w, 'mcBufferHistoryWindow'); w.document.open(); w.document.write(page); w.document.close();
                histMarkDays(w.document.getElementById('wrap'));
                // прокрутка снаружи: inline-скрипты в окне могут быть запрещены CSP
                try { w.scrollTo(0, w.document.body.scrollHeight); } catch(e) { }
            }
        }

        function pickKickUserId(data){
            return data?.id || data?.user_id || data?.user?.id || data?.data?.id || data?.data?.user?.id || null;
        }
        function pickHistoryMessages(data){
            const candidates = [data?.messages, data?.data?.messages, data?.data, data];
            return candidates.find(Array.isArray) || [];
        }
        function pickNextCursor(data, messages){
            const direct = data?.next_cursor || data?.nextCursor || data?.cursor || data?.data?.next_cursor || data?.data?.nextCursor || data?.data?.cursor;
            if(direct !== undefined && direct !== null && direct !== '') return String(direct);
            const last = messages[messages.length - 1] || {};
            const fallback = last.cursor || last.created_at_timestamp || last.created_at_ts || last.timestamp || last.created_at_ms;
            return fallback !== undefined && fallback !== null && fallback !== '' ? String(fallback) : '';
        }
        function kickHistoryRow(m, name){
            const content = m?.content || m?.message || m?.body || m?.text || '';
            const removed = !!(m?.deleted_at || m?.deleted || m?.is_deleted);
            return histRow({ id:m?.id || m?.message_id || '', when:m?.created_at || m?.sent_at || m?.timestamp || '', html:kickContent(String(content)), removed });
        }
        async function kickApiJson(url){
            const r = await kickApi('GET', url);
            const text = await r.text();
            try { return text ? JSON.parse(text) : {}; }
            catch(e){ throw new Error('bad JSON '+text.slice(0, 120)); }
        }
        async function openKickHistory(name){
            const w = window.open('', '_blank', popupFeatures('mcKickHistoryWindow', { width:640, height:760, left:90, top:70 }));
            if(!w) return;
            rememberPopup(w, 'mcKickHistoryWindow');
            const kickColor = rememberedColor('kick', name, '') || '#53fc18';
            const page = histPage(`Kick: ${name}`,
                histHead({ name, color:kickColor, platform:'kick', meta:'Kick · загружаю профиль…',
                    actions:histActions([['5','5м'],['60','1ч'],['1440','1д']], 'unban') }),
                '', '<button id="more">Ещё</button>');
            w.document.open(); w.document.write(page); w.document.close();

            const wrap = w.document.getElementById('wrap');
            const meta = w.document.getElementById('meta');
            const more = w.document.getElementById('more');
            const runKickHistoryAction = async (btn) => {
                const act = btn.dataset.uact || btn.dataset.hact;
                const row = btn.closest('.hr');
                try{
                    btn.disabled = true;
                    if(act === 'delete'){
                        const mid = row?.dataset.mid || '';
                        if(!mid) throw new Error('no message id');
                        await kickApi('DELETE', `https://kick.com/api/v2/chatrooms/${encodeURIComponent(KICK_CHATROOM_ID)}/messages/${encodeURIComponent(mid)}`);
                        row.classList.add('removed');
                        histRowStatus(row, 'удалено');
                    } else if(act === 'timeout'){
                        let min = btn.dataset.min;
                        min = durationToMinutes(min, 'minute');
                        await kickApi('POST', `https://kick.com/api/v2/channels/${KICK_SLUG}/bans`, { duration:min, banned_username:name, permanent:false });
                        histNotice(w, `Тайм-аут ${formatDuration(min)} — готово`);
                    } else if(act === 'ban'){
                        await kickApi('POST', `https://kick.com/api/v2/channels/${KICK_SLUG}/bans`, { permanent:true, banned_username:name });
                        histNotice(w, `${name} забанен`);
                    } else if(act === 'unban'){
                        await kickApi('DELETE', `https://kick.com/api/v2/channels/${KICK_SLUG}/bans/${encodeURIComponent(name)}`);
                        histNotice(w, 'Бан и тайм-аут сняты');
                    }
                }catch(err){
                    console.error('history moderation error', err);
                    if(row) histRowStatus(row, 'ошибка: ' + err.message, true);
                    else histNotice(w, 'Не вышло: ' + err.message, true);
                }finally{
                    btn.disabled = false;
                }
            };
            w.document.addEventListener('click', e => {
                const btn = e.target.closest('[data-uact],[data-hact]');
                if(btn && histArmed(btn)) { histDisarm(btn); runKickHistoryAction(btn); }
            });
            histWireCustomTimeout(w, runKickHistoryAction);
            let loading = false;
            let done = false;
            let cursor = '0';
            let loaded = 0;
            const usedCursors = new Set();

            const load = async () => {
                if(loading || done || usedCursors.has(cursor)) return;
                loading = true;
                let ok = false;
                more.textContent = 'Загрузка…';
                try{
                    let userId = more.dataset.uid;
                    if(!userId){
                        const user = await kickApiJson(`https://kick.com/api/v2/channels/${KICK_SLUG}/users/${encodeURIComponent(name)}`);
                        userId = pickKickUserId(user);
                        console.log('[MergedChat] Kick user history profile', name, user);
                        if(!userId) throw new Error('user id not found');
                        more.dataset.uid = String(userId);
                        // Бейджи из профиля (verified и т.п.) — дублируем в шапку окна
                        const profileBadges = (user?.badges || user?.data?.badges || [])
                            .map(b => kickTextBadgeHtml(b?.type ?? b?.name ?? b)).join('');
                        if(profileBadges) w.document.querySelector('.hn')?.insertAdjacentHTML('afterbegin', profileBadges);
                    }
                    const data = await kickApiJson(`https://kick.com/api/v2/channels/${KICK_CHANNEL_ID}/users/${encodeURIComponent(userId)}/messages?cursor=${encodeURIComponent(cursor)}`);
                    const messages = pickHistoryMessages(data);
                    console.log('[MergedChat] Kick user history messages', { name, userId, cursor, data });
                    usedCursors.add(cursor);
                    if(!messages.length){
                        done = true;
                        if(!loaded) wrap.innerHTML = '<div class="empty">Сообщений нет — или Kick их не отдал</div>';
                    } else {
                        const take = messages.slice(0, HISTORY_LIMIT - loaded);
                        wrap.insertAdjacentHTML('beforeend', take.map(m => kickHistoryRow(m, name)).join(''));
                        histMarkDays(wrap);
                        loaded += take.length;
                        const next = pickNextCursor(data, messages);
                        if(!next || next === cursor) done = true;
                        else cursor = next;
                    }
                    if(loaded >= HISTORY_LIMIT) done = true;
                    meta.textContent = `Kick · сообщений: ${loaded}${loaded >= HISTORY_LIMIT ? ` из ${HISTORY_LIMIT} — больше окно не держит` : done ? ' · это все' : ''}`;
                    ok = true;
                    more.hidden = done;
                }catch(err){
                    console.error('history error', err);
                    meta.textContent = 'Kick';
                    histNotice(w, 'История не загрузилась: ' + err.message, true);
                    more.textContent = 'Повторить';
                }finally{
                    loading = false;
                    if(ok && !done){
                        more.textContent = 'Ещё';
                        // окно ещё не заполнено до прокрутки — подгружаем следующую порцию сами
                        if(!w.closed && w.document.body.scrollHeight <= w.innerHeight + 260) setTimeout(load, 250);
                    }
                }
            };
            more.addEventListener('click', load);
            w.addEventListener('scroll', () => {
                if(w.innerHeight + w.scrollY > w.document.body.scrollHeight - 260) load();
            });
            load();
        }
        function vkHistoryRow(m, name){
            const msg = (m?.type === 'message' && m?.data && typeof m.data === 'object') ? m.data : (m?.message && typeof m.message === 'object' ? m.message : m);
            const content = msg?.content ?? msg?.text ?? msg?.body ?? msg?.data ?? msg?.payload?.data ?? msg?.message?.data ?? msg?.message ?? '';
            const id = msg?.id || msg?.message_id || msg?.chatMessageId || m?.id || '';
            const html = vkContent(asVkParts(content));
            const parent = msg?.parentMessage || msg?.parent || msg?.replyMessage || msg?.reply || null;
            let reply = '';
            if(parent && typeof parent === 'object'){
                const pu = parent.user || parent.author || {};
                const pname = pu.displayName || pu.nick || pu.name || parent.displayName || parent.nick || parent.name || '';
                const pparts = asVkParts(parent.content ?? parent.text ?? parent.message ?? parent.data ?? '');
                const ptext = pparts.map(p => p.v || '').join('').trim();
                if(pname || ptext) reply = `<span class="reply"><span class="reply-label">Ответ </span><span class="reply-name">${esc(pname)}</span><span class="reply-text">: ${vkContent(pparts)}</span></span>`;
            }
            if(!html.trim()) console.log('[MergedChat] VK history empty content', m);
            return histRow({ id, when:msg?.created_at || msg?.createdAt || msg?.createTime || msg?.timestamp || '', reply,
                html:html || '<span style="color:var(--muted)">[пусто]</span>' });
        }
        async function openVkHistory(name, userId){
            const w = window.open('', '_blank', popupFeatures('mcVkHistoryWindow', { width:640, height:760, left:100, top:80 }));
            if(!w) return;
            rememberPopup(w, 'mcVkHistoryWindow');
            const userColor = rememberedColor('vk', name, userId) || '#4da3ff';
            const page = histPage(`VK: ${name}`,
                histHead({ name, color:userColor, platform:'vk', meta:'VK · загружаю…',
                    actions:histActions([['10','10м'],['60','1ч'],['stream','До стрима']], 'clear') }),
                '', '<button id="more">Ещё</button>');
            w.document.open(); w.document.write(page); w.document.close();
            const wrap = w.document.getElementById('wrap');
            const meta = w.document.getElementById('meta');
            const more = w.document.getElementById('more');
            const runVkHistoryAction = async (btn) => {
                const act = btn.dataset.uact || btn.dataset.hact;
                const row = btn.closest('.hr');
                try{
                    btn.disabled = true;
                    if(act === 'delete'){
                        const mid = row?.dataset.mid || '';
                        if(!mid) throw new Error('no message id');
                        await vkApi('DELETE', `https://api.live.vkvideo.ru/v1/blog/${KICK_SLUG}/public_video_stream/chat/${encodeURIComponent(mid)}`);
                        row.classList.add('removed');
                        histRowStatus(row, 'удалено');
                    } else if(act === 'timeout'){
                        let min = btn.dataset.min;
                        min = durationToMinutes(min, 'minute');
                        await vkApi('PUT', `https://api.live.vkvideo.ru/v1/channel/${KICK_SLUG}/public_video_stream/ban/stream/slot/default`, {
                            user_id:userId,
                            period:String(min * 60),
                            by_stream:'false',
                            is_permanent:'false'
                        });
                        histNotice(w, `Тайм-аут ${formatDuration(min)} — готово`);
                    } else if(act === 'stream-timeout'){
                        await vkApi('PUT', `https://api.live.vkvideo.ru/v1/channel/${KICK_SLUG}/public_video_stream/ban/stream/slot/default`, {
                            user_id:userId,
                            by_stream:'true',
                            is_permanent:'false'
                        });
                        histNotice(w, 'Тайм-аут до конца стрима — готово');
                    } else if(act === 'ban'){
                        await vkApi('PUT', `https://api.live.vkvideo.ru/v1/channel/${KICK_SLUG}/public_video_stream/ban/stream/slot/default`, {
                            user_id:userId,
                            is_permanent:'true',
                            by_stream:'false',
                            clean_messages:'true'
                        });
                        histNotice(w, `${name} забанен, сообщения удалены`);
                    } else if(act === 'clear'){
                        await vkClearBan(userId);
                        histNotice(w, 'Бан и тайм-аут сняты');
                    }
                }catch(err){
                    console.error('vk history moderation error', err);
                    if(row) histRowStatus(row, 'ошибка: ' + err.message, true);
                    else histNotice(w, 'Не вышло: ' + err.message, true);
                }finally{
                    btn.disabled = false;
                }
            };
            w.document.addEventListener('click', e => {
                const btn = e.target.closest('[data-uact],[data-hact]');
                if(btn && histArmed(btn)) { histDisarm(btn); runVkHistoryAction(btn); }
            });
            histWireCustomTimeout(w, runVkHistoryAction);
            let after = '';
            let loading = false;
            let done = false;
            let loaded = 0;
            const used = new Set();
            const load = async () => {
                if(loading || done || used.has(after)) return;
                loading = true;
                let ok = false;
                more.textContent = 'Загрузка…';
                try{
                    const url = `https://api.live.vkvideo.ru/v1/blog/${KICK_SLUG}/public_video_stream/chat/user/${encodeURIComponent(userId)}${after ? '?after=' + encodeURIComponent(after) : ''}`;
                    const data = await vkApiJson(url);
                    const messages = [data?.messages, data?.data?.messages, data?.data, data].find(Array.isArray) || [];
                    console.log('[MergedChat] VK user history messages', { name, userId, after, data });
                    used.add(after);
                    if(!messages.length){
                        done = true;
                        if(!loaded) wrap.innerHTML = '<div class="empty">Сообщений нет — или VK их не отдал</div>';
                    } else {
                        const take = messages.slice(0, HISTORY_LIMIT - loaded);
                        wrap.insertAdjacentHTML('beforeend', take.map(m => vkHistoryRow(m, name)).join(''));
                        histMarkDays(wrap);
                        loaded += take.length;
                        const last = messages[messages.length - 1] || {};
                        const lastMsg = (last?.type === 'message' && last?.data && typeof last.data === 'object') ? last.data : (last?.message && typeof last.message === 'object' ? last.message : last);
                        const next = lastMsg.id || lastMsg.message_id || last.id || last.message_id || data?.next_after || data?.after || '';
                        if(!next || String(next) === String(after)) done = true;
                        else after = String(next);
                    }
                    if(loaded >= HISTORY_LIMIT) done = true;
                    meta.textContent = `VK · сообщений: ${loaded}${loaded >= HISTORY_LIMIT ? ` из ${HISTORY_LIMIT} — больше окно не держит` : done ? ' · это все' : ''}`;
                    ok = true;
                    more.hidden = done;
                }catch(err){
                    console.error('vk history error', err);
                    meta.textContent = 'VK';
                    histNotice(w, 'История не загрузилась: ' + err.message, true);
                    more.textContent = 'Повторить';
                }finally{
                    loading = false;
                    if(ok && !done){
                        more.textContent = 'Ещё';
                        // окно ещё не заполнено до прокрутки — подгружаем следующую порцию сами
                        if(!w.closed && w.document.body.scrollHeight <= w.innerHeight + 260) setTimeout(load, 250);
                    }
                }
            };
            more.addEventListener('click', load);
            w.addEventListener('scroll', () => {
                if(w.innerHeight + w.scrollY > w.document.body.scrollHeight - 260) load();
            });
            load();
        }
        // --- «Ждём ответа»: подсветка всех сообщений выбранного человека ---
        const waitingUsers = new Set();
        function isWaiting(platform, name, userId){
            return waitingUsers.has(userColorKey(platform, name, userId)) || waitingUsers.has(userColorKey(platform, name, ''));
        }
        function applyWaitingClass(row){
            if(!row || !row.dataset.plat) return;
            row.classList.toggle('awaiting', isWaiting(row.dataset.plat, row.dataset.name, row.dataset.userid || ''));
        }
        function markWaiting(platform, name, userId, on){
            const kFull = userColorKey(platform, name, userId);
            const kName = userColorKey(platform, name, '');
            if(on){ waitingUsers.add(kFull); waitingUsers.add(kName); }
            else { waitingUsers.delete(kFull); waitingUsers.delete(kName); }
            chat.querySelectorAll('.msg').forEach(applyWaitingClass);
        }

        // --- Постоянное выделение людей: цвет хранится в GM и переживает перезапуск ---
        function applyHighlightClass(row){
            if(!row || !row.dataset.plat) return;
            const color = getUserHighlight(row.dataset.plat, row.dataset.name, row.dataset.userid || '');
            row.classList.toggle('highlighted', !!color);
            if(color) row.style.setProperty('--mc-hl', color);
            else row.style.removeProperty('--mc-hl');
        }
        function refreshHighlightClasses(){
            chat.querySelectorAll('.msg').forEach(applyHighlightClass);
        }

        // мини-меню по клику на ник: локальное имя, история и ожидание ответа
        let nickMenu = null;
        function closeNickMenu(){ if(nickMenu){ nickMenu.remove(); nickMenu = null; } }
        function openNickMenu(el, data={}){
            closeNickMenu();
            const platform = data.platform || el.dataset.plat || el.closest('.msg')?.dataset.plat || 'vk';
            const name = data.name || el.dataset.name || el.textContent.trim().replace(/^@/, '');
            const userId = data.userId || el.dataset.userid || '';
            const alias = getLocalAlias(platform, name, userId);
            const waiting = isWaiting(platform, name, userId);
            const highlight = getUserHighlight(platform, name, userId);
            // яркие цвета выделения по кругу оттенков: две строки по 9
            const HL_COLORS = [
                ['#ff2e63','малиновый'], ['#ff5c5c','красный'], ['#ff7a00','оранжевый'], ['#ffd700','золотой'], ['#ffea00','лимонный'],
                ['#c6ff00','лайм'], ['#53fc18','кислотный'], ['#00ff9c','неоновая мята'], ['#00e5ff','электрик'],
                ['#00bcd4','бирюзовый'], ['#3a8bfd','синий'], ['#1e3cff','ультрамарин'], ['#7c4dff','фиолетовый'], ['#b388ff','лавандовый'],
                ['#e542ff','пурпурный'], ['#ff6fff','ультрарозовый'], ['#ff1493','ярко-розовый'], ['#ff80ab','сахарная вата']
            ];
            nickMenu = document.createElement('div');
            nickMenu.className = 'nick-menu';
            nickMenu.dataset.plat = platform;
            const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
            const NM_ICON = {
                mention: svg('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'),
                rename: svg('<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>'),
                reset: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
                history: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
                highlight: svg('<path d="m9 11-5 5v4h4l5-5"/><path d="m14 6 4 4"/><path d="m12 8 4 4 4-4-4-4-4 4Z"/>'),
                wait: svg('<path d="M6 3h12M6 21h12"/><path d="M7 3c0 5 10 5 10 9s-10 4-10 9"/><path d="M17 3c0 5-10 5-10 9s10 4 10 9"/>'),
                done: svg('<path d="m5 12 5 5 9-10"/>')
            };
            const item = (nm, icon, text, extra = '') => `<button class="nm-item${extra}" data-nm="${nm}">${icon}<span>${text}</span></button>`;
            // открыли с ника в ленте — можно ответить именно на это сообщение
            const replyRow = el.classList.contains('name') && el.closest('#chat') ? el.closest('.msg[data-rawid]') : null;
            const canReply = !!(replyRow && replyRow.dataset.rawid && platformOn(replyRow.dataset.plat));
            nickMenu.innerHTML =
                `<div class="nm-head"><img class="nm-plat" src="${esc(platform === 'kick' ? KICK_ICON_URL : VK_ICON_URL)}" alt="">`
                    + `<div class="nm-who"><div class="nm-title" style="color:${esc(el.style.color || 'var(--text)')}">${esc(alias || name)}</div>`
                    + (alias ? `<div class="nm-sub">ник: ${esc(name)}</div>` : '') + `</div></div>`
                + (canReply ? item('reply', REPLY_ICON, 'Ответить') : '')
                + item('mention', NM_ICON.mention, 'Тегнуть')
                + item('rename', NM_ICON.rename, alias ? 'Изменить имя' : 'Переименовать')
                + (alias ? item('rename-reset', NM_ICON.reset, 'Вернуть настоящий ник') : '')
                + item('history', NM_ICON.history, 'История и модерация')
                + `<div class="nm-sep"></div>`
                + `<div class="nm-hl" title="Выделять все сообщения этого человека">${NM_ICON.highlight}<span class="nm-hl-label">Выделить</span>`
                    + (highlight ? `<button class="nm-hl-off" data-nm="hl-off" title="Снять выделение">Снять</button>` : '')
                + `</div><div class="nm-hl-dots">`
                    + HL_COLORS.map(([c, label]) => `<button class="nm-hl-dot${String(highlight).toLowerCase() === c ? ' on' : ''}" data-nm="hl" data-color="${c}" style="--c:${c}" title="${label}" aria-label="${label}"></button>`).join('')
                + `</div>`
                + item('wait', waiting ? NM_ICON.done : NM_ICON.wait, waiting ? 'Снять ожидание' : 'Ждём ответа', ' nm-wait' + (waiting ? ' on' : ''));
            document.body.appendChild(nickMenu);
            // клавиатура: ↑/↓ по пунктам, Enter — выбрать, Esc — закрыть
            const menuEl = nickMenu;
            const nmItems = [...menuEl.querySelectorAll('.nm-item')];
            const onKey = ev => {
                if(nickMenu !== menuEl){ document.removeEventListener('keydown', onKey, true); return; }
                if(ev.key === 'ArrowDown' || ev.key === 'ArrowUp'){
                    ev.preventDefault();
                    const i = nmItems.indexOf(document.activeElement);
                    const next = i < 0 ? (ev.key === 'ArrowDown' ? 0 : nmItems.length - 1)
                        : ev.key === 'ArrowDown' ? (i + 1) % nmItems.length : (i - 1 + nmItems.length) % nmItems.length;
                    nmItems[next].focus({ preventScroll:true });
                } else if(ev.key === 'Escape'){
                    ev.preventDefault();
                    closeNickMenu();
                    document.removeEventListener('keydown', onKey, true);
                }
            };
            document.addEventListener('keydown', onKey, true);
            const r = el.getBoundingClientRect();
            nickMenu.style.left = Math.min(window.innerWidth - nickMenu.offsetWidth - 6, Math.max(6, r.left)) + 'px';
            nickMenu.style.top = Math.min(window.innerHeight - nickMenu.offsetHeight - 6, r.bottom + 4) + 'px';
            nickMenu.addEventListener('click', ev => {
                const b = ev.target.closest('button');
                if(!b) return;
                if(b.dataset.nm === 'reply'){ closeNickMenu(); replyToRow(replyRow); }
                else if(b.dataset.nm === 'mention'){
                    insertComposerText(`@${name} `);
                    selectedMention = { platform, name, userId };
                    closeNickMenu();
                }
                else if(b.dataset.nm === 'rename'){
                    const value = window.prompt(`Локальное имя для ${name}:`, alias || '');
                    if(value === null) return;
                    const clean = value.trim().slice(0, 80);
                    if(!clean){
                        saveLocalAlias(platform, name, userId, '');
                    } else {
                        saveLocalAlias(platform, name, userId, clean);
                    }
                    refreshLocalAliases(platform, name, userId);
                    closeNickMenu();
                }
                else if(b.dataset.nm === 'rename-reset'){
                    saveLocalAlias(platform, name, userId, '');
                    refreshLocalAliases(platform, name, userId);
                    closeNickMenu();
                }
                else if(b.dataset.nm === 'history'){ closeNickMenu(); openHistory(name, platform, userId); }
                else if(b.dataset.nm === 'hl'){ saveUserHighlight(platform, name, userId, b.dataset.color || ''); refreshHighlightClasses(); closeNickMenu(); }
                else if(b.dataset.nm === 'hl-off'){ saveUserHighlight(platform, name, userId, ''); refreshHighlightClasses(); closeNickMenu(); }
                else if(b.dataset.nm === 'wait'){ markWaiting(platform, name, userId, !waiting); closeNickMenu(); }
            });
        }

        // --- ВЕТКИ ОТВЕТОВ ---
        // Строим дерево по уже загруженным сообщениям: ответ знает id родителя,
        // поэтому можно подняться к корню и затем показать всех его потомков.
        function buildThreadIndex(){
            const messages = [...chat.querySelectorAll('.msg[data-id]')].filter(el => el.dataset.id);
            const byId = new Map();
            const childrenOf = new Map();
            const parentOf = new Map();
            messages.forEach(el => { if(!byId.has(el.dataset.id)) byId.set(el.dataset.id, el); });
            messages.forEach(el => {
                const parentId = el.querySelector('.reply[data-parent-id]')?.dataset.parentId;
                if(!parentId || !byId.has(parentId)) return;
                parentOf.set(el.dataset.id, parentId);
                if(!childrenOf.has(parentId)) childrenOf.set(parentId, []);
                childrenOf.get(parentId).push(el.dataset.id);
            });
            return { byId, childrenOf, parentOf };
        }
        function renderThreadNode(id, depth, index, currentId, visited, fragment){
            if(visited.has(id)) return;
            visited.add(id);
            const original = index.byId.get(id);
            if(!original) return;
            const clone = original.cloneNode(true);
            clone.style.display = '';
            clone.classList.add('thread-msg');
            clone.classList.remove('reply-target', 'awaiting', 'highlighted');
            clone.style.setProperty('--depth', depth);
            clone.querySelector('.mod')?.remove();
            clone.querySelector('.msg-reply')?.remove();
            clone.querySelector('.reply')?.remove();
            if(id === currentId) clone.classList.add('thread-current');
            const jump = document.createElement('button');
            jump.className = 'thread-jump';
            jump.type = 'button';
            jump.title = 'Перейти к сообщению в чате';
            jump.textContent = '⤴';
            clone.appendChild(jump);
            fragment.appendChild(clone);
            const children = (index.childrenOf.get(id) || []).slice().sort((a,b) =>
                Number(index.byId.get(a)?.dataset.sentAt || 0) - Number(index.byId.get(b)?.dataset.sentAt || 0));
            children.forEach(childId => renderThreadNode(childId, depth + 1, index, currentId, visited, fragment));
        }
        function positionThread(anchor){
            const width = threadPanel.offsetWidth;
            const height = threadPanel.offsetHeight;
            const margin = 8;
            const rect = anchor?.getBoundingClientRect();
            let left, top;
            if(window.innerWidth <= 700 || !rect){
                left = (window.innerWidth - width) / 2;
                top = (window.innerHeight - height) / 2;
            } else {
                left = rect.left - width - 10;
                if(left < margin) left = rect.right + 10;
                top = rect.top;
            }
            left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
            top = Math.min(Math.max(margin, top), window.innerHeight - height - margin);
            threadPanel.style.left = `${left}px`;
            threadPanel.style.top = `${top}px`;
        }
        function openThread(startId, anchor){
            const index = buildThreadIndex();
            if(!index.byId.has(startId)) return;
            let root = startId;
            const guard = new Set();
            while(index.parentOf.has(root) && !guard.has(root)){
                guard.add(root);
                root = index.parentOf.get(root);
            }
            const fragment = document.createDocumentFragment();
            renderThreadNode(root, 0, index, startId, new Set(), fragment);
            threadBody.innerHTML = '';
            threadBody.appendChild(fragment);
            const count = threadBody.querySelectorAll('.thread-msg').length;
            threadTitle.textContent = `Ветка ответов · ${count}`;
            threadPanel.classList.add('open');
            threadPanel.setAttribute('aria-hidden', 'false');
            positionThread(anchor);
            requestAnimationFrame(() => threadBody.querySelector('.thread-current')?.scrollIntoView({ block:'center' }));
        }
        function closeThread(){
            threadPanel.classList.remove('open');
            threadPanel.setAttribute('aria-hidden', 'true');
        }
        function jumpToThreadMessage(id){
            closeThread();
            const row = chat.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
            if(!row) return;
            row.scrollIntoView({ block:'center', behavior:'smooth' });
            row.classList.add('reply-target');
            setTimeout(() => row.classList.remove('reply-target'), 1600);
        }
        document.getElementById('thread-close').addEventListener('click', closeThread);
        document.addEventListener('keydown', e => {
            if(e.key === 'Escape' && threadPanel.classList.contains('open')) closeThread();
        });
        document.addEventListener('click', e => {
            if(!threadPanel.classList.contains('open')) return;
            if(threadPanel.contains(e.target) || e.target.closest('.reply[data-parent-id]')) return;
            closeThread();
        });
        threadBody.addEventListener('click', e => {
            const jump = e.target.closest('.thread-jump');
            if(jump){
                const id = jump.closest('.thread-msg')?.dataset.id;
                if(id) jumpToThreadMessage(id);
                return;
            }
            const name = e.target.closest('.name');
            if(name) openNickMenu(name);
        });

        chat.addEventListener('click', e => {
            const rb = e.target.closest('.msg-reply');
            if(rb){ replyToRow(rb.closest('.msg')); return; }
            const modName = e.target.closest('.mod-name');
            if(modName){
                openHistory(modName.dataset.name || modName.textContent.trim(), modName.dataset.plat || 'vk', modName.dataset.userid || '');
                return;
            }
            const m = e.target.closest('.mention');
            if(m){
                const name = m.dataset.name || m.textContent.trim().replace(/^@/, '');
                const row = m.closest('.msg');
                openNickMenu(m, {
                    platform:m.dataset.plat || row?.dataset.plat || 'vk',
                    name,
                    userId:m.dataset.userid || ''
                });
                return;
            }
            const r = e.target.closest('.reply[data-parent-id]');
            if(r && r.dataset.parentId){
                const current = r.closest('.msg');
                if(current?.dataset.id) openThread(current.dataset.id, r);
                else r.title = 'Не удалось собрать ветку';
                return;
            }
            const n = e.target.closest('.name');
            if(n){ openNickMenu(n); return; }
        });
        document.addEventListener('click', e => {
            if(!e.target.closest('.timeout-pop') && !e.target.closest('[data-act="timeout-menu"]')) closeTimeoutMenu();
            if(!e.target.closest('.nick-menu') && !e.target.closest('.name') && !e.target.closest('.mention')) closeNickMenu();
        });

        // --- МОДЕРАЦИЯ ---
        let timeoutPop = null;

        function status(row, text, bad=false){
            let el = row.querySelector('.mod-status');
            if(!el){
                el = document.createElement('span');
                el.className = 'mod-status';
                const textEl = row.querySelector('.text');
                if(textEl) textEl.insertAdjacentElement('afterend', el);
                else row.appendChild(el);
            }
            el.textContent = text;
            el.classList.toggle('bad', bad);
        }
        function showModeratorAction(platform, name, action){
            grantBothAccess(`successful ${platform} moderation`);
            render({
                platform,
                type:'mod_event',
                id:`local_mod_${platform}_${name}_${action}_${Date.now()}`,
                name,
                action
            });
        }

        function kickHeaders(useToken=true){
            const token = useToken ? GM_getValue(TOKEN_KEY, '') : '';
            const xsrfCookie = document.cookie
                .split(';')
                .map(part => part.trim())
                .find(part => part.startsWith('XSRF-TOKEN='));
            let xsrf = '';
            if(xsrfCookie){
                try { xsrf = decodeURIComponent(xsrfCookie.slice('XSRF-TOKEN='.length)); }
                catch(e) { xsrf = xsrfCookie.slice('XSRF-TOKEN='.length); }
            }
            const h = {
                'accept':'application/json',
                'x-app-platform':'web',
                'x-requested-with':'XMLHttpRequest'
            };
            if(token) h['authorization'] = token;
            if(xsrf) h['x-xsrf-token'] = xsrf;
            return h;
        }
        function waitForFreshKickToken(timeout=18000){
            return new Promise(resolve => {
                let done = false;
                let listener = null;
                let timer = null;
                let limit = null;
                const finish = token => {
                    if(done) return;
                    done = true;
                    clearInterval(timer);
                    clearTimeout(limit);
                    resolve(token || '');
                };
                listener = GM_addValueChangeListener(TOKEN_KEY, (_key, _old, value) => {
                    if(value && String(value).startsWith('Bearer ')) finish(value);
                });
                timer = setInterval(() => {
                    const token = GM_getValue(TOKEN_KEY, '');
                    if(token && String(token).startsWith('Bearer ')) finish(token);
                }, 250);
                limit = setTimeout(() => finish(''), timeout);
            });
        }
        async function refreshKickAuthToken(){
            if(typeof MC_EXT !== 'undefined'){
                // Расширение берёт токен прямо из куки kick.com (session_token);
                // если её нет — поднимает скрытый dashboard и ждёт токен оттуда.
                GM_setValue(TOKEN_KEY, '');
                const synced = await MC_EXT.syncTokens();
                if(!(synced && synced.kick)) await MC_EXT.refreshHelper('dash');
                const token = await waitForFreshKickToken(synced && synced.kick ? 5000 : 25000);
                if(!token){
                    MC_EXT.showHelper('dash');
                    throw new Error('Kick: войди на dashboard.kick.com — вкладка открыта');
                }
                const check = await fetch('https://kick.com/api/v1/user', {
                    credentials:'include',
                    headers:kickHeaders(true)
                });
                if(!check.ok){
                    GM_setValue(TOKEN_KEY, '');
                    MC_EXT.showHelper('dash');
                    throw new Error('Kick: новый токен не прошёл проверку. Перелогинься на dashboard.kick.com');
                }
                return token;
            }
            const probeAt = Date.now();
            GM_setValue(KICK_AUTH_PROBE_KEY, { t:probeAt, nonce:Math.random() });
            await new Promise(resolve => setTimeout(resolve, 1200));
            const dashboardOpen = Number(GM_getValue(KICK_AUTH_HEARTBEAT_KEY, 0)) >= probeAt;
            GM_setValue(TOKEN_KEY, '');
            if(!dashboardOpen) throw new Error('Kick: откройте dashboard.kick.com вручную');
            throw new Error('Kick: обновите открытую вкладку dashboard.kick.com вручную');
            const token = await waitForFreshKickToken();
            if(!token) throw new Error('Kick: dashboard не авторизован. Войдите на dashboard.kick.com');
            const check = await fetch('https://kick.com/api/v1/user', {
                credentials:'include',
                headers:kickHeaders(true)
            });
            if(!check.ok) {
                GM_setValue(TOKEN_KEY, '');
                throw new Error('Kick: новый токен не прошёл проверку. Перелогиньтесь на dashboard.kick.com');
            }
            return token;
        }
        async function refreshKickCsrf(){
            const r = await fetch('https://kick.com/sanctum/csrf-cookie', {
                method:'GET',
                credentials:'include',
                mode:'cors',
                headers:{ 'accept':'application/json', 'x-app-platform':'web' }
            });
            if(!r.ok && r.status !== 204) throw new Error(`CSRF HTTP ${r.status}`);
        }
        async function kickApi(method, url, body){
            const request = async (useToken=true) => {
                const opt = { method, headers: kickHeaders(useToken), credentials:'include', mode:'cors' };
                if(body){ opt.headers['content-type']='application/json'; opt.body=JSON.stringify(body); }
                return fetch(url, opt);
            };
            let r = await request();
            if(r.status === 419){
                console.warn('[MergedChat] Kick CSRF expired, refreshing and retrying');
                await refreshKickCsrf();
                r = await request();
            }
            if(r.status === 401 || r.status === 403){
                console.warn('[MergedChat] Kick auth rejected, retrying with cookie session');
                r = await request(false);
                if(r.status === 419){
                    await refreshKickCsrf();
                    r = await request(false);
                }
                if(r.status === 401 || r.status === 403){
                    console.warn('[MergedChat] Kick cookie session rejected, refreshing dashboard token');
                    await refreshKickAuthToken();
                    r = await request(true);
                }
            }
            const text = await r.clone().text().catch(() => '');
            console.log('[MergedChat] Kick API', method, url, r.status, text);
            if(!r.ok){
                const authError = r.status === 401 || r.status === 403;
                throw new Error(authError ? 'Kick: войдите или перелогиньтесь на dashboard.kick.com' : 'HTTP '+r.status+' '+text.slice(0, 120));
            }
            return r;
        }
        function vkHeaders(hasBody=false){
            const saved = GM_getValue(VK_HEADERS_KEY, {}) || {};
            const token = GM_getValue(VK_TOKEN_KEY, '') || saved.authorization || '';
            const h = {
                'accept':'application/json, text/plain, */*',
                'x-app': saved['x-app'] || 'streams_web',
                'x-from-id': saved['x-from-id'] || '',
                'x-referer': saved['x-referer'] || '',
                'x-super-referer': saved['x-super-referer'] || '',
                'x-trans-path': saved['x-trans-path'] || '',
                'x-trans-source': saved['x-trans-source'] || '',
                'x-trans-target': saved['x-trans-target'] || 'blog_url_stream_slot_url_only-chat',
                'x-trans-via': saved['x-trans-via'] || 'chat'
            };
            if(token) h.authorization = token;
            if(hasBody) h['content-type'] = 'application/x-www-form-urlencoded';
            return h;
        }
        function vkApi(method, url, bodyParams=null){
            const body = bodyParams ? new URLSearchParams(bodyParams).toString() : null;
            const hasVkToken = () => !!(GM_getValue(VK_TOKEN_KEY, '') || (GM_getValue(VK_HEADERS_KEY, {}) || {}).authorization);
            // В расширении без токена сами поднимаем фоновую вкладку VK-чата и ждём, пока она его отдаст
            const ready = (typeof MC_EXT === 'undefined' || hasVkToken()) ? Promise.resolve() : (async () => {
                await MC_EXT.ensureHelper('vk');
                for(let i = 0; i < 80 && !hasVkToken(); i++) await new Promise(r => setTimeout(r, 250));
                if(!hasVkToken()) MC_EXT.showHelper('vk');
            })();
            return ready.then(() => new Promise((resolve, reject) => {
                if(!hasVkToken()){
                    reject(new Error('no VK token: open live.vkvideo.ru/grpzdc/stream/default/only-chat'));
                    return;
                }
                GM_xmlhttpRequest({
                    method, url,
                    headers: vkHeaders(!!body),
                    data: body,
                    responseType: 'text',
                    onload: r => {
                        console.log('[MergedChat] VK API', method, url, r.status, r.responseText);
                        // протух токен VK — расширение перечитает его из куки (читатель сообщений тут ни при чём,
                        // его не перезагружаем: иначе каждая отказанная проверка рвала бы чат VK)
                        if((r.status === 401 || r.status === 403) && typeof MC_EXT !== 'undefined') MC_EXT.syncTokens();
                        if(r.status < 200 || r.status >= 300) reject(new Error('HTTP '+r.status+' '+String(r.responseText || '').slice(0,120)));
                        else resolve(r);
                    },
                    onerror: () => reject(new Error('VK request failed')),
                    ontimeout: () => reject(new Error('VK request timeout'))
                });
            }));
        }
        async function vkApiJson(url){
            const r = await vkApi('GET', url);
            const text = r.responseText || '';
            try { return text ? JSON.parse(text) : {}; }
            catch(e){ throw new Error('bad JSON '+text.slice(0, 120)); }
        }
        async function refreshCurrentChatUsers(){
            const jobs = [];
            jobs.push((async () => {
                try {
                    const r = await fetch('https://kick.com/api/v1/user', {
                        credentials:'include',
                        headers:kickHeaders()
                    });
                    if(!r.ok) return;
                    const data = await r.json();
                    const user = data?.data?.user || data?.data || data?.user || data;
                    rememberCurrentUser('kick', user?.username || user?.slug || user?.name);
                } catch(e) { }
            })());
            if(GM_getValue(VK_TOKEN_KEY, '') || (GM_getValue(VK_HEADERS_KEY, {}) || {}).authorization) {
                jobs.push(vkApiJson('https://api.live.vkvideo.ru/v1/current_user').then(data => {
                    const user = data?.data?.user || data?.user || {};
                    rememberCurrentUser('vk', user.nick || user.name || user.displayName);
                }).catch(() => {}));
            }
            await Promise.allSettled(jobs);
        }
        setTimeout(refreshCurrentChatUsers, 1500);
        setInterval(refreshCurrentChatUsers, 60000);
        GM_addValueChangeListener(TOKEN_KEY, refreshCurrentChatUsers);
        GM_addValueChangeListener(VK_TOKEN_KEY, refreshCurrentChatUsers);

        function vkTextBlocks(text, includeEnd=true){
            const blocks = [];
            const re = /https?:\/\/[^\s]+/g;
            let last = 0, match;
            const pushText = value => {
                if(value) blocks.push({ type:'text', content:JSON.stringify([value,'unstyled',[]]), modificator:'' });
            };
            while((match = re.exec(text))){
                pushText(text.slice(last, match.index));
                blocks.push({ type:'link', content:JSON.stringify([match[0],'unstyled',[]]), url:match[0] });
                last = re.lastIndex;
            }
            pushText(text.slice(last));
            if(includeEnd) blocks.push({ type:'text', content:'', modificator:'BLOCK_END' });
            return blocks;
        }
        function vkMessageBlocks(text){
            const smiles = new Map(
                [...(emoteCatalog.vkChannel || []), ...(emoteCatalog.vkRecent || [])]
                    .filter(item => item?.id && item?.name)
                    .map(item => [String(item.name).toLowerCase(), item])
            );
            const blocks = [];
            const re = /:([A-Za-z0-9_]+):/g;
            let last = 0, match;
            while((match = re.exec(text))){
                const smile = smiles.get(match[1].toLowerCase());
                if(!smile) continue;
                blocks.push(...vkTextBlocks(text.slice(last, match.index), false));
                blocks.push({ type:'smile', id:String(smile.id) });
                last = re.lastIndex;
            }
            blocks.push(...vkTextBlocks(text.slice(last), false));
            blocks.push({ type:'text', content:'', modificator:'BLOCK_END' });
            return blocks;
        }

        async function sendKickMessage(text, reply=null){
            const payload = { content:text, type:'message', message_ref:String(Date.now()) };
            if(reply?.rawId){
                payload.type = 'reply';
                payload.metadata = {
                    original_message: { id:reply.rawId, content:reply.preview || '' },
                    original_sender: { username:reply.name || '' }
                };
            }
            try {
                await kickApi('POST', `https://kick.com/api/v2/messages/send/${encodeURIComponent(KICK_CHATROOM_ID)}`, payload);
            } catch(error) {
                if(!reply?.name) throw error;
                await kickApi('POST', `https://kick.com/api/v2/messages/send/${encodeURIComponent(KICK_CHATROOM_ID)}`, {
                    content:`@${reply.name} ${text}`, type:'message', message_ref:String(Date.now())
                });
            }
        }

        async function sendVkMessage(text, reply=null, mention=null){
            const target = reply || mention;
            const token = target?.name ? `@${target.name}` : '';
            const bodyText = token && text.startsWith(token)
                ? text.slice(token.length).trimStart()
                : text;
            let blocks;
            if(target?.userId){
                blocks = [
                    { type:'mention', id:Number(target.userId), displayName:target.name, uniqueId:`${target.userId}${Date.now() % 1000}` },
                    { type:'space' },
                    ...vkMessageBlocks(`\u00a0${bodyText}\u200b`)
                ];
            } else {
                blocks = vkMessageBlocks(target?.name ? `@${target.name} ${bodyText}` : bodyText);
            }
            const body = { data:JSON.stringify(blocks) };
            if(reply?.rawId) body.reply_to_id = reply.rawId;
            await vkApi('POST', `https://api.live.vkvideo.ru/v1/channel/${KICK_SLUG}/stream/slot/default/chat`, body);
        }

        function setComposeReply(reply=null){
            selectedReply = reply;
            chat.querySelectorAll('.msg.replying').forEach(el => el.classList.remove('replying'));
            if(reply?.id) chat.querySelector(`.msg[data-id="${CSS.escape(reply.id)}"]`)?.classList.add('replying');
            replyCompose.classList.toggle('on', !!reply);
            replyComposeText.innerHTML = reply
                ? `<b>Ответ ${esc(displayName(reply.platform, reply.name, reply.userId || ''))}</b> <span class="rc-preview">${esc(reply.preview || '')}</span>`
                : '';
            document.getElementById('send-message').title = reply
                ? `Ответить в ${reply.platform === 'kick' ? 'Kick' : 'VK'}`
                : defaultSendTitle();
            if(emotePicker.classList.contains('open')) renderEmotePicker();
            if(reply) messageInput.focus();
        }

        function insertComposerText(text){
            const start = messageInput.selectionStart ?? messageInput.value.length;
            const end = messageInput.selectionEnd ?? start;
            messageInput.setRangeText(text, start, end, 'end');
            autosizeInput();
            messageInput.focus();
        }

        function mentionQuery(){
            if(messageInput.selectionStart !== messageInput.selectionEnd) return null;
            const end = messageInput.selectionStart;
            const before = messageInput.value.slice(0, end);
            const match = /(^|\s)@([^\s@]*)$/.exec(before);
            if(!match) return null;
            return { start:end - match[2].length - 1, end, query:match[2].toLowerCase() };
        }
        function hideMentionSuggest(){
            mentionSuggest.classList.remove('open');
            mentionSuggest.innerHTML = '';
            mentionItems = [];
            mentionActive = -1;
            mentionAnchor = null;
        }
        function renderMentionSuggest(){
            const query = mentionQuery();
            if(!query){ hideMentionSuggest(); return; }
            const all = [...chatUsers.values()].filter(user => platformOn(user.platform));
            const starts = [], includes = [];
            for(const user of all){
                const name = user.name.toLowerCase();
                if(name === query.query) continue;
                if(!query.query || name.startsWith(query.query)) starts.push(user);
                else if(name.includes(query.query)) includes.push(user);
            }
            const recent = (a,b) => b.ts - a.ts;
            mentionItems = [...starts.sort(recent), ...includes.sort(recent)].slice(0, 7);
            if(!mentionItems.length){ hideMentionSuggest(); return; }
            mentionAnchor = { start:query.start, end:query.end };
            mentionActive = 0;
            mentionSuggest.innerHTML = mentionItems.map((user, index) =>
                `<button type="button" class="mention-option${index === 0 ? ' active' : ''}" data-index="${index}">`
                + `<img src="${esc(user.platform === 'kick' ? KICK_ICON_URL : VK_ICON_URL)}" alt="${user.platform}">`
                + `<span>${esc(user.name)}</span></button>`).join('');
            mentionSuggest.classList.add('open');
        }
        function setMentionActive(index){
            if(!mentionItems.length) return;
            mentionActive = (index + mentionItems.length) % mentionItems.length;
            mentionSuggest.querySelectorAll('.mention-option').forEach((item, i) => item.classList.toggle('active', i === mentionActive));
            mentionSuggest.querySelector('.mention-option.active')?.scrollIntoView({ block:'nearest' });
        }
        function acceptMention(index=mentionActive){
            const user = mentionItems[index];
            if(!user || !mentionAnchor) return;
            const token = `@${user.name} `;
            messageInput.setRangeText(token, mentionAnchor.start, mentionAnchor.end, 'end');
            selectedMention = { platform:user.platform, name:user.name, userId:user.userId };
            hideMentionSuggest();
            messageInput.focus();
        }
        mentionSuggest.addEventListener('mousedown', event => event.preventDefault());
        mentionSuggest.addEventListener('click', event => {
            const option = event.target.closest('.mention-option');
            if(option) acceptMention(Number(option.dataset.index));
        });

        async function sendComposer(target){
            const text = messageInput.value.trim();
            if(!text) return;
            const disabledTarget = (target === 'both' ? ['kick','vk'] : [target]).find(platform => !platformOn(platform));
            if(disabledTarget) throw new Error(disabledTarget === composeEmotePlatform
                ? `В сообщении смайл ${platformLabel(disabledTarget)}, а ${platformLabel(disabledTarget)} отключён в настройках — убери смайл`
                : `${platformLabel(disabledTarget)} отключён в настройках`);
            if(target === 'both' && !canSendBoth) throw new Error('Отправка в оба чата доступна только модераторам и владельцам');
            const reply = selectedReply;
            if(reply && target !== reply.platform) throw new Error('Ответ можно отправить только в исходный чат');
            if(composeEmotePlatform && target !== composeEmotePlatform) {
                throw new Error(`Смайл предназначен для ${composeEmotePlatform === 'kick' ? 'Kick' : 'VK'}`);
            }
            document.getElementById('send-message').disabled = true;
            try {
                const jobs = [];
                const kickText = selectedTemplate?.kickText || selectedTemplate?.vkText || text;
                const vkText = selectedTemplate?.vkText || selectedTemplate?.kickText || text;
                if(target === 'kick' || target === 'both') jobs.push(sendKickMessage(kickText, reply?.platform === 'kick' ? reply : null));
                if(target === 'vk' || target === 'both') jobs.push(sendVkMessage(vkText, reply?.platform === 'vk' ? reply : null, selectedMention?.platform === 'vk' ? selectedMention : null));
                const settled = await Promise.allSettled(jobs);
                const failed = settled.filter(x => x.status === 'rejected');
                if(failed.length === settled.length) throw failed[0].reason;
                messageInput.value = '';
                autosizeInput();
                selectedMention = null;
                selectedTemplate = null;
                composeEmotePlatform = '';
                setComposeReply(null);
                setEmotePickerOpen(false);
                if(failed.length) alert('В один чат отправить не удалось: ' + failed[0].reason.message);
            } finally {
                document.getElementById('send-message').disabled = false;
                sendChoice.classList.remove('open');
            }
        }

        function chatTemplates(){
            const saved = GM_getValue(CHAT_TEMPLATES_KEY, null);
            return Array.isArray(saved) ? saved : structuredClone(DEFAULT_CHAT_TEMPLATES);
        }
        function saveChatTemplates(items){ GM_setValue(CHAT_TEMPLATES_KEY, items); }
        function renderTemplateMenu(){
            templateMenu.innerHTML = '';
            chatTemplates().forEach((tpl, index) => {
                const button = document.createElement('button');
                button.textContent = tpl.title || `Шаблон ${index + 1}`;
                button.addEventListener('click', () => {
                    const target = selectedReply?.platform || (platformOn('kick') ? 'kick' : 'vk');
                    selectedTemplate = tpl;
                    messageInput.value = target === 'vk' ? (tpl.vkText || tpl.kickText || '') : (tpl.kickText || tpl.vkText || '');
                    releaseDisabledEmoteLock();
                    templateMenu.classList.remove('open');
                    messageInput.focus();
                });
                templateMenu.appendChild(button);
            });
            const edit = document.createElement('button');
            edit.className = 'template-edit-toggle';
            edit.textContent = 'Редактировать…';
            edit.addEventListener('click', openTemplateEditor);
            templateMenu.appendChild(edit);
        }
        function openTemplateEditor(){
            const items = chatTemplates();
            templateEditor.innerHTML = `<button id="template-editor-close">Закрыть</button><h3>Шаблоны модератора</h3><div id="template-edit-list"></div><div class="template-actions"><button id="template-add">+ шаблон</button><button id="template-save">Сохранить</button><span id="template-save-status" class="show">✓ Сохранено</span></div>`;
            const list = templateEditor.querySelector('#template-edit-list');
            const saveStatus = templateEditor.querySelector('#template-save-status');
            const markTemplatesDirty = () => {
                saveStatus.textContent = '● Не сохранено';
                saveStatus.classList.add('show', 'dirty');
            };
            const emotesFor = platform => {
                const keys = platform === 'kick'
                    ? ['kickChannel','kickRecent','kickGlobal','kickEmoji','sevenTv']
                    : ['vkChannel','vkRecent'];
                const seen = new Set();
                return keys.flatMap(key => (emoteCatalog[key] || []).map(item => ({ ...item, catalog:key })))
                    .filter(item => {
                        const key = `${item.id || ''}:${item.name || ''}`;
                        if(!item.name || !item.url || seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
            };
            const templatePreviewHtml = (text, platform) => {
                const source = String(text || '');
                const byVkName = new Map(emotesFor('vk').map(item => [String(item.name).toLowerCase(), item]));
                const byKickId = new Map(emotesFor('kick').filter(item => item.id).map(item => [String(item.id), item]));
                let html = '', last = 0, match;
                const re = platform === 'vk'
                    ? /:([A-Za-z0-9_]+):/g
                    : /\[emote:(\d+):([^\]]+)\]|\b([A-Za-z0-9_]+)\b/g;
                while((match = re.exec(source))){
                    let item = null;
                    if(platform === 'vk') item = byVkName.get(String(match[1]).toLowerCase());
                    else if(match[1]) item = byKickId.get(String(match[1]));
                    else {
                        const url = sevenTvEmotes.get(match[3]);
                        if(url) item = { name:match[3], url };
                    }
                    if(!item) continue;
                    html += esc(source.slice(last, match.index));
                    html += `<img src="${esc(item.url)}" alt="${esc(item.name)}" title="${esc(item.name)}">`;
                    last = re.lastIndex;
                }
                return html + esc(source.slice(last));
            };
            const renderRowPreview = (row, platform) => {
                const textarea = row.querySelector(`[data-f="${platform}Text"]`);
                row.querySelector(`[data-preview="${platform}"]`).innerHTML = templatePreviewHtml(textarea.value, platform);
            };
            const addRow = (item={ title:'', kickText:'', vkText:'' }) => {
                const row = document.createElement('div');
                row.className = 'template-edit-row';
                row.innerHTML = `
                    <input data-f="title" placeholder="Название">
                    <div class="template-field-head"><span>Kick</span><button type="button" class="template-emote-toggle" data-open-emotes="kick">☺ Смайлы Kick</button></div>
                    <textarea data-f="kickText" placeholder="Kick"></textarea>
                    <div class="template-preview" data-preview="kick"></div>
                    <div class="template-emote-picker" data-emotes="kick"></div>
                    <div class="template-field-head"><span>VK</span><button type="button" class="template-emote-toggle" data-open-emotes="vk">☺ Смайлы VK</button></div>
                    <textarea data-f="vkText" placeholder="VK"></textarea>
                    <div class="template-preview" data-preview="vk"></div>
                    <div class="template-emote-picker" data-emotes="vk"></div>
                    <button data-delete>Удалить</button>`;
                row.querySelector('[data-f="title"]').value = item.title || '';
                row.querySelector('[data-f="kickText"]').value = item.kickText || '';
                row.querySelector('[data-f="vkText"]').value = item.vkText || '';
                for(const platform of ['kick','vk']){
                    const picker = row.querySelector(`[data-emotes="${platform}"]`);
                    const emotes = emotesFor(platform).slice(0, 300);
                    picker.__emotes = emotes;
                    picker.innerHTML = emotes.map((emote, index) =>
                        `<button type="button" data-template-emote="${index}" title="${esc(emote.name)}"><img src="${esc(emote.url)}" alt="${esc(emote.name)}" loading="lazy"></button>`
                    ).join('');
                    row.querySelector(`[data-open-emotes="${platform}"]`).onclick = () => picker.classList.toggle('open');
                    picker.onclick = event => {
                        const button = event.target.closest('[data-template-emote]');
                        if(!button) return;
                        const emote = emotes[Number(button.dataset.templateEmote)];
                        const textarea = row.querySelector(`[data-f="${platform}Text"]`);
                        const token = platform === 'vk'
                            ? `:${emote.name}:`
                            : emote.catalog === 'sevenTv' ? emote.name : `[emote:${emote.id}:${emote.name}]`;
                        const start = textarea.selectionStart ?? textarea.value.length;
                        const end = textarea.selectionEnd ?? start;
                        const prefix = start && !/\s$/.test(textarea.value.slice(0, start)) ? ' ' : '';
                        const suffix = end < textarea.value.length && !/^\s/.test(textarea.value.slice(end)) ? ' ' : '';
                        textarea.setRangeText(prefix + token + suffix, start, end, 'end');
                        textarea.focus();
                        renderRowPreview(row, platform);
                        markTemplatesDirty();
                    };
                    row.querySelector(`[data-f="${platform}Text"]`).addEventListener('input', () => renderRowPreview(row, platform));
                    renderRowPreview(row, platform);
                }
                row.querySelector('[data-delete]').onclick = () => { row.remove(); markTemplatesDirty(); };
                list.appendChild(row);
            };
            items.forEach(addRow);
            templateEditor.querySelector('#template-add').onclick = () => { addRow(); markTemplatesDirty(); };
            templateEditor.querySelector('#template-editor-close').onclick = () => templateEditor.classList.remove('open');
            list.addEventListener('input', markTemplatesDirty);
            templateEditor.querySelector('#template-save').onclick = () => {
                const next = [...list.querySelectorAll('.template-edit-row')].map(row => ({
                    title:row.querySelector('[data-f="title"]').value.trim(),
                    kickText:row.querySelector('[data-f="kickText"]').value,
                    vkText:row.querySelector('[data-f="vkText"]').value
                })).filter(x => x.title && (x.kickText || x.vkText));
                saveChatTemplates(next);
                renderTemplateMenu();
                saveStatus.textContent = `✓ Сохранено: ${next.length}`;
                saveStatus.classList.add('show');
                saveStatus.classList.remove('dirty');
            };
            templateEditor.classList.add('open');
            templateMenu.classList.remove('open');
        }

        document.getElementById('reply-cancel').onclick = () => setComposeReply(null);
        document.getElementById('template-toggle').onclick = e => { e.stopPropagation(); renderTemplateMenu(); templateMenu.classList.toggle('open'); };
        emoteToggle.onclick = e => {
            e.stopPropagation();
            templateMenu.classList.remove('open');
            sendChoice.classList.remove('open');
            setEmotePickerOpen(!emotePicker.classList.contains('open'));
        };
        emotePicker.addEventListener('click', e => {
            e.stopPropagation();
            const tab = e.target.closest('[data-emote-tab]');
            if(tab){
                emoteTab = tab.dataset.emoteTab;
                emoteSearch.value = '';
                renderEmotePicker();
                return;
            }
            const button = e.target.closest('[data-emote-index]');
            if(!button) return;
            const item = emoteList.__items?.[Number(button.dataset.emoteIndex)];
            if(!item) return;
            const platform = EMOTE_TABS.find(tabInfo => tabInfo[0] === emoteTab)?.[2] || 'kick';
            if(composeEmotePlatform && composeEmotePlatform !== platform) return;
            composeEmotePlatform = platform;
            const token = platform === 'vk'
                ? `:${item.name}:`
                : emoteTab === 'sevenTv' ? item.name : `[emote:${item.id}:${item.name}]`;
            const before = messageInput.value.slice(0, messageInput.selectionStart ?? messageInput.value.length);
            const after = messageInput.value.slice(messageInput.selectionEnd ?? messageInput.value.length);
            insertComposerText(`${before && !/\s$/.test(before) ? ' ' : ''}${token}${after && !/^\s/.test(after) ? ' ' : ''}`);
            selectedTemplate = null;
            renderEmotePicker();
        });
        emoteSearch.addEventListener('input', renderEmotePicker);
        // куда слать без меню выбора: ответ/смайл привязаны к чату, а если включён
        // только один чат — выбирать не из чего
        const directSendTarget = () => {
            releaseDisabledEmoteLock(); // поле могли переписать без input (шаблон, упоминание)
            return selectedReply?.platform || composeEmotePlatform || soleEnabledPlatform();
        };
        function hasEmoteTokens(platform, text){
            if(platform === 'vk'){
                // как в vkMessageBlocks: смайл — только :имя: из каталога VK, а не любое «19:30:00»
                const names = new Set([...(emoteCatalog.vkChannel || []), ...(emoteCatalog.vkRecent || [])]
                    .filter(item => item?.name).map(item => String(item.name).toLowerCase()));
                return [...text.matchAll(/:([A-Za-z0-9_]+):/g)].some(match => names.has(match[1].toLowerCase()));
            }
            return /\[emote:\d+:[^\]]+\]/.test(text) || text.split(/\s+/).some(word => sevenTvEmotes.has(word));
        }
        // смайл отключённого чата из поля убрали — отправку на этом чате больше не держим
        function releaseDisabledEmoteLock(){
            if(composeEmotePlatform && !platformOn(composeEmotePlatform) && !hasEmoteTokens(composeEmotePlatform, messageInput.value)) composeEmotePlatform = '';
        }
        document.getElementById('send-message').onclick = e => {
            e.stopPropagation();
            const target = directSendTarget();
            if(target) sendComposer(target).catch(err => alert(err.message || String(err)));
            else sendChoice.classList.toggle('open');
        };
        sendChoice.addEventListener('click', e => {
            const button = e.target.closest('[data-send]');
            if(button) sendComposer(button.dataset.send).catch(err => alert(err.message || String(err)));
        });
        messageInput.addEventListener('keydown', e => {
            if(mentionSuggest.classList.contains('open') && mentionItems.length){
                if(e.key === 'ArrowDown'){ e.preventDefault(); setMentionActive(mentionActive + 1); return; }
                if(e.key === 'ArrowUp'){ e.preventDefault(); setMentionActive(mentionActive - 1); return; }
                if(e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); acceptMention(); return; }
                if(e.key === 'Escape'){ e.preventDefault(); hideMentionSuggest(); return; }
            }
            if(e.key === 'Enter' && !e.shiftKey){
                e.preventDefault();
                const target = directSendTarget();
                if(target) sendComposer(target).catch(err => alert(err.message || String(err)));
                else sendChoice.classList.add('open');
            }
        });
        // поле растёт вместе с текстом (до ~6 строк), потом прокручивается
        function autosizeInput(){
            messageInput.style.height = 'auto';
            const max = 150;
            messageInput.style.height = Math.min(max, messageInput.scrollHeight + 2) + 'px';
            messageInput.style.overflowY = messageInput.scrollHeight + 2 > max ? 'auto' : 'hidden';
        }
        messageInput.addEventListener('input', autosizeInput);
        window.addEventListener('resize', autosizeInput);
        messageInput.addEventListener('input', () => {
            selectedTemplate = null;
            if(!messageInput.value.trim()) composeEmotePlatform = '';
            releaseDisabledEmoteLock();
            if(selectedMention && !messageInput.value.includes(`@${selectedMention.name}`)) selectedMention = null;
            renderMentionSuggest();
            if(emotePicker.classList.contains('open')) renderEmotePicker();
        });
        messageInput.addEventListener('click', renderMentionSuggest);
        messageInput.addEventListener('blur', () => setTimeout(hideMentionSuggest, 120));
        document.addEventListener('click', e => {
            if(!e.target.closest('#send-choice,#send-message')) sendChoice.classList.remove('open');
            if(!e.target.closest('#template-menu,#template-toggle')) templateMenu.classList.remove('open');
            if(!e.target.closest('#emote-picker,#emote-toggle')) setEmotePickerOpen(false);
        });
        renderTemplateMenu();

        function closeTimeoutMenu(){
            if(timeoutPop){ timeoutPop.remove(); timeoutPop = null; }
        }
        function formatDuration(minutes){
            if(minutes % 10080 === 0) return (minutes / 10080) + ' нед';
            if(minutes % 1440 === 0) return (minutes / 1440) + ' дн';
            if(minutes % 60 === 0) return (minutes / 60) + ' ч';
            return minutes + ' мин';
        }
        // --- Свой срок тайм-аута: поле + ползунок от нуля, единицы поправляются сами (120 мин → 2 ч, 1440 мин → 1 дн) ---
        const DURATION_STEPS = (() => {
            const a = [0];
            for(let m = 1; m <= 10; m++) a.push(m);
            for(let m = 15; m <= 60; m += 5) a.push(m);
            for(let m = 75; m <= 240; m += 15) a.push(m);
            for(let h = 5; h <= 24; h++) a.push(h * 60);
            for(let h = 36; h <= 168; h += 12) a.push(h * 60);
            return a;
        })();
        const DURATION_UNIT_MUL = { minute:1, hour:60, day:1440, week:10080 };
        function humanDuration(min){
            if(!min) return '';
            if(min === 10080) return '1 нед';
            const d = Math.floor(min / 1440), h = Math.floor(min % 1440 / 60), m = min % 60;
            return [d && `${d} дн`, h && `${h} ч`, m && `${m} мин`].filter(Boolean).join(' ');
        }
        function bestDurationUnit(min){
            return min % 10080 === 0 ? 'week' : min % 1440 === 0 ? 'day' : min % 60 === 0 ? 'hour' : 'minute';
        }
        function durationPickerHtml(){
            return `<div class="dp"><div class="dp-row">`
                + `<input class="dp-num" type="number" min="0" step="1" inputmode="decimal" placeholder="0" aria-label="Срок">`
                + `<select class="dp-unit" aria-label="Единица"><option value="minute">мин</option><option value="hour">ч</option><option value="day">дн</option><option value="week">нед</option></select>`
                + `<span class="dp-human"></span></div>`
                + `<input class="dp-range" type="range" min="0" max="${DURATION_STEPS.length - 1}" step="1" value="0" aria-label="Срок ползунком"></div>`;
        }
        // onChange(minutes) — после каждого изменения; minutes = 0, пока срок не выбран
        function wireDurationPicker(root, onChange){
            const num = root.querySelector('.dp-num'), unit = root.querySelector('.dp-unit');
            const range = root.querySelector('.dp-range'), human = root.querySelector('.dp-human');
            let minutes = 0;
            const show = () => {
                // «9999 мин = 6 дн 22 ч 39 мин»: подсказка, когда в поле написано не так, как читается
                const label = { minute:'мин', hour:'ч', day:'дн', week:'нед' }[unit.value];
                human.textContent = minutes && humanDuration(minutes) !== `${num.value} ${label}` ? '= ' + humanDuration(minutes) : '';
                range.style.setProperty('--p', (Number(range.value) / Number(range.max) * 100) + '%');
                if(onChange) onChange(minutes);
            };
            const syncRange = () => {
                let i = 0;
                DURATION_STEPS.forEach((step, k) => { if(step <= minutes) i = k; });
                range.value = String(i);
            };
            const normalize = () => {
                if(!minutes) return;
                unit.value = bestDurationUnit(minutes);
                num.value = String(minutes / DURATION_UNIT_MUL[unit.value]);
            };
            const fromInput = () => {
                const n = Number(String(num.value).replace(',', '.'));
                if(!num.value || !Number.isFinite(n) || n <= 0){
                    minutes = 0;
                    num.classList.toggle('invalid', num.value !== '' && !(n === 0));
                } else {
                    minutes = Math.max(1, Math.min(KICK_MAX_TIMEOUT_MINUTES, Math.round(n * DURATION_UNIT_MUL[unit.value])));
                    num.classList.remove('invalid');
                }
                syncRange();
                show();
            };
            range.addEventListener('input', () => {
                minutes = DURATION_STEPS[Number(range.value)] || 0;
                num.classList.remove('invalid');
                if(minutes) normalize(); else num.value = '';
                show();
            });
            num.addEventListener('input', fromInput);
            unit.addEventListener('change', fromInput);
            // ушёл из поля — переписываем крупнее: 120 мин → 2 ч, 1440 мин → 1 дн, больше недели → 1 нед
            num.addEventListener('change', () => { normalize(); show(); });
            show();
            return { get minutes(){ return minutes; }, focus(){ num.focus(); } };
        }
        function durationToMinutes(value, unit){
            const n = Math.max(1, Math.floor(Number(value) || 0));
            const mul = unit === 'week' ? 10080 : unit === 'day' ? 1440 : unit === 'hour' ? 60 : 1;
            return Math.min(KICK_MAX_TIMEOUT_MINUTES, n * mul);
        }
        function maxDurationValue(unit){
            if(unit === 'week') return 1;
            if(unit === 'day') return 7;
            if(unit === 'hour') return 168;
            return KICK_MAX_TIMEOUT_MINUTES;
        }
        function openTimeoutMenu(btn){
            closeTimeoutMenu();
            const row = btn.closest('.msg');
            const isVk = row.dataset.plat === 'vk';
            timeoutPop = document.createElement('div');
            timeoutPop.className = 'timeout-pop';
            timeoutPop.innerHTML = `
                <div class="tp-title">⏳ Тайм-аут</div>
                <div class="tp-presets">
                    ${isVk ? '<button data-min="10">10 минут</button>' : '<button data-min="5">5 минут</button>'}
                    <button data-min="60">1 час</button>
                    ${isVk ? '<button data-stream="1">До конца стрима</button>' : '<button data-min="1440">1 день</button><button data-min="10080">1 неделя</button>'}
                </div>
                <div class="tp-custom">
                    <div class="tp-sub">Свой срок</div>
                    ${durationPickerHtml()}
                    <button class="tp-set" disabled>Тайм-аут</button>
                </div>`;
            document.body.appendChild(timeoutPop);
            const setBtn = timeoutPop.querySelector('.tp-set');
            const picker = wireDurationPicker(timeoutPop.querySelector('.tp-custom'), m => {
                setBtn.disabled = !m;
                setBtn.textContent = m ? `Тайм-аут на ${humanDuration(m)}` : 'Тайм-аут';
            });
            timeoutPop.querySelector('.dp-num').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); setBtn.click(); } });
            const r = btn.getBoundingClientRect();
            timeoutPop.style.left = Math.min(window.innerWidth - timeoutPop.offsetWidth - 6, Math.max(6, r.right - timeoutPop.offsetWidth)) + 'px';
            timeoutPop.style.top = Math.min(window.innerHeight - timeoutPop.offsetHeight - 6, r.bottom + 6) + 'px';
            timeoutPop.addEventListener('click', e => {
                const preset = e.target.closest('[data-min]');
                if(preset){ doTimeout(row, Number(preset.dataset.min), btn).catch(err => { console.error('mod error', err); status(row, 'error', true); flash(btn,'ошибка '+err.message); }); closeTimeoutMenu(); return; }
                if(e.target.closest('[data-stream]')){ doVkStreamTimeout(row, btn).catch(err => { console.error('mod error', err); status(row, 'error', true); flash(btn,'ошибка '+err.message); }); closeTimeoutMenu(); return; }
                if(e.target.closest('.tp-set')){
                    if(!picker.minutes) return;
                    doTimeout(row, picker.minutes, btn).catch(err => { console.error('mod error', err); status(row, 'error', true); flash(btn,'ошибка '+err.message); });
                    closeTimeoutMenu();
                }
            });
        }
        async function doTimeout(row, minutes, btn){
            if(row.dataset.plat === 'vk') return doVkTimeout(row, minutes, btn);
            const name = row.dataset.name;
            await kickApi('POST', `https://kick.com/api/v2/channels/${KICK_SLUG}/bans`, { duration:minutes, banned_username:name, permanent:false });
            status(row, 'timeout ' + formatDuration(minutes));
            showModeratorAction('kick', name, 'тайм-аут ' + formatDuration(minutes));
            flash(btn, '✓');
        }
        async function doVkTimeout(row, minutes, btn){
            const userId = row.dataset.userid;
            if(!userId) throw new Error('no VK user id');
            await vkApi('PUT', `https://api.live.vkvideo.ru/v1/channel/${KICK_SLUG}/public_video_stream/ban/stream/slot/default`, {
                user_id:userId,
                period:String(minutes * 60),
                by_stream:'false',
                is_permanent:'false'
            });
            status(row, 'timeout ' + formatDuration(minutes));
            showModeratorAction('vk', row.dataset.name, 'тайм-аут ' + formatDuration(minutes));
            flash(btn, '✓');
        }
        async function doVkStreamTimeout(row, btn){
            const userId = row.dataset.userid;
            if(!userId) throw new Error('no VK user id');
            await vkApi('PUT', `https://api.live.vkvideo.ru/v1/channel/${KICK_SLUG}/public_video_stream/ban/stream/slot/default`, {
                user_id:userId,
                by_stream:'true',
                is_permanent:'false'
            });
            status(row, 'timeout stream');
            showModeratorAction('vk', row.dataset.name, 'тайм-аут до конца стрима');
            flash(btn, '✓');
        }
        async function vkClearBan(userId){
            let lastErr = null;
            for(const byStream of ['false', 'true']){
                try{
                    return await vkApi('DELETE', `https://api.live.vkvideo.ru/v1/channel/${KICK_SLUG}/public_video_stream/ban/stream/slot/default?by_stream=${byStream}&user_id=${encodeURIComponent(userId)}`);
                }catch(err){ lastErr = err; }
            }
            throw lastErr || new Error('VK clear ban failed');
        }
        async function doModeration(btn){
            const row = btn.closest('.msg');
            const plat = row.dataset.plat, name = row.dataset.name;
            const rawId = row.dataset.rawid || (row.dataset.id || '').replace(/^(kick|vk)_/, '');
            const userId = row.dataset.userid || '';
            const chatroomId = row.dataset.chatroomid || String(KICK_CHATROOM_ID);
            const act = btn.dataset.act;
            if(act === 'timeout-menu'){ openTimeoutMenu(btn); return; }
            if(act === 'delete' && !rawId){ flash(btn,'нет id'); console.warn('[MergedChat] moderation without rawId', row); return; }
            try{
                if(plat === 'vk'){
                    if((act === 'ban' || act === 'unban' || act === 'untimeout') && !userId) throw new Error('no VK user id');
                    if(act==='delete'){
                        await vkApi('DELETE', `https://api.live.vkvideo.ru/v1/blog/${KICK_SLUG}/public_video_stream/chat/${encodeURIComponent(rawId)}`);
                        status(row, 'delete sent');
                    } else if(act==='untimeout' || act==='unban'){
                        await vkClearBan(userId);
                        status(row, act==='unban' ? 'unbanned' : 'unmuted');
                    } else if(act==='ban'){
                        await vkApi('PUT', `https://api.live.vkvideo.ru/v1/channel/${KICK_SLUG}/public_video_stream/ban/stream/slot/default`, {
                            user_id:userId,
                            is_permanent:'true',
                            by_stream:'false',
                            clean_messages:'true'
                        });
                        status(row, 'banned', true);
                    }
                } else if(act==='delete'){
                    await kickApi('DELETE', `https://kick.com/api/v2/chatrooms/${encodeURIComponent(chatroomId)}/messages/${encodeURIComponent(rawId)}`);
                    status(row, 'delete sent');
                } else if(act==='untimeout'){
                    await kickApi('DELETE', `https://kick.com/api/v2/channels/${KICK_SLUG}/bans/${encodeURIComponent(name)}`);
                    status(row, 'unmuted');
                } else if(act==='ban'){
                    await kickApi('POST', `https://kick.com/api/v2/channels/${KICK_SLUG}/bans`, { permanent:true, banned_username:name });
                    status(row, 'banned', true);
                } else if(act==='unban'){
                    await kickApi('DELETE', `https://kick.com/api/v2/channels/${KICK_SLUG}/bans/${encodeURIComponent(name)}`);
                    status(row, 'unbanned');
                }
                const labels = {
                    delete:'сообщение удалено',
                    untimeout:'тайм-аут снят',
                    unban:'разбан',
                    ban:'бан'
                };
                showModeratorAction(plat, name, labels[act] || act);
                flash(btn,'✓');
            }catch(err){ console.error('mod error', err); flash(btn,'ошибка '+err.message); }
        }
        function flash(btn,text){
            const old = btn.textContent;
            btn.textContent = text; btn.classList.add('done');
            setTimeout(()=>{ btn.textContent=old; btn.classList.remove('done'); }, 1500);
        }

        function kickMessageFromPusher(d, channel=''){
            const msgId = d?.id || d?.message_id || d?.message?.id || d?.data?.id || '';
            const ident = d?.sender?.identity || {};
            const m = String(channel || '').match(/^chatrooms\.(\d+)\.v2$/);
            const chatroomId = m ? m[1] : String(KICK_CHATROOM_ID);
            return {
                platform: 'kick',
                id: msgId ? 'kick_' + msgId : 'kick_direct_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                rawId: msgId,
                chatroomId,
                name: d?.sender?.username || '???',
                color: ident.color || '',
                content: d?.content || '',
                badges_v2: (ident.badges_v2 || []).map(b => ({ url: b.image_url, name: b.name })),
                badges_txt: (ident.badges || []).map(b => b.type),
                reply: (d?.type === 'reply' && d.metadata && d.metadata.original_sender)
                    ? {
                        id: d.metadata.original_message?.id ? 'kick_' + d.metadata.original_message.id : '',
                        rawId: d.metadata.original_message?.id || '',
                        name: d.metadata.original_sender.username,
                        content: d.metadata.original_message?.content || ''
                    }
                    : null
            };
        }
        function startDirectKickPusher(){
            openKickPusher(raw => {
                let ev;
                try { ev = JSON.parse(raw); } catch { return; }
                let d = null;
                try { d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch { }
                if(ev.event && ev.event.includes('MessageDeletedEvent')){
                    const deletedId = d?.id || d?.message_id || d?.message?.id || d?.data?.id || '';
                    if(deletedId) render({ platform:'kick', type:'delete', id:'kick_direct_deleted_' + deletedId, targetId:'kick_' + deletedId, rawId:deletedId, chatroomId:String(KICK_CHATROOM_ID) });
                    return;
                }
                if(ev.event && /ban|timeout|unban|unmute/i.test(ev.event) && !ev.event.includes('ChatMessageEvent')){
                    const mod = kickModerationInfo(ev.event, d);
                    render({
                        platform:'kick',
                        type:'mod_event',
                        id:`kick_direct_mod_${ev.event}_${d?.id || Date.now()}`,
                        name:mod.name,
                        userId:mod.userId,
                        actor:mod.actor,
                        action:mod.action
                    });
                    return;
                }
                if(!ev.event || !ev.event.includes('ChatMessageEvent') || !d || !d.sender) return;
                render(kickMessageFromPusher(d, ev.channel));
            }, 'виджет');
        }

        // читаем обе очереди; помним последний показанный seq по каждой
        const lastSeen = { kick:0, vk:0 };
        function drain(platform){
            const q = GM_getValue(Q_KEYS[platform], []);
            for(const m of q){ if(m._seq>lastSeen[platform]){ lastSeen[platform]=m._seq; render(m); } }
        }
        // стартовое состояние: сперва восстанавливаем свою ленту после релоада…
        const savedFeed = GM_getValue(FEED_BUFFER_KEY, []) || [];
        const savedSeen = GM_getValue(FEED_SEEN_KEY, null);
        if(savedSeen && typeof savedSeen === 'object'){
            lastSeen.kick = Number(savedSeen.kick) || 0;
            lastSeen.vk = Number(savedSeen.vk) || 0;
        }
        // если счётчик очереди сбросился (переустановка/чистка GM) — реиграем всё
        for(const p of ['kick','vk']){
            const q = GM_getValue(Q_KEYS[p], []) || [];
            const maxSeq = q.length ? (q[q.length-1]._seq || 0) : 0;
            if(lastSeen[p] > maxSeq) lastSeen[p] = 0;
        }
        if(Array.isArray(savedFeed) && savedFeed.length){
            restoringFeed = true;
            feedBuffer = savedFeed.slice(-FEED_BUFFER_CAP);
            for(const m of feedBuffer){ try { render(m); } catch(e) { } }
            restoringFeed = false;
        }
        // …затем добираем только то, что пришло в очереди, пока виджет был закрыт
        drain('kick'); drain('vk');
        // подписка на изменения
        GM_addValueChangeListener(Q_KEYS.kick, ()=>drain('kick'));
        GM_addValueChangeListener(Q_KEYS.vk, ()=>drain('vk'));
        GM_addValueChangeListener(META_KEY, (_k, _old, val) => applyMeta(val));
        const lastVkDebug = GM_getValue(VK_DEBUG_KEY, null);
        if(lastVkDebug) console.log('[MergedChat] VK collector debug initial', lastVkDebug);
        GM_addValueChangeListener(VK_DEBUG_KEY, (_k, _old, val) => {
            console.log('[MergedChat] VK collector debug', val);
        });
        startDirectKickPusher();

        console.log('%c[MergedChat] виджет запущен', 'color:#53fc18;font-weight:bold');
    }

    // ============================================================
    // ПЕРЕЕЗД В РАСШИРЕНИЕ
    // Юзерскрипт (Tampermonkey) оставляет свои настройки в localStorage kick.com,
    // расширение при установке забирает их оттуда (переименования, выделения, шаблоны…).
    // Если расширение уже стоит — юзерскрипт не запускается, иначе в окне будет два чата.
    // ============================================================
    const MIGRATE_LS_KEY = 'mc_tm_export_v1';
    const MIGRATE_KEYS = [LOCAL_ALIASES_KEY, HIGHLIGHT_USERS_KEY, USER_COLORS_KEY, CHAT_TEMPLATES_KEY, PLATFORMS_KEY, PRIVILEGED_USERS_KEY, CURRENT_USERS_KEY];
    if (typeof MC_EXT === 'undefined') {
        if (HOST === 'kick.com') {
            try {
                const data = {};
                MIGRATE_KEYS.forEach(k => { const v = GM_getValue(k, null); if (v !== null && v !== undefined) data[k] = v; });
                const write = d => localStorage.setItem(MIGRATE_LS_KEY, JSON.stringify({ t: Date.now(), data: d }));
                // цвета ников — самое объёмное; не влезло в localStorage — переносим без них
                try { write(data); } catch (e) { delete data[USER_COLORS_KEY]; write(data); }
            } catch (e) { console.warn('[MergedChat] экспорт для расширения не удался', e); }
        }
        if (document.documentElement.dataset.mcExt) {
            console.log('[MergedChat] стоит расширение Merged Chat — юзерскрипт не запускается');
            return;
        }
        document.documentElement.dataset.mcUserscript = '1';
    }

    // ============================================================
    // РОУТИНГ
    // ============================================================
    if (IS_FEED) {
        // запускаем сразу (documentElement есть уже на document-start),
        // чтобы родное приложение Kick даже не успело подняться
        startFeed();
    } else if (HOST === 'dashboard.kick.com') {
        startKickAuthCollector();
    } else if (HOST.includes('kick.com')) {
        startKickCollector();
    } else if (HOST.includes('vkvideo.ru')) {
        // Расширение, скрытый режим: невидимый фрейм читает VK своим сокетом (страница VK не грузится),
        // а обычная открытая вкладка VK только отдаёт токен — иначе было бы два сборщика
        if (typeof MC_EXT !== 'undefined' && MC_EXT.directVk) startVkCollector({ direct: true });
        else if (typeof MC_EXT !== 'undefined' && MC_EXT.directVkMode) captureKickToken();
        else startVkCollector();
    }
})();
