import { App, Modal, Setting, TextAreaComponent } from 'obsidian';
import { InterventionGuidance, InterventionTriggerReason } from '../services/Schemas';

export interface InterventionModalOptions {
    triggerReason: InterventionTriggerReason;
    violationSummary: string;
    chunkId: string;
    severity: number;
}

export interface InterventionResult {
    guidance: InterventionGuidance;
    proceed: boolean;
}

export function showInterventionModal(
    app: App,
    opts: InterventionModalOptions
): Promise<InterventionResult | null> {
    return new Promise((resolve) => {
        let settled = false;

        const settle = (value: InterventionResult | null) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const handleCancel = () => { settle(null); modal.close(); };

        const modal = new (class extends Modal {
            private goalInput: TextAreaComponent;
            private mustPreserveInput: TextAreaComponent;
            private mustAvoidInput: TextAreaComponent;
            private userPromptInput: TextAreaComponent;

            onOpen() {
                const title = opts.triggerReason === 'FAIL_MATRIX_SEVERITY' 
                    ? 'Intervention Required: Lore Violation' 
                    : 'Intervention Required: Repair Cap Exceeded';
                this.titleEl.setText(title);

                const content = this.contentEl;
                
                // Display violation summary
                content.createEl('div', { 
                    cls: 'intervention-summary',
                    text: opts.violationSummary 
                });

                // Generate starter prompts based on failure type
                let defaultGoal = '';
                let defaultPreserve = '';
                let defaultAvoid = '';
                let starterPrompt = '';

                if (opts.triggerReason === 'FAIL_MATRIX_SEVERITY') {
                    defaultGoal = 'Fix canon violation by correcting or removing the violating claim';
                    defaultPreserve = 'All established canon facts, character states, timeline consistency';
                    defaultAvoid = 'Inventing new facts, contradicting established canon, adding unexplained changes';
                    starterPrompt = `The prose contains a violation of established canon. Please revise the chunk to remove or correct the conflicting claim: "${opts.violationSummary}". Ensure consistency with the Story Bible and existing canon facts.`;
                } else {
                    defaultGoal = 'Reduce complexity or simplify the paragraph structure';
                    defaultPreserve = 'Core narrative intent, key character actions, plot progression';
                    defaultAvoid = 'Complex nested clauses, multiple simultaneous actions, unclear references';
                    starterPrompt = `The prose requires simplification due to excessive repair attempts. Please rewrite the paragraph with clearer structure and reduced complexity while maintaining the narrative intent.`;
                }

                // Goal
                new Setting(content)
                    .setName('Goal')
                    .setDesc('What you want the AI to achieve')
                    .addTextArea((text) => {
                        this.goalInput = text;
                        text.setValue(defaultGoal);
                        text.inputEl.rows = 2;
                        text.inputEl.style.width = '100%';
                    });

                // Must Preserve
                new Setting(content)
                    .setName('Must Preserve')
                    .setDesc('Anchors/canon tuples that must be preserved (comma-separated)')
                    .addTextArea((text) => {
                        this.mustPreserveInput = text;
                        text.setValue(defaultPreserve);
                        text.inputEl.rows = 2;
                        text.inputEl.style.width = '100%';
                    });

                // Must Avoid
                new Setting(content)
                    .setName('Must Avoid')
                    .setDesc('Forbidden claims/domains (comma-separated)')
                    .addTextArea((text) => {
                        this.mustAvoidInput = text;
                        text.setValue(defaultAvoid);
                        text.inputEl.rows = 2;
                        text.inputEl.style.width = '100%';
                    });

                // User Prompt
                new Setting(content)
                    .setName('Your Guidance')
                    .setDesc('Provide specific instructions for the AI')
                    .addTextArea((text) => {
                        this.userPromptInput = text;
                        text.setValue(starterPrompt);
                        text.inputEl.rows = 4;
                        text.inputEl.style.width = '100%';
                    });

			// Buttons
                new Setting(content)
                    .addButton((btn) => {
                        btn.setButtonText('Cancel (Stop Run)');
                        btn.onClick(handleCancel);
                    })
                    .addButton((btn) => {
                        btn.setCta();
                        btn.setButtonText('Apply Guidance & Continue');
                        btn.onClick(() => {
                            const guidance: InterventionGuidance = {
                                goal: this.goalInput.getValue(),
                                mustPreserve: this.mustPreserveInput.getValue().split(',').map(s => s.trim()).filter(s => s),
                                mustAvoid: this.mustAvoidInput.getValue().split(',').map(s => s.trim()).filter(s => s),
                                userPrompt: this.userPromptInput.getValue()
                            };
                            settle({ guidance, proceed: true });
                            this.close();
                        });
                    });
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

