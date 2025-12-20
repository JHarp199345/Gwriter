import { ItemView, WorkspaceLeaf } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { createRoot } from 'react-dom/client';
import React from 'react';
import { DashboardComponent } from './DashboardComponent';

export const VIEW_TYPE_DASHBOARD = 'writing-dashboard';

type ReactRootLike = {
	render: (node: unknown) => void;
	unmount: () => void;
};

export class DashboardView extends ItemView {
	plugin: WritingDashboardPlugin;
	reactRoot: ReactRootLike | null = null;

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

	onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		container.empty();
		const reactContainer = container.createDiv();
		this.reactRoot = createRoot(reactContainer);
		this.reactRoot.render(
			React.createElement(DashboardComponent, { plugin: this.plugin })
		);
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		if (this.reactRoot) {
			this.reactRoot.unmount();
			this.reactRoot = null;
		}
		return Promise.resolve();
	}
}

