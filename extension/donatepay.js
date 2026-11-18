// Last Events is read-only here. The widget credentials and pending grants live
// in the extension origin's IndexedDB, outside chat pages and settings exports.
const BASE = 'https://widget.donatepay.ru';
const MONTH_RUB = 400;
let database;
async function stateStore(mode, change) {
    database ||= new Promise((resolve, reject) => {
        const open = indexedDB.open('donatepay', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('settings');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    }).catch(error => { database = null; throw error; });
    const db = await database;
    return new Promise((resolve, reject) => {
        const tx = db.transaction('settings', mode);
        const request = change(tx.objectStore('settings'));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error || new Error('Не удалось сохранить донаты'));
    });
}
const load = () => stateStore('readonly', store => store.get('connection'));
const save = state => stateStore('readwrite', store => store.put(state, 'connection'));
let tail = Promise.resolve();
function serial(task) {
    const work = tail.then(task);
    tail = work.catch(() => {});
    return work;
}

function targets(text) {
    const result = new Set();
    for (const m of text.matchAll(/(?<![\p{L}\p{N}_@.+/-])(?:@([a-z][a-z0-9_]{3,31})|@?([1-9]\d{4,15}))(?![\p{L}\p{N}_]|[.,/-]\d)/giu)) {
        result.add(m[1] ? '@' + m[1].toLowerCase() : m[2]);
    }
    for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_])(?:telegram\s*id|tg\s*id|тг\s*(?:id|айди)|айди|id)\s*[:#№=]?\s*([1-9]\d{0,15})(?![\p{L}\p{N}_]|[.,/-]\d)/giu)) result.add(m[1]);
    if (/^@?[1-9]\d{0,15}$/.test(text.trim())) result.add(text.trim().replace(/^@/, ''));
    return [...result];
}

export function donationCard(event) {
    if (event?.type !== 'donation') return null;
    let data = event.vars;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return null; }
    }
    if (!['RUB','RUR','₽','РУБ','РУБ.'].includes(String(data?.currency_type ?? '').trim().toUpperCase())) return null;
    const sum = String(data.sum ?? '').trim().replace(',', '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(sum)) return null;
    const amount = Number(sum);
    if (!Number.isSafeInteger(Math.round(amount * 100)) || amount < MONTH_RUB) return null;
    const comment = String(data.comment || '');
    const donor = String(data.name || data.social_name || 'Аноним');
    let candidates = targets(comment);
    if (!candidates.length) candidates = targets(donor);
    if (!candidates.length) return null;
    return { id: String(event.id), amount, months: Math.min(12, Math.floor(amount / MONTH_RUB)),
        donor: donor.slice(0, 150), comment: comment.slice(0, 2000), candidates };
}

