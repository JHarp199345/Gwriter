import { CanonFact, ParagraphMetadata } from './Schemas';
import WritingDashboardPlugin from '../main';
import { sha256, normalizeWhitespace } from './ContentHash';

/**
 * Locked fact attestation - model must explicitly state preservation status
 */
export interface LockedFactAttestation {
    factId: string;
    status: 'PRESERVED' | 'NOT_MENTIONED' | 'CONTRADICTED';
    evidence?: {
        paragraphId: string;
        quote: string;
    };
}

/**
 * Citation with hash verification
 */
export interface Citation {
    hitId: string;
    snippetHash: string; // SHA256 of the exact snippet text
}

/**
 * Cloud chapter write output - paragraphs[] is canonical, prose is derived
 */
export interface WriteChapterOutput {
    paragraphs: Array<{
        id: string;
        text: string;
        sidecar: ParagraphMetadata;
        citations: Citation[];
    }>;
    proseHash: string; // sha256(normalizeWhitespace(computedProse))
    lockedFactAttestations: LockedFactAttestation[];
    extractedTuples?: CanonFact[]; // Optional model-extracted facts
    usedHitIds: string[];
}

/**
 * Cloud chapter edit output
 */
export interface EditChapterOutput {
    resultParagraphs: Array<{
        id: string;
        text: string;
        sidecar: ParagraphMetadata;
    }>;
    patchOps: Array<{
        op: 'REPLACE' | 'INSERT';
        targetId: string;
        beforeHash?: string;
        afterHash: string;
    }>;
    lockedFactAttestations: LockedFactAttestation[];
}

/**
 * Context pack for cloud chapter write
 */
export interface WriteChapterInput {
    instruction: string; // User's director notes
    context: ContextPack;
    wordCount: number;
    lockMap: LockMap;
}

/**
 * Context pack for cloud chapter edit
 */
export interface EditChapterInput {
    chapterText: string; // Current chapter prose
    editInstructions: string; // User's edit directive
    context: ContextPack;
    lockMap: LockMap;
    outputContract: EditOutputContract;
}

/**
 * Lock map - protected facts that must not be contradicted
 */
export interface LockMap {
    canonicalTuples: CanonFact[];
    protectedEntities: string[]; // Entity IDs
    protectedNumbers: Array<{ entityId: string; attribute: string; value: number }>;
    protectedRelations: Array<{ fromId: string; toId: string; relationType: string }>;
}

/**
 * Context pack structure
 */
export interface ContextPack {
    lockMap: LockMap;
    chapterState: {
        plotMemory?: string;
        directorNotes?: string;
        currentLocation?: string;
        currentTime?: string;
        activeCast?: string[];
    };
    styleSignature?: string[]; // "Golden Paragraphs" for voice matching
    retrievalHits: Array<{
        id: string;
        excerpt: string;
        snippetHash: string;
        sourcePath: string;
        relevanceScore: number;
        intentHardness?: 'HARD' | 'SOFT';
    }>;
    tokenEstimate: {
        lockMap: number;
        state: number;
        style: number;
        hits: number;
        total: number;
    };
}

/**
 * Edit output contract
 */
export interface EditOutputContract {
    allowedScope: 'SCENE' | 'CHAPTER' | 'GLOBAL';
    allowedOperations: Array<'STYLE_ONLY' | 'CONTENT_EDIT' | 'ADDITION'>;
    protectedSpans?: Array<{ paragraphId: string; charRange: { start: number; end: number } }>;
}

/**
 * CloudRelay - Strict single-call primitives for cloud providers
 * 
 * Enforces exactly one cloud LLM call per writeChapter/editChapter request.
 * All safety gates (audit, tuple verification) run locally.
 */
export class CloudRelay {
    private readonly plugin: WritingDashboardPlugin;
    private readonly maxCloudAttemptsPerRequest: number = 1; // Strict: no retries unless zero bytes

    constructor(plugin: WritingDashboardPlugin) {
        this.plugin = plugin;
    }

