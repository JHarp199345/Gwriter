from typing import Dict, Any

class PromptEngine:
    def build_chapter_prompt(self, context: Dict[str, Any], instructions: str, word_count: int) -> str:
        return f"""SYSTEM INSTRUCTION FOR AI (1M CONTEXT):

You are working on a multi-book narrative. Interpret the following file contents as directed:

-------------------------------------------------------------
BOOK 1 — CANON (LOADED VIA SMART CONNECTIONS)
-------------------------------------------------------------
{context.get('smart_connections', '')}

Use these excerpts to maintain continuity, tone, and world consistency.
Do NOT contradict Book 1 canon.

-------------------------------------------------------------
BOOK 2 — ACTIVE MANUSCRIPT (CONTINUE THIS)
-------------------------------------------------------------
{context.get('book2', '')}

Continue this manuscript.

-------------------------------------------------------------
STORY BIBLE + EXTRACTIONS — WORLD + RULESET
-------------------------------------------------------------
{context.get('story_bible', '')}
{context.get('extractions', '')}

These define rules of the world, character arcs, faction details, timelines, technology, tone, themes, motifs, and relationship structure.
These override Book 2 in cases of conflict.

-------------------------------------------------------------
SLIDING WINDOW — IMMEDIATE CONTEXT
-------------------------------------------------------------
{context.get('sliding_window', '')}

Continue directly from this.

-------------------------------------------------------------
AUTHOR INSTRUCTIONS
-------------------------------------------------------------
{instructions}

Author provides summary of events to be written or directions (like a director) or both.

-------------------------------------------------------------
TARGET WORD COUNT
-------------------------------------------------------------
{word_count} words

-------------------------------------------------------------
SUMMARY OF YOUR ROLE
-------------------------------------------------------------
- Book 1 = immutable canon
- Book 2 = active writing
- Story Bible + Extractions = world + theme rules
- Sliding Window = direct lead-in
- Instructions = style constraints

Continue writing Book 2 using all provided context.
Maintain perfect continuity and match the author's voice."""

    def build_micro_edit_prompt(self, selected_text: str, director_notes: str, context: Dict[str, Any]) -> str:
        return f"""SYSTEM INSTRUCTION FOR AI (1M CONTEXT):

You are a line editor working on a specific passage that needs refinement.

-------------------------------------------------------------
SELECTED PASSAGE TO EDIT
-------------------------------------------------------------
{selected_text}

This is the passage the author wants revised.

-------------------------------------------------------------
AUTHOR GRIEVANCES + DIRECTIVES
-------------------------------------------------------------
{director_notes}

The author's specific concerns, plot disagreements, style issues, or desired changes for this passage.

-------------------------------------------------------------
IMMEDIATE CONTEXT — SLIDING WINDOW
-------------------------------------------------------------
{context.get('sliding_window', '')}

This provides immediate narrative context around the selected passage.

-------------------------------------------------------------
STORY BIBLE + EXTRACTIONS — CANON CONSTRAINTS
-------------------------------------------------------------
{context.get('story_bible', '')}
{context.get('extractions', '')}

Maintain consistency with world rules, character arcs, and established canon.

-------------------------------------------------------------
CHARACTER NOTES — VOICE + CONTINUITY
-------------------------------------------------------------
{context.get('character_notes', '')}

Use these to maintain character voice, relationships, and arc progression.

-------------------------------------------------------------
SMART CONNECTIONS — STYLE ECHOES
-------------------------------------------------------------
{context.get('smart_connections', '')}

Similar passages for tone and style reference.

-------------------------------------------------------------
YOUR TASK
-------------------------------------------------------------
Generate a SINGLE refined alternative to the selected passage that:
1. Addresses all author grievances/directives
2. Maintains perfect continuity with surrounding context
3. Preserves character voice and established canon
4. Matches the author's writing style
5. Flows seamlessly when inserted into the manuscript

Output ONLY the revised passage, ready to be copy-pasted into the manuscript."""

    def build_character_extraction_prompt(self, selected_text: str, character_notes: Dict[str, str], story_bible: str) -> str:
        character_notes_text = "\n\n".join([f"## {name}\n{content}" for name, content in character_notes.items()])
        
        return f"""SYSTEM INSTRUCTION FOR AI:

You are extracting character information from a narrative passage.

-------------------------------------------------------------
PASSAGE TO ANALYZE
-------------------------------------------------------------
{selected_text}

Extract character-relevant information from this passage.

-------------------------------------------------------------
EXISTING CHARACTER NOTES (IF ANY)
-------------------------------------------------------------
{character_notes_text}

Current state of character files. Update these with new information.

-------------------------------------------------------------
STORY BIBLE — CONTEXT
-------------------------------------------------------------
{story_bible}

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

This will be appended to the character's note file with timestamp."""

