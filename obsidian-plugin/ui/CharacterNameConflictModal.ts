import { App, Modal, Setting } from 'obsidian';

export interface CharacterResolutionChoice {
	type: 'existing' | 'create';
	// For 'existing', this is the resolved file basename (character name).
	// For 'create', this is the new name to create.
	name: string;
}

export interface CharacterNameConflictModalOptions {
	title: string;
	message: string;
	// The AI-proposed character header (raw).
	proposedName: string;
	// Candidate existing names (best first).
	candidates: string[];
}

export function showCharacterNameConflictModal(
	app: App,
	opts: CharacterNameConflictModalOptions
): Promise<CharacterResolutionChoice | null> {
	return new Promise((resolve) => {
		let settled = false;

		const settle = (value: CharacterResolutionChoice | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const modal = new (class extends Modal {
			private selected: string | null = null;

			onOpen() {
				this.titleEl.setText(opts.title);
				this.contentEl.createEl('p', { text: opts.message });
				this.contentEl.createEl('p', { text: `Proposed name: ${opts.proposedName}` });

				if (opts.candidates.length) {
					this.contentEl.createEl('p', { text: 'Select an existing character note:' });
					for (const c of opts.candidates) {
						new Setting(this.contentEl)
							.setName(c)
							.addButton((btn) => {
								btn.setButtonText('Use');
								btn.setCta();
								btn.onClick(() => {
									this.selected = c;
									settle({ type: 'existing', name: c });
									this.close();
								});
							});
					}
				}

				new Setting(this.contentEl)
					.setName('Create a new character note')
					.setDesc('Use the proposed name as a new file in your character folder.')
					.addButton((btn) => {
						btn.setButtonText('Create new');
						btn.onClick(() => {
							settle({ type: 'create', name: opts.proposedName });
							this.close();
						});
					});

				new Setting(this.contentEl).addButton((btn) => {
					btn.setButtonText('Cancel');
					btn.onClick(() => {
						settle(null);
						this.close();
					});
				});
			}

			onClose() {
				settle(null);
				this.contentEl.empty();
			}
		})(app);

		modal.open();
	});
}


