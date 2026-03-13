import re
from typing import List, Dict

class CharacterExtractor:
    def parse_extraction(self, extraction_text: str) -> List[Dict[str, str]]:
        """
        Parse AI extraction output into structured character updates.
        Expected format:
        ## CharacterName
        ### timestamp - Update
        [content]
        """
        updates = self._parse_structured(extraction_text)
        if not updates:
            updates = self._parse_fallback(extraction_text)
        return updates

    def _parse_structured(self, text: str) -> List[Dict[str, str]]:
        updates = []
        sections = re.split(r'^##\s+(.+)$', text, flags=re.MULTILINE)
        for i in range(1, len(sections), 2):
            if i + 1 >= len(sections):
                continue
            character_name = sections[i].strip()
            content = sections[i + 1].strip()
            if not character_name or not content:
                continue
            update_content = re.sub(r'^###\s+.*?Update\s*\n', '', content, flags=re.MULTILINE).strip()
            if update_content:
                updates.append({'character': character_name, 'update': update_content})
        return updates

    def _parse_fallback(self, text: str) -> List[Dict[str, str]]:
        pattern = r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b'
        seen = set()
        updates = []
        for char_name in re.findall(pattern, text):
            if char_name not in seen and len(char_name.split()) <= 3:
                seen.add(char_name)
                updates.append({'character': char_name, 'update': text})
        return updates
