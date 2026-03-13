import { App, FuzzySuggestModal, TFile } from 'obsidian';

/**
 * Generic searchable picker for any file types (useful for fonts).
 */
export class BinaryFilePickerModal extends FuzzySuggestModal<TFile> {
	private readonly files: TFile[];
	private readonly placeholderText: string;
	private readonly onPick: (file: TFile) => void | Promise<void>;

	constructor(opts: {
		app: App;
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
		return this.files.slice().sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		void this.onPick(item);
	}
}


