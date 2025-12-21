import React, { useEffect, useState } from 'react';
import { Notice } from 'obsidian';
import WritingDashboardPlugin, { DashboardSettings } from '../main';
import { VaultBrowser } from './VaultBrowser';
import { EditorPanel } from './EditorPanel';
import { DirectorNotes } from './DirectorNotes';
import { ModeSelector } from './ModeSelector';
import { TextChunker } from '../services/TextChunker';
import { fnv1a32 } from '../services/ContentHash';
import { estimateTokens } from '../services/TokenEstimate';
import { FilePickerModal } from './FilePickerModal';
import { parseCharacterRoster, rosterToBulletList } from '../services/CharacterRoster';
import { showConfirmModal } from './ConfirmModal';

type Mode = 'chapter' | 'micro-edit' | 'character-update';
type DemoStep = 'off' | 'chapter' | 'micro-edit' | 'character-update' | 'done';

const DEFAULT_REWRITE_INSTRUCTIONS =
	'[INSTRUCTION: The Scene Summary is a rough summary OR directions. Rewrite it into a fully detailed dramatic scene. Include dialogue, sensory details, and action. Do not summarize; write the prose. Match the tone, rhythm, and pacing of the provided context.]';

export const DashboardComponent: React.FC<{ plugin: WritingDashboardPlugin }> = ({ plugin }) => {
	const formatUnknownForUi = (value: unknown): string => {
		if (value instanceof Error) return value.message;
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
		if (typeof value === 'bigint') return 'bigint';
		if (value === null) return 'null';
		if (value === undefined) return 'undefined';
		try {
			return JSON.stringify(value);
		} catch {
			return '[unserializable value]';
		}
	};

	type SingleSettings = Omit<DashboardSettings, 'generationMode'> & { generationMode: 'single' };
	type MultiSettings = Omit<DashboardSettings, 'generationMode'> & { generationMode: 'multi' };

	const [mode, setMode] = useState<Mode>('chapter');
	const [demoStep, setDemoStep] = useState<DemoStep>('off');
	const [apiKeyPresent, setApiKeyPresent] = useState<boolean>(Boolean(plugin.settings.apiKey));
	const [demoStepCompleted, setDemoStepCompleted] = useState<Record<Exclude<DemoStep, 'off'>, boolean>>({
		chapter: false,
		'micro-edit': false,
		'character-update': false,
		done: false
	});
	const [isVaultPanelCollapsed, setIsVaultPanelCollapsed] = useState<boolean>(() => {
		try {
			return window.localStorage.getItem('writing-dashboard:vaultPanelCollapsed') === '1';
		} catch {
			return false;
		}
	});
	const [selectedText, setSelectedText] = useState('');
	const [directorNotes, setDirectorNotes] = useState('');
	const [minWords, setMinWords] = useState(2000);
	const [maxWords, setMaxWords] = useState(6000);
	// Keep a string buffer so users can clear/edit the number inputs naturally.
	// We clamp/commit to numeric state on blur/Enter.
	const [minWordsInput, setMinWordsInput] = useState<string>('2000');
	const [maxWordsInput, setMaxWordsInput] = useState<string>('6000');
	const [generatedText, setGeneratedText] = useState('');
	const [isGenerating, setIsGenerating] = useState(false);
	const [generationStage, setGenerationStage] = useState<string>('');
	const [error, setError] = useState<string | null>(null);
	const [promptTokenEstimate, setPromptTokenEstimate] = useState<number | null>(null);
	const [promptCharCount, setPromptCharCount] = useState<number | null>(null);
	const [retrievedContextStats, setRetrievedContextStats] = useState<{ items: number; tokens: number } | null>(null);
	const [indexStatusText, setIndexStatusText] = useState<string>(() => {
		if (!plugin.settings.retrievalEnableSemanticIndex) return 'Semantic retrieval: Off';
		const status = plugin.embeddingsIndex?.getStatus?.();
		if (!status) return 'Semantic retrieval: Starting…';
		if (status.paused) return `Index: Paused (${status.indexedFiles} file(s), ${status.indexedChunks} chunk(s))`;
		if (status.queued > 0) return `Index: Building (${status.queued} queued, ${status.indexedChunks} chunk(s))`;
		return `Index: Up to date (${status.indexedFiles} file(s), ${status.indexedChunks} chunk(s))`;
	});
	const [bulkSourcePath, setBulkSourcePath] = useState<string | undefined>(
		plugin.settings.characterExtractionSourcePath
	);

	const DEMO_FOLDER = 'Writing dashboard demo';
	const DEMO_CHARACTER_FOLDER = `${DEMO_FOLDER}/Characters`;
	const DEMO_CHAPTER_OUTPUT =
		`Ava kept to the seam of shadow where the alley met the service corridor, ` +
		`the city’s night noise dulled by concrete and distance. The corporate tower rose ` +
		`above her like a blackened ribcage, windows lit in irregular bands as though the ` +
		`building itself was breathing.\n\n` +
		`Marcus slid in beside her with the careless ease of someone who’d never been caught. ` +
		`He smelled faintly of rain and cheap coffee. “We’re late,” he whispered.\n\n` +
		`“We’re early,” Ava corrected. She watched the security camera complete its slow pan, ` +
		`then pause, then pan again. The rhythm mattered. Everything did. “If we rush, we miss the blind spot.”\n\n` +
		`Marcus’s mouth twitched. “Or we miss the keycard walking right past us. I told you. ` +
		`We grab it off the intern. Quick, clean.”\n\n` +
		`Ava flexed her gloved fingers around the thin coil of line in her pocket. She didn’t look at him. ` +
		`“And then what? You sprint down a hallway with a tower full of sensors tracking your heartbeat?”\n\n` +
		`“I’ve sprinted through worse.”\n\n` +
		`“You’ve survived worse,” Ava said, “because you got lucky.”\n\n` +
		`The corridor door ahead had a keypad and a reader. The stolen card would open it. ` +
		`Her stolen card. A small rectangle of plastic that held too much: access to archives, ` +
		`to names, to proof. She could feel it like a phantom weight in her palm.\n\n` +
		`Footsteps approached—soft, measured. Ava drew Marcus back with two fingers to his sleeve. ` +
		`They pressed into the alcove as a security guard passed, head tilted toward the earpiece wire ` +
		`threaded behind his ear.\n\n` +
		`“Rotation’s off,” Marcus breathed once the guard was gone. “They’re nervous.”\n\n` +
		`Ava’s gaze snagged on a faint glimmer near the reader: a strip of reflective tape, almost invisible. ` +
		`A marker. Not theirs. She swallowed. “Someone’s already here.”\n\n` +
		`Marcus leaned closer. “Or someone was.”\n\n` +
		`Ava’s heart kicked once, hard. She lifted her hand to the keypad—then froze. ` +
		`Behind the tinted glass of the corridor door, a phone screen lit for a second and went dark.\n\n` +
		`A message, no sender, no notification sound.\n\n` +
		`JUST THIS: “AVA, DON’T.”`;

	const DEMO_MICRO_EDIT_OUTPUT =
		`Ava kept to the seam of shadow where the alley met the service corridor, ` +
		`tracking the camera’s sweep like a metronome. Pan. Pause. Pan. The blind spot lived in the pause.\n\n` +
		`Marcus drifted in beside her, too relaxed for a man who should’ve been afraid. “We’re late,” he whispered.\n\n` +
		`“We’re early,” Ava said. She didn’t take her eyes off the lens. “Early keeps you alive.”\n\n` +
		`His breath hitched into something like a laugh. “Or it keeps you standing here while the keycard walks away.”\n\n` +
		`Ava’s fingers tightened around the coil of line in her pocket. “We do this my way. Quiet. Controlled. ` +
		`No hero runs.”\n\n` +
		`“I’m not a hero,” Marcus murmured. “I’m just fast.”\n\n` +
		`“Fast gets noticed.” Ava waited for the lens to turn, then moved—one step, two—into the thin slice of safety.\n\n` +
		`The corridor door waited with its keypad and reader, the place her stolen card would’ve belonged. ` +
		`A small piece of plastic that could unlock a vault of truths.\n\n` +
		`Footsteps approached. Ava snagged Marcus by his sleeve and pulled him into the alcove. ` +
		`A security guard passed, eyes forward, earwire gleaming.\n\n` +
		`When the sound faded, Marcus leaned in. “Rotation’s off,” he said. “They’re spooked.”\n\n` +
		`Ava stared at the reader and felt cold spread under her ribs. A sliver of reflective tape—too neat, too deliberate—` +
		`clung near the sensor. Not theirs.\n\n` +
		`“Someone’s already here,” she whispered.\n\n` +
		`Marcus’s voice dropped. “Or someone was.”`;

	const DEMO_CHARACTER_EXTRACTION_OUTPUT =
		`## Ava\n` +
		`- Highly cautious and methodical; tracks security camera rhythm and uses timing to avoid detection.\n` +
		`- Motivated by retrieving a stolen keycard tied to access, proof, and high-stakes information.\n` +
		`- Emotionally controlled under pressure; shows fear as tight focus rather than panic.\n` +
		`- Prioritizes stealth and control over speed; distrusts “luck” as a strategy.\n\n` +
		`## Marcus\n` +
		`- Pushes for riskier, faster action; prefers direct moves over careful planning.\n` +
		`- Confident and calm in danger; downplays fear and frames risk as survivable.\n` +
		`- Tension with Ava: he challenges her caution; she asserts leadership and constraints.\n`;

	const openPluginSettings = () => {
		// Obsidian's settings API isn't strongly typed in the public types; use defensive access.
		const setting = (plugin.app as unknown as { setting?: unknown }).setting as
			| { open?: () => void; openTabById?: (id: string) => void }
			| undefined;
		try {
			setting?.open?.();
			setting?.openTabById?.('writing-dashboard');
		} catch {
			new Notice('Open settings → writing dashboard to configure your API key.');
		}
	};

	const openPublishWizard = () => {
		try {
			plugin.showPublishWizard();
		} catch {
			new Notice('Unable to open the publishing wizard.');
		}
	};

	const isGuidedDemoActive = demoStep !== 'off' && demoStep !== 'done';
	const canUseAiInDemo = apiKeyPresent;

	const clampWords = (raw: string, fallback: number): number => {
		const parsed = parseInt(raw, 10);
		if (!Number.isFinite(parsed)) return fallback;
		return Math.max(100, Math.min(2_000_000, parsed));
	};

	const startGuidedDemo = () => {
		// Mark as shown so we don't auto-start repeatedly for the same vault.
		if (!plugin.settings.guidedDemoShownOnce) {
			plugin.settings.guidedDemoShownOnce = true;
			void plugin.saveSettings();
		}

		// Reset UI state
		setError(null);
		setPromptTokenEstimate(null);
		setPromptCharCount(null);
		setGenerationStage('');
		setGeneratedText('');

		// Smaller range to keep demo fast/cheap
		setMinWords(800);
		setMaxWords(1200);
		setMinWordsInput('800');
		setMaxWordsInput('1200');

		// Step 1: chapter generate
		setMode('chapter');
		setSelectedText(
			[
				'Write a tense, character-driven scene set at night in a quiet city.',
				'Include two named characters: Ava (the protagonist) and Marcus (an uneasy ally).',
				'Ava is trying to recover a stolen keycard without alerting security.',
				'Marcus pushes for a riskier plan; Ava stays cautious.',
				'End with a cliffhanger discovery (a hidden message or unexpected witness).'
			].join('\n')
		);
		setDirectorNotes(DEFAULT_REWRITE_INSTRUCTIONS);

		setDemoStep('chapter');
		setDemoStepCompleted({
			chapter: false,
			'micro-edit': false,
			'character-update': false,
			done: false
		});

		new Notice(
			plugin.settings.apiKey
				? 'Guided demo started. This will only generate demo text.'
				: 'Guided demo started in offline mode (no API key).'
		);
	};

	// Keep input buffers in sync when numeric values change (e.g., demo start)
	useEffect(() => {
		setMinWordsInput(String(minWords));
	}, [minWords]);

	useEffect(() => {
		setMaxWordsInput(String(maxWords));
	}, [maxWords]);

	// Poll index status while the dashboard is open (cheap + reliable).
	useEffect(() => {
		const update = () => {
			try {
				if (!plugin.settings.retrievalEnableSemanticIndex) {
					setIndexStatusText('Semantic retrieval: Off');
					return;
				}
				const status = plugin.embeddingsIndex?.getStatus?.();
				if (!status) {
					setIndexStatusText('Semantic retrieval: Starting…');
					return;
				}
				if (status.paused) {
					setIndexStatusText(`Index: Paused (${status.indexedFiles} file(s), ${status.indexedChunks} chunk(s))`);
					return;
				}
				if (status.queued > 0) {
					setIndexStatusText(`Index: Building (${status.queued} queued, ${status.indexedChunks} chunk(s))`);
					return;
				}
				setIndexStatusText(`Index: Up to date (${status.indexedFiles} file(s), ${status.indexedChunks} chunk(s))`);
			} catch {
				setIndexStatusText('Semantic retrieval: Unavailable');
			}
		};

		update();
		const id = window.setInterval(update, 2000);
		return () => window.clearInterval(id);
	}, [plugin]);

	const exitGuidedDemo = () => {
		setDemoStep('off');
		setDemoStepCompleted({
			chapter: false,
			'micro-edit': false,
			'character-update': false,
			done: false
		});
		new Notice('Guided demo exited.');
	};

	const skipGuidedDemo = () => {
		plugin.settings.guidedDemoDismissed = true;
		plugin.settings.guidedDemoShownOnce = true;
		void plugin.saveSettings();
		exitGuidedDemo();
		new Notice('Guided demo skipped.');
	};

	const continueGuidedDemo = () => {
		if (demoStep === 'chapter') {
			// Step 2: micro edit (uses generated output excerpt)
			const excerpt = (generatedText || '').slice(0, 1200).trim();
			setMode('micro-edit');
			setSelectedText(
				excerpt.length > 0
					? excerpt
					: 'Paste a paragraph here, then click Generate edit.'
			);
			setDemoStep('micro-edit');
			return;
		}

		if (demoStep === 'micro-edit') {
			// Step 3: character update (uses latest output excerpt)
			const excerpt = (generatedText || '').slice(0, 1500).trim();
			setMode('character-update');
			setSelectedText(
				excerpt.length > 0
					? excerpt
					: 'Paste character-relevant text here, then click Update characters.'
			);
			setDemoStep('character-update');
			return;
		}

		if (demoStep === 'character-update') {
			setDemoStep('done');
			setDemoStepCompleted((prev) => ({ ...prev, done: true }));
			// Don't auto-start again once the user completed the demo.
			if (!plugin.settings.guidedDemoDismissed) {
				plugin.settings.guidedDemoDismissed = true;
				plugin.settings.guidedDemoShownOnce = true;
				void plugin.saveSettings();
			}
			new Notice(`Guided demo complete. Demo notes are in "${DEMO_FOLDER}/".`);
		}
	};

	// Chapter mode default instructions
	useEffect(() => {
		const trimmed = (directorNotes || '').trim();
		const isBlank = trimmed.length === 0;
		const chapterDefault = DEFAULT_REWRITE_INSTRUCTIONS.trim();
		const characterDefault = (plugin.settings.defaultCharacterExtractionInstructions || '').trim();

		// Two-way overwrite between the two defaults:
		// - entering chapter: if blank OR still the character-update default, set chapter default
		// - entering character-update: if blank OR still the chapter default, set character default
		if (mode === 'chapter') {
			if (isBlank || (characterDefault && trimmed === characterDefault)) {
				setDirectorNotes(DEFAULT_REWRITE_INSTRUCTIONS);
			}
		} else if (mode === 'character-update') {
			if (isBlank || trimmed === chapterDefault) {
				setDirectorNotes(plugin.settings.defaultCharacterExtractionInstructions || '');
			}
		} else if (mode === 'micro-edit') {
			// Always clear so the placeholder guidance is visible.
			setDirectorNotes('');
		}
		// Only run when mode changes (intentional)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: defaults apply only on mode switch
	}, [mode]);

	// Start guided demo if requested by plugin command/settings/wizard
	useEffect(() => {
		const onSettingsChanged = () => {
			setApiKeyPresent(Boolean(plugin.settings.apiKey));
		};

		const onGuidedDemoStart = () => {
			startGuidedDemo();
		};

		window.addEventListener('writing-dashboard:settings-changed', onSettingsChanged as EventListener);
		window.addEventListener('writing-dashboard:guided-demo-start', onGuidedDemoStart as EventListener);

		// Back-compat: if the command was invoked before the dashboard mounted, honor the flag.
		if (plugin.guidedDemoStartRequested) {
			plugin.guidedDemoStartRequested = false;
			startGuidedDemo();
		} else if (!plugin.settings.guidedDemoDismissed && !plugin.settings.guidedDemoShownOnce) {
			// Auto-start demo exactly once (unless dismissed). They can skip.
			startGuidedDemo();
		}

		return () => {
			window.removeEventListener('writing-dashboard:settings-changed', onSettingsChanged as EventListener);
			window.removeEventListener('writing-dashboard:guided-demo-start', onGuidedDemoStart as EventListener);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: mount-only subscription
	}, []);

	// Keep bulk source label in sync when entering character mode (settings changes won't otherwise re-render)
	useEffect(() => {
		if (mode === 'character-update') {
			setBulkSourcePath(plugin.settings.characterExtractionSourcePath);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: sync label only on mode switch
	}, [mode]);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				'writing-dashboard:vaultPanelCollapsed',
				isVaultPanelCollapsed ? '1' : '0'
			);
		} catch {
			// ignore
		}
	}, [isVaultPanelCollapsed]);

	const handleGenerate = async () => {
		// Guided demo can run without an API key (offline canned output).
		// Auto mode:
		// - If API key is present, try AI.
		// - If AI fails (invalid key/quota/network), fall back to offline demo automatically.
		if (!plugin.settings.apiKey && isGuidedDemoActive) {
			setIsGenerating(true);
			setError(null);
			setGenerationStage('Generating (offline demo)...');
			try {
				if (mode === 'chapter') {
					setGeneratedText(DEMO_CHAPTER_OUTPUT);
					setDemoStepCompleted((prev) => ({ ...prev, chapter: true }));
				} else {
					setGeneratedText(DEMO_MICRO_EDIT_OUTPUT);
					setDemoStepCompleted((prev) => ({ ...prev, 'micro-edit': true }));
				}
				setGenerationStage('');
			} finally {
				setIsGenerating(false);
			}
			return;
		}

		if (!plugin.settings.apiKey) {
			setError('Please configure your API key in settings');
			return;
		}

		setIsGenerating(true);
		setError(null);
		setGenerationStage('');
		try {
			let prompt: string;
			let context;

			if (mode === 'chapter') {
				const retrievalQuery = plugin.queryBuilder.build({
					mode: 'chapter',
					activeFilePath: plugin.lastOpenedMarkdownPath ?? plugin.settings.book2Path,
					primaryText: selectedText,
					directorNotes
				});
				context = await plugin.contextAggregator.getChapterContext(retrievalQuery);
				try {
					const retrievedText = (context?.smart_connections || '').toString();
					const items = (retrievedText.match(/^\[\d+\]/gm) || []).length;
					setRetrievedContextStats({ items, tokens: estimateTokens(retrievedText) });
				} catch {
					setRetrievedContextStats(null);
				}
				const min = Math.max(100, Math.min(minWords, maxWords));
				const max = Math.max(100, Math.max(minWords, maxWords));
				prompt = plugin.promptEngine.buildChapterPrompt(
					context,
					directorNotes,
					selectedText,
					min,
					max
				);
			} else {
				// micro-edit
				const retrievalQuery = plugin.queryBuilder.build({
					mode: 'micro-edit',
					activeFilePath: plugin.lastOpenedMarkdownPath ?? plugin.settings.book2Path,
					primaryText: selectedText,
					directorNotes
				});
				context = await plugin.contextAggregator.getMicroEditContext(selectedText, retrievalQuery);
				try {
					const retrievedText = (context?.smart_connections || '').toString();
					const items = (retrievedText.match(/^\[\d+\]/gm) || []).length;
					setRetrievedContextStats({ items, tokens: estimateTokens(retrievedText) });
				} catch {
					setRetrievedContextStats(null);
				}
				prompt = plugin.promptEngine.buildMicroEditPrompt(selectedText, directorNotes, context);
			}

			// Estimate prompt size and warn if it may exceed the model's context window
			const estimatedTokens = estimateTokens(prompt);
			setPromptTokenEstimate(estimatedTokens);
			setPromptCharCount(prompt.length);
			const limit = plugin.settings.contextTokenLimit ?? 128000;
			if (estimatedTokens > limit) {
				const proceed = await showConfirmModal(plugin.app, {
					title: 'Large prompt warning',
					message:
						`Estimated prompt size: ~${estimatedTokens.toLocaleString()} tokens (limit: ${limit.toLocaleString()}).\n\n` +
						`This may exceed your model context window and cause truncation/failure.\n\n` +
						`Continue anyway?`,
					confirmText: 'Continue',
					cancelText: 'Cancel'
				});
				if (!proceed) {
					setGenerationStage('');
					return;
				}
			}

			if (plugin.settings.generationMode === 'multi') {
				setGenerationStage('Initializing multi-model generation...');
				const multiSettings: MultiSettings = { ...plugin.settings, generationMode: 'multi' };
				const result = await plugin.aiClient.generate(prompt, multiSettings);
				
				// Show stages if available
				if (result.stages) {
					setGenerationStage(`Finalizing (${Object.keys(result.stages).length} stages completed)...`);
				}
				
				setGeneratedText(result.primary);
			} else {
				setGenerationStage('Generating...');
				const singleSettings: SingleSettings = { ...plugin.settings, generationMode: 'single' };
				const result = await plugin.aiClient.generate(prompt, singleSettings);
				setGeneratedText(result);
			}

			// Guided demo progression: mark step complete after successful generation
			if (demoStep === 'chapter') {
				setDemoStepCompleted((prev) => ({ ...prev, chapter: true }));
			}
			if (demoStep === 'micro-edit') {
				setDemoStepCompleted((prev) => ({ ...prev, 'micro-edit': true }));
			}
			
			setGenerationStage('');
		} catch (err: unknown) {
			// In guided demo: fall back to offline canned outputs automatically.
			if (isGuidedDemoActive) {
				console.error('Guided demo AI generation failed; falling back to offline demo:', err);
				setError(null);
				setGenerationStage('Generating (offline demo fallback)...');
				try {
					if (mode === 'chapter') {
						setGeneratedText(DEMO_CHAPTER_OUTPUT);
						setDemoStepCompleted((prev) => ({ ...prev, chapter: true }));
					} else {
						setGeneratedText(DEMO_MICRO_EDIT_OUTPUT);
						setDemoStepCompleted((prev) => ({ ...prev, 'micro-edit': true }));
					}
					new Notice('AI request failed. Ran offline demo instead.');
				} finally {
					setGenerationStage('');
				}
			} else {
				const message = formatUnknownForUi(err);
				setError(message || 'Generation failed');
				console.error('Generation error:', err);
				setGenerationStage('');
			}
		} finally {
			setIsGenerating(false);
		}
	};

	const handleUpdateCharacters = async () => {
		if (!selectedText) {
			setError('Please select text to extract character information from');
			return;
		}

		// Guided demo can run without an API key (offline canned extraction).
		// Auto mode: if API key exists, try AI; on failure, fall back to offline demo automatically.
		if (!plugin.settings.apiKey && isGuidedDemoActive) {
			setIsGenerating(true);
			setError(null);
			setGenerationStage('Extracting character information (offline demo)...');
			try {
				const updates = plugin.characterExtractor.parseExtraction(DEMO_CHARACTER_EXTRACTION_OUTPUT);
				await plugin.vaultService.createFolderIfNotExists(DEMO_FOLDER);
				await plugin.vaultService.updateCharacterNotes(updates, DEMO_CHARACTER_FOLDER);
				setDemoStepCompleted((prev) => ({ ...prev, 'character-update': true }));
				setGenerationStage('');
				new Notice(`Updated ${updates.length} demo character note(s)`);
			} catch (err: unknown) {
				const message = formatUnknownForUi(err);
				setError(message || 'Character extraction failed');
				setGenerationStage('');
			} finally {
				setIsGenerating(false);
			}
			return;
		}

		if (!plugin.settings.apiKey) {
			setError('Please configure your API key in settings');
			return;
		}

		setIsGenerating(true);
		setError(null);
		setGenerationStage('Extracting character information...');
		try {
			const getEffectiveCharacterInstructions = (raw: string): string => {
				const trimmed = (raw || '').trim();
				const hasLetters = /[A-Za-z]/.test(trimmed);
				if (trimmed.length < 30 || !hasLetters) {
					return (plugin.settings.defaultCharacterExtractionInstructions || '').trim();
				}
				return trimmed;
			};

			const characterNotes = await plugin.contextAggregator.getCharacterNotes();
			const storyBible = await plugin.contextAggregator.readFile(plugin.settings.storyBiblePath);
			const instructions = getEffectiveCharacterInstructions(directorNotes);
			const retrievalQuery = plugin.queryBuilder.build({
				mode: 'character-update',
				activeFilePath: plugin.lastOpenedMarkdownPath ?? plugin.settings.book2Path,
				primaryText: selectedText,
				directorNotes
			});
			const retrievedItems = await plugin.retrievalService.search(retrievalQuery, {
				limit: plugin.settings.retrievalTopK ?? 24
			});
			const retrievedContext =
				retrievedItems.length === 0
					? '[No retrieved context]'
					: retrievedItems
							.map((it, idx) => `[${idx + 1}] ${it.path}\n${it.excerpt}`.trim())
							.join('\n\n---\n\n');
			setRetrievedContextStats({ items: retrievedItems.length, tokens: estimateTokens(retrievedContext) });
			const prompt = plugin.promptEngine.buildCharacterExtractionPrompt(
				selectedText,
				characterNotes,
				storyBible,
				instructions,
				retrievedContext
			);
			
			// Character extraction always uses single mode
			const singleModeSettings: SingleSettings = { ...plugin.settings, generationMode: 'single' };
			let updates: Array<{ character: string; update: string }>;
			try {
				const extractionResult = await plugin.aiClient.generate(prompt, singleModeSettings);
				updates = plugin.characterExtractor.parseExtraction(extractionResult);
			} catch (err: unknown) {
				if (!isGuidedDemoActive) throw err;
				console.error('Guided demo character extraction failed; falling back to offline demo:', err);
				updates = plugin.characterExtractor.parseExtraction(DEMO_CHARACTER_EXTRACTION_OUTPUT);
				new Notice('AI request failed. Used offline demo character extraction instead.');
			}
			
			// Apply updates to character files
			if (isGuidedDemoActive) {
				await plugin.vaultService.createFolderIfNotExists(DEMO_FOLDER);
				await plugin.vaultService.updateCharacterNotes(updates, DEMO_CHARACTER_FOLDER);
				new Notice(`Updated ${updates.length} demo character note(s)`);
				setDemoStepCompleted((prev) => ({ ...prev, 'character-update': true }));
			} else {
				await plugin.vaultService.updateCharacterNotes(updates);
				// Show success message
				new Notice(`Updated ${updates.length} character note(s)`);
			}
			setError(null);
			setGenerationStage('');
		} catch (err: unknown) {
			const message = formatUnknownForUi(err);
			setError(message || 'Character extraction failed');
			console.error('Character update error:', err);
			setGenerationStage('');
		} finally {
			setIsGenerating(false);
		}
	};

	const handleSelectCharacterExtractionSource = () => {
		const files = plugin.app.vault.getMarkdownFiles();
		const modal = new FilePickerModal({
			app: plugin.app,
			files,
			placeholder: 'Pick the manuscript to process for bulk character extraction (Book 1, Book 2, etc.)',
			onPick: async (file) => {
				plugin.settings.characterExtractionSourcePath = file.path;
				await plugin.saveSettings();
				setBulkSourcePath(file.path);
			}
		});
		modal.open();
	};

	const handleClearCharacterExtractionSource = async () => {
		delete plugin.settings.characterExtractionSourcePath;
		await plugin.saveSettings();
		setBulkSourcePath(undefined);
	};

	const handleProcessEntireBook = async () => {
		if (!plugin.settings.apiKey) {
			setError('Please configure your API key in settings');
			return;
		}

		setIsGenerating(true);
		setError(null);
		setGenerationStage('Loading book...');
		
		const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
		const getErrorMessage = (err: unknown) => formatUnknownForUi(err);

		const withRetries = async <T,>(
			label: string,
			fn: () => Promise<T>,
			maxRetries = 2
		): Promise<T> => {
			let attempt = 0;
			while (true) {
				try {
					return await fn();
				} catch (err) {
					attempt++;
					if (attempt > maxRetries) throw err;
					setGenerationStage(`${label} (retry ${attempt}/${maxRetries})...`);
					// backoff: 600ms, 1200ms, ...
					await sleep(600 * attempt);
				}
			}
		};

		try {
			// Read the entire book file
			const bookPath = plugin.settings.characterExtractionSourcePath || plugin.settings.book2Path;
			const bookText = await plugin.contextAggregator.readFile(bookPath);
			
			if (!bookText || bookText.trim().length === 0) {
				setError('Book file is empty or not found');
				return;
			}

			// Skip if unchanged since last processing
			const hashNow = fnv1a32(bookText);
			const fileState = plugin.settings.fileState?.[bookPath] || {};

			// Split by H1 chapters for better coherence; fallback to word chunks if no headings exist
			const chapters = TextChunker.splitByH1(bookText);
			const totalChapters = chapters.length;
			if (totalChapters === 0) {
				setError('No content found to process.');
				return;
			}
			
			setGenerationStage(`Pass 1/2: Building roster from ${totalChapters} chapter(s)...`);
			
			// Get context for extraction
			const characterNotes = await plugin.contextAggregator.getCharacterNotes();
			const storyBible = await plugin.contextAggregator.readFile(plugin.settings.storyBiblePath);

			// Decide whether we're retrying only failed chapters (same hash) or doing a full run.
			const meta = fileState.bulkProcessMeta;
			const canRetryFailures =
				meta &&
				meta.hash === hashNow &&
				typeof meta.rosterText === 'string' &&
				Array.isArray(meta.failedChapterIndices) &&
				meta.failedChapterIndices.length > 0;

			// Skip only when unchanged AND there are no recorded failures to retry
			if (fileState.lastProcessHash === hashNow && !canRetryFailures) {
				setError(null);
				setGenerationStage('');
				new Notice('Book unchanged since last processing — skipping.');
				return;
			}

			let rosterText: string;
			const failedChapterIndices: number[] = [];

			if (canRetryFailures) {
				rosterText = meta!.rosterText!;
				setGenerationStage(
					`Retrying ${meta!.failedChapterIndices!.length} failed chapter(s) (no restart)...`
				);
			} else {
				setGenerationStage(`Pass 1/2: Building roster from ${totalChapters} chapter(s)...`);

				// Pass 1: global roster (high recall)
				const rosterEntries: ReturnType<typeof parseCharacterRoster> = [];
				for (let i = 0; i < chapters.length; i++) {
					const label = `Pass 1/2: Roster scan ${i + 1} of ${totalChapters}`;
					setGenerationStage(`${label}...`);
					const passage = chapters[i].fullText;
					const rosterPrompt = plugin.promptEngine.buildCharacterRosterPrompt(passage, storyBible);
					const singleModeSettings: SingleSettings = { ...plugin.settings, generationMode: 'single' };
					try {
						const rosterResult = await withRetries(label, async () => {
							return await plugin.aiClient.generate(rosterPrompt, singleModeSettings);
						}, 2);
						rosterEntries.push(...parseCharacterRoster(rosterResult));
					} catch (err: unknown) {
						console.error(`Roster scan failed at chapter ${i + 1}:`, err);
						// Continue; roster is best-effort, failures here shouldn't kill the whole run.
					}
				}
				// De-dupe roster again after aggregation
				const mergedRoster = parseCharacterRoster(rosterToBulletList(rosterEntries));
				rosterText = rosterToBulletList(mergedRoster);

				// Persist roster immediately so if extraction fails, rerun can retry without re-roster
				plugin.settings.fileState = plugin.settings.fileState || {};
				plugin.settings.fileState[bookPath] = {
					...(plugin.settings.fileState[bookPath] || {}),
					bulkProcessMeta: {
						hash: hashNow,
						rosterText,
						failedChapterIndices: []
					}
				};
				await plugin.saveSettings();
			}

			setGenerationStage(`Pass 2/2: Extracting character updates from ${totalChapters} chapter(s)...`);

			// Pass 2: per-chapter extraction using roster + strict parsing
			const allUpdates: Map<string, string[]> = new Map();
			const chapterIndicesToProcess = canRetryFailures
				? meta!.failedChapterIndices!
				: chapters.map((_, idx) => idx);

			for (let k = 0; k < chapterIndicesToProcess.length; k++) {
				const i = chapterIndicesToProcess[k];
				const label = `Pass 2/2: Chapter ${i + 1} of ${totalChapters}`;
				setGenerationStage(`${label}...`);
				const passage = chapters[i].fullText;
				const prompt = plugin.promptEngine.buildCharacterExtractionPromptWithRoster({
					passage,
					roster: rosterText,
					characterNotes,
					storyBible
				});
				const singleModeSettings: SingleSettings = { ...plugin.settings, generationMode: 'single' };
				try {
					const extractionResult = await withRetries(label, async () => {
						return await plugin.aiClient.generate(prompt, singleModeSettings);
					}, 3);
					const updates = plugin.characterExtractor.parseExtraction(extractionResult, { strict: true });
					for (const update of updates) {
						const existing = allUpdates.get(update.character) ?? [];
						existing.push(update.update);
						allUpdates.set(update.character, existing);
					}
				} catch (err: unknown) {
					console.error(`${label} failed:`, err);
					failedChapterIndices.push(i);
				}
			}
			
			// Combine updates for each character
			const aggregatedUpdates = Array.from(allUpdates.entries()).map(([character, updates]) => ({
				character,
				update: updates.join('\n\n---\n\n')
			}));
			
			// Apply updates to character files
			setGenerationStage('Saving character updates...');
			await plugin.vaultService.updateCharacterNotes(aggregatedUpdates);

			// Record processing hash/timestamp
			plugin.settings.fileState = plugin.settings.fileState || {};
			plugin.settings.fileState[bookPath] = {
				...(plugin.settings.fileState[bookPath] || {}),
				lastProcessHash: hashNow,
				lastProcessedAt: new Date().toISOString(),
				bulkProcessMeta: {
					hash: hashNow,
					rosterText,
					failedChapterIndices
				}
			};
			await plugin.saveSettings();
			
			setError(null);
			setGenerationStage('');
			if (failedChapterIndices.length > 0) {
				new Notice(
					`Processed book and updated ${aggregatedUpdates.length} character note(s). ` +
						`${failedChapterIndices.length} chapter(s) failed; re-run to retry failures.`
				);
			} else {
				new Notice(`Processed book and updated ${aggregatedUpdates.length} character note(s)`);
			}
		} catch (err: unknown) {
			setError(getErrorMessage(err) || 'Processing entire book failed');
			console.error('Process entire book error:', err);
			setGenerationStage('');
		} finally {
			setIsGenerating(false);
		}
	};

	const handleChunkSelectedFile = async () => {
		if (!plugin.settings.apiKey) {
			setError('Please configure your API key in settings');
			return;
		}

		setIsGenerating(true);
		setError(null);
		setGenerationStage('Chunking file...');
		
		try {
			// Chunk is file-based: always chunk the current note file (not the dashboard text box)
			const sourceFilePath = plugin.lastOpenedMarkdownPath;
			if (!sourceFilePath) {
				setError('No active note detected. Open the note you want to chunk first.');
				return;
			}

			const textToChunk = await plugin.contextAggregator.readFile(sourceFilePath);
			setGenerationStage(`Reading ${sourceFilePath}...`);
			
			if (!textToChunk || textToChunk.trim().length === 0) {
				setError('No text to chunk. Ensure the note has content.');
				return;
			}

			// Only rebuild chunks when content changed
			const hashNow = fnv1a32(textToChunk);
			const prevState = plugin.settings.fileState?.[sourceFilePath];
			if (prevState?.lastChunkHash === hashNow) {
				setError(null);
				setGenerationStage('');
				new Notice('Chunks are up to date — no rebuild needed.');
				return;
			}
			
			const wordCount = TextChunker.getWordCount(textToChunk);
			setGenerationStage(`Chunking ${wordCount} words into 500-word chunks...`);
			
			// Chunk the text (overwrite mode) and clean up extra old chunks
			const result = await plugin.vaultService.chunkFile(sourceFilePath, textToChunk, 500, true);

			// Record chunk hash/timestamp
			plugin.settings.fileState = plugin.settings.fileState || {};
			plugin.settings.fileState[sourceFilePath] = {
				...(plugin.settings.fileState[sourceFilePath] || {}),
				lastChunkHash: hashNow,
				lastChunkedAt: new Date().toISOString(),
				lastChunkCount: result.totalChunks
			};
			await plugin.saveSettings();
			
			setError(null);
			setGenerationStage('');
			const written = result.created + result.overwritten;
			new Notice(
				`Chunks rebuilt (${result.totalChunks} total; ${written} written; ${result.deletedExtra} deleted)`
			);
		} catch (err: unknown) {
			const message = formatUnknownForUi(err);
			setError(message || 'Chunking failed');
			console.error('Chunking error:', err);
			setGenerationStage('');
		} finally {
			setIsGenerating(false);
		}
	};

	const handleCopyToClipboard = async () => {
		if (generatedText) {
			try {
				await navigator.clipboard.writeText(generatedText);
				new Notice('Copied to clipboard');
			} catch (err) {
				console.error('Copy failed:', err);
				new Notice('Copy failed');
			}
		}
	};

	return (
		<div className="writing-dashboard">
			{demoStep !== 'off' && (
				<div className="demo-banner">
					<div className="demo-banner-left">
						<strong>Guided demo</strong>
						<span className="demo-banner-step">
							{demoStep === 'chapter' && 'Step 1/3: Generate a chapter (demo text)'}
							{demoStep === 'micro-edit' && 'Step 2/3: Micro edit (demo text)'}
							{demoStep === 'character-update' && 'Step 3/3: Update characters (demo folder)'}
							{demoStep === 'done' && 'Complete'}
						</span>
						{!canUseAiInDemo && (
							<span className="demo-banner-step">
								Offline demo: uses sample outputs. Add an API key to run real generation.
							</span>
						)}
					</div>
					<div className="demo-banner-actions">
						<button onClick={openPluginSettings} disabled={isGenerating} className="mod-secondary">
							Open settings
						</button>
						{!plugin.settings.setupCompleted && (
							<button onClick={skipGuidedDemo} disabled={isGenerating} className="mod-secondary">
								Skip demo
							</button>
						)}
						{demoStep !== 'done' && (
							<button
								onClick={continueGuidedDemo}
								disabled={
									isGenerating ||
									(demoStep === 'chapter' && !demoStepCompleted.chapter) ||
									(demoStep === 'micro-edit' && !demoStepCompleted['micro-edit']) ||
									(demoStep === 'character-update' && !demoStepCompleted['character-update'])
								}
								className="mod-cta"
							>
								Next
							</button>
						)}
						{demoStep === 'done' && (
							<button onClick={exitGuidedDemo} disabled={isGenerating} className="mod-cta">
								Close demo
							</button>
						)}
						<button onClick={exitGuidedDemo} disabled={isGenerating} className="mod-secondary">
							Exit
						</button>
					</div>
				</div>
			)}
			{!apiKeyPresent && !isGuidedDemoActive && (
				<div className="backend-warning">
					⚠️ Please configure your API key in settings → writing dashboard
				</div>
			)}
			<div className="dashboard-layout">
				<div className={`sidebar ${isVaultPanelCollapsed ? 'collapsed' : ''}`}>
					<VaultBrowser
						plugin={plugin}
						collapsed={isVaultPanelCollapsed}
						onToggleCollapsed={setIsVaultPanelCollapsed}
					/>
				</div>
				<div className="main-workspace">
					<EditorPanel 
						plugin={plugin}
						mode={mode}
						selectedText={selectedText}
						onSelectionChange={setSelectedText}
						generatedText={generatedText}
						onCopy={handleCopyToClipboard}
					/>
					{mode === 'chapter' && (
						<div className="word-count-input">
							<label>Target word range:</label>
							<input
								type="number"
								value={minWordsInput}
								onChange={(e) => setMinWordsInput(e.target.value)}
								onBlur={() => {
									const nextMin = clampWords(minWordsInput, minWords);
									setMinWords(nextMin);
									if (nextMin > maxWords) setMaxWords(nextMin);
									setMinWordsInput(String(nextMin));
								}}
								onKeyDown={(e) => {
									if (e.key === 'Enter') {
										const nextMin = clampWords(minWordsInput, minWords);
										setMinWords(nextMin);
										if (nextMin > maxWords) setMaxWords(nextMin);
										setMinWordsInput(String(nextMin));
										(e.currentTarget as HTMLInputElement).blur();
									}
								}}
								min="100"
								max="2000000"
							/>
							<span style={{ margin: '0 8px' }}>to</span>
							<input
								type="number"
								value={maxWordsInput}
								onChange={(e) => setMaxWordsInput(e.target.value)}
								onBlur={() => {
									const nextMax = clampWords(maxWordsInput, maxWords);
									setMaxWords(nextMax);
									if (nextMax < minWords) setMinWords(nextMax);
									setMaxWordsInput(String(nextMax));
								}}
								onKeyDown={(e) => {
									if (e.key === 'Enter') {
										const nextMax = clampWords(maxWordsInput, maxWords);
										setMaxWords(nextMax);
										if (nextMax < minWords) setMinWords(nextMax);
										setMaxWordsInput(String(nextMax));
										(e.currentTarget as HTMLInputElement).blur();
									}
								}}
								min="100"
								max="2000000"
							/>
						</div>
					)}
					<DirectorNotes 
						value={directorNotes}
						onChange={setDirectorNotes}
						mode={mode}
						onResetToDefault={mode === 'chapter' ? () => setDirectorNotes(DEFAULT_REWRITE_INSTRUCTIONS) : undefined}
					/>
					{promptTokenEstimate !== null && (
						<div className="generation-status">
							Estimated prompt size: ~{promptTokenEstimate.toLocaleString()} tokens
							{promptCharCount !== null ? ` (${promptCharCount.toLocaleString()} chars)` : ''}
							{plugin.settings.contextTokenLimit && promptTokenEstimate > plugin.settings.contextTokenLimit
								? ` — exceeds warning limit (${plugin.settings.contextTokenLimit.toLocaleString()})`
								: ''}
						</div>
					)}
					<div className="generation-status">{indexStatusText}</div>
					{retrievedContextStats && (
						<div className="generation-status">
							Retrieved context: {retrievedContextStats.items.toLocaleString()} item(s) (~
							{retrievedContextStats.tokens.toLocaleString()} tokens)
						</div>
					)}
					{error && (
						<div className="error-message">
							❌ {error}
						</div>
					)}
					{isGenerating && generationStage && (
						<div className="generation-status">
							⏳ {generationStage}
						</div>
					)}
					{mode === 'character-update' && (
						<div className="generation-status">
							Bulk source: {bulkSourcePath || plugin.settings.book2Path}
							{bulkSourcePath ? ' (custom)' : ' (book main path)'}
						</div>
					)}
					<div className="controls">
						<button onClick={openPublishWizard} disabled={isGenerating} className="update-characters-button">
							Export to EPUB
						</button>
						{mode !== 'character-update' && (
							<button 
								onClick={handleGenerate}
								disabled={isGenerating || (!apiKeyPresent && !isGuidedDemoActive)}
								className="generate-button"
							>
								{isGenerating ? 'Generating...' : mode === 'chapter' ? 'Generate chapter' : 'Generate edit'}
							</button>
						)}
						{mode === 'character-update' && (
							<>
								<button 
									onClick={handleUpdateCharacters}
									disabled={isGenerating || !selectedText || (!apiKeyPresent && !isGuidedDemoActive)}
									className="update-characters-button"
								>
									Update characters
								</button>
								<button
									onClick={handleSelectCharacterExtractionSource}
									disabled={isGenerating}
									className="update-characters-button"
								>
									Select file to process
								</button>
								<button
									onClick={handleClearCharacterExtractionSource}
									disabled={isGenerating || !plugin.settings.characterExtractionSourcePath}
									className="update-characters-button"
								>
									Use book main path
								</button>
								<button 
									onClick={handleProcessEntireBook}
									disabled={isGenerating || !apiKeyPresent}
									className="update-characters-button"
								>
									Process entire book
								</button>
								<button 
									onClick={handleChunkSelectedFile}
									disabled={isGenerating || !apiKeyPresent}
									className="update-characters-button"
								>
									Chunk current note
								</button>
							</>
						)}
					</div>
					<ModeSelector mode={mode} onChange={setMode} />
				</div>
			</div>
		</div>
	);
};

