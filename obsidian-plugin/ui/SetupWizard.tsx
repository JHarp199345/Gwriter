import React, { useState, useEffect } from 'react';
import { createRoot, Root } from 'react-dom/client';
import WritingDashboardPlugin from '../main';
import { Modal } from 'obsidian';

interface SetupItem {
	type: 'file' | 'folder';
	path: string;
	description: string;
	content?: string;
	defaultChecked: boolean;
}

function getSetupItems(plugin: WritingDashboardPlugin): SetupItem[] {
	const bookPath = plugin.settings.book2Path || 'Book-Main.md';
	return [
		{
			type: 'file',
			path: bookPath,
			description: 'Your active manuscript file where new chapters are written',
			content: `# Book - Main

Your active manuscript goes here.

## Chapters

[Start writing...]`,
			defaultChecked: true
		},
		{
			type: 'file',
			path: plugin.settings.storyBiblePath || 'Book - Story Bible.md',
			description: 'World building, rules, canon, and story elements',
			content: `# Story Bible

## World Building
[Your world rules, magic systems, etc.]

## Characters
[Main character overviews]

## Plot Points
[Key plot elements]

## Themes
[Themes and motifs]`,
			defaultChecked: true
		},
		{
			type: 'file',
			path: plugin.settings.slidingWindowPath || 'Memory - Sliding Window.md',
			description: 'Recent narrative context used for AI generation',
			content: `# Memory - Sliding Window

Recent narrative context for AI generation.

[This file will be updated as you write]`,
			defaultChecked: true
		},
		{
			type: 'folder',
			path: plugin.settings.characterFolder || 'Characters',
			description: 'Folder for character notes (auto-updated by Character Update mode)',
			defaultChecked: true
		},
		{
			type: 'folder',
			path: 'Book 1 - Chunked',
			description: 'Chunked version of Book 1 (500-word sections) for Smart Connections. Only needed when starting Book 2.',
			defaultChecked: false
		}
	];
}

export class SetupWizardModal extends Modal {
	plugin: WritingDashboardPlugin;
	reactRoot: Root | null = null;

	constructor(plugin: WritingDashboardPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		const reactContainer = contentEl.createDiv();
		this.reactRoot = createRoot(reactContainer);
		this.reactRoot.render(
			React.createElement(SetupWizardComponent, {
				plugin: this.plugin,
				onClose: () => this.close()
			})
		);
	}

	onClose() {
		if (this.reactRoot) {
			this.reactRoot.unmount();
			this.reactRoot = null;
		}
	}
}

interface SetupWizardComponentProps {
	plugin: WritingDashboardPlugin;
	onClose: () => void;
}

export const SetupWizardComponent: React.FC<SetupWizardComponentProps> = ({ plugin, onClose }) => {
	const [items, setItems] = useState<Array<SetupItem & { checked: boolean; exists: boolean }>>([]);
	const [isCreating, setIsCreating] = useState(false);
	const [result, setResult] = useState<{ created: string[]; skipped: string[] } | null>(null);

	useEffect(() => {
		// Check which items already exist
		const checkItems = async () => {
			const checkedItems = await Promise.all(
				getSetupItems(plugin).map(async (item) => {
					const file = plugin.app.vault.getAbstractFileByPath(item.path);
					const exists = file !== null;
					return {
						...item,
						checked: item.defaultChecked && !exists,
						exists
					};
				})
			);
			setItems(checkedItems);
		};
		checkItems();
	}, [plugin]);

	const handleToggle = (index: number) => {
		const newItems = [...items];
		if (!newItems[index].exists) {
			newItems[index].checked = !newItems[index].checked;
			setItems(newItems);
		}
	};

	const handleCreate = async () => {
		setIsCreating(true);
		try {
			const selectedItems = items.filter(item => item.checked && !item.exists);
			const structureItems = selectedItems.map(item => ({
				type: item.type as 'file' | 'folder',
				path: item.path,
				content: item.content
			}));

			// Create Characters template file if Characters folder is selected
			// Note: This needs to be created after the folder, so we'll handle it separately
			const needsCharacterTemplate = selectedItems.some(item => item.path === 'Characters');

			const result = await plugin.vaultService.setupDefaultStructure(structureItems);
			
			// Create Character Template file if Characters folder was created
			if (needsCharacterTemplate && result.created.includes('Characters')) {
				try {
					await plugin.vaultService.createFileIfNotExists(
						'Characters/Character Template.md',
						`# Character Name

## Basic Info
- **Role**: 
- **Age**: 
- **Appearance**: 

## Voice & Tone
[Examples of their dialogue/voice]

## Traits
- [Trait]: [Evidence]

## Relationships
- **OtherCharacter**: [Relationship description]

## Arc Progression
[Character development notes]

## Notes
[Additional information]`
					);
					if (!result.created.includes('Characters/Character Template.md')) {
						result.created.push('Characters/Character Template.md');
					}
				} catch (error) {
					console.error('Error creating character template:', error);
				}
			}
			
			setResult(result);

			// Mark setup as completed
			plugin.settings.setupCompleted = true;
			await plugin.saveSettings();
		} catch (error) {
			console.error('Setup error:', error);
			alert(`Error creating files: ${error}`);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDontShowAgain = async () => {
		try {
			plugin.settings.setupCompleted = true;
			await plugin.saveSettings();
		} finally {
			onClose();
		}
	};

	if (result) {
		return (
			<div className="setup-wizard">
				<h2>Setup Complete!</h2>
				{result.created.length > 0 && (
					<div className="setup-success">
						<p><strong>Created:</strong></p>
						<ul>
							{result.created.map(path => (
								<li key={path}>{path}</li>
							))}
						</ul>
					</div>
				)}
				{result.skipped.length > 0 && (
					<div className="setup-skipped">
						<p><strong>Skipped (already exist):</strong></p>
						<ul>
							{result.skipped.map(path => (
								<li key={path}>{path}</li>
							))}
						</ul>
					</div>
				)}
				<button onClick={onClose} className="mod-cta">Close</button>
			</div>
		);
	}

	return (
		<div className="setup-wizard">
			<h2>Welcome to Writing Dashboard</h2>
			<p>Set up your writing workspace by selecting which files and folders to create:</p>

			<div className="setup-items">
				{items.map((item, index) => (
					<div key={item.path} className="setup-item">
						<label className={item.exists ? 'disabled' : ''}>
							<input
								type="checkbox"
								checked={item.checked}
								disabled={item.exists || isCreating}
								onChange={() => handleToggle(index)}
							/>
							<div className="setup-item-content">
								<div className="setup-item-header">
									<strong>{item.path}</strong>
									{item.exists && <span className="exists-badge">✓ Already exists</span>}
								</div>
								<div className="setup-item-description">{item.description}</div>
							</div>
						</label>
					</div>
				))}
			</div>

			<div className="setup-actions">
				<button onClick={onClose} disabled={isCreating} className="mod-secondary">
					Cancel
				</button>
				<button onClick={handleDontShowAgain} disabled={isCreating} className="mod-secondary">
					Don't show again
				</button>
				<button
					onClick={handleCreate}
					disabled={isCreating || items.filter(item => item.checked && !item.exists).length === 0}
					className="mod-cta"
				>
					{isCreating ? 'Creating...' : 'Create Selected'}
				</button>
			</div>
		</div>
	);
};