async function widget(path, token, json = false) {
    const url = new URL(path, BASE);
    url.searchParams.set('token', token);
    try {
        const r = await fetch(url, { redirect: 'error', credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error();
        return await (json ? r.json() : r.text());
    } catch { throw new Error('DonatePay недоступен. Проверьте ссылку виджета и соединение.'); }
}
function widgetToken(input) {
    const value = String(input || '').trim();
    if (/^[a-zA-Z0-9._~-]{8,1024}$/.test(value)) return value;
    let url;
    try { url = new URL(value); } catch {}
    if (url?.origin === BASE && url.pathname.replace(/\/$/, '') === '/last-events' && url.searchParams.get('token')) return url.searchParams.get('token');
    throw new Error('Нужна ссылка виджета DonatePay «Последние события» или его токен.');
}
async function connect(token) {
    const html = await widget('/last-events', token);
    const user = html.match(/window\.user\s*=\s*(\{[\s\S]*?\})\s*(?:;|<\/script>|(?:\r?\n)\s*(?:window\.|(?:const|let|var)\s))/);
    let account;
    try { account = JSON.parse(user?.[1]); } catch {}
    if (!account?.widgetsToken || !/^[1-9]\d*$/.test(String(account.id))) throw new Error('Виджет не вернул аккаунт. Проверьте ссылку Last Events.');
    const permissions = html.match(/window\.permissions\s*=\s*(\[[\s\S]*?\])/);
    if (permissions && !JSON.parse(permissions[1]).includes('scope_donation_amount')) throw new Error('Включите показ суммы в доступе к виджету DonatePay.');
    const socket = html.match(/window\.socketHost\s*=\s*("(?:\\.|[^"\\])*")/);
    const meta = html.match(/<meta\b(?=[^>]*\bname=["']csrf-token["'])[^>]*>/i)?.[0];
    let socketUrl = '';
    try {
        const url = new URL(JSON.parse(socket?.[1]));
        if (url.protocol === 'wss:' && url.hostname === 'centrifugo.donatepay.ru') socketUrl = url.href;
    } catch {}
    return { account: String(account.id), readToken: account.widgetsToken, socketUrl,
        csrf: meta?.match(/\bcontent=["']([^"']+)["']/i)?.[1] || '' };
}
async function snapshot(token) {
    const rows = await widget('/last-events/fetch', token, true);
    if (!Array.isArray(rows)) throw new Error('DonatePay вернул неверный список событий.');
    return rows;
}
const ids = rows => rows.map(row => Number(row?.id)).filter(id => Number.isSafeInteger(id) && id > 0);

// Keep a small overlap for snapshots arriving out of order. Never enqueue the
// initial history, including after a worker restart or a same-account token change.
export function observe(state, rows) {
    const seen = new Set(state.seen);
    const before = seen.size;
    for (const row of rows) {
        const id = Number(row?.id);
        if (!Number.isSafeInteger(id) || id <= state.floor || seen.has(id)) continue;
        seen.add(id);
        const card = donationCard(row);
        if (card) state.queue.push(card);
    }
    if (seen.size === before) return false;
    const ordered = [...seen].sort((a,b) => a-b);
    if (ordered.length > 500) state.floor = ordered[ordered.length - 501];
    state.seen = ordered.slice(-500);
    state.queue.sort((a,b) => Number(a.id) - Number(b.id));
    return true;
}
let checked = 0, problem = '';
let liveSocket = null, reconnectAt = 0;
let socketStatus = 'WebSocket ожидает подключения.';
async function notifyQueue() {
    const tabs = await chrome.tabs.query({ url: 'https://kick.com/popout/*/chat*' });
    await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'donation:changed' }, { frameId: 0 })));
}
// Subscribe only to LastEvents. Snapshots cover socket disconnects, missed
// publications and Chrome suspending the worker.
async function ensureSocket(state, session) {
    if (liveSocket || Date.now() < reconnectAt) return;
    reconnectAt = Date.now() + 60000;
    socketStatus = 'WebSocket: читаю настройки виджета.';
    try {
        session ||= await connect(state.token);
        if (session.account !== state.account) { socketStatus = 'WebSocket: изменился аккаунт виджета.'; return; }
        if (!session.socketUrl) { socketStatus = 'WebSocket: виджет не вернул ожидаемый адрес Centrifugo.'; return; }
        if (!session.csrf) { socketStatus = 'WebSocket: в виджете отсутствует CSRF-токен.'; return; }
        socketStatus = 'WebSocket: запрос токена /socket/token.';
        const auth = await fetch(BASE + '/socket/token', { method: 'POST', redirect: 'error', credentials: 'include',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _token: session.csrf, token: session.readToken }),
            signal: AbortSignal.timeout(5000) });
        if (!auth.ok) { socketStatus = 'WebSocket: /socket/token вернул HTTP ' + auth.status + '.'; return; }
        const { token } = await auth.json();
        if (!token) { socketStatus = 'WebSocket: DonatePay не вернул токен подключения.'; return; }
        socketStatus = 'WebSocket: подключение к Centrifugo.';
        const ws = liveSocket = new WebSocket(session.socketUrl);
        const channel = 'widgets:LastEvents#' + state.account;
        const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }));
        let ping, expiry, next = 3;
        let closeReason = '';
        const close = reason => { closeReason = reason; ws.close(); };
        const handshake = setTimeout(() => close('Истекло время подключения или подписки.'), 12000);
        ws.onopen = () => {
            if (ws !== liveSocket) return;
            socketStatus = 'WebSocket открыт. Идёт авторизация.';
            send(1, 0, { token, name: 'js' });
        };
        ws.onmessage = ({ data }) => {
            if (ws !== liveSocket) return;
            try {
                for (const line of String(data).split(/\r?\n/).filter(Boolean)) {
                    const { id, result, error } = JSON.parse(line);
                    if (error || result?.disconnect) {
                        close(error ? (id === 2 ? 'DonatePay отклонил подписку LastEvents.' : 'DonatePay отклонил команду WebSocket.') : 'Сервер закрыл соединение.');
                        return;
                    }
                    if (id === 1) {
                        socketStatus = 'WebSocket: подписка на LastEvents.';
                        send(2, 1, { channel });
                        expiry = setTimeout(() => ws.close(), Math.max(5, Number(result?.ttl || 21600) - 45) * 1000);
                    } else if (id === 2) {
                        clearTimeout(handshake);
                        socketStatus = 'WebSocket подключён. Подписка LastEvents активна.';
                        ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) send(next++, 7, {}); }, 25000);
                    } else if (!id && result?.channel === channel) {
                        const event = result.data?.data;
                        if (event?.type !== 'event' || !event.notification?.id) continue;
                        serial(async () => {
                            const current = await load();
                            if (current?.account !== state.account || !observe(current, [event.notification])) return;
                            await save(current);
                            notifyQueue().catch(() => {});
                        }).catch(() => {});
                    }
                }
            } catch { close('Некорректный ответ Centrifugo.'); }
        };
        ws.onclose = event => {
            clearTimeout(handshake); clearTimeout(expiry); clearInterval(ping);
            if (liveSocket === ws) {
                liveSocket = null;
                socketStatus = 'WebSocket отключён. ' + (closeReason || 'Код закрытия ' + event.code + '.');
            }
        };
    } catch { socketStatus += ' Не удалось завершить этап. Будет повтор.'; }
}
export function configureDonations(input) {
    return serial(async () => {
        const token = widgetToken(input);
        const auth = await connect(token);
        const rows = await snapshot(auth.readToken);
        const old = await load();
        if (old && old.account !== auth.account && old.queue.length) throw new Error('Сначала разберите очередь прежнего аккаунта.');
        const state = old?.account === auth.account ? old : { floor: Math.max(0,...ids(rows)), seen: [], queue: [] };
        Object.assign(state, auth, { token });
        observe(state, rows);
        await save(state);
        liveSocket?.close(); liveSocket = null; reconnectAt = 0;
        checked = Date.now(); problem = '';
        await ensureSocket(state, auth);
        return { configured: true };
    });
}
export function pollDonations() {
    return serial(async () => {
        if (Date.now() - checked < 4500) return;
        checked = Date.now();
        const state = await load();
        if (!state) return;
        try {
            let rows;
            try { rows = await snapshot(state.readToken); }
            catch {
                const auth = await connect(state.token);
                if (auth.account !== state.account) throw new Error('Изменился аккаунт DonatePay. Подключите виджет заново.');
                Object.assign(state, auth);
                rows = await snapshot(auth.readToken);
                await save(state);
            }
            if (observe(state, rows)) await save(state);
            problem = '';
        } catch (error) { problem = error.message; }
        await ensureSocket(state);
    });
}
export async function donationStatus(showCard = false) {
    const state = await load();
    const item = state?.queue[0];
    return { configured: !!state, problem, socketStatus, count: state?.queue.length || 0,
        card: showCard && item ? { ...item, key: state.account + '/' + item.id } : null };
}

