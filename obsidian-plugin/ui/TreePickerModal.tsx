import { Modal } from 'obsidian';
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import WritingDashboardPlugin from '../main';

type Node = { name: string; path: string; type: 'file' | 'folder' };

export type TreePickerMode = 'single' | 'multi';

export class TreePickerModal extends Modal {
	private plugin: WritingDashboardPlugin;
	private reactRoot: { render: (node: unknown) => void; unmount: () => void } | null = null;
	private opts: {
		title?: string;
		initialSelection?: string | string[];
		mode?: TreePickerMode;
		onSubmit: (value: string | string[]) => void | Promise<void>;
		filter?: (node: Node) => boolean;
	};

	constructor(
		plugin: WritingDashboardPlugin,
		opts: {
			title?: string;
			initialSelection?: string | string[];
			mode?: TreePickerMode;
			onSubmit: (value: string | string[]) => void | Promise<void>;
			filter?: (node: Node) => boolean;
		}
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.opts = opts;
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title || 'Select items');
		this.contentEl.empty();
		const container = this.contentEl.createDiv();
		this.reactRoot = createRoot(container);
		this.reactRoot.render(
			React.createElement(TreePickerComponent, {
				plugin: this.plugin,
				title: this.opts.title,
				initialSelection: this.opts.initialSelection,
				mode: this.opts.mode ?? 'single',
				onSubmit: this.opts.onSubmit,
				onClose: () => this.close(),
				filter: this.opts.filter
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

export const TreePickerComponent: React.FC<{
	plugin: WritingDashboardPlugin;
	title?: string;
	initialSelection?: string | string[];
	mode: TreePickerMode;
	onSubmit: (value: string | string[]) => void | Promise<void>;
	onClose: () => void;
	filter?: (node: Node) => boolean;
}> = ({ plugin, initialSelection, mode, onSubmit, onClose, filter }) => {
	const [nodes, setNodes] = useState<Node[]>([]);
	const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
	const [selected, setSelected] = useState<Set<string>>(new Set());

	useEffect(() => {
		const structure = plugin.vaultService.getVaultStructure();
		const filtered = filter ? structure.filter(filter) : structure;
		setNodes(filtered);
		const init = new Set<string>();
		const list = Array.isArray(initialSelection) ? initialSelection : initialSelection ? [initialSelection] : [];
		for (const p of list) init.add(p.replace(/\\/g, '/'));
		setSelected(init);
		if (list.length) {
			for (const p of list) {
				const parts = p.split('/');
				for (let i = 1; i < parts.length; i++) {
					expanded.add(parts.slice(0, i).join('/'));
				}
			}
			setExpanded(new Set(expanded));
		}
	}, [plugin, initialSelection, filter, expanded]);

	const childrenOf = useMemo(() => {
		const map = new Map<string, Node[]>();
		for (const n of nodes) {
			const parent = n.path.includes('/') ? n.path.split('/').slice(0, -1).join('/') : '';
			if (!map.has(parent)) map.set(parent, []);
			map.get(parent)!.push(n);
		}
		for (const arr of map.values()) arr.sort((a, b) => a.path.localeCompare(b.path));
		return map;
	}, [nodes]);

	const toggleExpand = (path: string) => {
		const next = new Set(expanded);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		setExpanded(next);
	};

	const toggleSelect = (path: string) => {
		if (mode === 'single') {
			setSelected(new Set([path]));
		} else {
			const next = new Set(selected);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			setSelected(next);
		}
	};

	const renderNode = (node: Node, depth = 0) => {
		const isFolder = node.type === 'folder';
		const isExpanded = expanded.has(node.path);
		const isSelected = selected.has(node.path);
		const kids = childrenOf.get(node.path) || [];
		return (
			<div key={node.path} style={{ paddingLeft: `${depth * 18}px` }}>
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
					{isFolder ? (
						<span
							onClick={() => toggleExpand(node.path)}
							style={{ cursor: 'pointer', width: '16px', textAlign: 'center' }}
							title={isExpanded ? 'Collapse' : 'Expand'}
						>
							{isExpanded ? '📂' : '📁'}
						</span>
					) : (
						<span style={{ width: '16px', textAlign: 'center' }}>📄</span>
					)}
					<input
						type={mode === 'single' ? 'radio' : 'checkbox'}
						checked={isSelected}
						onChange={() => toggleSelect(node.path)}
						style={{ margin: 0 }}
						name="tree-picker"
					/>
					<span onClick={() => toggleSelect(node.path)} style={{ flex: 1 }}>
						{node.name}
					</span>
				</div>
				{isFolder && isExpanded && kids.map((c) => renderNode(c, depth + 1))}
			</div>
		);
	};

	const roots = childrenOf.get('') || [];

	const handleSubmit = () => {
		const value = mode === 'single' ? Array.from(selected)[0] || '' : Array.from(selected);
		void onSubmit(value);
		onClose();
	};

	return (
		<div style={{ padding: '12px', maxHeight: '60vh', overflowY: 'auto', minWidth: '360px' }}>
			<div style={{ marginBottom: '12px', color: 'var(--text-muted)' }}>
				Select folders and notes to include. If none are selected in some contexts, the active note is used.
			</div>
			{roots.length === 0 ? (
				<div style={{ padding: '12px', color: 'var(--text-muted)' }}>No items found</div>
			) : (
				roots.map((n) => renderNode(n))
			)}
			<div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
				<button className="mod-cta" onClick={handleSubmit} style={{ flex: 1 }}>
					Save
				</button>
				<button className="mod-secondary" onClick={onClose} style={{ flex: 1 }}>
					Cancel
				</button>
			</div>
		</div>
	);
};


