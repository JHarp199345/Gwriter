import { Modal } from 'obsidian';
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import WritingDashboardPlugin from '../main';

export class FileTreePickerModal extends Modal {
	private plugin: WritingDashboardPlugin;
	private reactRoot: { render: (node: unknown) => void; unmount: () => void } | null = null;
	private onPick: (filePath: string) => void | Promise<void>;
	private currentPath?: string;

	constructor(plugin: WritingDashboardPlugin, opts: { onPick: (filePath: string) => void | Promise<void>; currentPath?: string }) {
		super(plugin.app);
		this.plugin = plugin;
		this.onPick = opts.onPick;
		this.currentPath = opts.currentPath;
	}

	onOpen() {
		this.titleEl.setText('Select book file');
		this.contentEl.empty();
		const container = this.contentEl.createDiv();
		this.reactRoot = createRoot(container);
		this.reactRoot.render(
			React.createElement(FileTreePickerComponent, {
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

interface FileTreePickerComponentProps {
	plugin: WritingDashboardPlugin;
	currentPath?: string;
	onPick: (filePath: string) => void;
	onClose: () => void;
}

export const FileTreePickerComponent: React.FC<FileTreePickerComponentProps> = ({ plugin, currentPath, onPick, onClose }) => {
	const [structure, setStructure] = useState<Array<{ name: string; path: string; type: 'file' | 'folder' }>>([]);
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['']));

	useEffect(() => {
		// Get vault structure and filter to only markdown files, but keep all folders
		const vaultStructure = plugin.vaultService.getVaultStructure();
		const filtered = vaultStructure.filter(item => 
			item.type === 'folder' || (item.type === 'file' && item.path.endsWith('.md'))
		);
		setStructure(filtered);
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

	const renderItem = (item: { name: string; path: string; type: 'file' | 'folder' }, depth: number = 0) => {
		if (item.type === 'folder') {
			const isExpanded = expandedFolders.has(item.path);
			const children = structure.filter(s => 
				s.path.startsWith(item.path + '/') && 
				s.path.split('/').length === item.path.split('/').length + 1
			);
			
			// Only show folder if it has children (files or subfolders)
			if (children.length === 0) return null;
			
			return (
				<div key={item.path} className="vault-item folder" style={{ paddingLeft: `${depth * 20}px` }}>
					<span 
						className="folder-toggle"
						onClick={() => toggleFolder(item.path)}
						style={{ cursor: 'pointer', userSelect: 'none' }}
					>
						{isExpanded ? '📂' : '📁'} {item.name}
					</span>
					{isExpanded && children.map(child => renderItem(child, depth + 1))}
				</div>
			);
		} else {
			const isSelected = item.path === currentPath;
			return (
				<div 
					key={item.path} 
					className={`vault-item file ${isSelected ? 'selected' : ''}`}
					style={{ 
						paddingLeft: `${depth * 20}px`,
						cursor: 'pointer',
						padding: '4px 8px',
						borderRadius: '4px',
						backgroundColor: isSelected ? 'var(--background-modifier-hover)' : 'transparent'
					}}
					onClick={() => onPick(item.path)}
					onMouseEnter={(e) => {
						if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--background-modifier-hover)';
					}}
					onMouseLeave={(e) => {
						if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
					}}
				>
					📄 {item.name}
					{isSelected && <span style={{ marginLeft: '8px', color: 'var(--text-accent)' }}>✓</span>}
				</div>
			);
		}
	};

	const rootItems = structure.filter(item => !item.path.includes('/'));

	return (
		<div className="file-tree-picker" style={{ padding: '12px', maxHeight: '60vh', overflowY: 'auto' }}>
			<div className="vault-tree">
				{rootItems.length === 0 ? (
					<div style={{ padding: '12px', color: 'var(--text-muted)' }}>No markdown files found in vault</div>
				) : (
					rootItems.map(item => renderItem(item))
				)}
			</div>
		</div>
	);
};

