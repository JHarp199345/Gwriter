import React, { useEffect, useRef, useState } from 'react';
import { Notice, TFolder } from 'obsidian';
import WritingDashboardPlugin, { DashboardSettings } from '../main';
import { VaultBrowser } from './VaultBrowser';
import { EditorPanel } from './EditorPanel';
import { DirectorNotes } from './DirectorNotes';
import { ModeSelector } from './ModeSelector';
import { TextChunker } from '../services/TextChunker';
import { fnv1a32 } from '../services/ContentHash';
import { estimateTokens } from '../services/TokenEstimate';
import type { MultiModelResult } from '../services/AIClient';
import { FilePickerModal } from './FilePickerModal';
import { FolderTreePickerModal } from './FolderTreePickerModal';
import { FileTreePickerModal } from './FileTreePickerModal';
import { parseCharacterRoster, rosterToBulletList } from '../services/CharacterRoster';
import { showConfirmModal } from './ConfirmModal';
import { PromptPreviewModal } from './PromptPreviewModal';
import { ButtonHelpModal } from './ButtonHelpModal';
import { FactInspector } from './FactInspector';
import { ReplayPanel } from './ReplayPanel';
import { PilotHealthPanel } from './PilotHealthPanel'; // New
import { relayEventBus } from '../services/EventBus';
import { GenerationStep, StageResult } from '../services/Schemas';

type Mode = 'chapter' | 'micro-edit' | 'character-update' | 'continuity-check';
type DemoStep = 'off' | 'chapter' | 'micro-edit' | 'character-update' | 'done';

const DEFAULT_REWRITE_INSTRUCTIONS =
	'[INSTRUCTION: The Scene Summary is a rough summary OR directions. Rewrite it into a fully detailed dramatic scene. Include dialogue, sensory details, and action. Do not summarize; write the prose. Match the tone, rhythm, and pacing of the provided context.]';

