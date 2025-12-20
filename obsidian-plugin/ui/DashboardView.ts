import { ItemView, WorkspaceLeaf } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { createRoot } from 'react-dom/client';
import React from 'react';
import { DashboardComponent } from './DashboardComponent';

export const VIEW_TYPE_DASHBOARD = 'writing-dashboard';

export class DashboardView extends ItemView {
	plugin: WritingDashboardPlugin;
	reactRoot: ReturnType<typeof createRoot> | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: WritingDashboardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_DASHBOARD;
	}

	getDisplayText() {
		return 'Writing dashboard';
	}

	getIcon(): string {
		return 'book-open';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		const reactContainer = container.createDiv();
		this.reactRoot = createRoot(reactContainer);
		this.reactRoot.render(
			React.createElement(DashboardComponent, { plugin: this.plugin })
		);
	}

	async onClose() {
		if (this.reactRoot) {
			this.reactRoot.unmount();
			this.reactRoot = null;
		}
	}
}

