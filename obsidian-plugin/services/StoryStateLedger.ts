import { TFile } from 'obsidian';
import type WritingDashboardPlugin from '../main';
import { CanonFact, ChapterState, Entity, FactScope, FactType, LoopKind, LoopStatus, StoryLoop } from './Schemas';
import { ContextManager } from './ContextManager';
import { sha256 } from './ContentHash';

export interface StoryStateDelta {
	source: 'model' | 'heuristic' | 'manual';
	entities: Entity[];
	facts: CanonFact[];
	openLoops: string[];
	resolvedLoops: string[];
	loopMovements: RawLoopMovement[];
	warnings: string[];
}

export type RawLoopMovement = {
	loopId?: string;
	label: string;
	kind?: LoopKind;
	status: LoopStatus;
	movement: string;
	ownerEntityIds?: string[];
	urgency?: number;
	dropRisk?: number;
	expectedPayoff?: StoryLoop['expectedPayoff'];
	closureCondition?: string;
	nextObligation?: string;
	evidence?: string;
};

type RawDelta = {
	entities?: Array<Partial<Entity> & { name: string; type?: Entity['type'] }>;
	facts?: Array<{
		entityId?: string;
		entityName?: string;
		type?: string;
		attribute?: string;
		value?: unknown;
		scope?: string;
		confidence?: number;
		lifecycleState?: CanonFact['lifecycleState'];
	}>;
	openLoops?: string[];
	resolvedLoops?: string[];
	loopMovements?: RawLoopMovement[];
	warnings?: string[];
};

/**
 * StoryStateLedger turns narrative/source text into typed state deltas.
 * It deliberately uses the configured writing model for extraction when possible;
 * the local NSM/Gemma sidecar is optional telemetry, not required for correctness.
 */
export class StoryStateLedger {
	private readonly plugin: WritingDashboardPlugin;

	constructor(plugin: WritingDashboardPlugin) {
		this.plugin = plugin;
	}

	async seedFromStoryBible(contextManager: ContextManager, storyBiblePath: string): Promise<{ updated: boolean; hash: string; delta: StoryStateDelta }> {
		const file = this.plugin.app.vault.getAbstractFileByPath(storyBiblePath);
		if (!(file instanceof TFile)) {
			return { updated: false, hash: '', delta: this.emptyDelta('heuristic') };
		}

		const content = await this.plugin.app.vault.read(file);
		const hash = await sha256(content);
		const delta = await this.extractDelta(content, {
			sourceLabel: storyBiblePath,
			defaultOrigin: 'BIBLE',
			defaultLifecycle: 'CANON',
			existingState: contextManager.getState(),
		});

		this.applyDelta(contextManager, delta);
		await this.writeSnapshot('story-bible', hash, contextManager.getState(), delta);

		return { updated: delta.entities.length > 0 || delta.facts.length > 0 || delta.openLoops.length > 0, hash, delta };
	}

	async extractDeltaFromProse(text: string, contextManager: ContextManager, sourceLabel: string): Promise<StoryStateDelta> {
		return this.extractDelta(text, {
			sourceLabel,
			defaultOrigin: 'GENERATION',
			defaultLifecycle: 'PROPOSED',
			existingState: contextManager.getState(),
		});
	}

	async recordDelta(kind: string, sourceLabel: string, contextManager: ContextManager, delta: StoryStateDelta): Promise<void> {
		await this.writeSnapshot(kind, await sha256(sourceLabel), contextManager.getState(), delta);
	}

	normalizeExternalDelta(
		raw: RawDelta,
		sourceLabel: string,
		defaultOrigin: CanonFact['origin'],
		defaultLifecycle: CanonFact['lifecycleState'],
		source: StoryStateDelta['source'] = 'model'
	): StoryStateDelta {
		return this.normalizeRawDelta(raw, { sourceLabel, defaultOrigin, defaultLifecycle }, source);
	}

	applyDelta(contextManager: ContextManager, delta: StoryStateDelta, timelineEvent?: { chunkId: string; summary: string }): void {
		const state = contextManager.getState();
		for (const entity of delta.entities) {
			if (!state.entities.some(e => e.id === entity.id)) {
				state.entities.push(entity);
			}
		}

		contextManager.updateState(delta.facts, timelineEvent);

		for (const loop of delta.openLoops) {
			if (!state.openLoops.includes(loop)) {
				state.openLoops.push(loop);
			}
		}

		if (delta.resolvedLoops.length > 0) {
			const resolved = new Set(delta.resolvedLoops.map(l => l.toLowerCase()));
			state.openLoops = state.openLoops.filter(loop => !resolved.has(loop.toLowerCase()));
		}

		this.applyLoopMovements(state, delta, timelineEvent?.chunkId || state.lastChunkId || 'unknown');
	}

