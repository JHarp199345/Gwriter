import { App, Modal, Setting } from 'obsidian';

export interface PromptPreviewModalOptions {
	title: string;
	prompt: string;
	stats?: Array<{ label: string; value: string }>;
}

export class PromptPreviewModal extends Modal {
	private readonly opts: PromptPreviewModalOptions;

	constructor(app: App, opts: PromptPreviewModalOptions) {
		super(app);
		this.opts = opts;
	}

	onOpen() {
		this.titleEl.setText(this.opts.title);
		this.contentEl.empty();

		if (this.opts.stats?.length) {
			for (const s of this.opts.stats) {
				new Setting(this.contentEl).setName(s.label).setDesc(s.value);
			}
		}

		const textarea = this.contentEl.createEl('textarea');
		textarea.value = this.opts.prompt || '';
		textarea.readOnly = true;
		textarea.rows = 18;
		textarea.addClass('generated-textarea');

		new Setting(this.contentEl).addButton((btn) => {
			btn.setButtonText('Copy');
			btn.setCta();
			btn.onClick(() => {
				void navigator.clipboard.writeText(textarea.value).catch(() => {
					// ignore
				});
			});
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}


