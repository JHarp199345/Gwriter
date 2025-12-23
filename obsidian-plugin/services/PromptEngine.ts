export interface Context {
	smart_connections?: string;
	story_bible?: string;
	extractions?: string;
	sliding_window?: string;
	character_notes?: string;
	surrounding_before?: string;
	surrounding_after?: string;
}

export class PromptEngine {
	buildChapterPrompt(
		context: Context,
		rewriteInstructions: string,
		sceneSummary: string,
		minWords: number,
		maxWords: number
	): string {
		return `SYSTEM INSTRUCTION FOR AI (1M CONTEXT):

You are working on a multi-book narrative. Interpret the following file contents as directed:

-------------------------------------------------------------
RETRIEVED CONTEXT — RELEVANT NOTES (WHOLE VAULT)
-------------------------------------------------------------
${context.smart_connections || ''}

Use these excerpts to maintain continuity, tone, and world consistency.

-------------------------------------------------------------
STORY BIBLE + EXTRACTIONS — WORLD + RULESET
-------------------------------------------------------------
${context.story_bible || ''}
${context.extractions || ''}

These define rules of the world, character arcs, faction details, timelines, technology, tone, themes, motifs, and relationship structure.

-------------------------------------------------------------
SLIDING WINDOW — IMMEDIATE CONTEXT (LAST 20K WORDS)
-------------------------------------------------------------
${context.sliding_window || ''}

Continue directly from this. This is the most recent portion of your active manuscript.

-------------------------------------------------------------
REWRITE INSTRUCTIONS
-------------------------------------------------------------
${rewriteInstructions}

-------------------------------------------------------------
SCENE SUMMARY / DIRECTIONS
-------------------------------------------------------------
${sceneSummary}

-------------------------------------------------------------
TARGET LENGTH RANGE
-------------------------------------------------------------
Between ${minWords} and ${maxWords} words (aim for the middle unless the scene requires otherwise).

-------------------------------------------------------------
SUMMARY OF YOUR ROLE
-------------------------------------------------------------
- Retrieved context = continuity references from whole vault (including previous books)
- Sliding Window = direct lead-in (last 20k words of active manuscript)
- Story Bible + Extractions = world + theme rules
- Rewrite Instructions = style and constraints
- Scene Summary = outline to be rewritten into full prose

Continue writing using the sliding window context and retrieved references for continuity.
Maintain perfect continuity and match the author's voice.`;
	}

	buildMicroEditPrompt(selectedText: string, directorNotes: string, context: Context): string {
		return `SYSTEM INSTRUCTION FOR AI (1M CONTEXT):

You are a line editor working on a specific passage that needs refinement.

-------------------------------------------------------------
CONTEXT BEFORE SELECTED PASSAGE (500 words)
-------------------------------------------------------------
${context.surrounding_before || '[No preceding context available]'}

This is the text immediately before the passage to be edited. Use this to ensure smooth narrative flow and continuity.

-------------------------------------------------------------
SELECTED PASSAGE TO EDIT
-------------------------------------------------------------
${selectedText}

This is the passage the author wants revised.

-------------------------------------------------------------
CONTEXT AFTER SELECTED PASSAGE (500 words)
-------------------------------------------------------------
${context.surrounding_after || '[No following context available]'}

This is the text immediately after the passage to be edited. Use this to ensure smooth narrative flow and continuity.

-------------------------------------------------------------
AUTHOR GRIEVANCES + DIRECTIVES
-------------------------------------------------------------
${directorNotes}

The author's specific concerns, plot disagreements, style issues, or desired changes for this passage.

-------------------------------------------------------------
IMMEDIATE CONTEXT — SLIDING WINDOW
-------------------------------------------------------------
${context.sliding_window || ''}

This provides immediate narrative context around the selected passage.

-------------------------------------------------------------
STORY BIBLE + EXTRACTIONS — CANON CONSTRAINTS
-------------------------------------------------------------
${context.story_bible || ''}
${context.extractions || ''}

Maintain consistency with world rules, character arcs, and established canon.

-------------------------------------------------------------
CHARACTER NOTES — VOICE + CONTINUITY
-------------------------------------------------------------
${context.character_notes || ''}

Use these to maintain character voice, relationships, and arc progression.

-------------------------------------------------------------
RETRIEVED CONTEXT — STYLE ECHOES
-------------------------------------------------------------
${context.smart_connections || ''}

Similar passages for tone and style reference.

-------------------------------------------------------------
YOUR TASK
-------------------------------------------------------------
Generate a SINGLE refined alternative to the selected passage that:
1. Addresses all author grievances/directives
2. Maintains perfect continuity with surrounding context (especially the 500 words before and after)
3. Preserves character voice and established canon
4. Matches the author's writing style
5. Flows seamlessly when inserted into the manuscript, creating smooth transitions with the text before and after

Output ONLY the revised passage, ready to be copy-pasted into the manuscript.`;
	}

