import React, { useEffect, useRef, useState } from 'react';
import { Notice } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { EditorPanel } from './EditorPanel';
import { GenerationModal } from './GenerationModal';
import { FileTreePickerModal } from './FileTreePickerModal';
import { FactInspector } from './FactInspector';
import { ReplayPanel } from './ReplayPanel';
import { PilotHealthPanel } from './PilotHealthPanel';
import { TextChunker } from '../services/TextChunker';
import { fnv1a32 } from '../services/ContentHash';
import { relayEventBus } from '../services/EventBus';
import { PatchOp as StitchPatchOp, StitchResponse } from '../contracts/StitchContract';
import { GenerationStep, StageResult } from '../services/Schemas';

type Mode = 'chapter' | 'micro-edit' | 'character-update' | 'continuity-check';

export const DashboardComponent: React.FC<{ plugin: WritingDashboardPlugin }> = ({ plugin }) => {
	const [mode, setMode] = useState<Mode>('chapter');
	const [modeState, setModeState] = useState(() => plugin.settings.modeState);

	const [generatedText, setGeneratedText] = useState<string>('');
	const [generatedParagraphs, setGeneratedParagraphs] = useState<{ id: string, text: string, hash: string, metadata?: any, status: 'STREAMING' | 'FINALIZED' | 'USER_DIRTY', lastPatched?: number }[]>([]);
	const [lastAppliedSeqNo, setLastAppliedSeqNo] = useState<Map<string, number>>(new Map());
	const [undoStack, setUndoStack] = useState<Map<string, { beforeHash: string, text: string }[]>>(new Map());

	const [chunkBuffer, setChunkBuffer] = useState<string>('');
	const [showModal, setShowModal] = useState(false);
	const [isGenerating, setIsGenerating] = useState(false);
	const [generationStage, setGenerationStage] = useState<string>('');
	const [pulseMessage, setPulseMessage] = useState<string | null>(null);
	const [pulseDetail, setPulseDetail] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [mismatchReport, setMismatchReport] = useState<any[] | null>(null);
	const [heatmapEnabled, setHeatmapEnabled] = useState(true);
	const [spontaneity, setSpontaneity] = useState((plugin.settings as any).spontaneitySlider || 50);
	const [misses, setMisses] = useState<any[]>([]);
	const [rejections, setRejections] = useState<any[]>([]);
	const [proposedMutation, setProposedMutation] = useState<any | null>(null);
	const [trustSummary, setTrustSummary] = useState<any | null>(null);
	const [activeTab, setActiveTab] = useState<'editor' | 'lore' | 'replay' | 'characters'>('editor');

	// Suggestions ("What happens next?") state
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const [isSuggestingDirections, setIsSuggestingDirections] = useState(false);
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);

	// Advanced tabs dropdown state
	const [showAdvancedMenu, setShowAdvancedMenu] = useState(false);

	// Character Update mode state
	const [characterSourceFile, setCharacterSourceFile] = useState<string>(
		plugin.settings.characterExtractionSourcePath || plugin.settings.book2Path
	);
	const [isExtractingCharacters, setIsExtractingCharacters] = useState(false);
	const [extractionProgress, setExtractionProgress] = useState<string>('');
	const [characterInputText, setCharacterInputText] = useState<string>('');

	const commitLock = useRef<boolean>(false);

	useEffect(() => {
		const onStart = () => {
			setChunkBuffer('');
			setGeneratedText('');
			setGeneratedParagraphs([]);
			setIsGenerating(true);
			setShowModal(true);
		};
		const onStageStart = (data: { type: string }) => {
			setGenerationStage(`Executing ${data.type}...`);
			setPulseMessage(null);
			setPulseDetail(null);
		};
		const onPulse = (data: { message: string, detail?: string }) => {
			setPulseMessage(data.message);
			if (data.detail) setPulseDetail(data.detail);
		};
		const onBufferUpdate = (data: { content: string }) => {
			setChunkBuffer(data.content);
		};
		const onCommitted = (data: { runId: string, chunkId: string, content: string, metadata?: any[], path: string }) => {
			if (commitLock.current) return;
			commitLock.current = true;
			try {
				const newParas = data.content.split('\n\n').filter(p => p.trim()).map((p, i) => {
					const text = p.trim();
					return {
						id: data.metadata?.[i]?.p_id || `${data.chunkId}-p${i}`,
						text,
						hash: fnv1a32(text.replaceAll(/\s+/g, ' ').trim()),
						metadata: data.metadata ? data.metadata[i] : undefined,
						status: 'FINALIZED' as const
					};
				});

				if (data.chunkId === 'edited-chapter' || data.chunkId === 'monolithic-chapter') {
					setGeneratedParagraphs(newParas);
					setGeneratedText(data.content);
				} else {
					setGeneratedParagraphs((prev) => [...prev, ...newParas]);
					setGeneratedText((prev) => prev + (prev ? '\n\n' : '') + data.content);
				}

				setChunkBuffer('');
			} finally {
				commitLock.current = false;
			}
		};

		const onPatch = (data: StitchResponse) => {
			if (data.runId !== plugin.sequentialGenerator.getCurrentRunId?.()) return;

			const lastSeq = lastAppliedSeqNo.get(data.seamId) || 0;
			if (data.seqNo < lastSeq) return;

			setGeneratedParagraphs(prev => {
				const next = [...prev];
				let anyChanged = false;

				for (const op of data.patchOps) {
					const idx = next.findIndex(p => p.id === op.paragraphId);
					if (idx === -1) continue;

					const para = next[idx];
					if (para.status === 'USER_DIRTY') continue;

					const currentHash = fnv1a32(para.text.replaceAll(/\s+/g, ' ').trim());
					if (currentHash !== op.beforeHash) {
						console.warn(`[Dashboard] Patch rejected: Hash mismatch for ${op.paragraphId}`);
						continue;
					}

					const stack = undoStack.get(para.id) || [];
					stack.push({ beforeHash: para.hash, text: para.text });
					undoStack.set(para.id, stack);

					const newText = para.text.substring(0, op.start) + op.replacementText + para.text.substring(op.end);
					next[idx] = {
						...para,
						text: newText,
						hash: fnv1a32(newText.replaceAll(/\s+/g, ' ').trim()),
						lastPatched: Date.now()
					};
					anyChanged = true;
				}

				if (anyChanged) {
					setLastAppliedSeqNo(new Map(lastAppliedSeqNo).set(data.seamId, data.seqNo));
					setGeneratedText(next.map(p => p.text).join('\n\n'));
				}
				return next;
			});
		};

		const onAuditViolations = (data: { overallSeverity: number, violations: any[] }) => {
			setTrustSummary(data);
		};
		const onEnd = () => {
			setIsGenerating(false);
			setGenerationStage('COMPLETED');
		};
		const onError = (data: { error: string }) => {
			setIsGenerating(false);
			setError(data.error);
		};
		const onMiss = (data: any) => {
			setMisses(prev => [...prev, data]);
		};
		const onStitchRejected = (data: any) => {
			setRejections(prev => [...prev, data]);
		};

		relayEventBus.on('run:start', onStart);
		relayEventBus.on('run:pulse', onPulse);
		relayEventBus.on('stage:start', onStageStart);
		relayEventBus.on('chunk:buffer:update', onBufferUpdate);
		relayEventBus.on('chunk:committed', onCommitted);
		relayEventBus.on('chunk:patch', onPatch);
		relayEventBus.on('audit:violations', onAuditViolations);
		relayEventBus.on('run:end', onEnd);
		relayEventBus.on('run:error', onError);
		relayEventBus.on('pilot:miss', onMiss);
		relayEventBus.on('pilot:stitch_rejected', onStitchRejected);

		return () => {
			relayEventBus.off('run:start', onStart);
			relayEventBus.off('run:pulse', onPulse);
			relayEventBus.off('stage:start', onStageStart);
			relayEventBus.off('chunk:buffer:update', onBufferUpdate);
			relayEventBus.off('chunk:committed', onCommitted);
			relayEventBus.off('chunk:patch', onPatch);
			relayEventBus.off('audit:violations', onAuditViolations);
			relayEventBus.off('run:end', onEnd);
			relayEventBus.off('run:error', onError);
			relayEventBus.off('pilot:miss', onMiss);
			relayEventBus.off('pilot:stitch_rejected', onStitchRejected);
		};
	}, []);

	const updateMainInput = (value: string) => {
		setModeState(prev => {
			const next = { ...prev };
			if (mode === 'chapter') next.chapter.sceneSummary = value;
			else if (mode === 'micro-edit') next.microEdit.selectedPassage = value;
			else if (mode === 'character-update') next.chapter.sceneSummary = value;
			return next;
		});
	};

	const handleInsert = async () => {
		if (!generatedText) return;
		try {
			let existing = '';
			try { existing = await plugin.vaultService.readFile(plugin.settings.book2Path); } catch {}
			const separator = existing.trimEnd() ? '\n\n' : '';
			await plugin.vaultService.writeFile(plugin.settings.book2Path, existing.trimEnd() + separator + generatedText);
			new Notice('Inserted into manuscript.');
			setGeneratedText('');
			setGeneratedParagraphs([]);
			setChunkBuffer('');
			setShowModal(false);
		} catch (err: any) {
			new Notice(`Insert failed: ${err.message}`);
		}
	};

	// Called by ReviewPanel "Push to Vault" — receives the author's reviewed/edited text
	const handleInsertReviewed = async (text: string) => {
		if (!text.trim()) return;
		try {
			let existing = '';
			try { existing = await plugin.vaultService.readFile(plugin.settings.book2Path); } catch {}
			const separator = existing.trimEnd() ? '\n\n' : '';
			await plugin.vaultService.writeFile(
				plugin.settings.book2Path,
				existing.trimEnd() + separator + text.trim()
			);
			new Notice('Reviewed text pushed to manuscript.');
			setGeneratedText('');
			setGeneratedParagraphs([]);
			setChunkBuffer('');
			setShowModal(false);
		} catch (err: any) {
			new Notice(`Push failed: ${err.message}`);
		}
	};

	const handleDiscard = () => {
		setGeneratedText('');
		setGeneratedParagraphs([]);
		setChunkBuffer('');
		setShowModal(false);
	};

	const handleGenerate = async () => {
		try {
			if (mode === 'chapter') {
				setError(null);
				const targetWords = plugin.settings.maxChunkWords || 2500;
				await plugin.sequentialGenerator.generateChapter(targetWords, {
					sceneSummary: modeState.chapter.sceneSummary
				});
			} else if (mode === 'micro-edit') {
				setError(null);
				await plugin.sequentialGenerator.editChapter({
					chapterText: modeState.microEdit.selectedPassage,
					editInstructions: modeState.microEdit.grievances
				});
			} else {
				new Notice('Relay generation is currently only available for Chapter and Micro-Edit modes.');
			}
		} catch (err: any) {
			const msg = err?.message || String(err);
			setError(msg);
			setIsGenerating(false);
			new Notice(`Generation error: ${msg}`);
		}
	};

	const handleUndo = (paraId: string) => {
		const stack = undoStack.get(paraId) || [];
		if (stack.length === 0) return;

		const last = stack.pop()!;
		setUndoStack(new Map(undoStack).set(paraId, stack));

		setGeneratedParagraphs(prev => {
			const next = prev.map(p => {
				if (p.id === paraId) {
					return {
						...p,
						text: last.text,
						hash: last.beforeHash,
						lastPatched: undefined
					};
				}
				return p;
			});
			setGeneratedText(next.map(p => p.text).join('\n\n'));
			return next;
		});
	};

	const handleCharacterUpdate = async () => {
		const text = characterInputText.trim();
		if (!text) {
			new Notice('Please paste text to extract characters from.');
			return;
		}

		setIsExtractingCharacters(true);
		setExtractionProgress('Extracting characters...');

		try {
			const updates = await plugin.characterUpdateService.extractFromText(text);
			if (updates.length === 0) {
				new Notice('No character information found in the text.');
			} else {
				await plugin.characterUpdateService.commitUpdates(updates);
				new Notice(`Updated ${updates.length} character note(s).`);
			}
		} catch (err: any) {
			new Notice(`Character extraction failed: ${err.message || err}`);
			console.error('[CharacterUpdate] Error:', err);
		} finally {
			setIsExtractingCharacters(false);
			setExtractionProgress('');
		}
	};

	const handleProcessEntireBook = async () => {
		if (!characterSourceFile) {
			new Notice('Please select a source file first.');
			return;
		}

		setIsExtractingCharacters(true);

		try {
			const result = await plugin.characterUpdateService.processEntireBook(
				characterSourceFile,
				(msg) => setExtractionProgress(msg)
			);

			await plugin.characterUpdateService.commitUpdates(result.updates);
			new Notice(`Processed ${result.chaptersProcessed} chapters. Updated ${result.updates.length} character(s).`);
		} catch (err: any) {
			new Notice(`Bulk processing failed: ${err.message || err}`);
			console.error('[CharacterUpdate] Bulk error:', err);
		} finally {
			setIsExtractingCharacters(false);
			setExtractionProgress('');
		}
	};

	const handleSelectCharacterFile = () => {
		new FileTreePickerModal(plugin, {
			title: 'Select source file for character extraction',
			currentPath: characterSourceFile,
			onPick: async (path) => {
				setCharacterSourceFile(path);
				plugin.settings.characterExtractionSourcePath = path;
				await plugin.saveSettings();
			}
		}).open();
	};

	const handleResetToBookMain = async () => {
		setCharacterSourceFile(plugin.settings.book2Path);
		plugin.settings.characterExtractionSourcePath = plugin.settings.book2Path;
		await plugin.saveSettings();
	};

	const handleGeneratedChange = (value: string) => {
		setGeneratedText(value);
		setGeneratedParagraphs(prev => prev.map(p => ({ ...p, status: 'USER_DIRTY' as const })));
	};

	const handleSpontaneityChange = (val: number) => {
		setSpontaneity(val);
		(plugin.settings as any).spontaneitySlider = val;
		plugin.saveSettings();
	};

	const handleMismatchProceed = () => {
		setMismatchReport(null);
		new Notice('Proceeding in Best-Effort mode...');
	};

	/** Parse a numbered list from AI output — works incrementally while streaming. */
	const parseSuggestions = (text: string): string[] => {
		const result: string[] = [];
		let current = '';
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (/^\d+[\.\)]/.test(trimmed)) {
				if (current.trim()) result.push(current.trim());
				current = trimmed.replace(/^\d+[\.\)]\s*/, '');
			} else if (current) {
				current += ' ' + trimmed;
			}
		}
		if (current.trim()) result.push(current.trim());
		return result;
	};

	const handleGetSuggestions = async () => {
		setIsSuggestingDirections(true);
		setSuggestions([]);
		setSuggestionsOpen(true);
		try {
			// Read the last ~1500 words of the active manuscript
			const content = await plugin.vaultService.readFile(plugin.settings.book2Path).catch(() => '');
			const words = content.trim().split(/\s+/);
			const tail = words.slice(-1500).join(' ');

			// Read the story bible for tone and world grounding
			const bible = await plugin.vaultService.readFile(plugin.settings.storyBiblePath).catch(() => '');

			const prompt = plugin.promptEngine.buildDirectionSuggestionsPrompt(tail, bible);

			await plugin.aiClient.generateStream(
				prompt,
				{ ...plugin.settings, generationMode: 'single' as const },
				(accumulated) => {
					setSuggestions(parseSuggestions(accumulated));
				}
			);
		} catch (err: any) {
			new Notice(`Suggestions failed: ${err.message}`);
		} finally {
			setIsSuggestingDirections(false);
		}
	};

	return (
		<div className="writing-dashboard">
			<div className="dashboard-tabs">
				<button
					className={activeTab === 'editor' ? 'active' : ''}
					onClick={() => { setActiveTab('editor'); setShowAdvancedMenu(false); }}
				>
					Editor
				</button>
				<div className="advanced-dropdown-wrapper">
					<button
						className={`advanced-dropdown-trigger ${(['lore', 'replay', 'characters'] as const).includes(activeTab as any) ? 'active' : ''}`}
						onClick={() => setShowAdvancedMenu(v => !v)}
					>
						⚙ Advanced {showAdvancedMenu ? '▲' : '▾'}
					</button>
					{showAdvancedMenu && (
						<div className="advanced-dropdown-menu">
							<button onClick={() => { setActiveTab('lore'); setShowAdvancedMenu(false); }}>
								🔍 Lore Inspector
							</button>
							<button onClick={() => { setActiveTab('replay'); setShowAdvancedMenu(false); }}>
								🔄 Replay History
							</button>
							<button onClick={() => { setActiveTab('characters'); setShowAdvancedMenu(false); }}>
								👤 Characters
							</button>
						</div>
					)}
				</div>
			</div>

			<div className="dashboard-layout">
				<div className="main-workspace">
					<div className="tab-content-wrapper" style={{ flex: '1 1 auto', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
						{activeTab === 'editor' && (
							<EditorPanel
								plugin={plugin}
								mode={mode}
								selectedText={modeState.chapter.sceneSummary}
								onSelectionChange={updateMainInput}
								generatedText={generatedText}
								generatedParagraphs={generatedParagraphs}
								heatmapEnabled={heatmapEnabled}
								onGeneratedChange={handleGeneratedChange}
								onCopy={() => navigator.clipboard.writeText(generatedText)}
								onUndo={handleUndo}
								chunkBuffer={chunkBuffer}
								suggestions={suggestions}
								isSuggestingDirections={isSuggestingDirections}
								suggestionsOpen={suggestionsOpen}
								onToggleSuggestions={() => setSuggestionsOpen(v => !v)}
								onGetSuggestions={handleGetSuggestions}
								onUseSuggestion={(text) => {
									updateMainInput(text);
									setSuggestionsOpen(false);
								}}
							/>
						)}

						{activeTab === 'lore' && (
							<div className="lore-tab">
								<FactInspector
									plugin={plugin}
									state={plugin.sequentialGenerator.getContextManager()?.getState() || {
										chapterId: 'temp',
										canonVersion: 1,
										schemaVersion: 1,
										entities: [],
										canonFacts: [],
										mutationHistory: [],
										pendingMutations: [],
										entity_redirects: {},
										redirectRegistryVersion: 0,
										timeline: [],
										openLoops: [],
										constraints: { pov: 'third', tense: 'past', tone: [], forbidden: [] }
									}}
								/>
								<PilotHealthPanel
									plugin={plugin}
									misses={misses}
									rejections={rejections}
									quarantineCount={0}
								/>
							</div>
						)}

						{activeTab === 'replay' && (
							<div className="replay-tab">
								<ReplayPanel plugin={plugin} />
							</div>
						)}

						{activeTab === 'characters' && (
							<div className="characters-tab">
								<div className="editor-section">
									<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
										<label>Paste narrative text for character extraction:</label>
										<span className="generation-status" style={{ margin: 0 }}>
											{TextChunker.getWordCount(characterInputText).toLocaleString()} words / {characterInputText.length.toLocaleString()} chars
										</span>
									</div>
									<textarea
										value={characterInputText}
										onChange={(e) => setCharacterInputText(e.target.value)}
										placeholder="Paste a scene, chapter, or any narrative text containing character dialogue and descriptions..."
										rows={12}
										className="editor-textarea"
									/>
								</div>

								<div className="character-update-controls">
									<button
										onClick={handleCharacterUpdate}
										disabled={isExtractingCharacters || !characterInputText.trim()}
										className="generate-button mod-cta"
									>
										{isExtractingCharacters ? 'Extracting...' : 'Update Characters'}
									</button>

									<div className="file-selection-row">
										<span className="file-label">
											Source file: {characterSourceFile?.split('/').pop() || 'None selected'}
										</span>
										<button onClick={handleSelectCharacterFile} disabled={isExtractingCharacters}>
											Select file
										</button>
										<button onClick={handleResetToBookMain} disabled={isExtractingCharacters}>
											Use book main
										</button>
									</div>

									<button
										onClick={handleProcessEntireBook}
										disabled={isExtractingCharacters || !characterSourceFile}
										className="generate-button"
									>
										{isExtractingCharacters ? extractionProgress : 'Process Entire Book'}
									</button>
								</div>

								<div className="character-help-text">
									<p><strong>Update Characters:</strong> Extracts character info from the text above and updates notes in your Characters folder.</p>
									<p><strong>Process Entire Book:</strong> 2-pass extraction (roster + per-chapter) from the selected file.</p>
								</div>
							</div>
						)}
					</div>

					{isGenerating && (
						<div className="generation-status-overlay">
							<div className="loader">⏳</div>
							<div className="stage">{generationStage}</div>
							{chunkBuffer && (
								<div className={`buffer-preview ${heatmapEnabled ? 'heatmap' : ''}`}>
									{chunkBuffer.split('\n').map((p, i) => {
										const isSpeculative = p.length % 2 === 0;
										return (
											<p key={`chunk-${i}`} className={isSpeculative ? 'speculative' : 'grounded'}>
												{p}
											</p>
										);
									})}
								</div>
							)}
						</div>
					)}

					{proposedMutation && (
						<div className="mutation-modal">
							<h3>Lore Mutation Proposal</h3>
							<p>{proposedMutation.message}</p>
							<div className="actions">
								<button onClick={() => setProposedMutation(null)}>Reject</button>
								<button onClick={() => setProposedMutation(null)}>Defer</button>
								<button className="mod-cta" onClick={() => setProposedMutation(null)}>Accept & Version Canon</button>
							</div>
						</div>
					)}

					{trustSummary && (
						<div className="trust-summary-banner">
							<span>Grounding: <strong>{trustSummary.grounding}</strong></span>
							<span>Lore: <strong>{trustSummary.loreStatus}</strong></span>
							<span>Canon Version: <strong>{trustSummary.version}</strong></span>
							{trustSummary.replayable && <span className="verified">✓ Replayable</span>}
						</div>
					)}

					{mismatchReport && (
						<div className="mismatch-report-banner">
							<h3>⚠️ Strict Replay Mismatch</h3>
							{mismatchReport.map((m) => (
								<p key={`${m.field}-${m.expected}`}><strong>{m.field}:</strong> Expected "{m.expected.slice(0, 8)}", Got "{m.actual.slice(0, 8)}" ({m.severity})</p>
							))}
							<div className="actions">
								<button onClick={() => setMismatchReport(null)}>Cancel Replay</button>
								<button className="mod-cta" onClick={handleMismatchProceed}>Proceed Creative (Best-Effort)</button>
							</div>
						</div>
					)}

					<div className="controls">
						<div className="spontaneity-control" style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
							<div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8em' }}>
								<span>Faithful</span>
								<span>Spontaneity: {spontaneity}</span>
								<span>Wild</span>
							</div>
							<input
								type="range"
								min="0"
								max="100"
								value={spontaneity}
								onChange={(e) => handleSpontaneityChange(Number.parseInt(e.target.value, 10))}
								className="spontaneity-slider"
								title="Adjusts LLM temperature and novelty bias."
							/>
						</div>

						<button
							onClick={handleGenerate}
							disabled={isGenerating}
							className="generate-button mod-cta"
						>
							{isGenerating ? 'Generating...' : 'Generate'}
						</button>

						{!isGenerating && generatedText && (
							<button onClick={() => setShowModal(true)} className="generate-button insert-button">
								↗ Review output
							</button>
						)}

						<button
							onClick={() => setHeatmapEnabled(!heatmapEnabled)}
							className={`heatmap-toggle ${heatmapEnabled ? 'active' : ''}`}
						>
							{heatmapEnabled ? 'Hide Heatmap' : 'Show Heatmap'}
						</button>

						{isGenerating && (
							<button onClick={() => plugin.sequentialGenerator.abort()} className="abort-button">
								Abort
							</button>
						)}
					</div>

					{isGenerating && pulseMessage && (
						<div className="continuity-pulse-container">
							<div className="pulse-message">
								<span className="pulse-icon">⚛️</span>
								<strong>{pulseMessage}</strong>
							</div>
							{pulseDetail && <div className="pulse-detail">{pulseDetail}</div>}
							<div className="pulse-progress-bar">
								<div className="pulse-progress-fill" />
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Generation popup — opens automatically when a run starts */}
			{showModal && (
				<GenerationModal
					isGenerating={isGenerating}
					generationStage={generationStage}
					chunkBuffer={chunkBuffer}
					generatedText={generatedText}
					error={error}
					plugin={plugin}
					onApprove={handleInsert}
					onPushReviewed={handleInsertReviewed}
					onDiscard={handleDiscard}
					onAbort={() => { plugin.sequentialGenerator.abort(); }}
				/>
			)}
		</div>
	);
};
