import openai
from anthropic import Anthropic
import google.generativeai as genai
from typing import Optional

class AIClient:
    async def generate(
        self,
        prompt: str,
        api_key: str,
        provider: str,
        model: str,
        max_tokens: Optional[int] = None
    ) -> str:
        if provider == 'openai':
            return await self._generate_openai(prompt, api_key, model, max_tokens)
        elif provider == 'anthropic':
            return await self._generate_anthropic(prompt, api_key, model, max_tokens)
        elif provider == 'gemini':
            return await self._generate_gemini(prompt, api_key, model, max_tokens)
        else:
            raise ValueError(f"Unsupported provider: {provider}")
    
    async def _generate_openai(self, prompt: str, api_key: str, model: str, max_tokens: Optional[int]) -> str:
        client = openai.OpenAI(api_key=api_key)
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "You are a professional writing assistant."},
                {"role": "user", "content": prompt}
            ],
            max_tokens=max_tokens or 4000,
            temperature=0.7
        )
        return response.choices[0].message.content
    
    async def _generate_anthropic(self, prompt: str, api_key: str, model: str, max_tokens: Optional[int]) -> str:
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens or 4000,
            messages=[
                {"role": "user", "content": prompt}
            ]
        )
        return response.content[0].text
    
    async def _generate_gemini(self, prompt: str, api_key: str, model: str, max_tokens: Optional[int]) -> str:
        genai.configure(api_key=api_key)
        model_instance = genai.GenerativeModel(model)
        response = model_instance.generate_content(
            prompt,
            generation_config={
                'max_output_tokens': max_tokens or 4000,
                'temperature': 0.7
            }
        )
        return response.text

