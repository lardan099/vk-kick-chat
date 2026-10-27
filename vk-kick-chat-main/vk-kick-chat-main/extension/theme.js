// Подставляет в окно расширения переменные темы, выбранной в чате (сохраняет их ext-ui.js).
export async function applyChatTheme() {
    const { ext_theme } = await chrome.storage.local.get('ext_theme');
    if (!ext_theme || !ext_theme.vars) return;
    for (const [k, v] of Object.entries(ext_theme.vars)) document.documentElement.style.setProperty(k, v);
}
applyChatTheme();
