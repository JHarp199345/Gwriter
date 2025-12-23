import { Modal } from 'obsidian';
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import WritingDashboardPlugin from '../main';

export class FolderTreePickerModal extends Modal {
	private plugin: WritingDashboardPlugin;
	private reactRoot: { render: (node: unknown) => void; unmount: () => void } | null = null;
	private onPick: (folderPath: string) => void | Promise<void>;
	private currentPath?: string;
	private title: string;

	constructor(
		plugin: WritingDashboardPlugin,
		opts: {
			onPick: (folderPath: string) => void | Promise<void>;
			currentPath?: string;
			title?: string;
		}
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.onPick = opts.onPick;
		this.currentPath = opts.currentPath;
		this.title = opts.title || 'Select folder';
	}

	onOpen() {
		this.titleEl.setText(this.title);
		this.contentEl.empty();
		const container = this.contentEl.createDiv();
		this.reactRoot = createRoot(container);
		this.reactRoot.render(
			React.createElement(FolderTreePickerComponent, {
				plugin: this.plugin,
				currentPath: this.currentPath,
				onPick: (path: string) => {
					void this.onPick(path);
					this.close();
				},
				onClose: () => this.close()
			})
		);
	}

	onClose() {
		if (this.reactRoot) {
			this.reactRoot.unmount();
			this.reactRoot = null;
		}
		this.contentEl.empty();
	}
}

interface FolderTreePickerComponentProps {
	plugin: WritingDashboardPlugin;
	currentPath?: string;
	onPick: (folderPath: string) => void;
	onClose: () => void;
}

