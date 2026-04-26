export class TFile {
    static [Symbol.hasInstance](value) {
        return Boolean(value && typeof value === 'object' && 'extension' in value);
    }
    constructor(path = '') {
        this.path = path;
        this.extension = path.split('.').pop() || '';
    }
}
export class Notice {
    constructor(message, timeout) {
        this.message = message;
        this.timeout = timeout;
    }
}
export const requestUrl = async () => ({
    status: 200,
    json: {},
    text: '',
});
export class Modal {
}
export class Plugin {
}
export class PluginSettingTab {
}
export class Setting {
}
export class ItemView {
}
export class MarkdownView {
}
export class Vault {
}
export class App {
}