	buildContinuityCheckPrompt(params: {
		draft: string;
		context: Context;
		focus: { knowledge: boolean; timeline: boolean; pov: boolean; naming: boolean };
	}): string {
		const focusLines: string[] = [];
		if (params.focus.knowledge) focusLines.push('- Character knowledge state');
		if (params.focus.timeline) focusLines.push('- Timeline / injuries / locations');
		if (params.focus.pov) focusLines.push('- POV drift and voice consistency');
		if (params.focus.naming) focusLines.push('- Naming consistency / aliases');

		return `SYSTEM INSTRUCTION FOR AI:

You are a continuity QA editor for a long-form fiction project.

You will audit the provided draft against canon and context, then produce a concise report of continuity issues and suggested patches.

Focus areas:
${focusLines.length ? focusLines.join('\n') : '- General continuity'}

Rules:
- Evidence-based only: cite exact quotes from the draft and from context when possible.
- Do not invent canon. If something is unknown, mark it as \"Needs confirmation\".
- Keep the report short and actionable.

-------------------------------------------------------------
STORY BIBLE + EXTRACTIONS (CANON)
-------------------------------------------------------------
${params.context.story_bible || ''}
${params.context.extractions || ''}

-------------------------------------------------------------
CHARACTER NOTES (VOICE + STATE)
-------------------------------------------------------------
${params.context.character_notes || ''}

-------------------------------------------------------------
RETRIEVED CONTEXT (WHOLE VAULT)
-------------------------------------------------------------
${params.context.smart_connections || ''}

-------------------------------------------------------------
SLIDING WINDOW — IMMEDIATE CONTEXT (LAST 20K WORDS)
-------------------------------------------------------------
${params.context.sliding_window || ''}

-------------------------------------------------------------
DRAFT TO CHECK
-------------------------------------------------------------
${params.draft}

-------------------------------------------------------------
OUTPUT FORMAT (required)
-------------------------------------------------------------
## Continuity report
- Severity: Low | Medium | High
- Issue: ...
- Evidence (draft): \"...\"
- Evidence (canon/context): \"...\" (or [none found])
- Suggested fix: ...

## Suggested patches (optional)
- Provide small replacement blocks only when you are confident.
- If a patch is risky, do not provide it; keep it as a suggested fix instead.`;
	}

	buildCharacterExtractionPrompt(
		selectedText: string,
		characterNotes: Record<string, string>,
		storyBible: string,
		instructions: string,
		retrievedContext?: string
	): string {
		const characterNotesText = Object.entries(characterNotes)
			.map(([name, content]) => `## ${name}\n${content}`)
			.join('\n\n');
		
		return `SYSTEM INSTRUCTION FOR AI:

-------------------------------------------------------------
EXTRACTION INSTRUCTIONS
-------------------------------------------------------------
${instructions}

-------------------------------------------------------------
PASSAGE TO ANALYZE
-------------------------------------------------------------
${selectedText}

-------------------------------------------------------------
EXISTING CHARACTER NOTES (IF ANY)
-------------------------------------------------------------
${characterNotesText || '[No existing character notes]'}

Current state of character files. Update these with new information.

-------------------------------------------------------------
RETRIEVED CONTEXT — RELEVANT NOTES (WHOLE VAULT)
-------------------------------------------------------------
${retrievedContext || '[No retrieved context]'}

Use this for continuity. Do not invent facts.

-------------------------------------------------------------
STORY BIBLE — CONTEXT
-------------------------------------------------------------
${storyBible}

Use for world context and relationship structures.

-------------------------------------------------------------
OUTPUT FORMAT (required)
-------------------------------------------------------------
## Character Name
- Bullet updates only (no extra headings)

Only include characters with meaningful new information supported by the passage.
Do not invent facts.
Do not output any other sections.`;
	}

