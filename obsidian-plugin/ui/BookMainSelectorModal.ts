import { FuzzySuggestModal, TFile } from 'obsidian';
import WritingDashboardPlugin from '../main';

export class BookMainSelectorModal extends FuzzySuggestModal<TFile> {
	private plugin: WritingDashboardPlugin;
	private files: TFile[];

	constructor(plugin: WritingDashboardPlugin, files: TFile[]) {
		super(plugin.app);
		this.plugin = plugin;
		this.files = files;
		this.setPlaceholder('Type to search for your manuscript file (e.g., "Reach of the Abyss")');
	}

	getItems(): TFile[] {
		// Prefer larger / more recently modified files by default ordering
		return this.files.slice().sort((a, b) => {
			const aScore = (a.stat?.mtime || 0) + (a.stat?.size || 0);
			const bScore = (b.stat?.mtime || 0) + (b.stat?.size || 0);
			return bScore - aScore;
		});
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		void (async () => {
			this.plugin.settings.book2Path = item.path;
			this.plugin.settings.setupCompleted = true;
			await this.plugin.saveSettings();
		})();
	}
}


