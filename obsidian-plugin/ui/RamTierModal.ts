import { App, Modal, Setting } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { RamTier, RAM_TIERS } from '../services/ContextSafety';

/**
 * RamTierModal - First-run modal for RAM tier selection.
 * 
 * Shown once when settings.ramTier is undefined.
 * User selects their machine's RAM, which is saved permanently.
 * Can be changed later in Settings → Memory & Performance.
 */
export class RamTierModal extends Modal {
    private plugin: WritingDashboardPlugin;
    private selectedTier: RamTier = 32; // Default selection
    private onComplete?: (tier: RamTier) => void;

    constructor(app: App, plugin: WritingDashboardPlugin, onComplete?: (tier: RamTier) => void) {
        super(app);
        this.plugin = plugin;
        this.onComplete = onComplete;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ram-tier-modal');

        // Header
        contentEl.createEl('h2', { text: 'Welcome to GWriter' });
        
        // Explanation
        const desc = contentEl.createDiv({ cls: 'ram-tier-description' });
        desc.createEl('p', { 
            text: 'To prevent system freezes, GWriter needs to know how much RAM your machine has.' 
        });
        desc.createEl('p', { 
            text: 'This helps us set safe context limits for AI generation. You can change this later in Settings.',
            cls: 'setting-item-description'
        });

        // RAM tier selection
        new Setting(contentEl)
            .setName('How much RAM does this machine have?')
            .setDesc('Select the closest option. When in doubt, choose lower.')
            .addDropdown(dropdown => {
                const tierLabels: Record<RamTier, string> = {
                    8: '8 GB (entry-level)',
                    16: '16 GB (standard)',
                    24: '24 GB (power user)',
                    32: '32 GB (workstation)',
                    64: '64 GB (high-end)',
                    128: '128 GB+ (professional)'
                };

                for (const tier of RAM_TIERS) {
                    dropdown.addOption(String(tier), tierLabels[tier]);
                }

                dropdown.setValue(String(this.selectedTier));
                dropdown.onChange(value => {
                    this.selectedTier = parseInt(value) as RamTier;
                });
            });

        // Info box
        const infoBox = contentEl.createDiv({ cls: 'ram-tier-info' });
        infoBox.createEl('strong', { text: 'Why does this matter?' });
        infoBox.createEl('p', { 
            text: 'Large language models need RAM for both their weights and their "working memory" (context window). ' +
                  'A 70B model at 128k context needs 100GB+ RAM. If we try to use more than your machine has, it will freeze.',
            cls: 'setting-item-description'
        });

        // Button container
        const buttonContainer = contentEl.createDiv({ cls: 'ram-tier-buttons' });
        
        // Confirm button
        const confirmBtn = buttonContainer.createEl('button', { 
            text: 'Continue',
            cls: 'mod-cta'
        });
        confirmBtn.addEventListener('click', async () => {
            await this.saveAndClose();
        });
    }

    async saveAndClose() {
        // Save the selected tier
        this.plugin.settings.ramTier = this.selectedTier;
        
        // Set default risk profile if not set
        if (!this.plugin.settings.riskProfile) {
            this.plugin.settings.riskProfile = 'safe';
        }
        
        await this.plugin.saveSettings();
        
        // Callback
        if (this.onComplete) {
            this.onComplete(this.selectedTier);
        }
        
        this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