	buildCharacterRosterPrompt(passage: string, storyBible: string): string {
		return `SYSTEM INSTRUCTION FOR AI:

You are building a comprehensive character roster from a narrative text.

-------------------------------------------------------------
PASSAGE
-------------------------------------------------------------
${passage}

-------------------------------------------------------------
STORY BIBLE (context)
-------------------------------------------------------------
${storyBible || '[No story bible provided]'}

-------------------------------------------------------------
TASK
-------------------------------------------------------------
Extract ALL characters referenced in the passage, including:
- main characters
- side characters
- one-off named characters
- characters referenced by title or alias

Output one character per line in this exact format:
- Name | aliases: Alias1, Alias2

If no aliases are known, omit the aliases portion:
- Name

Only output the list. No extra commentary.`;
	}

	buildCharacterExtractionPromptWithRoster(params: {
		passage: string;
		roster: string;
		characterNotes: Record<string, string>;
		storyBible: string;
		retrievedContext?: string;
	}): string {
		const characterNotesText = Object.entries(params.characterNotes)
			.map(([name, content]) => `## ${name}\n${content}`)
			.join('\n\n');

		return `SYSTEM INSTRUCTION FOR AI:

You are extracting character information from a narrative passage.

-------------------------------------------------------------
GLOBAL CHARACTER ROSTER (from full manuscript scan)
-------------------------------------------------------------
${params.roster}

Use this roster to recognize characters even when only referred to by alias/title/pronoun.

-------------------------------------------------------------
PASSAGE TO ANALYZE
-------------------------------------------------------------
${params.passage}

-------------------------------------------------------------
EXISTING CHARACTER NOTES (IF ANY)
-------------------------------------------------------------
${characterNotesText || '[No existing character notes]'}

-------------------------------------------------------------
RETRIEVED CONTEXT — RELEVANT NOTES (WHOLE VAULT)
-------------------------------------------------------------
${params.retrievedContext || '[No retrieved context]'}

Use this for continuity. Do not invent facts.

-------------------------------------------------------------
STORY BIBLE — CONTEXT
-------------------------------------------------------------
${params.storyBible}

-------------------------------------------------------------
STRICT OUTPUT FORMAT
-------------------------------------------------------------
1) First output a section:

### Characters Mentioned
- Name
- Name

Only include names that appear in the passage (including aliases mapping to roster entries).

2) Then output ONE section per mentioned character (must use H2 headings exactly):

## CharacterName

**Voice Evidence:**
[quotes or narration evidence]

**New Traits:**
- [trait]: [evidence]

**Relationships:**
- **OtherCharacter**: [relationship change/evidence]

**Arc Progression:**
[what changed in this passage]

**Spoiler Notes:**
[any sensitive information]

If no new info is present for a mentioned character, still output the character section and write:
"No new character-relevant information in this passage."

Do not output any other sections.`;
	}

	buildStoryBibleDeltaPrompt(passage: string): string {
		return `SYSTEM INSTRUCTION FOR AI:

You are extracting story bible updates from a narrative passage.

Rules:
- Evidence-based only: do not invent facts.
- Prefer exact wording from the passage when possible.
- Only output new/changed information. If nothing new exists, output: [No new story bible updates]

Output format:
## Section
- Bullet updates only

Suggested sections:
- Characters
- Locations
- Factions
- Timeline
- World rules
- Technology or magic
- Terminology
- Open questions

-------------------------------------------------------------
PASSAGE
-------------------------------------------------------------
${passage}`;
	}

	buildStoryBibleMergePrompt(params: { existingStoryBible: string; delta: string }): string {
		return `SYSTEM INSTRUCTION FOR AI:

You are updating a story bible with a set of new evidence-based updates.

Goals:
- Preserve existing canon.
- Merge new information cleanly into the appropriate sections.
- If the delta conflicts with existing canon, do NOT guess. Add a "Conflicts to resolve" section listing the conflict.

Rules:
- Do not invent facts.
- Keep the story bible structured and readable.
- Maintain a consistent heading hierarchy.

-------------------------------------------------------------
EXISTING STORY BIBLE
-------------------------------------------------------------
${params.existingStoryBible}

-------------------------------------------------------------
NEW UPDATES (DELTA)
-------------------------------------------------------------
${params.delta}

-------------------------------------------------------------
OUTPUT
-------------------------------------------------------------
Return the full updated story bible markdown only.`;
	}
}

