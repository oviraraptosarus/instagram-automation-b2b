
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

export const config = {
    ai: {
        provider: process.env.AI_PROVIDER || 'openclaw', // openclaw, openai, gemini, openrouter, none
        apiKey: process.env.AI_API_KEY || '',
        model: process.env.AI_MODEL_NAME || 'gpt-4o-mini',
        tone: process.env.AI_TONE_INSTRUCTION || 'Act as a friendly, supportive creator. Keep comments short (1-2 sentences), genuine.'
    },
    safety: {
        profile: process.env.SAFETY_PROFILE || 'balanced', // safe, balanced, active
        sleepStart: parseInt(process.env.SLEEP_START_HOUR || '23', 10),
        sleepEnd: parseInt(process.env.SLEEP_END_HOUR || '8', 10)
    },
    targeting: {
        hashtags: (process.env.TARGET_HASHTAGS || 'tech,coding,software').split(',').map(h => h.trim()),
        accountContext: process.env.ACCOUNT_CONTEXT || '',
    },
    filtering: {
        strictRelevance: process.env.STRICT_RELEVANCE_CHECK === 'true'
    },
    modules: {
        feedLike: process.env.ENABLE_AUTO_LIKE_FEED !== 'false',
        feedComment: process.env.ENABLE_AUTO_COMMENT_FEED === 'true',
        hashtagLike: process.env.ENABLE_AUTO_LIKE_HASHTAGS !== 'false',
        hashtagComment: process.env.ENABLE_AUTO_COMMENT_HASHTAGS === 'true',
        dmReply: process.env.ENABLE_DM_AUTO_REPLY === 'true'
    },
    dashboard: {
        port: parseInt(process.env.DASHBOARD_PORT || '3456', 10)
    },
    dm: {
        // Max threads inspected per inbox sweep (keeps a sweep bounded).
        maxThreadsPerSweep: parseInt(process.env.DM_MAX_THREADS_PER_SWEEP || '5', 10),
        // Skip threads whose last inbound message is older than this.
        maxThreadAgeHours: parseInt(process.env.DM_MAX_THREAD_AGE_HOURS || '48', 10),
        // Never send more than one reply to the same thread within this window.
        replyCooldownMinutes: parseInt(process.env.DM_REPLY_COOLDOWN_MINUTES || '180', 10),
        // Require the AI to classify intent before replying.
        qualifyLeads: process.env.DM_QUALIFY_LEADS !== 'false',
        // Hand off to a human instead of replying when intent is high-value.
        handoffOnHotLead: process.env.DM_HANDOFF_ON_HOT_LEAD !== 'false',
        // Never auto-reply to these intents (comma separated).
        neverReplyIntents: (process.env.DM_NEVER_REPLY_INTENTS || 'SPAM,ABUSE,SALES_PITCH')
            .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    },
    paths: {
        // NOTE: resolves to <projectRoot>/data from BOTH src/ (ts-node) and dist/ (compiled).
        // Previously used '../../data', which escaped the project root and wrote to $HOME.
        userDataDir: path.join(__dirname, '../data/browser_profile'),
        dataDir: path.join(__dirname, '../data'),
        statsFile: path.join(__dirname, '../data/stats.json'),
        logsFile: path.join(__dirname, '../data/app.log')
    }
};

export const profiles = {
    safe: {
        dailyLikes: 30, hourlyLikes: 8,
        dailyComments: 10, hourlyComments: 3,
        dailyDMs: 15, hourlyDMs: 4,
        jitterMinSec: 45, jitterMaxSec: 120
    },
    balanced: {
        dailyLikes: 70, hourlyLikes: 15,
        dailyComments: 25, hourlyComments: 6,
        dailyDMs: 30, hourlyDMs: 8,
        jitterMinSec: 30, jitterMaxSec: 90
    },
    active: {
        dailyLikes: 150, hourlyLikes: 25,
        dailyComments: 50, hourlyComments: 12,
        dailyDMs: 60, hourlyDMs: 15,
        jitterMinSec: 15, jitterMaxSec: 45
    }
};

export function getActiveLimits() {
    return profiles[config.safety.profile as keyof typeof profiles] || profiles.balanced;
}