    /**
     * Write a full chapter in a single cloud call.
     * Returns structured output with paragraphs as canonical source of truth.
     */
    async writeChapter(
        input: WriteChapterInput,
        signal?: AbortSignal
    ): Promise<WriteChapterOutput> {
        // Build monolithic prompt
        const prompt = this.buildWritePrompt(input);
        
        // Single cloud call with JSON Schema enforcement
        const response = await this.callCloudWithSchema(
            prompt,
            this.getWriteOutputSchema(),
            signal
        );

        // Parse and validate response
        return await this.parseWriteOutput(response);
    }

    /**
     * Edit an existing chapter in a single cloud call.
     */
    async editChapter(
        input: EditChapterInput,
        signal?: AbortSignal
    ): Promise<EditChapterOutput> {
        const prompt = this.buildEditPrompt(input);
        
        const response = await this.callCloudWithSchema(
            prompt,
            this.getEditOutputSchema(),
            signal
        );

        return this.parseEditOutput(response);
    }

    /**
     * Build monolithic write prompt from context pack
     */
    private buildWritePrompt(input: WriteChapterInput): string {
        const { context, instruction, wordCount, lockMap } = input;
        
        return `
# Chapter Generation Task

## Director Notes
${instruction}

## Target Length
${wordCount} words

## Locked Facts (MUST PRESERVE)
${this.formatLockMap(lockMap)}

## Story Context
${context.chapterState.plotMemory || 'No plot memory yet.'}
Location: ${context.chapterState.currentLocation || 'Unknown'}
Time: ${context.chapterState.currentTime || 'Unknown'}
Active Cast: ${context.chapterState.activeCast?.join(', ') || 'None'}

## Style Signature
${context.styleSignature?.join('\n\n---\n\n') || 'No style signature provided.'}

## Retrieved Context
${context.retrievalHits.map(hit => `[${hit.id}] ${hit.excerpt}`).join('\n\n')}

## Output Requirements
Generate a complete chapter as a JSON object with:
- paragraphs[]: Array of {id, text, sidecar, citations[]}
- proseHash: SHA256 hash of normalized prose (computed from paragraphs)
- lockedFactAttestations[]: For each locked fact, state PRESERVED/NOT_MENTIONED/CONTRADICTED
- extractedTuples[]: Any new canonical facts introduced
- usedHitIds[]: Which retrieval hits were actually used

Ensure prose matches target word count and maintains narrative coherence.
`;
    }

    /**
     * Build edit prompt
     */
    private buildEditPrompt(input: EditChapterInput): string {
        const { chapterText, editInstructions, context, lockMap } = input;
        
        return `
# Chapter Edit Task

## Current Chapter Text
${chapterText}

## Edit Instructions
${editInstructions}

## Locked Facts (MUST PRESERVE)
${this.formatLockMap(lockMap)}

## Context
${JSON.stringify(context.chapterState, null, 2)}

## Output Requirements
Return JSON with:
- resultParagraphs[]: Edited paragraphs
- patchOps[]: Operations applied
- lockedFactAttestations[]: Preservation status of locked facts
`;
    }

    /**
     * Format lock map for prompt
     */
    private formatLockMap(lockMap: LockMap): string {
        const lines: string[] = [];
        
        lockMap.canonicalTuples.forEach(fact => {
            lines.push(`- ${fact.entityId}.${fact.attribute} = ${JSON.stringify(fact.value)}`);
        });
        
        lockMap.protectedNumbers.forEach(num => {
            lines.push(`- ${num.entityId}.${num.attribute} = ${num.value} (number)`);
        });
        
        lockMap.protectedRelations.forEach(rel => {
            lines.push(`- ${rel.fromId} --[${rel.relationType}]--> ${rel.toId}`);
        });
        
        return lines.join('\n');
    }