	private async extractDelta(
		text: string,
		opts: {
			sourceLabel: string;
			defaultOrigin: CanonFact['origin'];
			defaultLifecycle: CanonFact['lifecycleState'];
			existingState: ChapterState;
		}
	): Promise<StoryStateDelta> {
		if (this.plugin.settings.apiKey) {
			const prompt = this.plugin.promptEngine.buildStoryStateDeltaPrompt({
				sourceLabel: opts.sourceLabel,
				text,
				existingEntities: opts.existingState.entities,
				existingFacts: opts.existingState.canonFacts,
				openLoops: opts.existingState.openLoops,
				loopLedger: opts.existingState.loopLedger,
				defaultOrigin: opts.defaultOrigin,
				defaultLifecycle: opts.defaultLifecycle,
			});

			try {
				const response = await this.plugin.aiClient.generate(prompt, {
					...this.plugin.settings,
					generationMode: 'single' as const,
					spontaneity: 0,
				});
				return this.normalizeRawDelta(this.recoverJson(response), opts, 'model');
			} catch (err) {
				console.warn('[StoryStateLedger] Model extraction failed; using heuristic fallback.', err);
				return this.heuristicDelta(text, opts, err instanceof Error ? err.message : String(err));
			}
		}

		return this.heuristicDelta(text, opts);
	}

	private normalizeRawDelta(raw: RawDelta, opts: { sourceLabel: string; defaultOrigin: CanonFact['origin']; defaultLifecycle: CanonFact['lifecycleState'] }, source: StoryStateDelta['source']): StoryStateDelta {
		const entities: Entity[] = [];
		const entityIds = new Set<string>();

		for (const rawEntity of raw.entities || []) {
			if (!rawEntity.name) continue;
			const id = this.slugId(rawEntity.id || rawEntity.name, this.prefixForEntityType(rawEntity.type));
			if (entityIds.has(id)) continue;
			entityIds.add(id);
			entities.push({
				id,
				name: rawEntity.name,
				type: rawEntity.type || 'concept',
				attributes: rawEntity.attributes || {},
			});
		}

		const facts: CanonFact[] = [];
		for (const rawFact of raw.facts || []) {
			const entityId = rawFact.entityId
				? this.slugId(rawFact.entityId, 'ent')
				: this.slugId(rawFact.entityName || 'story', 'ent');
			const attribute = this.safeAttribute(rawFact.attribute || 'note');
			facts.push({
				id: this.factId(entityId, attribute, rawFact.value),
				entityId,
				type: this.factType(rawFact.type),
				attribute,
				value: rawFact.value ?? '',
				scope: this.factScope(rawFact.scope),
				origin: opts.defaultOrigin,
				source: opts.sourceLabel,
				timestamp: Date.now(),
				confidence: typeof rawFact.confidence === 'number' ? Math.max(0, Math.min(1, rawFact.confidence)) : 0.75,
				lifecycleState: rawFact.lifecycleState || opts.defaultLifecycle,
			});
		}

		return {
			source,
			entities,
			facts,
			openLoops: this.cleanList(raw.openLoops),
			resolvedLoops: this.cleanList(raw.resolvedLoops),
			loopMovements: this.normalizeLoopMovements(raw.loopMovements),
			warnings: this.cleanList(raw.warnings),
		};
	}

