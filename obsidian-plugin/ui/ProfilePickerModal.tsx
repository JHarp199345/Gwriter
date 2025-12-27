import { Modal } from 'obsidian';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import WritingDashboardPlugin from '../main';

type FolderNode = { name: string; path: string; type: 'folder' | 'file' };

export class ProfilePickerModal extends Modal {
	private plugin: WritingDashboardPlugin;
	private reactRoot: { render: (node: unknown) => void; unmount: () => void } | null = null;

	constructor(plugin: WritingDashboardPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.titleEl.setText('Select folders for retrieval');
		this.contentEl.empty();
		const container = this.contentEl.createDiv();
		this.reactRoot = createRoot(container);
		this.reactRoot.render(
			React.createElement(ProfilePickerComponent, {
				plugin: this.plugin,
				onClose: () => this.close()
			})
		);
	}

	onClose(): void {
		if (this.reactRoot) {
			this.reactRoot.unmount();
			this.reactRoot = null;
		}
		this.contentEl.empty();
	}
}

const ProfilePickerComponent: React.FC<{ plugin: WritingDashboardPlugin; onClose: () => void }> = ({ plugin, onClose }) => {
	const [structure, setStructure] = useState<FolderNode[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));

	useEffect(() => {
		const vaultStructure = plugin.vaultService.getVaultStructure().filter((i) => i.type === 'folder');
		setStructure(vaultStructure);
		const initial = new Set<string>((plugin.settings.retrievalIncludedFolders || []).map((p) => p.replace(/\\/g, '/')));
		setSelected(initial);
	}, [plugin]);

	const toggleFolder = (path: string) => {
		const next = new Set(expanded);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		setExpanded(next);
	};

	const toggleSelect = (path: string) => {
		const next = new Set(selected);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		setSelected(next);
	};

	const save = async () => {
		plugin.settings.retrievalIncludedFolders = Array.from(selected).sort((a, b) => a.localeCompare(b));
		plugin.settings.retrievalActiveProfileId = undefined;
		await plugin.saveSettings();
		onClose();
	};

	const renderItem = (item: FolderNode, depth = 0) => {
		if (item.type !== 'folder') return null;
		const isExpanded = expanded.has(item.path);
		const isSelected = selected.has(item.path);
		const children = structure.filter(
			(n) => n.type === 'folder' && n.path.startsWith(item.path + '/') && n.path.split('/').length === item.path.split('/').length + 1
		);

		return (
			<div key={item.path} style={{ paddingLeft: `${depth * 18}px` }}>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						padding: '4px 6px',
						borderRadius: '4px',
						cursor: 'pointer',
						backgroundColor: isSelected ? 'var(--background-modifier-hover)' : 'transparent'
					}}
				>
					<span
						onClick={() => toggleFolder(item.path)}
						style={{ cursor: 'pointer', width: '16px', textAlign: 'center' }}
						title={isExpanded ? 'Collapse' : 'Expand'}
					>
						{isExpanded ? '📂' : '📁'}
					</span>
					<input
						type="checkbox"
						checked={isSelected}
						onChange={() => toggleSelect(item.path)}
						style={{ margin: 0 }}
					/>
					<span onClick={() => toggleSelect(item.path)} style={{ flex: 1 }}>
						{item.name}
					</span>
				</div>
				{isExpanded && children.map((c) => renderItem(c, depth + 1))}
			</div>
		);
	};

	const rootItems = structure.filter((i) => !i.path.includes('/'));

	return (
		<div style={{ padding: '12px', maxHeight: '60vh', overflowY: 'auto', minWidth: '320px' }}>
			<div style={{ marginBottom: '12px', color: 'var(--text-muted)' }}>
				Select folders to include for retrieval/indexing. If none are selected, only the active note is used.
			</div>
			{rootItems.length === 0 ? (
				<div style={{ padding: '12px', color: 'var(--text-muted)' }}>No folders found</div>
			) : (
				rootItems.map((item) => renderItem(item))
			)}
			<div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
				<button className="mod-cta" onClick={save} style={{ flex: 1 }}>
					Save
				</button>
				<button className="mod-secondary" onClick={onClose} style={{ flex: 1 }}>
					Cancel
				</button>
			</div>
		</div>
	);
};


