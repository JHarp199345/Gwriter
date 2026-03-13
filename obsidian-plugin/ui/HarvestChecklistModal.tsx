import { App, Modal, Setting } from 'obsidian';
import { HarvestItem } from '../services/Schemas';

export interface HarvestChecklistModalOptions {
    items: HarvestItem[];
}

export interface HarvestChecklistResult {
    approvedIds: string[];
    rejectedIds: string[];
    runLocalIds: string[]; // Items accepted as run-local only
    resolutionActions: Record<string, string>; // harvestId -> resolutionAction
}

export function showHarvestChecklistModal(
    app: App,
    opts: HarvestChecklistModalOptions
): Promise<HarvestChecklistResult | null> {
    return new Promise((resolve) => {
        let settled = false;

        const settle = (value: HarvestChecklistResult | null) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const selectedIds = new Set<string>();
        const runLocalIds = new Set<string>();
        const autoAcceptedIds = new Set<string>();
        const resolutionActions: Record<string, string> = {};

        const handleDropdownChange = (harvestId: string) => (value: string) => {
            selectedIds.delete(harvestId);
            runLocalIds.delete(harvestId);
            if (value === 'promote') {
                selectedIds.add(harvestId);
                resolutionActions[harvestId] = 'PROMOTE_TO_BIBLE';
            } else if (value === 'run-local') {
                runLocalIds.add(harvestId);
                resolutionActions[harvestId] = 'SCOPE_TO_SCENE';
            } else {
                delete resolutionActions[harvestId];
            }
        };

        const handleCancel = () => { settle(null); modal.close(); };
        const handleApply = () => {
            const allIds = new Set(opts.items.map(i => i.harvestId));
            settle({
                approvedIds: Array.from(selectedIds),
                rejectedIds: Array.from(allIds).filter(id => !selectedIds.has(id) && !runLocalIds.has(id)),
                runLocalIds: Array.from(runLocalIds),
                resolutionActions
            });
            modal.close();
        };

        // Pre-select auto-accept items
        opts.items.forEach(item => {
            if (item.recommendedAction === 'AUTO_ACCEPT_SCENE_ONLY') {
                autoAcceptedIds.add(item.harvestId);
                runLocalIds.add(item.harvestId);
            }
        });

        const modal = new (class extends Modal {
            onOpen() {
                this.titleEl.setText('Lore Harvest Review');

                const content = this.contentEl;
                content.createEl('p', { 
                    text: `Review ${opts.items.length} harvested lore items. Select which to merge into the Story Bible.`,
                    cls: 'harvest-intro'
                });

                const itemsContainer = content.createDiv({ cls: 'harvest-items-container' });

                opts.items.forEach((item) => {
                    const itemDiv = itemsContainer.createDiv({ cls: 'harvest-item' });
                    
                    const isAutoAccepted = autoAcceptedIds.has(item.harvestId);
                    const isPromoted = selectedIds.has(item.harvestId);
                    // Check evidence freshness
                    const staleEvidence = item.supportingEvidence.some(e => e.relocationTier === 'STALE' || e.relocationTier === 'RELOCATED_AMBIGUOUS');
                    if (staleEvidence && !isAutoAccepted) {
                        const staleBanner = itemDiv.createDiv({ cls: 'harvest-stale-warning' });
                        staleBanner.createSpan({ text: '⚠️ Evidence may be stale - manuscript may have changed since extraction', cls: 'stale-banner' });
                    }

                    new Setting(itemDiv)
                        .setName(`${item.proposedFact.attribute} of ${item.proposedFact.entityId}`)
                        .setDesc(this.formatItemDescription(item))
                        .addDropdown((dropdown) => {
                            dropdown.addOption('none', 'Reject');
                            dropdown.addOption('run-local', 'Accept Run-Local');
                            dropdown.addOption('promote', staleEvidence ? 'Promote (Stale Evidence Override)' : 'Promote to Story Bible');
                            let dropdownValue: string;
                            if (isAutoAccepted) dropdownValue = 'run-local';
                            else if (isPromoted) dropdownValue = 'promote';
                            else dropdownValue = 'none';
                            dropdown.setValue(dropdownValue);
                            dropdown.setDisabled(isAutoAccepted);
                            dropdown.onChange(handleDropdownChange(item.harvestId));
                        });

                    // Show conflict flags with taxonomy
                    if (item.conflictCheckResult.hasConflict) {
                        const conflictDiv = itemDiv.createDiv({ cls: 'harvest-conflict' });
                        const conflictType = item.conflictCheckResult.conflictType || 'Conflict';
                        conflictDiv.createSpan({ 
                            text: `⚠️ ${conflictType}: ${item.conflictCheckResult.conflictingFactIds?.join(', ')}`,
                            cls: 'conflict-warning'
                        });
                    }

                    // Show tier, support count, and evidence tiers with confidence badges
                    const metaDiv = itemDiv.createDiv({ cls: 'harvest-meta' });
                    metaDiv.createSpan({ text: `Tier: ${item.tierImpact}`, cls: 'tier-badge' });
                    metaDiv.createSpan({ text: `Appearances: ${item.appearanceCount}`, cls: 'count-badge' });
                    
                    // Show evidence relocation tiers with confidence badges
                    const evidenceTiers = item.supportingEvidence.map(e => e.relocationTier);
                    const uniqueTiers = [...new Set(evidenceTiers)];
                    uniqueTiers.forEach(tier => {
                        let tierText: string;
                        if (tier === 'EXACT') tierText = '✓ Exact';
                        else if (tier === 'RELOCATED_UNIQUE') tierText = '~ Relocated';
                        else if (tier === 'STALE') tierText = '⚠ Stale';
                        else tierText = tier;
                        const tierCls = tier === 'EXACT' ? 'evidence-badge-exact'
                            : tier === 'RELOCATED_UNIQUE' ? 'evidence-badge-relocated'
                            : 'evidence-badge-stale';
                        metaDiv.createSpan({ text: tierText, cls: tierCls });
                    });
                    
                    if (item.recommendedAction === 'AUTO_ACCEPT_SCENE_ONLY') {
                        metaDiv.createSpan({ text: '✓ Auto-accepted (run-local)', cls: 'auto-badge' });
                    }

                    // Show occurrences/blast radius
                    if (item.appearanceCount > 0) {
                        const occurrencesDiv = itemDiv.createDiv({ cls: 'harvest-occurrences' });
                        occurrencesDiv.createSpan({ text: `${item.appearanceCount} occurrence(s) in run`, cls: 'occurrences-count' });
                    }
                });

                new Setting(content)
                    .addButton((btn) => {
                        btn.setButtonText('Cancel');
                        btn.onClick(handleCancel);
                    })
                    .addButton((btn) => {
                        btn.setCta();
                        btn.setButtonText(`Apply ${selectedIds.size + runLocalIds.size} Selected`);
                        btn.onClick(handleApply);
                    });
            }

            private formatItemDescription(item: HarvestItem): string {
                const fact = item.proposedFact;
                const valueStr = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value);
                return `${fact.attribute}: ${valueStr} (${fact.scope})`;
            }

            onClose() {
                if (!settled) {
                    settle(null);
                }
                this.contentEl.empty();
            }
        })(app);

        modal.open();
    });
}