    /**
     * Get JSON Schema for write output
     */
    private getWriteOutputSchema(): object {
        return {
            type: 'object',
            required: ['paragraphs', 'proseHash', 'lockedFactAttestations', 'usedHitIds'],
            properties: {
                paragraphs: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['id', 'text', 'sidecar', 'citations'],
                        properties: {
                            id: { type: 'string' },
                            text: { type: 'string' },
                            sidecar: { type: 'object' },
                            citations: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    required: ['hitId', 'snippetHash'],
                                    properties: {
                                        hitId: { type: 'string' },
                                        snippetHash: { type: 'string' }
                                    }
                                }
                            }
                        }
                    }
                },
                proseHash: { type: 'string' },
                lockedFactAttestations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['factId', 'status'],
                        properties: {
                            factId: { type: 'string' },
                            status: { type: 'string', enum: ['PRESERVED', 'NOT_MENTIONED', 'CONTRADICTED'] },
                            evidence: { type: 'object' }
                        }
                    }
                },
                extractedTuples: { type: 'array' },
                usedHitIds: { type: 'array', items: { type: 'string' } }
            }
        };
    }

    /**
     * Get JSON Schema for edit output
     */
    private getEditOutputSchema(): object {
        return {
            type: 'object',
            required: ['resultParagraphs', 'patchOps', 'lockedFactAttestations'],
            properties: {
                resultParagraphs: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['id', 'text', 'sidecar'],
                        properties: {
                            id: { type: 'string' },
                            text: { type: 'string' },
                            sidecar: { type: 'object' }
                        }
                    }
                },
                patchOps: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['op', 'targetId', 'afterHash'],
                        properties: {
                            op: { type: 'string', enum: ['REPLACE', 'INSERT'] },
                            targetId: { type: 'string' },
                            beforeHash: { type: 'string' },
                            afterHash: { type: 'string' }
                        }
                    }
                },
                lockedFactAttestations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['factId', 'status'],
                        properties: {
                            factId: { type: 'string' },
                            status: { type: 'string' },
                            evidence: { type: 'object' }
                        }
                    }
                }
            }
        };
    }

    /**
     * Call cloud provider with JSON Schema enforcement
     */
    private async callCloudWithSchema(
        prompt: string,
        schema: object,
        signal?: AbortSignal
    ): Promise<string> {
        const provider = this.plugin.settings.apiProvider;
        const model = this.plugin.settings.relayCloudModel || this.plugin.settings.model;
        const apiKey = this.plugin.settings.apiKey;

        if (!apiKey) {
            throw new Error('API key not configured for cloud provider');
        }

        // Route to appropriate provider
        if (provider === 'openai' || provider === 'openrouter') {
            return await this.callOpenAIWithSchema(prompt, model, apiKey, schema, signal);
        } else if (provider === 'anthropic') {
            return await this.callAnthropicWithSchema(prompt, model, apiKey, schema, signal);
        } else if (provider === 'gemini') {
            return await this.callGeminiWithSchema(prompt, model, apiKey, schema, signal);
        } else {
            throw new Error(`Unsupported cloud provider: ${provider}`);
        }
    }

    /**
     * OpenAI/OpenRouter with JSON Schema
     */
    private async callOpenAIWithSchema(
        prompt: string,
        model: string,
        apiKey: string,
        schema: object,
        signal?: AbortSignal
    ): Promise<string> {
        const url = this.plugin.settings.apiProvider === 'openrouter'
            ? 'https://openrouter.ai/api/v1/chat/completions'
            : 'https://api.openai.com/v1/chat/completions';

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };

        if (this.plugin.settings.apiProvider === 'openrouter') {
            headers['HTTP-Referer'] = 'https://github.com/JHarp199345/Gwriter';
            headers['X-Title'] = 'Writing Dashboard';
        }

        const body = {
            model,
            messages: [
                { role: 'system', content: 'You are a professional writing assistant. Always respond with valid JSON matching the provided schema.' },
                { role: 'user', content: prompt }
            ],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'chapter_output',
                    schema: schema,
                    strict: true
                }
            },
            max_tokens: 12000,
            temperature: 0.7
        };

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: signal as any
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
            throw new Error(`Cloud API error: ${error.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0]?.message?.content || '';
    }

    /**
     * Anthropic with structured output
     */
    private async callAnthropicWithSchema(
        prompt: string,
        model: string,
        apiKey: string,
        schema: object,
        signal?: AbortSignal
    ): Promise<string> {
        // Anthropic doesn't support JSON Schema in the same way
        // We'll use prompt-based JSON with validation
        const enhancedPrompt = `${prompt}\n\nIMPORTANT: Respond with ONLY valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model,
                max_tokens: 12000,
                messages: [
                    { role: 'user', content: enhancedPrompt }
                ]
            }),
            signal: signal as any
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
            throw new Error(`Anthropic API error: ${error.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.content[0]?.text || '';
    }

    /**
     * Gemini with structured output
     */
    private async callGeminiWithSchema(
        prompt: string,
        model: string,
        apiKey: string,
        schema: object,
        signal?: AbortSignal
    ): Promise<string> {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    response_mime_type: 'application/json',
                    response_schema: schema,
                    maxOutputTokens: 12000,
                    temperature: 0.7
                }
            }),
            signal: signal as any
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
            throw new Error(`Gemini API error: ${error.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.candidates[0]?.content?.parts[0]?.text || '';
    }

    /**
     * Parse and validate write output
     */
    private async parseWriteOutput(response: string): Promise<WriteChapterOutput> {
        // Apply safe JSON recovery first
        const recovered = this.safeJsonRecovery(response);
        const parsed = JSON.parse(recovered);

        // Validate structure
        if (!parsed.paragraphs || !Array.isArray(parsed.paragraphs)) {
            throw new Error('Invalid cloud output: missing paragraphs array');
        }

        // Verify proseHash matches computed prose (async validation)
        const computedProse = parsed.paragraphs.map((p: any) => p.text).join('\n\n');
        const computedHash = await sha256(normalizeWhitespace(computedProse));
        if (parsed.proseHash && parsed.proseHash !== computedHash) {
            console.warn('[CloudRelay] proseHash mismatch - cloud provided hash does not match computed prose');
        }

        return parsed as WriteChapterOutput;
    }

    /**
     * Parse and validate edit output
     */
    private parseEditOutput(response: string): EditChapterOutput {
        const recovered = this.safeJsonRecovery(response);
        const parsed = JSON.parse(recovered);

        if (!parsed.resultParagraphs || !Array.isArray(parsed.resultParagraphs)) {
            throw new Error('Invalid cloud edit output: missing resultParagraphs array');
        }

        return parsed as EditChapterOutput;
    }

    /**
     * Safe JSON recovery - only safe transforms
     */
    private safeJsonRecovery(jsonText: string): string {
        // Attempt 1: Direct parse (fast path)
        let isValidJson = false;
        try { JSON.parse(jsonText); isValidJson = true; } catch { isValidJson = false; }
        if (isValidJson) return jsonText;

        // Recovery: Trim trailing junk after last valid bracket
        let trimmed = jsonText.trim();
        const lastBrace = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
        if (lastBrace > 0) {
            trimmed = trimmed.substring(0, lastBrace + 1);
        }

        // Recovery: Safe brace closure (only if diff <= 3)
        try {
            JSON.parse(trimmed);
            return trimmed;
        } catch (e2) {
            // Count and track order of brackets
            const stack: ('{' | '[')[] = [];
            for (let i = 0; i < trimmed.length; i++) {
                const char = trimmed[i];
                if (char === '{' || char === '[') {
                    stack.push(char);
                } else if (char === '}') {
                    if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop();
                } else if (char === ']') {
                    if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop();
                }
            }

            // Only attempt closure if diff <= 3
            if (stack.length > 0 && stack.length <= 3) {
                let recovered = trimmed;
                // Append missing closers in REVERSE order of stack
                while (stack.length > 0) {
                    const last = stack.pop();
                    recovered += (last === '{' ? '}' : ']');
                }

                try {
                    JSON.parse(recovered);
                    return recovered;
                } catch (e2) {
                    console.warn('[CloudRelay] JSON brace-closure recovery failed:', e2);
                }
            }
        }

        // All recovery attempts failed - throw original error
        throw new Error(`JSON recovery failed: ${jsonText.substring(0, 200)}...`);
    }
}