	private heuristicDelta(text: string, opts: { sourceLabel: string; defaultOrigin: CanonFact['origin']; defaultLifecycle: CanonFact['lifecycleState'] }, fallbackReason?: string): StoryStateDelta {
		const entities: Entity[] = [];
		const facts: CanonFact[] = [];
		const seen = new Set<string>();
		const lines = text.split(/\r?\n/);
		let section = 'story';

		for (const line of lines) {
			const trimmed = line.trim();
			const heading = /^#{1,4}\s+(.+)$/.exec(trimmed);
			if (heading) {
				section = heading[1].trim();
				continue;
			}

			const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
			if (!bullet) continue;
			const body = bullet[1].trim();
			const bracketed = /^\[([^\]]+)\]\s*([^:]+):\s*(.+)$/.exec(body);
			const colon = /^([^:]{2,80}):\s*(.+)$/.exec(body);

			const name = bracketed?.[1] || colon?.[1] || section;
			const attribute = this.safeAttribute(bracketed?.[2] || section);
			const value = bracketed?.[3] || colon?.[2] || body;
			const entityId = this.slugId(name, section.toLowerCase().includes('location') ? 'loc' : 'ent');

			if (!seen.has(entityId)) {
				seen.add(entityId);
				entities.push({
					id: entityId,
					name,
					type: section.toLowerCase().includes('character') ? 'character' : section.toLowerCase().includes('location') ? 'location' : 'concept',
					attributes: {},
				});
			}

			facts.push({
				id: this.factId(entityId, attribute, value),
				entityId,
				type: attribute.includes('relationship') ? 'RELATIONSHIP' : attribute.includes('timeline') ? 'TIMELINE' : 'TRAIT',
				attribute,
				value,
				scope: opts.defaultOrigin === 'BIBLE' ? 'GLOBAL' : 'SCENE',
				origin: opts.defaultOrigin,
				source: opts.sourceLabel,
				timestamp: Date.now(),
				confidence: 0.6,
				lifecycleState: opts.defaultLifecycle,
			});
		}

		if (facts.length === 0) {
			const proseDelta = this.heuristicProseDelta(text, opts);
			entities.push(...proseDelta.entities.filter(e => !seen.has(e.id)));
			proseDelta.entities.forEach(e => seen.add(e.id));
			facts.push(...proseDelta.facts);
		}

		const openLoops = Array.from(text.matchAll(/\b(?:promise|mystery|unresolved|open question|thread)\b[:\s-]+([^\n.]+)/gi))
			.map(match => match[1]?.trim())
			.filter(Boolean) as string[];

		const warnings = fallbackReason
			? [`Model state extraction failed; heuristic fallback used instead. Reason: ${fallbackReason}`]
			: [];

