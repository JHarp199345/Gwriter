import { App, Modal, Notice, Setting } from 'obsidian';
import WritingDashboardPlugin from '../main';

export class OllamaSetupWizardModal extends Modal {
	private plugin: WritingDashboardPlugin;

	constructor(app: App, plugin: WritingDashboardPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Ollama Setup (Local Semantic Search)' });

		// Step 1: Download
		contentEl.createEl('h4', { text: 'Step 1 — Download Ollama' });
		contentEl.createEl('p', { text: 'Download and install Ollama for your OS.' });
		const linkRow = contentEl.createEl('div', { cls: 'ollama-link-row' });
		const link = linkRow.createEl('a', { href: 'https://ollama.com/download', text: 'https://ollama.com/download' });
		link.setAttr('target', '_blank');

		// Note about PATH / manual path
		contentEl.createEl('p', { text: 'If the ollama command is not found after install, try:' });
		contentEl.createEl('pre', { text: 'export PATH="/Applications/Ollama.app/Contents/MacOS:$PATH"\nsource ~/.zshrc\nollama --version' });

		// Step 2: Pull model
		contentEl.createEl('h4', { text: 'Step 2 — Pull the embedding model' });
		contentEl.createEl('p', { text: 'Run this in your terminal/command prompt:' });
		const cmd = 'ollama pull nomic-embed-text';
		new Setting(contentEl)
			.setName(cmd)
			.addButton((btn) =>
				btn.setButtonText('Copy').onClick(async () => {
					try {
						await navigator.clipboard.writeText(cmd);
						new Notice('Copied command to clipboard');
					} catch {
						new Notice('Copy failed. Please copy manually.');
					}
				})
			);

		// Step 3: Check connection
		contentEl.createEl('h4', { text: 'Step 3 — Verify' });
		contentEl.createEl('p', { text: 'Click below to confirm Ollama is running and the model is available.' });
		new Setting(contentEl)
			.setName('Check Ollama connection')
			.addButton((btn) =>
				btn.setButtonText('Check').setCta().onClick(async () => {
					try {
						const isRunning = await (this.plugin as any).ollama?.isAvailable?.();
						if (!isRunning) {
							new Notice('❌ Ollama not found at http://127.0.0.1:11434');
							return;
						}
						const hasModel = await (this.plugin as any).ollama?.hasModel?.('nomic-embed-text');
						if (!hasModel) {
							new Notice('⚠️ Ollama is running, but "nomic-embed-text" is missing. Run "ollama pull nomic-embed-text".');
							return;
						}
						new Notice('✅ Success! Local AI is ready.');
					} catch (err) {
						new Notice(`❌ Check failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				})
			);

		// Step 4: Re-index reminder
		contentEl.createEl('h4', { text: 'Step 4 — Re-index (optional)' });
		contentEl.createEl('p', { text: 'If you just installed Ollama, you can re-run indexing to generate embeddings for your vault.' });
		new Setting(contentEl)
			.setName('Re-index now')
			.setDesc('Kick off a full semantic re-index.')
			.addButton((btn) =>
				btn.setButtonText('Re-index').onClick(() => {
					try {
						this.plugin.embeddingsIndex.enqueueFullRescan();
						new Notice('Re-index queued.');
					} catch {
						new Notice('Failed to queue re-index.');
					}
				})
			);
	}
}

