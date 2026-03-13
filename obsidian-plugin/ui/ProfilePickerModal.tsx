import { Modal } from 'obsidian';
import React from 'react';
import { createRoot } from 'react-dom/client';
import WritingDashboardPlugin from '../main';
import { TreePickerComponent } from './TreePickerModal';

export class ProfilePickerModal extends Modal {
	private readonly plugin: WritingDashboardPlugin;
	private reactRoot: { render: (node: unknown) => void; unmount: () => void } | null = null;

	constructor(plugin: WritingDashboardPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.titleEl.setText('Select folders or notes for retrieval');
		this.contentEl.empty();
		const container = this.contentEl.createDiv();
		this.reactRoot = createRoot(container);
		this.reactRoot.render(
			React.createElement(TreePickerComponent, {
				plugin: this.plugin,
				initialSelection: this.plugin.settings.retrievalIncludedFolders || [],
				mode: 'multi',
				onSubmit: async (value: string | string[]) => {
					let list: string[];
				if (Array.isArray(value)) list = value;
				else if (value) list = [value];
				else list = [];
					this.plugin.settings.retrievalIncludedFolders = list;
					this.plugin.settings.retrievalActiveProfileId = undefined;
					await this.plugin.saveSettings();
					this.plugin.embeddingsIndex.enqueueFullRescan();
				},
				onClose: () => this.close(),
				filter: (node) => {
					const n = node.path.replace(/\\/g, '/');
					return !n.startsWith(`${this.plugin.app.vault.configDir.replace(/\\/g, '/')}`);
				}
			})
		);
	}

	onClose(): void {
		if (this.reactRoot) {
			this.reactRoot.unmount();
			this.reactRoot = null;
		}
		this.contentEl.empty();
	}
}


