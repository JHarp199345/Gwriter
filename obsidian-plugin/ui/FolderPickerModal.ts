import { App, FuzzySuggestModal, TFolder } from 'obsidian';

/**
 * Generic searchable picker for folders in the vault.
 */
export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
	private folders: TFolder[];
	private placeholderText: string;
	private onPick: (folder: TFolder) => void | Promise<void>;

	constructor(opts: {
		app: App;
		folders: TFolder[];
		placeholder: string;
		onPick: (folder: TFolder) => void | Promise<void>;
	}) {
		super(opts.app);
		this.folders = opts.folders;
		this.placeholderText = opts.placeholder;
		this.onPick = opts.onPick;
		this.setPlaceholder(this.placeholderText);
	}

	getItems(): TFolder[] {
		return this.folders.slice().sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(item: TFolder): string {
		return item.path;
	}

	onChooseItem(item: TFolder): void {
		void this.onPick(item);
	}
}


