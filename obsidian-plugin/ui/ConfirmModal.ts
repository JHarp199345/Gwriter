import { App, Modal, Setting } from 'obsidian';

export interface ConfirmModalOptions {
	title: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
}

export function showConfirmModal(app: App, opts: ConfirmModalOptions): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;

		const settle = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const handleCancel = () => { settle(false); modal.close(); };
		const handleConfirm = () => { settle(true); modal.close(); };

		const modal = new (class extends Modal {
			onOpen() {
				this.titleEl.setText(opts.title);
				this.contentEl.createEl('p', { text: opts.message });
				new Setting(this.contentEl)
					.addButton((btn) => {
						btn.setButtonText(opts.cancelText ?? 'Cancel');
						btn.onClick(handleCancel);
					})
					.addButton((btn) => {
						btn.setCta();
						btn.setButtonText(opts.confirmText ?? 'Continue');
						btn.onClick(handleConfirm);
					});
			}

			onClose() {
				settle(false);
				this.contentEl.empty();
			}
		})(app);

		modal.open();
	});
}


