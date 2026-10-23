// Только на странице-виджете: кнопка «Фон» в шапке (статус скрытых сборщиков)
// и полоска «вышло обновление». Оформление — на переменных и приёмах самого чата
// (--surface-*, --border, --accent…), поэтому подстраивается под любую его тему.
(() => {
    'use strict';
    if (typeof MC_EXT === 'undefined' || !MC_EXT.isFeed) return;

    const KICK_ICON = 'https://www.google.com/s2/favicons?domain=kick.com&sz=64';
    const VK_ICON = 'https://images.live.vkvideo.ru/smile/42502cfe-8cf9-4f13-aaa3-4f100359b6d1/icon/size/medium?change_time=1764532236';
    const HELPERS = [
        ['vk', 'VK чат', VK_ICON],
        ['kick', 'Kick чат', KICK_ICON],
        ['dash', 'Kick dashboard', KICK_ICON]
    ];
    const STATE = {
        ok: ['работает', 'ok'],
        starting: ['запускается', 'wait'],
        login: ['нужен вход', 'bad'],
        error: ['не отвечает', 'bad'],
        off: ['выключен', 'off'],
        closed: ['не запущен', 'off'],
        idle: ['открыт', 'ok']
    };
    const WHERE = { frame: 'скрыто', direct: 'скрыто', tab: 'вкладка', 'user-tab': 'твоя вкладка' };
    const RELOAD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/></svg>';

    MC_EXT.ready.then(() => {
        const bar = document.getElementById('bar');
        const right = bar && bar.querySelector('.bar-right');
        if (!right) return;
        watchOldUserscript();

        const style = document.createElement('style');
        style.textContent = `
            #mcx-btn{display:inline-flex;align-items:center;gap:6px;margin-right:6px}
            #mcx-btn.open{border-color:var(--accent-strong,#888);background:var(--accent-soft,rgba(255,255,255,.08))}
            .mcx-dot{width:7px;height:7px;border-radius:50%;background:var(--muted,#888);flex:0 0 auto;transition:background-color .3s}
            .mcx-dot.ok{background:#3aa655}
            .mcx-dot.wait{background:#d49a1e;animation:mcx-breathe 1.4s ease-in-out infinite}
            .mcx-dot.bad{background:#d24545}
            .mcx-new{font-size:10px;font-weight:700;color:var(--accent-contrast,#fff);background:var(--accent,#7a6337);border-radius:4px;padding:1px 4px;display:none}
            #mcx-btn.has-update .mcx-new{display:inline}
            @keyframes mcx-breathe{50%{opacity:.35}}
            @keyframes mcx-open{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
            @keyframes mcx-turn{to{transform:rotate(360deg)}}

            #mcx-panel{position:fixed;top:calc(var(--bar-h) + 4px);right:8px;z-index:999996;width:330px;max-width:calc(100vw - 16px);
                display:none;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--border,#444);border-radius:8px;
                background:var(--panel,#181a1b);color:var(--text,#eee);font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
            #mcx-panel.open{display:flex;animation:mcx-open .14s ease-out}
            .mcx-group{display:grid;gap:6px;padding:8px;border:1px solid var(--border,#444);border-radius:8px;background:var(--surface-0,#1d1f21)}
            .mcx-title{display:flex;align-items:baseline;gap:6px}
            .mcx-title strong{color:var(--text,#eee)}
            .mcx-title span{margin-left:auto;color:var(--muted,#999);font-size:11px}
            .mcx-row{display:grid;grid-template-columns:14px auto minmax(0,1fr) 26px;align-items:center;gap:8px;min-height:28px}
            .mcx-row img{width:14px;height:14px;border-radius:3px;flex:0 0 auto}
            .mcx-name{font-weight:700;white-space:nowrap}
            .mcx-state{min-width:0;display:flex;align-items:center;gap:5px;color:var(--muted,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .mcx-state.bad{color:#d24545}
            .mcx-panel-btn{border:1px solid var(--border,#444);border-radius:6px;background:var(--surface-2,#242628);color:var(--text,#eee);
                cursor:pointer;padding:5px 8px;font:inherit;font-size:12px;transition:background-color .12s,border-color .12s,transform .08s}
            .mcx-panel-btn:hover{background:var(--surface-3,#2e3133)}
            .mcx-panel-btn:active{transform:scale(.97)}
            .mcx-panel-btn.icon{width:26px;height:26px;padding:0;display:grid;place-items:center;flex:0 0 auto}
            .mcx-panel-btn svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
            .mcx-panel-btn.turn svg{animation:mcx-turn .6s ease-in-out}
            .mcx-panel-btn.accent{background:var(--accent,#7a6337);border-color:var(--accent-dark,#5c4825);color:var(--accent-contrast,#fff);font-weight:700}
            .mcx-panel-btn.accent:hover{background:var(--accent-bright,#947b48)}
            .mcx-panel-btn:disabled{opacity:.55;cursor:default}
            .mcx-actions{display:flex;gap:6px}
            .mcx-actions .mcx-panel-btn{flex:1}
            .mcx-note{color:var(--muted,#999);font-size:11px;line-height:1.4}

            #mcx-update{display:none;align-items:center;gap:8px;flex:0 0 auto;padding:5px 10px;font-size:12px;cursor:pointer;
                background:var(--accent,#7a6337);color:var(--accent-contrast,#fff);border-bottom:1px solid var(--accent-dark,#5c4825)}
            #mcx-update.show{display:flex;animation:mcx-open .16s ease-out}
            #mcx-update b{font-weight:700}
            #mcx-update u{margin-left:auto;text-decoration:none;font-weight:700;border:1px solid currentColor;border-radius:4px;padding:1px 7px;opacity:.9}
            #mcx-update:hover u{opacity:1;background:rgba(255,255,255,.14)}
            #mcx-update .mcx-hide{width:22px;height:22px;display:grid;place-items:center;padding:0;border:0;border-radius:5px;background:transparent;
                color:inherit;font-size:13px;line-height:1;cursor:pointer;opacity:.75;transition:opacity .12s,background-color .12s}
            #mcx-update .mcx-hide:hover{opacity:1;background:rgba(255,255,255,.18)}

            #mcx-toast{position:fixed;left:50%;top:calc(var(--bar-h) + 8px);transform:translateX(-50%);z-index:999996;padding:6px 12px;width:max-content;max-width:calc(100vw - 24px);
                border:1px solid var(--border,#444);border-radius:6px;background:var(--panel,#181a1b);color:var(--text,#eee);font-size:12px;
                box-shadow:0 6px 18px rgba(0,0,0,.18);animation:mcx-open .16s ease-out;transition:opacity .3s}
            @media (max-width:560px){#mcx-btn .mcx-label{display:none}}
            @media (prefers-reduced-motion:reduce){#mcx-panel,#mcx-update,#mcx-toast,.mcx-dot,.mcx-panel-btn svg{animation:none!important}}
        `;
        document.head.appendChild(style);

        const btn = document.createElement('button');
        btn.id = 'mcx-btn';
        btn.type = 'button';
        btn.className = 'bar-btn'; // та же кнопка, что ⚙ и «Очистить»
        btn.title = 'Сборщики и обновления';
        btn.innerHTML = '<i class="mcx-dot"></i><span class="mcx-label">Фон</span><span class="mcx-new">new</span>';
        right.insertBefore(btn, right.firstChild);
        const dot = btn.querySelector('.mcx-dot');

        const panel = document.createElement('div');
        panel.id = 'mcx-panel';
        document.body.appendChild(panel);

        const banner = document.createElement('div');
        banner.id = 'mcx-update';
        bar.insertAdjacentElement('afterend', banner);

        const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const ago = t => {
            if (!t) return '';
            const s = Math.max(0, Math.round((Date.now() - t) / 1000));
            return s < 60 ? `${s} с назад` : `${Math.round(s / 60)} мин назад`;
        };
        let busy = '';

        function render() {
            const status = GM_getValue('ext_status', null);
            const upd = GM_getValue('ext_update', null);
            const helpers = (status && status.helpers) || {};
            const states = HELPERS.map(([n]) => (helpers[n] || {}).state).filter(s => s && s !== 'off');
            dot.className = 'mcx-dot ' + (!states.length ? '' : states.some(s => s === 'login' || s === 'error') ? 'bad'
                : states.some(s => s !== 'ok' && s !== 'idle') ? 'wait' : 'ok');
            btn.classList.toggle('has-update', !!(upd && upd.available));

            const rows = HELPERS.filter(([n]) => (helpers[n] || {}).state !== 'off').map(([name, label, icon]) => {
                const h = helpers[name] || {};
                const [text, cls] = STATE[h.state] || ['…', 'wait'];
                const bits = [text];
                if (h.state === 'ok' && h.hb) bits.push(ago(h.hb));
                if (h.where === 'user-tab' || h.where === 'tab') bits.push(WHERE[h.where]);
            if (h.detail && h.state !== 'ok') bits.splice(1, 0, h.detail);
                return `<div class="mcx-row"><img src="${icon}" alt=""><span class="mcx-name">${esc(label)}</span>
                    <span class="mcx-state ${cls === 'bad' ? 'bad' : ''}"><i class="mcx-dot ${cls}"></i>${esc(bits.join(' · '))}</span>
                    <button class="mcx-panel-btn icon" data-refresh="${name}" title="Перезапустить">${RELOAD}</button></div>`;
            }).join('');
            const failing = HELPERS.find(([n]) => ['error', 'login'].includes((helpers[n] || {}).state));

            let note = `Версия ${esc(MC_EXT.version)}`;
            if (busy) note += ` · ${esc(busy)}`;
            else if (upd && upd.error === 'no-url') note += ' · адрес обновлений не задан';
            else if (upd && upd.error) note += ` · не удалось проверить обновления`;
            else if (upd && upd.available) note += ` · вышла ${esc(upd.latest)}${upd.notes ? ': ' + esc(upd.notes) : ''}`;
            else if (upd && upd.checked) note += ` · последняя, проверено ${ago(upd.checked)}`;

            panel.innerHTML = `
                <div class="mcx-group">
                    <div class="mcx-title"><strong>Сборщики</strong><span>${status && status.placement === 'hidden' ? 'без окон и вкладок' : ''}</span></div>
                    ${rows || '<div class="mcx-note">Все выключены — включаются в значке расширения.</div>'}
                    ${failing ? `<div class="mcx-note">${esc(failing[1])} не поднимается — открой его обычной вкладкой, возможно, нужно войти.
                        <button class="mcx-panel-btn" data-show="${failing[0]}" style="margin-top:4px">Открыть ${esc(failing[1])}</button></div>` : ''}
                </div>
                <div class="mcx-actions">
                    <button class="mcx-panel-btn" data-act="restart" ${busy ? 'disabled' : ''}>Перезапустить всё</button>
                    ${upd && upd.available
                        ? `<button class="mcx-panel-btn accent" data-act="install">Как обновить до ${esc(upd.latest)}</button>`
                        : `<button class="mcx-panel-btn" data-act="check" ${busy ? 'disabled' : ''}>Проверить обновления</button>`}
                </div>
                <div class="mcx-note">${note}</div>`;

            // полоску можно скрыть: она не вернётся до следующей версии (в панели «Фон» обновление остаётся)
            if (upd && upd.available && GM_getValue('ext_update_hidden', '') !== upd.latest) {
                banner.innerHTML = `<span>Вышла версия <b>${esc(upd.latest)}</b></span><u>Обновить</u>`
                    + `<button class="mcx-hide" title="Скрыть до следующей версии" aria-label="Скрыть">✕</button>`;
                banner.classList.add('show');
            } else banner.classList.remove('show');
        }

        const install = () => MC_EXT.send('update:open', { auto: true }).catch(() => { });
        banner.addEventListener('click', e => {
            if (e.target.closest('.mcx-hide')) {
                const upd = GM_getValue('ext_update', null);
                if (upd && upd.latest) GM_setValue('ext_update_hidden', upd.latest);
                banner.classList.remove('show');
                return;
            }
            install();
        });

        const openPanel = open => {
            panel.classList.toggle('open', open);
            btn.classList.toggle('open', open);
            if (open) { render(); MC_EXT.send('helpers:status').catch(() => { }); }
        };
        btn.addEventListener('click', e => { e.stopPropagation(); openPanel(!panel.classList.contains('open')); });
        document.addEventListener('click', e => { if (!panel.contains(e.target) && !btn.contains(e.target)) openPanel(false); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') openPanel(false); });

        panel.addEventListener('click', async e => {
            const b = e.target.closest('button');
            if (!b) return;
            e.stopPropagation();
            if (b.dataset.show) return MC_EXT.showHelper(b.dataset.show);
            if (b.dataset.refresh) {
                b.classList.remove('turn'); void b.offsetWidth; b.classList.add('turn');
                await MC_EXT.refreshHelper(b.dataset.refresh);
                MC_EXT.send('helpers:status').catch(() => { });
                return;
            }
            const act = b.dataset.act;
            if (act === 'install') return install();
            busy = act === 'restart' ? 'перезапускаю…' : 'проверяю…';
            render();
            await MC_EXT.send(act === 'restart' ? 'helpers:restart' : 'update:check').catch(() => { });
            busy = '';
            render();
        });

        GM_addValueChangeListener('ext_status', () => { if (panel.classList.contains('open') || !busy) render(); });
        GM_addValueChangeListener('ext_update', render);
        setInterval(() => { if (panel.classList.contains('open')) render(); }, 5000);
        render();

        // окно расширения повторяет тему чата: сохраняем её переменные
        const THEME_VARS = ['--bg', '--panel', '--border', '--text', '--muted', '--accent', '--accent-dark', '--accent-bright',
            '--accent-contrast', '--accent-soft', '--accent-medium', '--accent-strong', '--surface-0', '--surface-1', '--surface-2', '--surface-3'];
        const saveTheme = () => {
            const cs = getComputedStyle(document.documentElement);
            const vars = {};
            THEME_VARS.forEach(v => { const x = cs.getPropertyValue(v).trim(); if (x) vars[v] = x; });
            GM_setValue('ext_theme', { vars, scheme: document.documentElement.dataset.theme || '' });
        };
        saveTheme();
        new MutationObserver(() => setTimeout(saveTheme, 50))
            .observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });

        const toast = (text, ms = 5000) => {
            const el = document.createElement('div');
            el.id = 'mcx-toast';
            el.textContent = text;
            document.body.appendChild(el);
            setTimeout(() => { el.style.opacity = '0'; }, ms);
            setTimeout(() => el.remove(), ms + 400);
        };
        const just = GM_getValue('ext_just_updated', null);
        if (just && Date.now() - just.t < 3 * 60000) {
            toast(`Расширение обновлено: ${just.from || '?'} → ${just.to}`);
            GM_deleteValue('ext_just_updated');
        }
        // переезд из Tampermonkey (gm-shim забрал данные до старта чата)
        const imp = GM_getValue('ext_tm_import', null);
        if (imp && !imp.shown) {
            toast(`Перенесено из Tampermonkey: ${imp.aliases} переименований, выделения и шаблоны`, 7000);
            GM_setValue('ext_tm_import', { ...imp, shown: true });
        }
        // юзерскрипт 6.43+ успел запуститься раньше расширения — два чата в одном окне
        if (document.documentElement.dataset.mcUserscript) {
            const warn = document.createElement('div');
            warn.style.cssText = 'flex:0 0 auto;padding:5px 10px;font-size:12px;font-weight:700;color:#fff;background:#b03a2e;border-bottom:1px solid #7d2a21';
            warn.innerHTML = '<span>В Tampermonkey ещё включён Merged Chat — выключи его там, настройки уже перенесены</span>';
            banner.insertAdjacentElement('afterend', warn);
        }

        // чат открыт — пусть воркер сразу поднимет сборщики
        MC_EXT.send('feed:hello').catch(() => { });
    });

    // Старый юзерскрипт (до 6.43) не знает про расширение: если он стартует позже, то перерисовывает окно
    // своим чатом — без VK (сборщика VK у него в скрытом режиме нет). Замечаем это по пропавшей метке
    // на нашем body и показываем поверх, что делать.
    function watchOldUserscript() {
        document.body.dataset.mcOwner = 'ext';
        let shown = false;
        const check = () => {
            if (shown || (document.body && document.body.dataset.mcOwner === 'ext')) return;
            if (!document.getElementById('bar') && !document.getElementById('chat')) return; // ещё не дорисовал
            shown = true;
            showTakeover();
        };
        new MutationObserver(check).observe(document.documentElement, { childList: true });
        const timer = setInterval(check, 1000);
        setTimeout(() => clearInterval(timer), 60000);
    }
    function showTakeover() {
        const host = document.createElement('div');
        host.id = 'mcx-takeover';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>
            :host{all:initial}
            .back{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:16px;
                background:color-mix(in srgb,var(--bg,#111) 72%,transparent);backdrop-filter:blur(3px);font:13px/1.45 Inter,system-ui,Arial,sans-serif;animation:in .18s ease-out}
            .card{max-width:380px;padding:16px 18px;border-radius:12px;background:var(--panel,#1b1b1f);color:var(--text,#eee);
                border:1px solid var(--border,#3a3a40);box-shadow:0 14px 40px rgba(0,0,0,.35)}
            h1{margin:0 0 6px;font-size:15px}
            p{margin:0 0 10px;color:var(--muted,#aaa)}
            ol{margin:0 0 12px;padding-left:18px}li{margin:4px 0}
            .row{display:flex;gap:8px;flex-wrap:wrap}
            button{font:inherit;font-weight:600;cursor:pointer;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--border,#3a3a40);
                background:var(--surface-2,#2a2a30);color:var(--text,#eee);transition:background-color .14s,transform .1s}
            button:hover{background:var(--surface-3,#34343b)}button:active{transform:scale(.97)}
            .main{background:var(--accent,#53fc18);border-color:var(--accent-dark,#3aa012);color:var(--accent-contrast,#000)}
            .main:hover{background:var(--accent-bright,#6dff3a)}
            @keyframes in{from{opacity:0}to{opacity:1}}
        </style>
        <div class="back"><div class="card" role="alertdialog" aria-labelledby="t">
            <h1 id="t">Окно перехватил старый Merged Chat</h1>
            <p>В Tampermonkey включён скрипт Merged Chat. Он нарисовал поверх расширения свой чат, а VK в нём нет.</p>
            <ol>
                <li>Перенеси переименования из Tampermonkey (один раз).</li>
                <li>Выключи Merged Chat в Tampermonkey.</li>
                <li>Перезагрузи это окно.</li>
            </ol>
            <div class="row">
                <button class="main" data-a="transfer">Перенести переименования</button>
                <button data-a="reload">Перезагрузить</button>
                <button data-a="close">Скрыть</button>
            </div>
        </div></div>`;
        root.addEventListener('click', e => {
            const a = e.target.closest('button') && e.target.closest('button').dataset.a;
            if (a === 'transfer') MC_EXT.send('transfer:open').catch(() => { });
            if (a === 'reload') location.reload();
            if (a === 'close') host.remove();
        });
        document.documentElement.appendChild(host);
    }
})();
