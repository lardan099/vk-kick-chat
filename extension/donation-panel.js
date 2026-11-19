// Called by ext-ui after the staff access check. All donor text is rendered as text.
function setupDonationPanel() {
    const panel = document.createElement('section');
    panel.id = 'mc-donation';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'mc-donation-title');
    panel.innerHTML = `
        <div data-body>
            <header>
                <h2 id="mc-donation-title"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12M12 8c-1.5-3-5-3.5-5-1.2C7 8 9.5 8 12 8Zm0 0c1.5-3 5-3.5 5-1.2C17 8 14.5 8 12 8Z"/></svg>Подписка за донат</h2>
            </header>
            <div data-summary><strong data-amount></strong><span data-donor></span><small data-count></small></div>
            <blockquote tabindex="0" aria-label="Комментарий к донату"></blockquote>
            <label hidden>Получатель <select></select></label>
        </div>
        <footer>
            <div data-recipient><b data-target></b><span data-result role="status"></span></div>
            <div data-actions>
                <button type="button" data-skip>Пропустить</button>
                <button type="button" data-confirm disabled>Выдать</button>
            </div>
        </footer>`;
    document.body.appendChild(panel);
    const style = document.createElement('style');
    style.textContent = `
        #mc-donation[hidden],#mc-donation [hidden]{display:none!important}
        #mc-donation{position:fixed;z-index:999997;right:8px;bottom:8px;width:min(432px,calc(100% - 16px));
        max-height:calc(100% - 16px);box-sizing:border-box;display:flex;flex-direction:column;overflow:auto;
        border-radius:14px;background:var(--panel,#191919);color:var(--text,#eee);
        font-family:inherit;font-size:14px;line-height:1.4;overflow-wrap:anywhere;
        box-shadow:0 6px 22px #0004,0 0 0 1px var(--border,#373737)}
        #mc-donation [data-body]{padding:8px 16px 11px;min-height:min(80px,35vh);overflow:auto;flex:0 1 auto;
        background:linear-gradient(110deg,color-mix(in srgb,var(--accent,#b49c76) 7%,transparent),transparent 75%)}
        #mc-donation header,#mc-donation [data-summary],#mc-donation footer{display:flex;align-items:center;gap:5px 10px}
        #mc-donation header{justify-content:space-between}
        #mc-donation h2{display:flex;align-items:center;gap:7px;margin:0;font:inherit;font-size:12px;font-weight:600}
        #mc-donation h2 svg{flex:none;width:16px;height:16px;fill:none;stroke:var(--accent,#b49c76);stroke-width:1.7;stroke-linejoin:round}
        #mc-donation button{font-family:inherit;cursor:pointer}
        #mc-donation [data-actions]{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;max-width:100%;margin-left:auto}
        #mc-donation [data-skip]{min-height:34px;max-width:100%;padding:4px 7px;border:0;border-radius:5px;background:transparent;color:var(--muted,#aaa);font-size:12px}
        #mc-donation [data-skip]:hover{background:var(--surface-2,#333);color:var(--text,#eee)}
        #mc-donation [data-summary]{align-items:baseline;flex-wrap:wrap;margin:2px 0 3px}
        #mc-donation [data-amount]{font-size:24px;line-height:1.15;font-weight:700;letter-spacing:-.035em;font-variant-numeric:tabular-nums}
        #mc-donation [data-donor],#mc-donation [data-count]{font-size:12px;color:var(--muted,#aaa)}
        #mc-donation [data-count]{margin-left:auto}
        #mc-donation blockquote{margin:3px 0 0;font-size:13px;line-height:1.45;white-space:pre-wrap;max-height:2.9em;overflow:auto}
        #mc-donation blockquote:empty,#mc-donation [data-count]:empty,#mc-donation [data-target]:empty{display:none}
        #mc-donation footer{flex:none;flex-wrap:wrap;padding:9px 16px;background:var(--surface-1,#222);
        border-top:1px solid var(--border,#333);justify-content:space-between}
        #mc-donation [data-recipient]{flex:1 1 150px;min-width:0;display:grid;gap:1px}
        #mc-donation [data-target]{font-size:14px;font-weight:650}
        #mc-donation [data-result]{font-size:12px;color:var(--muted,#aaa)}
        #mc-donation [data-result][data-error]{color:var(--text,#eee)}
        #mc-donation [data-confirm]{min-height:34px;max-width:100%;border:0;border-radius:8px;padding:6px 13px;
        background:var(--accent,#b49c76);color:var(--accent-contrast,#191919);font-size:13px;font-weight:650;line-height:1.35}
        #mc-donation [data-confirm]:hover{background:var(--accent-bright,#d1b88d)}
        #mc-donation button:disabled{opacity:.55;cursor:default}
        #mc-donation :focus-visible{outline:2px solid var(--accent,#b49c76);outline-offset:1px}
        #mc-donation label{display:block;margin-top:6px}#mc-donation select{max-width:100%;font:inherit}
    `;
    document.head.appendChild(style);
    const el = selector => panel.querySelector(selector);
    const confirm = el('[data-confirm]'), skip = el('[data-skip]'), select = el('select'), status = el('[data-result]');
    let card = null, user = null, revision = 0, working = false, loading = false, needsLookup = false;
    const send = (type, args = {}) => MC_EXT.send(type, args);
    async function lookup() {
        const rev = ++revision;
        user = null;
        needsLookup = false;
        status.removeAttribute('data-error');
        confirm.disabled = true;
        confirm.textContent = 'Выдать на ' + card.months + ' мес.';
        const target = select.value;
        el('[data-target]').textContent = target;
        if (!target) { status.textContent = 'Выберите, кому выдать подписку.'; return; }
        status.textContent = 'Ищу получателя…';
        try {
            const r = await send('gift:api', { path: 'lookup?q=' + encodeURIComponent(target) });
            if (rev !== revision) return;
            user = r?.data?.recipient;
            if (!user || r.status !== 200) throw new Error(r?.data?.message || r?.error || 'Получатель не найден.');
            const name = user.username ? '@' + user.username : user.name || 'Пользователь Telegram';
            const subs = user.subscriptions || [];
            const expiry = Math.max(...subs.map(s => Date.parse(s.expiredAt)).filter(Number.isFinite));
            const details = user.banned ? 'Заблокирован' : subs.some(s => s.infinite) ? 'Бессрочная подписка' :
                Number.isFinite(expiry) ? 'Подписка до ' + new Date(expiry).toLocaleDateString('ru-RU') : 'Без подписки';
            el('[data-target]').textContent = name;
            status.textContent = 'ID ' + user.telegramId + ' · ' + details;
            confirm.disabled = !!user.banned;
        } catch (error) {
            if (rev !== revision) return;
            status.textContent = error.message;
            status.setAttribute('data-error', '');
            needsLookup = true; confirm.disabled = false; confirm.textContent = 'Повторить поиск';
        }
    }
    function display(item, count) {
        el('[data-count]').textContent = count > 1 ? 'В очереди: ' + count : '';
        if (card?.key === item?.key && !!card?.operation === !!item?.operation) return;
        revision++;
        card = item; user = null; needsLookup = false;
        panel.hidden = !item;
        if (!item) return;
        el('[data-amount]').textContent = item.amount.toLocaleString('ru-RU') + ' ₽';
        el('[data-donor]').textContent = 'от ' + item.donor;
        el('blockquote').textContent = item.comment;
        select.replaceChildren();
        const choose = item.candidates.length > 1 && !item.operation;
        el('label').hidden = !choose;
        if (choose) select.add(new Option('Выберите получателя', ''));
        for (const target of item.candidates) select.add(new Option(target, target));
        el('[data-target]').textContent = item.operation ? 'Telegram ID ' + item.operation.telegramId : choose ? '' : item.candidates[0];
        skip.disabled = select.disabled = false;
        skip.textContent = item.operation ? 'Убрать из очереди' : 'Пропустить';
        if (item.operation) {
            status.removeAttribute('data-error');
            status.textContent = 'Запрошена выдача на ' + item.months + ' мес.';
            confirm.textContent = 'Проверить результат'; confirm.disabled = false;
        } else lookup();
    }
    async function refresh() {
        if (working || loading) return;
        loading = true;
        const rev = revision;
        try {
            const result = await send('donation:next');
            if (!working && rev === revision && result && !result.error) display(result.card, result.count);
        } catch {} finally { loading = false; }
    }
    async function act(grant) {
        if (working || !card) return;
        if (grant && needsLookup) { lookup(); return; }
        working = true; revision++;
        skip.disabled = confirm.disabled = select.disabled = true;
        const current = card;
        status.textContent = grant ? 'Проверяю выдачу…' : 'Закрываю карточку…';
        try {
            const result = await send(grant ? 'donation:grant' : 'donation:skip', {
                key: current.key, target: select.value, telegramId: current.operation?.telegramId || user?.telegramId
            });
            if (!result?.ok) throw new Error(result?.error || 'Нет ответа от расширения.');
            display(null, 0);
            if (grant) {
                const notice = document.createElement('div');
                notice.className = 'gq-note'; notice.dataset.kind = 'ok';
                notice.setAttribute('role', 'status');
                notice.style.cssText = 'position:fixed;top:45px;left:8px;z-index:999998;background:var(--panel,#181a1b)';
                notice.textContent = 'Выдано ' + current.months + ' мес. · ID ' + (current.operation?.telegramId || result.telegramId);
                document.body.appendChild(notice); setTimeout(() => notice.remove(), 4500);
            }
        } catch (error) {
            // Reload persisted attempt before offering a retry, even if the POST reply was lost.
            const latest = await send('donation:next').catch(() => null);
            if (latest && !latest.error) display(latest.card, latest.count);
            if (card?.key === current.key) {
                status.textContent = error.message;
                status.setAttribute('data-error', '');
                skip.disabled = select.disabled = false;
                confirm.disabled = !card.operation && (!user || user.banned);
                if (!user && !card.operation) { needsLookup = true; confirm.textContent = 'Повторить поиск'; confirm.disabled = false; }
            }
        } finally { working = false; }
        refresh();
    }
    select.addEventListener('change', lookup);
    confirm.addEventListener('click', e => { if (e.isTrusted) act(true); });
    skip.addEventListener('click', e => { if (e.isTrusted) act(false); });
    refresh();
    chrome.runtime.onMessage.addListener(msg => { if (msg?.type === 'donation:changed') refresh(); });
    setInterval(refresh, 5000);
}
