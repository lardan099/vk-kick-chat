// Окно выдачи подписок — порт /zapisi/manage сайта PZDCFLIX.
// Ключей здесь нет: запросы идут в тот же /api/rec/admin под твоим входом на сайте
// (куку отправляет сам браузер, расширение её не читает и не хранит). Защита от двойной
// оплаты, журнал выдач и проверка «ты из команды» остаются на сервере.
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = '', recipient = null, busy = false, pasting = false, operation = null, lastQuery = '', justGranted = false;
  let staffName = '', historyVersion = 0, historyController, historyNext = null, historyLoading = false;
  let historyQuery = '';
  let lookupTimer, lookupVersion = 0, lookupController, lookingUp = false;
  let auditVersion = 0, auditController, auditNext = null, auditLoading = false;
  // Old failed requests must not lock the panel after a reload. Invoice-level
  // deduplication and payment recovery remain on the server.
  const date = (value) => new Date(value).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
  const shortDate = (value) => new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const PRESETS = [1, 3, 6, 12];
  function normalizeTarget(value) {
    let q = String(value).trim();
    const link = q.match(/^https:\/\/(?:t\.me|telegram\.me)\/([a-z0-9_]{1,32})\/?$/i);
    if (link) q = link[1];
    if (/^@?[1-9]\d{0,19}$/.test(q)) return q.replace(/^@/, '');
    if (/^@?[a-z][a-z0-9_]{0,31}$/i.test(q)) return '@' + q.replace(/^@/, '');
    return q;
  }
  function normalizeField(input, editing = false) {
    const raw = input.value;
    // Do not erase spaces while typing a display name and accidentally join it
    // into somebody else's valid username. Explicit search/paste can trim edges.
    const value = editing && raw !== raw.trim() ? raw : normalizeTarget(raw);
    if (value !== raw) {
      const start = input.selectionStart, end = input.selectionEnd;
      input.value = value;
      if (value === '@' + raw && start != null) input.setSelectionRange(start + 1, end + 1);
      else input.setSelectionRange(value.length, value.length);
    }
    return value;
  }
  function targetError(value) {
    const q = normalizeTarget(value);
    if (/^[1-9]\d{0,19}$/.test(q) || /^@[a-z][a-z0-9_]{3,31}$/i.test(q)) return '';
    if (/[.\s]/.test(q)) return 'Это не Telegram username: точки и пробелы не допускаются. Введите @username или числовой ID.';
    return 'Введите @username из профиля Telegram или числовой ID. Имя профиля не подходит.';
  }
  async function api(path, init = {}) {
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const request = chrome.runtime.sendMessage({ type: 'gift:api', path, method: init.method || 'GET',
      body: init.body || null, csrf: init.headers?.['x-csrf-token'] || '' });
    // отмену поиска уважаем на стороне окна: ответ просто выбрасываем
    const aborted = init.signal ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) : null;
    const r = await (aborted ? Promise.race([request, aborted]) : request);
    if (!r || r.error && !r.status) throw Object.assign(new Error(r?.error || 'Сайт не ответил. Проверь интернет.'), { code: 'NETWORK' });
    if (r.site) $('site').textContent = 'Сайт: ' + r.site.replace('https://', '');
    const data = r.data || {};
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(data.message || 'Не удалось проверить ответ сервера.'), { code: data.error, status: r.status });
    return data;
  }
  function notice(text, kind = 'error') { $('result').textContent = text; $('result').dataset.kind = kind; $('result').hidden = false; }
  function buttons() {
    const months = Number($('months').value);
    const validMonths = Number.isInteger(months) && months >= 1 && months <= 12;
    $('price-rub').textContent = validMonths ? (months * 400).toLocaleString('ru-RU') + ' ₽' : '—';
    $('price-stars').textContent = validMonths ? (months * 250).toLocaleString('ru-RU') + ' Stars' : 'от 1 до 12 месяцев';
    const pending = Boolean(operation);
    $('give').textContent = busy ? 'Проверяем…' : `Выдать на ${months || '…'} мес.`;
    const existing = Boolean(recipient?.subscriptions.length);
    const infinite = recipient?.subscriptions.some((s) => s.infinite);
    const ends = (recipient?.subscriptions || []).map((s) => Date.parse(s.expiredAt)).filter(Number.isFinite);
    const expiry = new Date(Math.max(Date.now(), ...ends)), day = expiry.getUTCDate();
    expiry.setUTCDate(1); expiry.setUTCMonth(expiry.getUTCMonth() + months);
    expiry.setUTCDate(Math.min(day, new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0)).getUTCDate()));
    $('replacement').hidden = !recipient || justGranted;
    $('replacement').dataset.shorter = 'false';
    $('recipient').dataset.shorter = 'false';
    if (recipient) $('new-expiry').textContent = infinite ? 'уже бессрочный' : !validMonths ? 'срок от 1 до 12 месяцев'
      : `${existing ? 'продлится' : 'откроется'} до ${shortDate(expiry)}`;
    $('months').closest('label').dataset.active = String(validMonths && !PRESETS.includes(months));
    $('give').disabled = busy || pasting || lookingUp || !recipient || recipient.banned || !validMonths;
    $('target').disabled = busy || pasting;
    document.querySelectorAll('#lookup button, #grant input, [data-months], .g-tabs button').forEach((el) => { el.disabled = busy || pasting; });
    $('paste-target').textContent = pasting ? 'Вставляем…' : 'Вставить';
    $('retry').disabled = busy || pasting;
    $('retry').textContent = pending ? 'Проверить результат' : 'Попробовать ещё раз';
    document.querySelectorAll('[data-months]').forEach((el) => el.setAttribute('aria-pressed', String(Number(el.dataset.months) === months)));
  }
  function showRecipient(value) {
    recipient = value;
    $('recipient').hidden = !value;
    if (value) {
      $('recipient-name').textContent = value.username ? '@' + value.username : value.name || 'Пользователь Telegram';
      $('recipient-id').textContent = 'ID ' + value.telegramId;
      $('recipient-avatar').textContent = (value.username || value.name || 'T').replace(/^@/, '').slice(0, 1);
      const infinite = value.subscriptions.some((s) => s.infinite);
      const expiry = Math.max(...value.subscriptions.map((s) => Date.parse(s.expiredAt)));
      $('recipient-state').textContent = value.banned ? 'Заблокирован в боте' : infinite ? 'Бессрочно' : value.subscriptions.length ? 'До ' + shortDate(expiry) : 'Без подписки';
      $('recipient-state').dataset.tone = value.banned ? 'bad' : value.subscriptions.length ? 'ok' : '';
      $('recipient-state').title = value.subscriptions.length && !infinite ? 'Подписка до ' + date(expiry) : '';
    }
    buttons();
  }
  async function lookup(refresh = false) {
    if (busy || pasting) return;
    cancelLookup();
    const query = normalizeField($('target'));
    const invalid = targetError(query);
    if (invalid) {
      operation = null; showRecipient(null); notice(invalid); resetAudit(invalid, true); $('retry').hidden = true;
      return;
    }
    const version = lookupVersion;
    lookupController = new AbortController(); lookingUp = true;
    operation = null; justGranted = false;
    lastQuery = $('target').value.trim(); showRecipient(null);
    resetAudit('Проверяем прошлые выдачи…');
    $('retry').hidden = true; $('result').hidden = true;
    try {
      const data = await api('lookup?q=' + encodeURIComponent(lastQuery) + (refresh ? '&refresh=1' : ''), { signal: lookupController.signal });
      if (version !== lookupVersion) return;
      if (!Array.isArray(data.history?.items) || !Number.isSafeInteger(data.history?.counts?.issued)) throw Error('Не удалось проверить прошлые выдачи. Повторите поиск.');
      showRecipient(data.recipient);
      displayAudit(data.history);
    } catch (error) {
      if (version !== lookupVersion || error.name === 'AbortError') return;
      notice(error.message); $('retry').hidden = false; resetAudit(error.code === 'BAD_TARGET' ? error.message : 'Не удалось проверить получателя и прошлые выдачи.', true);
    } finally { if (version === lookupVersion) { lookingUp = false; buttons(); } }
  }
  function cancelLookup() {
    clearTimeout(lookupTimer); lookupVersion++; lookupController?.abort(); lookingUp = false;
  }
  function resetAudit(text, error = false) {
    auditVersion++; auditController?.abort(); auditLoading = false; auditNext = null;
    $('audit-list').replaceChildren(); $('audit-warning').hidden = true; $('audit-more').hidden = true;
    $('audit-summary').hidden = false; $('audit-summary').dataset.error = String(error); $('audit-summary').textContent = text;
  }
  function displayAudit(data, more = false) {
    if (!more) $('audit-list').replaceChildren();
    data.items.filter((item) => item.status === 'issued').forEach((item) => renderHistoryItem(item, $('audit-list')));
    auditNext = data.next; $('audit-more').hidden = !auditNext;
    $('audit-warning').hidden = data.counts.issued === 0;
    $('audit-warning').textContent = `Выдавали: ${data.counts.issued}`;
    $('audit-summary').hidden = data.counts.issued > 0;
    $('audit-summary').dataset.error = 'false'; $('audit-summary').textContent = 'Ручных выдач через сайт ещё не было.';
  }
  async function refreshAudit(more = false) {
    if (!recipient || (more && (auditLoading || !auditNext))) return;
    const target = recipient.telegramId;
    const cursor = more ? auditNext : null;
    if (!more) resetAudit('Обновляем прошлые выдачи…');
    const version = ++auditVersion;
    auditController?.abort(); auditController = new AbortController(); auditLoading = true; $('audit-more').disabled = true;
    try {
      const query = new URLSearchParams({ q: target, status: 'issued', ...(cursor ? { before: cursor } : {}) });
      const data = await api('history?' + query, { signal: auditController.signal });
      if (version !== auditVersion || recipient?.telegramId !== target) return;
      displayAudit(data, more);
    } catch (error) {
      if (version !== auditVersion || error.name === 'AbortError') return;
      $('audit-summary').hidden = false; $('audit-summary').dataset.error = 'true'; $('audit-summary').textContent = 'Не удалось обновить историю. Повторите поиск.';
    } finally { if (version === auditVersion) { auditLoading = false; $('audit-more').disabled = false; } }
  }
  async function pasteTarget() {
    if (busy || pasting) return;
    cancelLookup();
    pasting = true; buttons();
    let pasted = false;
    try {
      if (!navigator.clipboard?.readText) throw Error('Clipboard unavailable');
      const value = normalizeTarget(await navigator.clipboard.readText());
      if (!value) { notice('В буфере обмена пусто.'); return; }
      const invalid = targetError(value);
      if (invalid) {
        if (value.length <= 40) { $('target').value = value; $('target').dispatchEvent(new Event('input')); }
        operation = null; showRecipient(null); resetAudit(invalid, true); notice(invalid); return;
      }
      $('target').value = value;
      $('target').dispatchEvent(new Event('input'));
      pasted = true;
    } catch { notice('Браузер не дал доступ к буферу. Вставьте вручную в поле.'); }
    finally { pasting = false; buttons(); $('target').focus(); }
    if (pasted) await lookup();
  }
  function renderHistoryItem(item, container = $('history-list')) {
    // Строка: «+3» | кто, когда и кем | до какого числа стал доступ.
    // Остатки до/после — в подсказке, чтобы не дублировать срок.
    const li = document.createElement('li'); li.className = 'g-item'; li.dataset.status = item.status;
    const append = (parent, tag, className, text) => {
      const el = document.createElement(tag); el.className = className; el.textContent = text; parent.append(el); return el;
    };
    const status = { issued: '', failed: 'не выдано', pending: 'проверяется' }[item.status] ?? 'проверяется';
    append(li, 'span', 'g-item-months', '+' + item.months).title = `${item.months} мес.`;
    append(li, 'strong', 'g-item-who', item.username ? '@' + item.username : item.name || 'Пользователь Telegram');
    const until = append(li, 'span', 'g-item-until', item.status === 'issued' ? 'доступ' : '');
    append(until, 'b', '', item.status !== 'issued' ? status : item.infinite ? 'бессрочно' : item.expiresAt ? 'до ' + shortDate(item.expiresAt) : '—');
    const days = (s) => (s ? s.infinite ? 'бессрочно' : `${s.daysRemaining} дн.` : 'нет данных');
    if (item.before || item.after) until.title = `Было: ${days(item.before)} → стало: ${days(item.after)}`;
    const when = item.completedAt || item.createdAt;
    const meta = append(li, 'span', 'g-item-meta', '');
    const time = append(meta, 'time', '', shortDate(when));
    time.dateTime = when; time.title = date(when);
    meta.append(` · ${item.actor === staffName ? 'вы' : item.actor}`);
    if (container !== $('audit-list')) meta.append(` · ID ${item.telegramId}`);
    container.append(li);
  }
  async function loadHistory(more = false) {
    if (more && (historyLoading || !historyNext)) return;
    const version = ++historyVersion;
    historyController?.abort(); historyController = new AbortController();
    historyLoading = true; $('history-more').disabled = true;
    if (!more) {
      historyQuery = normalizeField($('history-query'));
      historyNext = null; $('history-list').replaceChildren(); $('history-more').hidden = true;
    }
    if (historyQuery && targetError(historyQuery)) {
      $('history-summary').dataset.error = 'true'; $('history-summary').textContent = targetError(historyQuery);
      historyLoading = false; $('history-more').disabled = false; return;
    }
    $('history-summary').dataset.error = 'false'; $('history-summary').textContent = 'Загружаем историю…';
    const query = new URLSearchParams({ q: historyQuery, ...(more ? { before: historyNext } : {}) });
    try {
      const data = await api('history?' + query, { signal: historyController.signal });
      if (version !== historyVersion) return;
      data.items.forEach((item) => renderHistoryItem(item)); historyNext = data.next;
      const { total, issued, failed } = data.counts, pending = total - issued - failed;
      $('history-summary').textContent = total ? `Выдано: ${issued} · Не выдано: ${failed}${pending ? ` · Проверяется: ${pending}` : ''}` : 'Выдач через сайт не найдено.';
      $('history-more').hidden = !historyNext;
    } catch (error) {
      if (version !== historyVersion || error.name === 'AbortError') return;
      $('history-summary').dataset.error = 'true'; $('history-summary').textContent = error.message;
    } finally { if (version === historyVersion) { historyLoading = false; $('history-more').disabled = false; } }
  }
  function showView(history) {
    cancelLookup();
    $('grant-view').hidden = history; $('history-view').hidden = !history;
    $('show-grant').setAttribute('aria-pressed', String(!history)); $('show-history').setAttribute('aria-pressed', String(history));
    if (history) {
      $('history-query').value = recipient?.telegramId || $('target').value.trim();
      loadHistory();
    } else {
      historyVersion++; historyController?.abort(); historyLoading = false;
      $('target').focus();
    }
  }
  async function grant() {
    if (busy || (!operation && $('give').disabled)) return;
    operation ||= { operationId: crypto.randomUUID(), telegramId: recipient.telegramId, months: Number($('months').value), replaceExisting: Boolean(recipient.subscriptions.length) };
    busy = true; buttons(); $('retry').hidden = true;
    try {
      const result = await api('grant', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(operation) });
      justGranted = true;
      showRecipient(result.recipient);
      refreshAudit();
      const who = result.recipient.username ? '@' + result.recipient.username : result.recipient.name || 'Получатель';
      const ends = result.recipient.subscriptions.map((s) => Date.parse(s.expiredAt)).filter(Number.isFinite);
      const infinite = result.recipient.subscriptions.some((s) => s.infinite);
      notice(`Готово: ${who} +${result.months} мес. ${infinite ? 'Доступ бессрочный.' : ends.length ? `Доступ до ${shortDate(Math.max(...ends)).replace(/\.$/, "")}.` : ''}`, 'success');
      operation = null;
    } catch (error) {
      notice(error.message);
      // Only known invoice/payment outcomes need resuming, never a failed create.
      if (error.code && !['PAY_UNKNOWN', 'SUBSCRIPTION_PENDING', 'INVOICE_STATE', 'GRANT_BUSY', 'VISIBILITY_RESTORE'].includes(error.code)) operation = null;
      $('retry').hidden = false;
    } finally { busy = false; buttons(); }
  }
  $('lookup').addEventListener('submit', (e) => { e.preventDefault(); lookup(); });
  $('paste-target').addEventListener('click', pasteTarget);
  $('show-grant').addEventListener('click', () => showView(false));
  $('show-history').addEventListener('click', () => showView(true));
  $('history-search').addEventListener('submit', (e) => { e.preventDefault(); loadHistory(); });
  $('history-query').addEventListener('input', () => normalizeField($('history-query'), true));
  $('history-all').addEventListener('click', () => { $('history-query').value = ''; loadHistory(); });
  $('history-more').addEventListener('click', () => loadHistory(true));
  $('audit-more').addEventListener('click', () => refreshAudit(true));
  $('grant').addEventListener('submit', (e) => { e.preventDefault(); grant(); });
  document.querySelectorAll('[data-months]').forEach((el) => el.addEventListener('click', () => { operation = null; justGranted = false; $('months').value = el.dataset.months; buttons(); }));
  $('months').addEventListener('input', () => { operation = null; justGranted = false; buttons(); });
  $('target').addEventListener('input', () => {
    cancelLookup(); operation = null; justGranted = false; showRecipient(null);
    resetAudit('Введите @username или Telegram ID — история появится здесь.');
    $('result').hidden = true; $('retry').hidden = true;
    const value = normalizeField($('target'), true);
    if (/^(?:@[a-z][a-z0-9_]{3,31}|[1-9]\d{0,19})$/i.test(value)) lookupTimer = setTimeout(() => lookup(), 400);
    else if (value.trim() && /[.\s]/.test(value.trim())) resetAudit(targetError(value), true);
  });
  $('retry').addEventListener('click', () => operation ? grant() : lookup(true));
  $('login').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'gift:login' }));
  // вошёл на сайте в соседней вкладке — проверяем доступ заново
  window.addEventListener('focus', () => { if (!$('workspace').hidden) return; checkAccess(); });
  const checkAccess = () => api('me').then((data) => {
    csrf = data.csrf; staffName = data.username;
    $('staff-name').replaceChildren('выдаёт ', Object.assign(document.createElement('b'), { textContent: data.username }));
    $('staff-name').hidden = false;
    $('access').hidden = true; $('workspace').hidden = false;
    $('target').focus();
    buttons();
  }).catch((error) => {
    $('access').textContent = error.status === 403 ? 'Выдавать подписки может только команда канала. Войдите через Kick своим аккаунтом.' : error.message;
    $('access').dataset.kind = 'error';
    $('login').hidden = error.status !== 403;
  });
  checkAccess();
  // окно открыли из чата с готовым получателем: ?q=@username
  const preset = new URLSearchParams(location.search).get('q');
  if (preset) $('target').value = preset;
})();
