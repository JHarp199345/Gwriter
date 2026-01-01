import os
from pathlib import Path
from typing import Dict, Any, List
import json

class ContextAggregator:
    def __init__(self):
        pass
    
    async def get_chapter_context(
        self,
        vault_path: str,
        story_bible_path: str,
        extractions_path: str,
        sliding_window_path: str,
        book2_path: str
    ) -> Dict[str, Any]:
        vault = Path(vault_path)
        
        return {
            'smart_connections': await self._get_smart_connections(vault),
            'book2': await self._read_file(vault / book2_path),
            'story_bible': await self._read_file(vault / story_bible_path),
            'extractions': await self._read_file(vault / extractions_path),
            'sliding_window': await self._read_file(vault / sliding_window_path)
        }
    
    async def get_micro_edit_context(
        self,
        vault_path: str,
        selected_text: str,
        story_bible_path: str,
        extractions_path: str,
        sliding_window_path: str,
        character_folder: str
    ) -> Dict[str, Any]:
        vault = Path(vault_path)
        
        return {
            'sliding_window': await self._read_file(vault / sliding_window_path),
            'story_bible': await self._read_file(vault / story_bible_path),
            'extractions': await self._read_file(vault / extractions_path),
            'character_notes': await self._format_character_notes(await self._get_all_character_notes(vault / character_folder)),
            'smart_connections': await self._get_smart_connections(vault, limit=32)
        }
    
    async def get_character_notes(self, vault_path: str, character_folder: str) -> Dict[str, str]:
        vault = Path(vault_path)
        return await self._get_all_character_notes(vault / character_folder)
    
    async def _read_file(self, file_path: Path) -> str:
        try:
            return file_path.read_text(encoding='utf-8')
        except Exception as e:
            return f"[Error reading file: {e}]"
    
    async def _get_smart_connections(self, vault: Path, limit: int = 64) -> str:
        # Try to read Smart Connections data
        sc_data_path = vault / '.obsidian' / 'plugins' / 'smart-connections' / 'data.json'
        if sc_data_path.exists():
            try:
                # Parse Smart Connections embeddings and return similar notes
                # This is a simplified version - actual implementation would need
                # to understand Smart Connections' embedding format
                data = json.loads(sc_data_path.read_text(encoding='utf-8'))
                # For now, return a placeholder - full implementation would
                # query embeddings and return actual similar note content
                return "[Smart Connections data loaded - similarity search available]"
            except Exception as e:
                return f"[Smart Connections: Error loading data - {e}]"
        return "[Smart Connections: No data found - ensure plugin is installed and has indexed your vault]"
    
    async def _get_all_character_notes(self, character_folder: Path) -> Dict[str, str]:
        notes = {}
        if not character_folder.exists():
            return notes
        
        for file_path in character_folder.glob('*.md'):
            character_name = file_path.stem
            notes[character_name] = await self._read_file(file_path)
        
        return notes
    
    async def _format_character_notes(self, character_notes: Dict[str, str]) -> str:
        """Format character notes for inclusion in prompts"""
        if not character_notes:
            return "[No character notes found]"
        
        formatted = []
        for name, content in character_notes.items():
            formatted.append(f"## {name}\n{content}\n")
        
        return "\n---\n\n".join(formatted)

