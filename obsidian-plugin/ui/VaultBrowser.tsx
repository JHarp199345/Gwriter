import React, { useState, useEffect } from 'react';
import WritingDashboardPlugin from '../main';

export const VaultBrowser: React.FC<{ plugin: WritingDashboardPlugin }> = ({ plugin }) => {
	const [structure, setStructure] = useState<Array<{ name: string; path: string; type: 'file' | 'folder' }>>([]);
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

	useEffect(() => {
		const vaultStructure = plugin.vaultService.getVaultStructure();
		setStructure(vaultStructure);
		// Auto-expand root level
		setExpandedFolders(new Set(['']));
	}, []);

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
			
			return (
				<div key={item.path} className="vault-item folder" style={{ paddingLeft: `${depth * 20}px` }}>
					<span 
						className="folder-toggle"
						onClick={() => toggleFolder(item.path)}
					>
						{isExpanded ? '📂' : '📁'} {item.name}
					</span>
					{isExpanded && children.map(child => renderItem(child, depth + 1))}
				</div>
			);
		} else {
			return (
				<div key={item.path} className="vault-item file" style={{ paddingLeft: `${depth * 20}px` }}>
					📄 {item.name}
				</div>
			);
		}
	};

	const rootItems = structure.filter(item => !item.path.includes('/'));

	return (
		<div className="vault-browser">
			<h3>Vault Structure</h3>
			<div className="vault-tree">
				{rootItems.map(item => renderItem(item))}
			</div>
		</div>
	);
};