		return {
			source: 'heuristic',
			entities,
			facts,
			openLoops,
			resolvedLoops: [],
			loopMovements: openLoops.map(label => ({
				label,
				kind: 'mystery',
				status: 'OPEN',
				movement: 'Heuristic fallback identified this as an unresolved story obligation.',
				urgency: 0.4,
				dropRisk: 0.5,
				expectedPayoff: 'later'
			})),
			warnings
		};
	}

	private heuristicProseDelta(text: string, opts: { sourceLabel: string; defaultOrigin: CanonFact['origin']; defaultLifecycle: CanonFact['lifecycleState'] }): Pick<StoryStateDelta, 'entities' | 'facts'> {
		const entities: Entity[] = [];
		const facts: CanonFact[] = [];
		const seen = new Set<string>();
		const knownNonNames = new Set(['The', 'This', 'That', 'There', 'He', 'She', 'His', 'Her', 'It', 'In', 'And', 'But', 'Because', 'Meaning', 'Instead']);
		const entityPattern = /\b(?:Dr\.\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g;
		const roomPattern = /\b(?:room|Room)\s+(\d{3})\b/g;
		const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];

		for (const match of text.matchAll(entityPattern)) {
			const name = match[0].trim();
			if (knownNonNames.has(name) || name.length < 3) continue;
			const id = this.slugId(name.replace(/^Dr\.\s+/, ''), 'char');
			if (seen.has(id)) continue;
			seen.add(id);
			entities.push({
				id,
				name,
				type: name.startsWith('Dr.') || /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$/.test(name) ? 'character' : 'concept',
				attributes: {},
			});
		}

		for (const match of text.matchAll(roomPattern)) {
			const room = `Room ${match[1]}`;
			const id = this.slugId(room, 'loc');
			if (seen.has(id)) continue;
			seen.add(id);
			entities.push({ id, name: room, type: 'location', attributes: {} });
		}

		const entityIdsByName = new Map(entities.map(e => [e.name.replace(/^Dr\.\s+/, ''), e.id]));
		const importantSentencePattern = /\b(is|was|were|has|had|thinks|believes|knows|wants|faking|orderly|patient|room|incident|theory|threat|grievance|sleeping|voluntary|military|journalist|corrupt|sincere|authority|medications|retaliat)/i;

		for (const sentence of sentences) {
			const clean = sentence.replace(/\s+/g, ' ').trim();
			if (clean.length < 25 || clean.length > 420 || !importantSentencePattern.test(clean)) continue;
			const mentioned = [...entityIdsByName.entries()].find(([name]) => clean.includes(name));
			if (!mentioned) continue;
			const [name, entityId] = mentioned;
			const attribute = this.safeAttribute(this.inferAttribute(clean));
			facts.push({
				id: this.factId(entityId, attribute, clean),
				entityId,
				type: attribute.includes('relationship') ? 'RELATIONSHIP' : attribute.includes('timeline') ? 'TIMELINE' : 'SCENE_DETAIL',
				attribute,
				value: clean,
				scope: 'SCENE',
				origin: opts.defaultOrigin,
				source: opts.sourceLabel,
				timestamp: Date.now(),
				confidence: 0.45,
				lifecycleState: opts.defaultLifecycle,
			});
			if (facts.length >= 24) break;
		}

		return { entities, facts };
	}

	private inferAttribute(sentence: string): string {
		const lower = sentence.toLowerCase();
		if (lower.includes('room')) return 'room_detail';
		if (lower.includes('orderly') || lower.includes('patient')) return 'institutional_role';
		if (lower.includes('theory') || lower.includes('believes') || lower.includes('thinks')) return 'belief_or_theory';
		if (lower.includes('grievance') || lower.includes('retaliat') || lower.includes('threat')) return 'threat_state';
		if (lower.includes('sleeping')) return 'relationship_boundary_violation';
		if (lower.includes('incident')) return 'incident_context';
		return 'scene_detail';
	}

	private recoverJson(response: string): RawDelta {
		const trimmed = response.trim();
		try {
			return JSON.parse(trimmed);
		} catch {
			const start = trimmed.indexOf('{');
			const end = trimmed.lastIndexOf('}');
			if (start >= 0 && end > start) {
				return JSON.parse(trimmed.slice(start, end + 1));
			}
			throw new Error('State extraction did not return JSON.');
		}
	}

	private emptyDelta(source: StoryStateDelta['source']): StoryStateDelta {
		return { source, entities: [], facts: [], openLoops: [], resolvedLoops: [], loopMovements: [], warnings: [] };
	}

	private cleanList(values?: string[]): string[] {
		return (values || []).map(v => String(v).trim()).filter(Boolean);
	}

	private slugId(value: unknown, prefix: string): string {
		const slug = String(value || 'story')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60);
		if (/^(char|loc|obj|ent|concept)-/.test(slug)) {
			return slug;
		}
		return slug.startsWith(`${prefix}-`) ? slug : `${prefix}-${slug || 'story'}`;
	}

	private prefixForEntityType(type?: Entity['type']): string {
		if (type === 'character') return 'char';
		if (type === 'location') return 'loc';
		if (type === 'object') return 'obj';
		return 'ent';
	}

	private safeAttribute(value: string): string {
		return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'note';
	}

	private factType(value?: string): FactType {
		const upper = String(value || '').toUpperCase();
		if (['IDENTITY', 'RELATIONSHIP', 'TIMELINE', 'TRAIT', 'SCENE_DETAIL', 'TONE_RULE', 'THREAD_STATE'].includes(upper)) {
			return upper as FactType;
		}
		return 'TRAIT';
	}

	private factScope(value?: string): FactScope {
		const upper = String(value || '').toUpperCase();
		if (upper === 'SCENE' || upper === 'CHAPTER' || upper === 'GLOBAL') return upper;
		return 'GLOBAL';
	}

	private factId(entityId: string, attribute: string, value: unknown): string {
		const valueText = typeof value === 'string' ? value : JSON.stringify(value);
		return `fact-${this.safeAttribute(`${entityId}-${attribute}-${valueText || ''}`).slice(0, 96)}`;
	}

	private normalizeLoopMovements(values?: RawLoopMovement[]): RawLoopMovement[] {
		return (values || [])
			.filter(v => v && v.label && v.status && v.movement)
			.map(v => ({
				loopId: v.loopId,
				label: String(v.label).trim(),
				kind: this.loopKind(v.kind),
				status: this.loopStatus(v.status),
				movement: String(v.movement).trim(),
				ownerEntityIds: (v.ownerEntityIds || []).map(String),
				urgency: this.clamp01(v.urgency, 0.5),
				dropRisk: this.clamp01(v.dropRisk, 0.5),
				expectedPayoff: this.expectedPayoff(v.expectedPayoff),
				closureCondition: v.closureCondition ? String(v.closureCondition).trim() : undefined,
				nextObligation: v.nextObligation ? String(v.nextObligation).trim() : undefined,
				evidence: v.evidence ? String(v.evidence).trim() : undefined,
			}));
	}

	private applyLoopMovements(state: ChapterState, delta: StoryStateDelta, chunkId: string): void {
		state.loopLedger = state.loopLedger || [];
		const movements = [...delta.loopMovements];

		for (const label of delta.openLoops) {
			if (!movements.some(m => m.label.toLowerCase() === label.toLowerCase())) {
				movements.push({
					label,
					kind: 'mystery',
					status: 'OPEN',
					movement: 'Opened by this passage.',
					urgency: 0.5,
					dropRisk: 0.5,
					expectedPayoff: 'later',
				});
			}
		}

		for (const label of delta.resolvedLoops) {
			if (!movements.some(m => m.label.toLowerCase() === label.toLowerCase())) {
				movements.push({
					label,
					kind: 'mystery',
					status: 'SATISFIED',
					movement: 'Resolved by this passage.',
					urgency: 0,
					dropRisk: 0,
					expectedPayoff: 'none',
				});
			}
		}

		for (const movement of movements) {
			const id = movement.loopId || this.loopId(movement.label);
			const existing = state.loopLedger.find(loop => loop.id === id || loop.label.toLowerCase() === movement.label.toLowerCase());
			const entry = {
				chunkId,
				status: movement.status,
				movement: movement.movement,
				nextObligation: movement.nextObligation,
				evidence: movement.evidence,
				timestamp: Date.now(),
			};

			if (existing) {
				existing.status = movement.status;
				existing.kind = movement.kind || existing.kind;
				existing.ownerEntityIds = movement.ownerEntityIds?.length ? movement.ownerEntityIds : existing.ownerEntityIds;
				existing.urgency = this.clamp01(movement.urgency, existing.urgency);
				existing.dropRisk = this.clamp01(movement.dropRisk, existing.dropRisk);
				existing.expectedPayoff = movement.expectedPayoff || existing.expectedPayoff;
				existing.closureCondition = movement.closureCondition || existing.closureCondition;
				existing.lastTouchedChunk = chunkId;
				existing.history.push(entry);
			} else {
				state.loopLedger.push({
					id,
					label: movement.label,
					kind: movement.kind || 'mystery',
					status: movement.status,
					ownerEntityIds: movement.ownerEntityIds || [],
					urgency: this.clamp01(movement.urgency, 0.5),
					dropRisk: this.clamp01(movement.dropRisk, 0.5),
					openedAtChunk: chunkId,
					lastTouchedChunk: chunkId,
					expectedPayoff: movement.expectedPayoff || 'later',
					closureCondition: movement.closureCondition,
					history: [entry],
				});
			}
		}
	}

	private loopId(label: string): string {
		return `loop-${this.safeAttribute(label).slice(0, 80)}`;
	}

	private loopStatus(value?: string): LoopStatus {
		const upper = String(value || '').toUpperCase();
		const allowed: LoopStatus[] = ['OPEN', 'ACTIVE', 'DORMANT', 'TRANSFERRED', 'SATISFIED', 'RECONTEXTUALIZED', 'BACKGROUND_CONTINUITY', 'ABANDONED_INTENTIONALLY', 'DEAD_END', 'CLOSED'];
		return allowed.includes(upper as LoopStatus) ? upper as LoopStatus : 'OPEN';
	}

	private loopKind(value?: string): LoopKind {
		const lower = String(value || '').toLowerCase();
		const allowed: LoopKind[] = ['mystery', 'threat', 'relationship', 'promise', 'emotional', 'world', 'theme', 'texture'];
		return allowed.includes(lower as LoopKind) ? lower as LoopKind : 'mystery';
	}

	private expectedPayoff(value?: string): StoryLoop['expectedPayoff'] {
		return value === 'soon' || value === 'later' || value === 'background' || value === 'none' ? value : 'later';
	}

	private clamp01(value: unknown, fallback: number): number {
		return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
	}

	private async writeSnapshot(kind: string, hash: string, state: ChapterState, delta: StoryStateDelta): Promise<void> {
		try {
			const path = `.gwriter/state-ledger/${kind}-${Date.now()}.json`;
			await this.plugin.vaultService.ensureParentFolder(path);
			await this.plugin.vaultService.writeFile(path, JSON.stringify({
				kind,
				hash,
				createdAt: Date.now(),
				delta,
				canonVersion: state.canonVersion,
				entityCount: state.entities.length,
				factCount: state.canonFacts.length,
				openLoopCount: state.openLoops.length,
			}, null, 2));
		} catch (err) {
			console.warn('[StoryStateLedger] Failed to write ledger snapshot.', err);
		}
	}
}
