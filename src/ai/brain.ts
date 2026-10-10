
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

/** Classified intent of an inbound DM. Drives reply vs escalate vs ignore. */
export type DMIntent =
    | 'HOT_LEAD'
    | 'WARM_LEAD'
    | 'QUESTION'
    | 'COMPLIMENT'
    | 'SPAM'
    | 'ABUSE'
    | 'SALES_PITCH'
    | 'OTHER'
    | 'UNKNOWN';

/**
 * Per-account AI overrides. When omitted the global .env values are used, so
 * single-account setups keep working unchanged.
 *
 * This exists because AIBrain previously read ONLY the global config, which
 * meant every account in a multi-account run shared one identity, one offer
 * and one tone — the model would pitch account B's offer in account A's DMs.
 */
export interface BrainContext {
    accountId?: string;
    tone?: string;
    accountContext?: string;
}

export class AIBrain {
    private endpoint: string;
    private model: string;
    private apiKey: string;
    private tone: string;
    private accountContext: string;
    private accountId: string;

    constructor(ctx: BrainContext = {}) {
        const provider = config.ai.provider.toLowerCase();
        this.endpoint = providerEndpoints[provider]
            || providerEndpoints['openclaw']; // Default to OpenClaw
        this.model = config.ai.model;
        this.apiKey = config.ai.apiKey;
        // Per-account values win; fall back to the global .env defaults.
        this.tone = ctx.tone || config.ai.tone;
        this.accountContext = ctx.accountContext ?? config.targeting.accountContext;
        this.accountId = ctx.accountId || 'global';
    }

    /** The business/offer context this brain is grounded in. */
    public getAccountContext(): string {
        return this.accountContext;
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

        return this.callLLM(systemPrompt, userPrompt) as Promise<string>;
    }


    /**
     * Relevancy check to ensure we only interact with potential leads or peers.
     */
    async isPostRelevant(postCaption: string, username: string): Promise<boolean> {
        if (!config.filtering.strictRelevance) return true;
        if (!this.accountContext) return true;

        const systemPrompt = `You are a strict filtering AI for an Instagram account.
Account Context: "${this.accountContext}"

Analyze the post. Is it relevant to this account (e.g., a potential client, a lead, a peer in the exact same niche, or relevant industry news)?
If it is unrelated to the account's niche, personal noise, or random spam, reject it.
Respond ONLY with the word YES or NO.`;

        const userPrompt = `Post by @${username}: "${postCaption || '(no caption)'}"`;

        const response = await this.callLLM(systemPrompt, userPrompt, { allowFallback: false });
        // Fail closed: if the relevance model is unavailable we skip the post
        // rather than engaging blind. Strict mode is opt-in and should stay strict.
        if (!response) {
            Logger.warn('Relevance check unavailable — skipping post (fail-closed)');
            return false;
        }
        return response.toUpperCase().includes('YES');
    }