// The grant API accepts UUIDv4-shaped keys. Identical DonatePay events must
// produce the same key on every operator's browser, including after a lost reply.
export async function donationOperation(key) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('MergedChat/DonatePay/' + key)));
    hash[6] = (hash[6] & 15) | 64;
    hash[8] = (hash[8] & 63) | 128;
    return Array.from(hash.subarray(0,16), (b,i) => ([4,6,8,10].includes(i) ? '-' : '') + b.toString(16).padStart(2,'0')).join('');
}
export function resolveDonation(msg, api) {
    return serial(async () => {
        const state = await load();
        const item = state?.queue[0];
        if (!item || msg.key !== state.account + '/' + item.id) throw new Error('Карточка уже закрыта. Обновляю очередь.');
        const me = await api({ path: 'me' });
        if (me.data?.allowed !== true || !me.data.csrf) throw new Error('Для выдачи нужен вход в аккаунт команды.');
        if (msg.type === 'donation:grant') {
            if (item.operation && item.operation.telegramId !== msg.telegramId) throw new Error('В другом окне уже выбрали получателя. Проверьте карточку.');
            if (!item.operation) {
                if (!item.candidates.includes(msg.target)) throw new Error('Выберите получателя из доната.');
                const lookup = await api({ path: 'lookup?q=' + encodeURIComponent(msg.target) });
                const user = lookup.data?.recipient;
                if (!user || user.banned || user.telegramId !== msg.telegramId) throw new Error('Получатель изменился или недоступен. Проверьте его ещё раз.');
                item.operation = { operationId: await donationOperation(msg.key), telegramId: user.telegramId,
                    replaceExisting: Boolean(user.subscriptions.length), months: item.months };
                await save(state);
            }
            const r = await api({ path: 'grant', method: 'POST', csrf: me.data.csrf, body: JSON.stringify(item.operation) });
            if (r.status !== 200 || r.data?.state !== 'done' || r.data?.recipient?.telegramId !== item.operation.telegramId || r.data.months !== item.months)
                throw new Error(r.data?.message || r.error || 'Сервер не подтвердил выдачу. Проверьте результат.');
        }
        state.queue.shift();
        await save(state);
        return { ok: true, telegramId: item.operation?.telegramId };
    });
}
