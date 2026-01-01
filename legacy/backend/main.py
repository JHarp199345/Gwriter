from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict
import os

from services.ai_client import AIClient
from services.prompt_engine import PromptEngine
from services.context_aggregator import ContextAggregator
from services.character_extractor import CharacterExtractor

app = FastAPI(title="Writing Dashboard Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to Obsidian
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize services
ai_client = AIClient()
prompt_engine = PromptEngine()
context_aggregator = ContextAggregator()
character_extractor = CharacterExtractor()

class GenerateRequest(BaseModel):
    mode: str
    selectedText: Optional[str] = None
    directorNotes: Optional[str] = None
    wordCount: Optional[int] = 2000
    settings: Dict

class ExtractRequest(BaseModel):
    selectedText: str
    settings: Dict

@app.post("/api/generate/chapter")
async def generate_chapter(request: GenerateRequest):
    try:
        # Aggregate context
        context = await context_aggregator.get_chapter_context(
            vault_path=request.settings['vaultPath'],
            story_bible_path=request.settings['storyBiblePath'],
            extractions_path=request.settings['extractionsPath'],
            sliding_window_path=request.settings['slidingWindowPath'],
            book2_path=request.settings['book2Path']
        )
        
        # Build prompt
        prompt = prompt_engine.build_chapter_prompt(
            context=context,
            instructions=request.directorNotes or "",
            word_count=request.wordCount
        )
        
        # Generate
        result = await ai_client.generate(
            prompt=prompt,
            api_key=request.settings['apiKey'],
            provider=request.settings['apiProvider'],
            model=request.settings['model']
        )
        
        return {"text": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate/micro-edit")
async def generate_micro_edit(request: GenerateRequest):
    try:
        if not request.selectedText:
            raise HTTPException(status_code=400, detail="selectedText required")
        
        # Aggregate context
        context = await context_aggregator.get_micro_edit_context(
            vault_path=request.settings['vaultPath'],
            selected_text=request.selectedText,
            story_bible_path=request.settings['storyBiblePath'],
            extractions_path=request.settings['extractionsPath'],
            sliding_window_path=request.settings['slidingWindowPath'],
            character_folder=request.settings['characterFolder']
        )
        
        # Build prompt
        prompt = prompt_engine.build_micro_edit_prompt(
            selected_text=request.selectedText,
            director_notes=request.directorNotes or "",
            context=context
        )
        
        # Generate
        result = await ai_client.generate(
            prompt=prompt,
            api_key=request.settings['apiKey'],
            provider=request.settings['apiProvider'],
            model=request.settings['model']
        )
        
        return {"text": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/extract/characters")
async def extract_characters(request: ExtractRequest):
    try:
        # Get existing character notes
        character_notes = await context_aggregator.get_character_notes(
            vault_path=request.settings['vaultPath'],
            character_folder=request.settings['characterFolder']
        )
        
        # Get story bible for context
        from pathlib import Path
        vault = Path(request.settings['vaultPath'])
        story_bible = await context_aggregator._read_file(vault / request.settings['storyBiblePath'])
        
        # Build extraction prompt
        prompt = prompt_engine.build_character_extraction_prompt(
            selected_text=request.selectedText,
            character_notes=character_notes,
            story_bible=story_bible
        )
        
        # Extract
        extraction_result = await ai_client.generate(
            prompt=prompt,
            api_key=request.settings['apiKey'],
            provider=request.settings['apiProvider'],
            model=request.settings['model']
        )
        
        # Parse extraction into character updates
        updates = character_extractor.parse_extraction(extraction_result)
        
        return {"updates": updates}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

