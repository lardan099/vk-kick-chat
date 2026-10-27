// Общие настройки расширения. Подключается в background.js, popup.js и updater.js.
export const CONFIG = {
    // Откуда тянуть обновления: адрес update.json, который собирает tools/build.mjs.
    // Пример для GitHub: 'https://raw.githubusercontent.com/<ник>/<репозиторий>/main/extension/update.json'
    // Пусто — проверка обновлений выключена (можно задать в окне расширения → «Ещё»).
    updateUrl: 'https://raw.githubusercontent.com/lardan099/vk-kick-chat/main/extension/update.json',
    updateCheckMinutes: 30,
    // архив для ручного обновления (расширение само файлы не перезаписывает)
    downloadUrl: 'https://github.com/lardan099/vk-kick-chat/archive/refs/heads/main.zip',

    feedUrl: 'https://kick.com/popout/grpzdc/chat#feed',
    // выдача подписок (/zapisi/manage): берётся первый сайт, где ты вошёл
    giftSites: ['https://m.pzdcflix.ru', 'https://pzdcflix.ru', 'https://m.pzdcflix.live', 'https://pzdcflix.live'],

    // Фоновые вкладки, которые расширение держит открытыми, пока открыт чат.
    helpers: {
        vk: {
            label: 'VK чат',
            url: 'https://live.vkvideo.ru/grpzdc/stream/default/only-chat',
            // скрытый читатель VK: страница с адреса VK (честный Origin для сокета), где приложение VK
            // сразу останавливается; #mc-direct включает в ней прямое чтение. Плеер-виджет VK сам
            // разрешает встраивание, robots.txt — запасной (там запрет встраивания снимает правило DNR).
            // Не поднялся один адрес — воркер переключается на следующий и запоминает рабочий.
            readerUrls: [
                'https://live.vkvideo.ru/app/embed/grpzdc#mc-direct',
                'https://live.vkvideo.ru/robots.txt#mc-direct'
            ],
            // сборщик VK работает и на only-chat, и в студии — своя вкладка не нужна, если есть любая
            match: '^https://live\\.vkvideo\\.ru/([^?#]*(only-chat|/studio)|robots\\.txt|app/embed/)',
            heartbeatKey: 'mc_collector_vk_heartbeat',
            probeKey: 'mc_collector_probe',
            why: 'сообщения VK (в скрытом режиме — напрямую, без страницы)'
        },
        kick: {
            label: 'Kick чат',
            url: 'https://kick.com/popout/grpzdc/chat',
            match: '^https://kick\\.com/popout/[^/]+/chat',
            heartbeatKey: 'mc_collector_kick_heartbeat',
            probeKey: 'mc_collector_probe',
            why: 'история Kick при заходе и тайм-ауты из родного чата'
        },
        dash: {
            label: 'Kick dashboard',
            url: 'https://dashboard.kick.com/',
            match: '^https://dashboard\\.kick\\.com/',
            heartbeatKey: 'mc_kick_auth_heartbeat',
            probeKey: 'mc_kick_auth_probe',
            why: 'запасной источник токена Kick (обычно берётся из куки)'
        }
    }
};

export const DEFAULT_SETTINGS = {
    helpers: { vk: true, kick: true, dash: false }, // dashboard не нужен: токен Kick берётся из куки
    placement: 'hidden',     // 'hidden' — невидимые фреймы внутри расширения, 'window' — свёрнутое окно, 'tabs' — закреплённые вкладки
    autoClose: true,         // закрыть свои фоновые вкладки, когда чат закрыт
    updateUrl: ''            // перекрывает CONFIG.updateUrl
};

export function isFeedUrl(url) {
    return /^https:\/\/kick\.com\/popout\/[^/?#]+\/chat[^#]*#.*feed/.test(String(url || ''));
}

export function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}

export async function loadSettings() {
    const { ext_settings } = await chrome.storage.local.get('ext_settings');
    const s = ext_settings || {};
    return {
        ...DEFAULT_SETTINGS,
        ...s,
        helpers: { ...DEFAULT_SETTINGS.helpers, ...(s.helpers || {}) }
    };
}

export function updateUrlOf(settings) {
    return (settings && settings.updateUrl) || CONFIG.updateUrl || '';
}
