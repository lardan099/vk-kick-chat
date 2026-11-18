// Called by ext-ui after the staff access check. All donor text is rendered as text.
function setupDonationPanel() {
    const panel = document.createElement('section');
    panel.id = 'mc-donation';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'mc-donation-title');
    panel.innerHTML = `
        <header><h2 id="mc-donation-title">Подписка за донат</h2><small data-count></small></header>
        <strong data-amount></strong><div data-donor></div><blockquote></blockquote>
        <label hidden>Получатель <select></select></label>
        <b data-target></b><div data-result role="status"></div>
        <footer><button type="button" class="mcx-panel-btn" data-skip>Пропустить</button>
        <button type="button" class="mcx-panel-btn accent" data-confirm disabled>Выдать</button></footer>`;
    document.body.appendChild(panel);
    const style = document.createElement('style');
    style.textContent = `
        #mc-donation[hidden],#mc-donation [hidden]{display:none!important}
        #mc-donation{position:fixed;z-index:999997;left:6px;right:6px;bottom:6px;height:50vh;box-sizing:border-box;
        overflow:auto;display:flex;flex-direction:column;gap:7px;padding:14px;border:1px solid var(--accent,#947b48);
        border-radius:12px;background:var(--panel,#181a1b);color:var(--text,#eee);box-shadow:0 6px 24px #0005;
        font:inherit;overflow-wrap:anywhere}
        #mc-donation header,#mc-donation footer{display:flex;align-items:center;justify-content:space-between;gap:8px}
        #mc-donation h2{margin:0;font-size:1.05em}#mc-donation small{color:var(--muted,#999)}
        #mc-donation [data-amount]{font-size:1.3em}#mc-donation blockquote{margin:0;padding-left:8px;
        border-left:2px solid var(--border,#666);white-space:pre-wrap;max-height:5em;overflow:auto;flex-shrink:0}
        #mc-donation blockquote:empty{display:none}#mc-donation footer{margin-top:auto;flex-wrap:wrap}
        #mc-donation footer button{min-height:34px}#mc-donation select{max-width:100%;font:inherit}
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
        confirm.disabled = true;
        confirm.textContent = 'Выдать на ' + card.months + ' мес.';
        const target = select.value;
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
            status.textContent = name + ' · ID ' + user.telegramId + ' · ' + details;
            confirm.disabled = !!user.banned;
        } catch (error) {
            if (rev !== revision) return;
            status.textContent = error.message;
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
        el('[data-amount]').textContent = item.amount.toLocaleString('ru-RU') + ' ₽ · ' + item.months + ' мес.';
        el('[data-donor]').textContent = 'От ' + item.donor;
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
            status.textContent = 'Выдача уже запрошена. Можно проверить ту же операцию.';
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