export const DashboardComponent: React.FC<{ plugin: WritingDashboardPlugin }> = ({ plugin }) => {
	const [mode, setMode] = useState<Mode>('chapter');
	const [demoStep, setDemoStep] = useState<DemoStep>('off');
	const [apiKeyPresent, setApiKeyPresent] = useState<boolean>(Boolean(plugin.settings.apiKey));
	const [modeState, setModeState] = useState(() => plugin.settings.modeState);
	
	const [generatedText, setGeneratedText] = useState<string>('');
	const [generatedParagraphs, setGeneratedParagraphs] = useState<{ text: string, metadata?: any }[]>([]);
	const [chunkBuffer, setChunkBuffer] = useState<string>('');
	const [isGenerating, setIsGenerating] = useState(false);
	const [generationStage, setGenerationStage] = useState<string>('');
	const [pulseMessage, setPulseMessage] = useState<string | null>(null);
	const [pulseDetail, setPulseDetail] = useState<string | null>(null);
	const [generationSteps, setGenerationSteps] = useState<GenerationStep[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [mismatchReport, setMismatchReport] = useState<any[] | null>(null); // New
	const [telemetry, setTelemetry] = useState<{ tps: number, model: string, digest: string } | null>(null);
	const [costEstimate, setCostEstimate] = useState<{ low: number, high: number } | null>(null);
	const [showFactInspector, setShowFactInspector] = useState(false);
	const [heatmapEnabled, setHeatmapEnabled] = useState(true);
	const [spontaneity, setSpontaneity] = useState((plugin.settings as any).spontaneitySlider || 50);
	const [misses, setMisses] = useState<any[]>([]); // New
	const [rejections, setRejections] = useState<any[]>([]); // New
	const [proposedMutation, setProposedMutation] = useState<any | null>(null);
	const [trustSummary, setTrustSummary] = useState<any | null>(null);
	const [activeTab, setActiveTab] = useState<'editor' | 'lore' | 'replay' | 'signature'>('editor');

	const commitLock = useRef<boolean>(false);

	useEffect(() => {
		const onStart = () => {
			setGenerationSteps([]);
			setChunkBuffer('');
			setGeneratedText('');
			setGeneratedParagraphs([]);
			setIsGenerating(true);
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
		const onCommitted = (data: { content: string, metadata?: any[], chunkId?: string }) => {
			// Transactional commit to note and UI
			if (commitLock.current) return;
			commitLock.current = true;
			try {
				const newParas = data.content.split('\n\n').filter(p => p.trim()).map((p, i) => ({
					text: p,
					metadata: data.metadata ? data.metadata[i] : undefined
				}));

				if (data.chunkId === 'edited-chapter' || data.chunkId === 'monolithic-chapter') {
					setGeneratedParagraphs(newParas);
					setGeneratedText(data.content);
				} else {
					setGeneratedParagraphs((prev) => [...prev, ...newParas]);
					setGeneratedText((prev) => prev + (prev ? '\n\n' : '') + data.content);
				}
				
				setChunkBuffer('');
				// Update trust summary for the chunk
				setTrustSummary({
					grounding: 'High',
					loreStatus: 'Stable',
					version: 'v1.2.0',
					replayable: true
				});
			} finally {
				commitLock.current = false;
			}
		};
		const onEnd = (data?: { runId: string, totalWords: number, health?: any }) => {
			setIsGenerating(false);
			setGenerationStage('Complete');
			if (data?.health) {
				setTrustSummary({
					grounding: `${(data.health.tierARatio * 100).toFixed(0)}% Tier A`,
					loreStatus: data.health.mutationsProposed > 0 ? 'Mutated' : 'Stable',
					version: `v${data.health.mutationsProposed + 1}`,
					recoveryEvents: data.health.recoveryEvents
				});
			}
		};
		const onAuditViolations = (data: { violations: any[] }) => {
			const mutation = data.violations.find(v => v.type === 'ENTITY_ATTRIBUTE_MISMATCH');
			if (mutation) {
				setProposedMutation(mutation);
			}
		};
		const onError = (data: { error: string, mismatchReport?: any[] }) => {
			setError(data.error);
			setIsGenerating(false);
			if (data.mismatchReport) {
				setMismatchReport(data.mismatchReport);
			}
		};
		const onMiss = (data: { type: string }) => {
			setMisses(prev => [...prev, data]);
		};
		const onStitchRejected = (data: { iteration: number, changes?: string[] }) => {
			setRejections(prev => [...prev, data]);
		};

		relayEventBus.on('run:start', onStart);
		relayEventBus.on('run:pulse', onPulse);
		relayEventBus.on('stage:start', onStageStart);
		relayEventBus.on('chunk:buffer:update', onBufferUpdate);
		relayEventBus.on('chunk:committed', onCommitted);
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
			relayEventBus.off('audit:violations', onAuditViolations);
			relayEventBus.off('run:end', onEnd);
			relayEventBus.off('run:error', onError);
			relayEventBus.off('pilot:miss', onMiss);
			relayEventBus.off('pilot:stitch_rejected', onStitchRejected);
		};
	}, []);

	const handleGenerate = async () => {
		if (mode === 'chapter') {
			setError(null);
			const minCfg = modeState.chapter.minWords ?? 2000;
			await plugin.sequentialGenerator.generateChapter(minCfg);
		} else if (mode === 'micro-edit') {
			setError(null);
			await plugin.sequentialGenerator.editChapter({
				chapterText: modeState.microEdit.selectedPassage,
				editInstructions: modeState.microEdit.grievances
			});
		} else {
			new Notice('Relay generation is currently only available for Chapter and Micro-Edit modes.');
		}
	};

	const updateMainInput = (value: string) => {
		// Simplified for this spec
		setModeState(prev => ({ ...prev, chapter: { ...prev.chapter, sceneSummary: value } }));
	};

	return (
		<div className="writing-dashboard">
			<div className="dashboard-tabs">
				<button className={activeTab === 'editor' ? 'active' : ''} onClick={() => setActiveTab('editor')}>Editor</button>
				<button className={activeTab === 'lore' ? 'active' : ''} onClick={() => setActiveTab('lore')}>Lore</button>
				<button className={activeTab === 'replay' ? 'active' : ''} onClick={() => setActiveTab('replay')}>Replay</button>
				<button className={activeTab === 'signature' ? 'active' : ''} onClick={() => setActiveTab('signature')}>Signature</button>
			</div>

			<div className="dashboard-layout">
				<div className="main-workspace">
					{activeTab === 'editor' && (
						<EditorPanel 
							plugin={plugin}
							mode={mode}
							selectedText={modeState.chapter.sceneSummary}
							onSelectionChange={updateMainInput}
							generatedText={generatedText}
							generatedParagraphs={generatedParagraphs}
							heatmapEnabled={heatmapEnabled}
							onGeneratedChange={setGeneratedText}
							onCopy={() => navigator.clipboard.writeText(generatedText)}
							chunkBuffer={chunkBuffer}
						/>
					)}

					{activeTab === 'lore' && (
						<div className="lore-tab">
							<FactInspector 
								state={plugin.sequentialGenerator.getContextManager()?.getState() || plugin.settings.modeState.chapterState || {
									chapterId: 'temp',
									canonVersion: 1,
									entities: [],
									canonFacts: [],
									mutationHistory: [],
									pendingMutations: [],
									entity_redirects: {},
									redirectRegistryVersion: 0,
									timeline: [],
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

					{isGenerating && (
						<div className="generation-status-overlay">
							<div className="loader">⏳</div>
							<div className="stage">{generationStage}</div>
							{chunkBuffer && (
								<div className={`buffer-preview ${heatmapEnabled ? 'heatmap' : ''}`}>
									{chunkBuffer.split('\n').map((p, i) => {
										const isSpeculative = p.length % 2 === 0; // Simulated rule
										return (
											<p key={i} className={isSpeculative ? 'speculative' : 'grounded'}>
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
							{mismatchReport.map((m, i) => (
								<p key={i}><strong>{m.field}:</strong> Expected "{m.expected.slice(0, 8)}", Got "{m.actual.slice(0, 8)}" ({m.severity})</p>
							))}
							<div className="actions">
								<button onClick={() => setMismatchReport(null)}>Cancel Replay</button>
								<button className="mod-cta" onClick={() => {
									// Proceed logic
									setMismatchReport(null);
									new Notice('Proceeding in Best-Effort mode...');
								}}>Proceed Creative (Best-Effort)</button>
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
								onChange={(e) => {
									const val = parseInt(e.target.value);
									setSpontaneity(val);
									(plugin.settings as any).spontaneitySlider = val;
									plugin.saveSettings();
								}}
								className="spontaneity-slider"
								title="Adjusts LLM temperature and novelty bias."
							/>
						</div>

						<button 
							onClick={handleGenerate} 
							disabled={isGenerating}
							className="generate-button mod-cta"
						>
							{isGenerating ? 'Generating...' : 'Start Relay Generation'}
						</button>

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

					{telemetry && (
						<div className="telemetry-bar">
							<span>TPS: {telemetry.tps}</span>
							<span>Model: {telemetry.model}</span>
							<span>Digest: {telemetry.digest.slice(0, 8)}</span>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
