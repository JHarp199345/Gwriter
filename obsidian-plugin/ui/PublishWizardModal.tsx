import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal, Notice, TFile, TFolder } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { FilePickerModal } from './FilePickerModal';
import { FolderPickerModal } from './FolderPickerModal';
import { BinaryFilePickerModal } from './BinaryFilePickerModal';
import { MarkdownCompile } from '../services/publish/MarkdownCompile';
import { EpubExportService } from '../services/publish/EpubExportService';
import { LICENSE_TEMPLATES, type LicenseTemplateId } from '../services/publish/LicenseTemplates';

type SourceMode = 'book-main' | 'toc-note';

type Step = 1 | 2 | 3 | 4 | 5 | 6;

const FONT_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2']);

function currentYear(): string {
	return String(new Date().getFullYear());
}

function sanitizeFileName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return 'book';
	const forbidden = '<>:"/\\\\|?*';
	let out = '';
	for (const ch of trimmed) {
		const code = ch.charCodeAt(0);
		if (code < 32) {
			out += '_';
			continue;
		}
		out += forbidden.includes(ch) ? '_' : ch;
	}
	return out.length ? out : 'book';
}

function ensureEpubExt(name: string): string {
	return name.toLowerCase().endsWith('.epub') ? name : `${name}.epub`;
}

export class PublishWizardModal extends Modal {
	private plugin: WritingDashboardPlugin;
	private reactRoot: { render: (node: unknown) => void; unmount: () => void } | null = null;