export const FolderTreePickerComponent: React.FC<FolderTreePickerComponentProps> = ({
	plugin,
	currentPath,
	onPick,
	onClose
}) => {
	const [structure, setStructure] = useState<Array<{ name: string; path: string; type: 'file' | 'folder' }>>([]);
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['']));
	const [newFolderName, setNewFolderName] = useState('');
	const [newFolderParent, setNewFolderParent] = useState<string>('');
	const [showCreateForm, setShowCreateForm] = useState(false);

	useEffect(() => {
		// Get vault structure - only folders
		const vaultStructure = plugin.vaultService.getVaultStructure();
		const foldersOnly = vaultStructure.filter(item => item.type === 'folder');
		setStructure(foldersOnly);
		// Auto-expand root level and current path's parent folders
		const expanded = new Set<string>(['']);
		if (currentPath) {
			const parts = currentPath.split('/');
			for (let i = 1; i < parts.length; i++) {
				expanded.add(parts.slice(0, i).join('/'));
			}
		}
		setExpandedFolders(expanded);
	}, [currentPath, plugin]);

	const toggleFolder = (path: string) => {
		const newExpanded = new Set(expandedFolders);
		if (newExpanded.has(path)) {
			newExpanded.delete(path);
		} else {
			newExpanded.add(path);
		}
		setExpandedFolders(newExpanded);
	};

	const handleCreateFolder = async () => {
		if (!newFolderName.trim()) return;
		
		const parentPath = newFolderParent || '';
		const fullPath = parentPath ? `${parentPath}/${newFolderName.trim()}` : newFolderName.trim();
		
		try {
			await plugin.vaultService.createFolderIfNotExists(fullPath);
			// Refresh structure
			const vaultStructure = plugin.vaultService.getVaultStructure();
			const foldersOnly = vaultStructure.filter(item => item.type === 'folder');
			setStructure(foldersOnly);
			// Select the newly created folder
			onPick(fullPath);
		} catch (error) {
			console.error('Failed to create folder:', error);
			// Show error to user
			alert(`Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	};

	const renderItem = (item: { name: string; path: string; type: 'file' | 'folder' }, depth: number = 0) => {
		if (item.type === 'folder') {
			const isExpanded = expandedFolders.has(item.path);
			const isSelected = item.path === currentPath;
			const children = structure.filter(
				s => s.path.startsWith(item.path + '/') && s.path.split('/').length === item.path.split('/').length + 1
			);

			return (
				<div key={item.path} style={{ paddingLeft: `${depth * 20}px` }}>
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '8px',
							padding: '4px 8px',
							borderRadius: '4px',
							cursor: 'pointer',
							backgroundColor: isSelected ? 'var(--background-modifier-hover)' : 'transparent',
							userSelect: 'none'
						}}
						onClick={() => onPick(item.path)}
						onMouseEnter={(e) => {
							if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--background-modifier-hover)';
						}}
						onMouseLeave={(e) => {
							if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
						}}
					>
						<span
							onClick={(e) => {
								e.stopPropagation();
								toggleFolder(item.path);
							}}
							style={{ cursor: 'pointer' }}
						>
							{isExpanded ? '📂' : '📁'}
						</span>
						<span style={{ flex: 1 }}>{item.name}</span>
						{isSelected && <span style={{ color: 'var(--text-accent)' }}>✓</span>}
						<button
							onClick={(e) => {
								e.stopPropagation();
								setNewFolderParent(item.path);
								setShowCreateForm(true);
							}}
							style={{
								padding: '2px 6px',
								fontSize: '11px',
								border: '1px solid var(--background-modifier-border)',
								borderRadius: '3px',
								background: 'var(--background-secondary)',
								cursor: 'pointer'
							}}
							title="Create subfolder here"
						>
							+
						</button>
					</div>
					{isExpanded && children.map(child => renderItem(child, depth + 1))}
				</div>
			);
		}
		return null;
	};

	const rootItems = structure.filter(item => !item.path.includes('/'));

	return (
		<div className="folder-tree-picker" style={{ padding: '12px', maxHeight: '60vh', overflowY: 'auto' }}>
			<div className="vault-tree" style={{ marginBottom: '12px' }}>
				{rootItems.length === 0 ? (
					<div style={{ padding: '12px', color: 'var(--text-muted)' }}>No folders found in vault</div>
				) : (
					rootItems.map(item => renderItem(item))
				)}
			</div>
			
			{showCreateForm && (
				<div style={{ 
					padding: '12px', 
					border: '1px solid var(--background-modifier-border)', 
					borderRadius: '4px',
					marginTop: '12px',
					backgroundColor: 'var(--background-secondary)'
				}}>
					<div style={{ marginBottom: '8px', fontWeight: 600 }}>Create new folder</div>
					<div style={{ marginBottom: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
						{newFolderParent ? `Inside: ${newFolderParent}` : 'At root level'}
					</div>
					<input
						type="text"
						value={newFolderName}
						onChange={(e) => setNewFolderName(e.target.value)}
						placeholder="Folder name"
						style={{
							width: '100%',
							padding: '6px',
							marginBottom: '8px',
							border: '1px solid var(--background-modifier-border)',
							borderRadius: '4px',
							background: 'var(--background-primary)',
							color: 'var(--text-normal)'
						}}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								handleCreateFolder();
							} else if (e.key === 'Escape') {
								setShowCreateForm(false);
								setNewFolderName('');
								setNewFolderParent('');
							}
						}}
						autoFocus
					/>
					<div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
						<button
							onClick={() => {
								setShowCreateForm(false);
								setNewFolderName('');
								setNewFolderParent('');
							}}
							style={{
								padding: '4px 12px',
								border: '1px solid var(--background-modifier-border)',
								borderRadius: '4px',
								background: 'var(--background-secondary)',
								cursor: 'pointer'
							}}
						>
							Cancel
						</button>
						<button
							onClick={handleCreateFolder}
							disabled={!newFolderName.trim()}
							style={{
								padding: '4px 12px',
								border: 'none',
								borderRadius: '4px',
								background: 'var(--interactive-accent)',
								color: 'var(--text-on-accent)',
								cursor: newFolderName.trim() ? 'pointer' : 'not-allowed',
								opacity: newFolderName.trim() ? 1 : 0.5
							}}
						>
							Create
						</button>
					</div>
				</div>
			)}
			
			{!showCreateForm && (
				<button
					onClick={() => {
						setNewFolderParent('');
						setShowCreateForm(true);
					}}
					style={{
						width: '100%',
						padding: '8px',
						marginTop: '12px',
						border: '1px solid var(--background-modifier-border)',
						borderRadius: '4px',
						background: 'var(--background-secondary)',
						cursor: 'pointer',
						fontWeight: 500
					}}
				>
					+ Create new folder at root
				</button>
			)}
		</div>
	);
};

