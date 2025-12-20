import { FuzzySuggestModal, TFile } from 'obsidian';

/**
 * Generic searchable picker for markdown files in the vault.
 */
export class FilePickerModal extends FuzzySuggestModal<TFile> {
	private files: TFile[];
	private placeholderText: string;
	private onPick: (file: TFile) => void | Promise<void>;

	constructor(opts: {
		app: any;
		files: TFile[];
		placeholder: string;
		onPick: (file: TFile) => void | Promise<void>;
	}) {
		super(opts.app);
		this.files = opts.files;
		this.placeholderText = opts.placeholder;
		this.onPick = opts.onPick;
		this.setPlaceholder(this.placeholderText);
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
		void this.onPick(item);
	}
}


