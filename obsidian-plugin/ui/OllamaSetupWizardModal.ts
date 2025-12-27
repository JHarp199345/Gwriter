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
		contentEl.createEl('a', { href: 'https://ollama.com/download', text: 'https://ollama.com/download', attr: { target: '_blank' } });

		// Quick PATH fixes if the command is not found
		contentEl.createEl('p', { text: 'If the ollama command is not found after install, try:' });
		contentEl.createEl('pre', {
			text: [
				'# Windows PowerShell (temporary PATH fix)',
				'$env:Path = "C:\\\\Program Files\\\\Ollama;" + $env:Path',
				'ollama --version',
				'',
				'# macOS (temporary PATH fix)',
				'export PATH="/Applications/Ollama.app/Contents/MacOS:$PATH"',
				'source ~/.zshrc',
				'ollama --version'
			].join('\n')
		});

		// Step 2: Verify Ollama is running
		contentEl.createEl('h4', { text: 'Step 2 — Verify Ollama' });
		contentEl.createEl('pre', {
			text: [
				'# Windows',
				'ollama --version',
				'',
				'# macOS / Linux',
				'ollama --version'
			].join('\n')
		});

		// Step 3: Pull the embedding model
		contentEl.createEl('h4', { text: 'Step 3 — Pull the embedding model' });
		const pullCmd = 'ollama pull nomic-embed-text';
		new Setting(contentEl)
			.setName(pullCmd)
			.addButton((btn) =>
				btn.setButtonText('Copy').onClick(async () => {
					try {
						await navigator.clipboard.writeText(pullCmd);
						new Notice('Copied command to clipboard');
					} catch {
						new Notice('Copy failed. Please copy manually.');
					}
				})
			);

		// Step 4: Confirm the model is present
		contentEl.createEl('h4', { text: 'Step 4 — Confirm the model' });
		contentEl.createEl('p', { text: 'Use curl to list models. On Windows, use curl.exe to avoid prompts.' });
		contentEl.createEl('pre', {
			text: [
				'# Windows PowerShell',
				'curl.exe http://127.0.0.1:11434/api/tags',
				'',
				'# macOS / Linux',
				'curl http://127.0.0.1:11434/api/tags'
			].join('\n')
		});

		// Step 5: Verify in plugin (Check Connection)
		contentEl.createEl('h4', { text: 'Step 5 — Check in Writing Dashboard' });
		contentEl.createEl('p', { text: 'Click “Check Connection” below. If it succeeds, local semantic search is ready.' });
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

		// Step 6: Re-index reminder
		contentEl.createEl('h4', { text: 'Step 6 — Re-index (optional)' });
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