    /**
     * Generate a contextual DM reply, grounded in the business context so the
     * model cannot invent offers, pricing or availability.
     *
     * `history` is the recent thread transcript (oldest first) so replies stay
     * coherent across a multi-message conversation instead of answering the
     * last line in isolation.
     */
    async generateDMReply(
        incomingMessage: string,
        senderName: string,
        opts: { history?: string[]; intent?: DMIntent } = {}
    ): Promise<string | null> {
        const businessContext = this.accountContext
            ? `Your business context: ${this.accountContext}`
            : 'You have no specific business context — stay generic and friendly.';

        const systemPrompt = `${this.tone}

You are replying to an Instagram DM. Keep it warm, casual, human. Max 2 sentences.
${businessContext}

Hard rules:
1. NEVER invent prices, discounts, delivery times, guarantees or features.
2. If asked something you cannot know, say you'll follow up — do not guess.
3. No formal/corporate language. No bullet points. No emoji spam (max 1).
4. Do not paste links unless the incoming message explicitly asked for one.
5. Never repeat the sender's message back to them verbatim.${
            opts.intent ? `\n6. The sender's detected intent is ${opts.intent}. Reply appropriately.` : ''
        }`;

        const transcript = (opts.history && opts.history.length)
            ? `Recent conversation (oldest first):\n${opts.history.join('\n')}\n\n`
            : '';

        const userPrompt = `${transcript}Latest DM from @${senderName}: "${incomingMessage}"

Write a natural DM reply.`;

        // No silent template fallback for DMs: a canned "Love this 🔥" sent into
        // someone's inbox is worse than staying silent. Null means "skip".
        return this.callLLM(systemPrompt, userPrompt, { allowFallback: false });
    }

    /**
     * Classify an inbound DM so the engine can decide whether to auto-reply,
     * escalate to a human, or ignore it entirely.
     *
     * Returns 'UNKNOWN' when the model is unavailable — callers treat UNKNOWN
     * as "do not auto-reply" so an AI outage cannot cause blind replies.
     */
    async classifyDMIntent(incomingMessage: string, senderName: string): Promise<DMIntent> {
        if (config.ai.provider === 'none') return 'UNKNOWN';

        const systemPrompt = `You are a strict intent classifier for inbound Instagram DMs.
${this.accountContext ? `Business context: ${this.accountContext}` : ''}

Reply with EXACTLY ONE of these labels and nothing else:
HOT_LEAD      - explicitly wants to buy, asks price/availability, wants a call
WARM_LEAD     - curious about the offer, asking how it works, soft interest
QUESTION      - genuine non-sales question
COMPLIMENT    - praise, fan message, emoji-only positivity
SPAM          - bot, giveaway, crypto, follow-for-follow, mass blast
ABUSE         - hostile, harassing, sexual or threatening
SALES_PITCH   - they are selling something TO you (agency/SMMA outreach)
OTHER         - none of the above`;

        const userPrompt = `DM from @${senderName}: "${incomingMessage}"\n\nLabel:`;

        const raw = await this.callLLM(systemPrompt, userPrompt, {
            allowFallback: false,
            maxTokens: 8,
            temperature: 0,
        });

        if (!raw) return 'UNKNOWN';

        const normalized = raw.toUpperCase().replace(/[^A-Z_]/g, '');
        const valid: DMIntent[] = [
            'HOT_LEAD', 'WARM_LEAD', 'QUESTION', 'COMPLIMENT',
            'SPAM', 'ABUSE', 'SALES_PITCH', 'OTHER',
        ];
        const hit = valid.find(v => normalized.includes(v));
        return hit ?? 'UNKNOWN';
    }

    /**
     * Single LLM call with bounded exponential backoff.
     *
     * Previously a single transient failure fell straight through to the canned
     * template list, which is exactly the generic spam the product claims to
     * avoid. Now: retry transient faults (5xx/429/timeouts), fail fast on
     * auth/4xx, and only use the template list when the caller opts in.
     */
    private async callLLM(
        system: string,
        user: string,
        opts: { allowFallback?: boolean; maxTokens?: number; temperature?: number } = {}
    ): Promise<string | null> {
        const allowFallback = opts.allowFallback !== false;

        if (config.ai.provider === 'none') {
            return allowFallback ? this.getFallbackComment() : null;
        }

        const maxAttempts = 3;
        let lastErr = '';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
                        max_tokens: opts.maxTokens ?? 60,
                        temperature: opts.temperature ?? 0.85
                    },
                    { headers, timeout: 15000 }
                );

                const text = resp.data?.choices?.[0]?.message?.content?.trim();
                if (!text) {
                    lastErr = 'empty completion';
                    break; // A 200 with no content will not fix itself on retry.
                }

                // Strip wrapping quotes from LLM output if present
                return text.replace(/^["']|["']$/g, '');
            } catch (err: any) {
                lastErr = err.message || String(err);
                const status = err.response?.status;

                // Auth / bad request / not found are permanent — stop immediately.
                if (status && status !== 429 && status < 500) {
                    Logger.error(`AI request failed permanently (HTTP ${status}): ${lastErr}`);
                    break;
                }

                if (attempt < maxAttempts) {
                    const backoffMs = 800 * Math.pow(2, attempt - 1); // 800ms, 1.6s
                    Logger.warn(`AI request failed (attempt ${attempt}/${maxAttempts}): ${lastErr}. Retrying in ${backoffMs}ms`);
                    await new Promise(r => setTimeout(r, backoffMs));
                }
            }
        }

        Logger.error(`AI request failed after retries: ${lastErr}`);
        return allowFallback ? this.getFallbackComment() : null;
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
