// Держит скрытые фреймы-сборщики. Командует им background.js.
const frames = new Map(); // name -> { el, url, createdAt, loadedAt }

function add(name, url) {
    let f = frames.get(name);
    if (f && f.url === url) return;
    if (f) f.el.remove();
    const el = document.createElement('iframe');
    el.name = 'mc-' + name;
    el.allow = 'autoplay; clipboard-read; clipboard-write';
    el.style.cssText = 'width:1280px;height:900px;border:0';
    f = { el, url, createdAt: Date.now(), loadedAt: 0 };
    el.addEventListener('load', () => { f.loadedAt = Date.now(); });
    el.src = url;
    document.body.appendChild(el);
    frames.set(name, f);
}

function remove(name) {
    const f = frames.get(name);
    if (!f) return;
    f.el.remove();
    frames.delete(name);
}

function reload(name) {
    const f = frames.get(name);
    if (!f) return false;
    f.loadedAt = 0;
    f.createdAt = Date.now();
    // переназначение src — это полная перезагрузка фрейма с сервера
    f.el.src = 'about:blank';
    setTimeout(() => { f.el.src = f.url; }, 50);
    return true;
}

function list() {
    const out = {};
    for (const [name, f] of frames) out[name] = { url: f.url, createdAt: f.createdAt, loadedAt: f.loadedAt };
    return out;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.target !== 'offscreen') return false;
    if (msg.type === 'add') add(msg.name, msg.url);
    else if (msg.type === 'remove') remove(msg.name);
    else if (msg.type === 'reload') reload(msg.name);
    reply(list());
    return false;
});