	constructor(plugin: WritingDashboardPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onOpen() {
		this.titleEl.setText('Export to epub');
		this.contentEl.empty();
		const container = this.contentEl.createDiv();
		this.reactRoot = createRoot(container);
		this.reactRoot.render(React.createElement(PublishWizardComponent, { plugin: this.plugin, onClose: () => this.close() }));
	}

	onClose() {
		this.reactRoot?.unmount();
		this.reactRoot = null;
		this.contentEl.empty();
	}
}

export const PublishWizardComponent: React.FC<{ plugin: WritingDashboardPlugin; onClose: () => void }> = ({
	plugin,
	onClose
}) => {
	const [step, setStep] = useState<Step>(1);
	const [mode, setMode] = useState<SourceMode>('book-main');
	const [sourcePath, setSourcePath] = useState<string>(plugin.settings.book2Path || 'Book-Main.md');
	const [tocPath, setTocPath] = useState<string>('');

	const [title, setTitle] = useState<string>('Untitled');
	const [subtitle, setSubtitle] = useState<string>('');
	const [author, setAuthor] = useState<string>('');
	const [language, setLanguage] = useState<string>('en');

	const [includeTitlePage, setIncludeTitlePage] = useState<boolean>(true);
	const [includeCopyrightPage, setIncludeCopyrightPage] = useState<boolean>(true);
	const [licenseTemplateId, setLicenseTemplateId] = useState<LicenseTemplateId>('all-rights-reserved');
	const [copyrightYear, setCopyrightYear] = useState<string>(currentYear());
	const [copyrightHolder, setCopyrightHolder] = useState<string>('');

	const [embedFonts, setEmbedFonts] = useState<boolean>(false);
	const [fontRegular, setFontRegular] = useState<string>('');
	const [fontBold, setFontBold] = useState<string>('');
	const [fontItalic, setFontItalic] = useState<string>('');
	const [fontBoldItalic, setFontBoldItalic] = useState<string>('');

	const [outputFolder, setOutputFolder] = useState<string>('Exports');
	const [outputFileName, setOutputFileName] = useState<string>('Untitled.epub');

	const [isExporting, setIsExporting] = useState<boolean>(false);
	const [progress, setProgress] = useState<string>('');
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setOutputFileName(ensureEpubExt(sanitizeFileName(title || 'Untitled')));
	}, [title]);

	const canNext = useMemo(() => {
		if (step === 1) {
			if (mode === 'book-main') return Boolean(sourcePath.trim());
			return Boolean(tocPath.trim());
		}
		if (step === 4 && embedFonts) {
			return Boolean(fontRegular.trim());
		}
		if (step === 5) {
			return Boolean(outputFolder.trim()) && Boolean(outputFileName.trim());
		}
		return true;
	}, [step, mode, sourcePath, tocPath, embedFonts, fontRegular, outputFolder, outputFileName]);

	const pickMarkdownFile = (placeholder: string, onPick: (file: TFile) => void | Promise<void>) => {
		const files = plugin.app.vault.getMarkdownFiles();
		const modal = new FilePickerModal({
			app: plugin.app,
			files,
			placeholder,
			onPick
		});
		modal.open();
	};

	const pickFolder = (onPick: (folder: TFolder) => void | Promise<void>) => {
		const folders = plugin.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
		const modal = new FolderPickerModal({
			app: plugin.app,
			folders,
			placeholder: 'Pick an output folder',
			onPick
		});
		modal.open();
	};

	const pickFontFile = (onPick: (file: TFile) => void | Promise<void>) => {
		const files = plugin.app.vault.getFiles().filter((f) => FONT_EXTS.has(f.extension.toLowerCase()));
		const modal = new BinaryFilePickerModal({
			app: plugin.app,
			files,
			placeholder: 'Pick a font file',
			onPick
		});
		modal.open();
	};

	const goNext = () => {
		if (!canNext) return;
		setStep((s) => (s < 6 ? ((s + 1) as Step) : s));
	};

	const goBack = () => {
		setStep((s) => (s > 1 ? ((s - 1) as Step) : s));
	};

	const doExport = async () => {
		setIsExporting(true);
		setError(null);
		setProgress('Compiling chapters…');
		try {
			const compiler = new MarkdownCompile(plugin.app);
			const compileResult =
				mode === 'book-main' ? await compiler.compileFromBookMain(sourcePath) : await compiler.compileFromTocNote(tocPath);

			if (!compileResult.chapters.length) {
				throw new Error('No chapters were found to export.');
			}

			setProgress(`Building EPUB (${compileResult.chapters.length} chapter(s))…`);
			const exporter = new EpubExportService(plugin.app.vault);

			const result = await exporter.exportEpub({
				bookTitle: title,
				subtitle,
				author,
				language,
				chapters: compileResult.chapters,
				includeTitlePage,
				includeCopyrightPage,
				licenseTemplateId,
				copyrightYear,
				copyrightHolder,
				embedCustomFonts: embedFonts,
				customFonts: embedFonts
					? {
							regularPath: fontRegular,
							boldPath: fontBold || undefined,
							italicPath: fontItalic || undefined,
							boldItalicPath: fontBoldItalic || undefined
						}
					: undefined,
				outputFolder,
				outputFileName
			});

			setProgress('');
			new Notice(`Exported EPUB: ${result.outputPath}`);
			onClose();
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : (() => {
				try {
					return JSON.stringify(e);
				} catch {
					return '[unserializable error]';
				}
			})();
			setError(message || 'Export failed');
			setProgress('');
		} finally {
			setIsExporting(false);
		}
	};

	return (
		<div className="publish-wizard">
			<div className="publish-steps">Step {step} of 6</div>

			{step === 1 && (
				<div>
					<h2>Source</h2>
					<div className="publish-row">
						<label>
							<input
								type="radio"
								checked={mode === 'book-main'}
								onChange={() => setMode('book-main')}
								disabled={isExporting}
							/>
							Book main (H1 chapters)
						</label>
						<label style={{ marginLeft: 12 }}>
							<input
								type="radio"
								checked={mode === 'toc-note'}
								onChange={() => setMode('toc-note')}
								disabled={isExporting}
							/>
							TOC note
						</label>
					</div>

					{mode === 'book-main' && (
						<div className="publish-row">
							<div>Book main file</div>
							<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
								<input value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} disabled={isExporting} />
								<button
									onClick={() =>
										pickMarkdownFile('Pick your manuscript note', (file) => {
											setSourcePath(file.path);
										})
									}
									disabled={isExporting}
								>
									Browse
								</button>
							</div>
						</div>
					)}

					{mode === 'toc-note' && (
						<div className="publish-row">
							<div>TOC note</div>
							<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
								<input value={tocPath} onChange={(e) => setTocPath(e.target.value)} disabled={isExporting} />
								<button
									onClick={() =>
										pickMarkdownFile('Pick your TOC note', (file) => {
											setTocPath(file.path);
										})
									}
									disabled={isExporting}
								>
									Browse
								</button>
							</div>
						</div>
					)}
				</div>
			)}

			{step === 2 && (
				<div>
					<h2>Metadata</h2>
					<div className="publish-row">
						<div>Title</div>
						<input value={title} onChange={(e) => setTitle(e.target.value)} disabled={isExporting} />
					</div>
					<div className="publish-row">
						<div>Subtitle (optional)</div>
						<input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} disabled={isExporting} />
					</div>
					<div className="publish-row">
						<div>Author</div>
						<input value={author} onChange={(e) => setAuthor(e.target.value)} disabled={isExporting} />
					</div>
					<div className="publish-row">
						<div>Language</div>
						<input value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isExporting} placeholder="en" />
					</div>
				</div>
			)}

			{step === 3 && (
				<div>
					<h2>Front matter</h2>
					<div className="publish-row">
						<label>
							<input type="checkbox" checked={includeTitlePage} onChange={(e) => setIncludeTitlePage(e.target.checked)} />
							Title page
						</label>
					</div>
					<div className="publish-row">
						<label>
							<input
								type="checkbox"
								checked={includeCopyrightPage}
								onChange={(e) => setIncludeCopyrightPage(e.target.checked)}
							/>
							Copyright page
						</label>
					</div>
					<div className="publish-row">
						<div>License template</div>
						<select
							value={licenseTemplateId}
							onChange={(e) => setLicenseTemplateId(e.target.value as LicenseTemplateId)}
							disabled={isExporting}
						>
							{LICENSE_TEMPLATES.map((t) => (
								<option key={t.id} value={t.id}>
									{t.label}
								</option>
							))}
						</select>
					</div>
					<div className="publish-row">
						<div>Copyright year</div>
						<input value={copyrightYear} onChange={(e) => setCopyrightYear(e.target.value)} disabled={isExporting} />
					</div>
					<div className="publish-row">
						<div>Copyright holder</div>
						<input value={copyrightHolder} onChange={(e) => setCopyrightHolder(e.target.value)} disabled={isExporting} />
					</div>
				</div>
			)}

			{step === 4 && (
				<div>
					<h2>Typography</h2>
					<p>Default styling uses Literata if available on the reader device. You can embed your own font files to guarantee the look.</p>
					<div className="publish-row">
						<label>
							<input type="checkbox" checked={embedFonts} onChange={(e) => setEmbedFonts(e.target.checked)} disabled={isExporting} />
							Embed custom fonts
						</label>
					</div>

					{embedFonts && (
						<div>
							<div className="publish-row">
								<div>Regular (required)</div>
								<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
									<input value={fontRegular} onChange={(e) => setFontRegular(e.target.value)} disabled={isExporting} />
									<button onClick={() => pickFontFile((f) => setFontRegular(f.path))} disabled={isExporting}>
										Browse
									</button>
								</div>
							</div>
							<div className="publish-row">
								<div>Bold</div>
								<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
									<input value={fontBold} onChange={(e) => setFontBold(e.target.value)} disabled={isExporting} />
									<button onClick={() => pickFontFile((f) => setFontBold(f.path))} disabled={isExporting}>
										Browse
									</button>
								</div>
							</div>
							<div className="publish-row">
								<div>Italic</div>
								<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
									<input value={fontItalic} onChange={(e) => setFontItalic(e.target.value)} disabled={isExporting} />
									<button onClick={() => pickFontFile((f) => setFontItalic(f.path))} disabled={isExporting}>
										Browse
									</button>
								</div>
							</div>
							<div className="publish-row">
								<div>Bold italic</div>
								<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
									<input value={fontBoldItalic} onChange={(e) => setFontBoldItalic(e.target.value)} disabled={isExporting} />
									<button onClick={() => pickFontFile((f) => setFontBoldItalic(f.path))} disabled={isExporting}>
										Browse
									</button>
								</div>
							</div>
						</div>
					)}
				</div>
			)}

			{step === 5 && (
				<div>
					<h2>Output</h2>
					<div className="publish-row">
						<div>Folder</div>
						<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
							<input value={outputFolder} onChange={(e) => setOutputFolder(e.target.value)} disabled={isExporting} />
							<button onClick={() => pickFolder((f) => setOutputFolder(f.path))} disabled={isExporting}>
								Browse
							</button>
						</div>
					</div>
					<div className="publish-row">
						<div>File name</div>
						<input value={outputFileName} onChange={(e) => setOutputFileName(ensureEpubExt(e.target.value))} disabled={isExporting} />
					</div>
				</div>
			)}

			{step === 6 && (
				<div>
					<h2>Export</h2>
					<p>When you click Export, the plugin will compile your notes and write an EPUB into your vault.</p>
					{progress && <div className="generation-status">{progress}</div>}
					{error && <div className="error-message">❌ {error}</div>}
				</div>
			)}

			<div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
				<div>
					<button onClick={onClose} className="mod-secondary" disabled={isExporting}>
						Close
					</button>
				</div>
				<div style={{ display: 'flex', gap: 8 }}>
					<button onClick={goBack} disabled={isExporting || step === 1}>
						Back
					</button>
					{step < 6 && (
						<button onClick={goNext} disabled={isExporting || !canNext} className="mod-cta">
							Next
						</button>
					)}
					{step === 6 && (
						<button onClick={doExport} disabled={isExporting} className="mod-cta">
							Export epub
						</button>
					)}
				</div>
			</div>
		</div>
	);
};


