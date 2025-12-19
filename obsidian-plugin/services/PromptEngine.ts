export interface Context {
	smart_connections?: string;
	book2?: string;
	story_bible?: string;
	extractions?: string;
	sliding_window?: string;
	character_notes?: string;
	surrounding_before?: string;
	surrounding_after?: string;
}

export class PromptEngine {
	buildChapterPrompt(context: Context, instructions: string, wordCount: number): string {
		return `SYSTEM INSTRUCTION FOR AI (1M CONTEXT):

You are working on a multi-book narrative. Interpret the following file contents as directed:

-------------------------------------------------------------
BOOK 1 — CANON (LOADED VIA SMART CONNECTIONS)
-------------------------------------------------------------
${context.smart_connections || ''}

Use these excerpts to maintain continuity, tone, and world consistency.
Do NOT contradict Book 1 canon.

-------------------------------------------------------------
BOOK 2 — ACTIVE MANUSCRIPT (CONTINUE THIS)
-------------------------------------------------------------
${context.book2 || ''}

Continue this manuscript.

-------------------------------------------------------------
STORY BIBLE + EXTRACTIONS — WORLD + RULESET
-------------------------------------------------------------
${context.story_bible || ''}
${context.extractions || ''}

These define rules of the world, character arcs, faction details, timelines, technology, tone, themes, motifs, and relationship structure.
These override Book 2 in cases of conflict.

-------------------------------------------------------------
SLIDING WINDOW — IMMEDIATE CONTEXT
-------------------------------------------------------------
${context.sliding_window || ''}

Continue directly from this.

-------------------------------------------------------------
AUTHOR INSTRUCTIONS
-------------------------------------------------------------
${instructions}

Author provides summary of events to be written or directions (like a director) or both.

-------------------------------------------------------------
TARGET WORD COUNT
-------------------------------------------------------------
${wordCount} words

-------------------------------------------------------------
SUMMARY OF YOUR ROLE
-------------------------------------------------------------
- Book 1 = immutable canon
- Book 2 = active writing
- Story Bible + Extractions = world + theme rules
- Sliding Window = direct lead-in
- Instructions = style constraints

Continue writing Book 2 using all provided context.
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
SMART CONNECTIONS — STYLE ECHOES
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

	buildCharacterExtractionPrompt(selectedText: string, characterNotes: Record<string, string>, storyBible: string): string {
		const characterNotesText = Object.entries(characterNotes)
			.map(([name, content]) => `## ${name}\n${content}`)
			.join('\n\n');
		
		return `SYSTEM INSTRUCTION FOR AI:

You are extracting character information from a narrative passage.

-------------------------------------------------------------
PASSAGE TO ANALYZE
-------------------------------------------------------------
${selectedText}

Extract character-relevant information from this passage.

-------------------------------------------------------------
EXISTING CHARACTER NOTES (IF ANY)
-------------------------------------------------------------
${characterNotesText || '[No existing character notes]'}

Current state of character files. Update these with new information.

-------------------------------------------------------------
STORY BIBLE — CONTEXT
-------------------------------------------------------------
${storyBible}

Use for world context and relationship structures.

-------------------------------------------------------------
EXTRACTION TASK
-------------------------------------------------------------
Analyze the passage and extract:

1. **Character Identities**
   - Names mentioned
   - New aliases or titles
   - Role/function in scene

2. **Voice Evidence**
   - Syntax patterns
   - Speech cadence
   - Verbal tells or quirks
   - Dialogue style

3. **New Traits/Revelations**
   - Physical descriptions
   - Personality traits
   - Skills/abilities shown
   - Emotional states

4. **Relationship Dynamics**
   - Interactions with other characters
   - Relationship changes or revelations
   - Power dynamics shifts

5. **Arc Progression**
   - Character development shown
   - Motivations revealed or changed
   - Goals/conflicts introduced
   - Status changes

6. **Spoiler-Sensitive Information**
   - What must not be revealed yet
   - Foreshadowing present

Output in the following format for each character found:

## {{CharacterName}}

### {{timestamp}} - Update

**Voice Evidence:**
[quoted dialogue or narration with page/chapter reference]

**New Traits:**
- [trait]: [evidence]

**Relationships:**
- **{{OtherCharacter}}**: [relationship change/evidence]

**Arc Progression:**
[what changed in this passage]

**Spoiler Notes:**
[any sensitive information to track]

---

This will be appended to the character's note file with timestamp.`;
	}
}

