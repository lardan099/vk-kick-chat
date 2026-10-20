// Мир страницы (world: MAIN), document_start — раньше скриптов сайта.
// Делает то, что в Tampermonkey делалось через unsafeWindow: подменяет WebSocket,
// fetch и XHR страницы и пересылает кадры/заголовки в gm-shim.js (изолированный мир).
(() => {
    if (window.__mcExtHook) return;
    window.__mcExtHook = true;
    // На странице-виджете свой код страницы не работает (gm-shim останавливает загрузку)
    if (location.hostname === 'kick.com' && location.hash.includes('feed')) return;
    // плеер-виджет VK — только адрес для читателя (там всё делает gm-shim), сайт мы там не слушаем
    if (location.pathname.startsWith('/app/embed/') || location.hash.includes('mc-direct')) return;
    // Во фреймах работаем только внутри скрытого документа расширения, не в iframe самого сайта
    if (window !== window.top) {
        const anc = location.ancestorOrigins;
        if (!anc || !anc.length || !String(anc[anc.length - 1]).startsWith('chrome-extension://')) return;
    }

    // Ссылки берём сразу: сайт может потом переопределить глобальные объекты
    const stringify = JSON.stringify;
    const CE = CustomEvent;
    const dispatch = EventTarget.prototype.dispatchEvent;
    const doc = document;
    const decoder = new TextDecoder('utf-8');
    const emit = (name, payload) => {
        try { dispatch.call(doc, new CE(name, { detail: stringify(payload) })); } catch (e) { }
    };

    // ---------- WebSocket ----------
    const Native = window.WebSocket;
    if (Native && !Native.__mcTapped) {
        const forward = (url, data) => {
            if (typeof data === 'string') return emit('mc-ext:ws', { u: url, d: data });
            if (data instanceof Blob) return void data.text().then(t => emit('mc-ext:ws', { u: url, d: t }), () => { });
            if (data instanceof ArrayBuffer) return emit('mc-ext:ws', { u: url, d: decoder.decode(new Uint8Array(data)) });
            if (ArrayBuffer.isView(data)) return emit('mc-ext:ws', { u: url, d: decoder.decode(data) });
        };
        const Tapped = function (url, protocols) {
            const ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
            const u = String(url);
            try {
                ws.addEventListener('message', ev => { try { forward(u, ev.data); } catch (e) { } });
                // жизненный цикл сокета — по нему gm-shim понимает, что сборщик оглох
                ws.addEventListener('open', () => emit('mc-ext:wsstate', { u, s: 'open' }));
                ws.addEventListener('close', ev => emit('mc-ext:wsstate', { u, s: 'close', c: ev.code }));
            } catch (e) { }
            return ws;
        };
        Tapped.prototype = Native.prototype;
        Tapped.CONNECTING = Native.CONNECTING;
        Tapped.OPEN = Native.OPEN;
        Tapped.CLOSING = Native.CLOSING;
        Tapped.CLOSED = Native.CLOSED;
        Tapped.__mcTapped = true;
        window.WebSocket = Tapped;
    }

    // ---------- заголовки запросов (токены Kick/VK) ----------
    const relevant = (url, h) => !!h.authorization || String(url || '').includes('api.live.vkvideo.ru');
    const toMap = (headers, out = {}) => {
        if (!headers) return out;
        try {
            if (headers instanceof Headers || typeof headers.forEach === 'function' && !Array.isArray(headers)) {
                headers.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
            } else if (Array.isArray(headers)) {
                headers.forEach(p => { if (p) out[String(p[0]).toLowerCase()] = String(p[1]); });
            } else if (typeof headers === 'object') {
                Object.keys(headers).forEach(k => { out[String(k).toLowerCase()] = String(headers[k]); });
            }
        } catch (e) { }
        return out;
    };

    const nativeFetch = window.fetch;
    if (nativeFetch && !nativeFetch.__mcWrapped) {
        const wrapped = function (input, init) {
            try {
                const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
                const h = toMap(input && typeof input === 'object' ? input.headers : null);
                toMap(init && init.headers, h);
                if (relevant(url, h)) emit('mc-ext:hdr', { u: url, h });
            } catch (e) { }
            return nativeFetch.apply(this, arguments);
        };
        wrapped.__mcWrapped = true;
        window.fetch = wrapped;
    }

    const XHR = window.XMLHttpRequest;
    if (XHR && !XHR.prototype.__mcWrapped) {
        const open = XHR.prototype.open;
        const setHeader = XHR.prototype.setRequestHeader;
        const send = XHR.prototype.send;
        XHR.prototype.open = function (method, url) {
            this.__mcUrl = String(url || '');
            this.__mcHeaders = {};
            return open.apply(this, arguments);
        };
        XHR.prototype.setRequestHeader = function (k, v) {
            try { (this.__mcHeaders || (this.__mcHeaders = {}))[String(k).toLowerCase()] = String(v); } catch (e) { }
            return setHeader.apply(this, arguments);
        };
        XHR.prototype.send = function () {
            try {
                const h = this.__mcHeaders || {};
                if (relevant(this.__mcUrl, h)) emit('mc-ext:hdr', { u: this.__mcUrl, h });
            } catch (e) { }
            return send.apply(this, arguments);
        };
        XHR.prototype.__mcWrapped = true;
    }
})();
