import { TFile } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { FilePickerModal } from './FilePickerModal';

export class BookMainSelectorModal extends FilePickerModal {
	constructor(plugin: WritingDashboardPlugin, files: TFile[]) {
		super({
			app: plugin.app,
			files,
			placeholder: 'Type to search for your manuscript file (e.g., "Reach of the Abyss")',
			onPick: async (item) => {
				plugin.settings.book2Path = item.path;
				plugin.settings.setupCompleted = true;
				await plugin.saveSettings();
			}
		});
	}
}


