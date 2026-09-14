
import axios from 'axios';
import { config } from '../config';
import { Logger } from '../utils/logger';

/**
 * Universal AI client — supports OpenClaw, OpenAI, Gemini, OpenRouter,
 * or any OpenAI-compatible endpoint. Just set the provider in .env.
 */

const providerEndpoints: Record<string, string> = {
    openclaw: 'https://api.openclaw.com/v1/chat/completions',   // OpenClaw (OpenAI-compatible)
    openai: 'https://api.openai.com/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ollama: 'http://localhost:11434/v1/chat/completions',
};

export class AIBrain {
    private endpoint: string;
    private model: string;
    private apiKey: string;
    private tone: string;

    constructor() {
        const provider = config.ai.provider.toLowerCase();
        this.endpoint = providerEndpoints[provider]
            || providerEndpoints['openclaw']; // Default to OpenClaw
        this.model = config.ai.model;
        this.apiKey = config.ai.apiKey;
        this.tone = config.ai.tone;
    }

    /**
     * Generate a contextual, human-sounding comment for a post.
     * @param postCaption - The text caption of the Instagram post.
     * @param username    - Person who posted it.
     */
    async generateComment(postCaption: string, username: string): Promise<string> {
        const systemPrompt = `${this.tone}
        
Rules:
1. Never say "nice post", "great content", "amazing photo" — be SPECIFIC about what's in the post.
2. Max 10 words. No hashtags. At most 1 emoji.
3. Sound like a real person scrolling, not a brand.
4. If there's no caption, say something short and friendly about the image.
5. Never repeat the same comment twice.`;

        const userPrompt = `Post by @${username}: "${postCaption || '(no caption — reply about the vibe/image)'}"

Generate a single short, natural-sounding Instagram comment.`;

        return this.callLLM(systemPrompt, userPrompt);
    }

    /**
     * Generate a contextual DM reply.
     */
    async generateDMReply(incomingMessage: string, senderName: string): Promise<string> {
        const systemPrompt = `${this.tone}
        
You are replying to an Instagram DM. Keep it warm, casual, human. Max 2 sentences.
Never make up facts. If you don't know something, say "let me get back to you on that!"
Don't oversell. Don't use formal language.`;

        const userPrompt = `DM from @${senderName}: "${incomingMessage}"

Write a natural DM reply.`;

        return this.callLLM(systemPrompt, userPrompt);
    }

    private async callLLM(system: string, user: string): Promise<string> {
        if (config.ai.provider === 'none') {
            return this.getFallbackComment();
        }

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            
            if (config.ai.provider === 'gemini') {
                // Gemini uses x-goog-api-key
                headers['x-goog-api-key'] = this.apiKey;
            } else {
                headers['Authorization'] = `Bearer ${this.apiKey}`;
            }

            const resp = await axios.post(
                this.endpoint,
                {
                    model: this.model,
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: user }
                    ],
                    max_tokens: 60,
                    temperature: 0.85
                },
                { headers, timeout: 15000 }
            );

            const text = resp.data?.choices?.[0]?.message?.content?.trim();
            if (!text) return this.getFallbackComment();

            // Strip wrapping quotes from LLM output if present
            return text.replace(/^["']|["']$/g, '');
        } catch (err: any) {
            Logger.error(`AI request failed: ${err.message}`);
            return this.getFallbackComment();
        }
    }

    private getFallbackComment(): string {
        const templates = [
            "Love this 🔥",
            "This is so good",
            "Needed this today",
            "So well done",
            "This hits different",
            "Really cool work",
            "Vibes ✨",
            "Insane quality",
            "Saved this one",
            "Respect 💯"
        ];
        return templates[Math.floor(Math.random() * templates.length)];
    }
}
