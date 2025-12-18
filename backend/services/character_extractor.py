import re
from typing import List, Dict
from datetime import datetime

class CharacterExtractor:
    def parse_extraction(self, extraction_text: str) -> List[Dict[str, str]]:
        """
        Parse AI extraction output into structured character updates.
        Expected format:
        ## CharacterName
        ### timestamp - Update
        [content]
        """
        updates = []
        
        # Split by character sections (## CharacterName)
        character_sections = re.split(r'^##\s+(.+)$', extraction_text, flags=re.MULTILINE)
        
        for i in range(1, len(character_sections), 2):
            if i + 1 < len(character_sections):
                character_name = character_sections[i].strip()
                content = character_sections[i + 1].strip()
                
                if character_name and content:
                    # Extract the update content (everything after the header)
                    # Remove the timestamp header if present
                    update_content = re.sub(r'^###\s+.*?Update\s*\n', '', content, flags=re.MULTILINE)
                    update_content = update_content.strip()
                    
                    if update_content:
                        updates.append({
                            'character': character_name,
                            'update': update_content
                        })
        
        # If no structured format found, try to extract character names from text
        if not updates:
            # Look for character names mentioned in the text
            character_pattern = r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b'
            potential_characters = re.findall(character_pattern, extraction_text)
            
            # Simple heuristic: if we find potential character names, create updates
            # This is a fallback - the AI should ideally follow the format
            if potential_characters:
                # Group by potential character name
                seen = set()
                for char_name in potential_characters:
                    if char_name not in seen and len(char_name.split()) <= 3:
                        seen.add(char_name)
                        updates.append({
                            'character': char_name,
                            'update': extraction_text
                        })
        
        return updates

