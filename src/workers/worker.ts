import { BrowserEngine } from '../engine/browser';
import { AIBrain } from '../ai/brain';
import { Storage } from '../utils/storage';
import { Logger } from '../utils/logger';
import { Humanizer } from '../engine/humanizer';
import { DMEngine } from '../engine/dm-engine';
import { QuotaLedger } from '../storage/quota-ledger';
import { upsertAccountRow } from '../storage/db';
import { config, getActiveLimits } from '../config';
import type { Page } from 'playwright';

export class AccountWorker {
    private accountId: string;
    private browserEngine: BrowserEngine;
    private storage: Storage;
    private logger: Logger;
    private brain: AIBrain;
    private isRunning: boolean = false;
    private page: Page | null = null;
    private dmEngine: DMEngine;
    private safetyProfile: string;
    /** This account's own hashtag set (falls back to global .env). */
    private hashtags: string[];
    /** Rotates DM sweeps and engagement cycles so DMs are never starved. */
    private cycleCount: number = 0;

    constructor(
        accountId: string,
        browserEngine: BrowserEngine,
        storage: Storage,
        logger: Logger,
        brain: AIBrain,
        safetyProfile: string = config.safety.profile,
        hashtags?: string[]
    ) {
        this.accountId = accountId;
        this.browserEngine = browserEngine;
        this.storage = storage;
        this.logger = logger;
        this.brain = brain;
        this.safetyProfile = safetyProfile;
        // Per-account hashtags; fall back to the global .env list.
        this.hashtags = hashtags?.length ? hashtags : config.targeting.hashtags;
        this.dmEngine = new DMEngine(accountId, brain, logger, safetyProfile);
    }

    public getIsRunning(): boolean {
        return this.isRunning;
    }

    /** Begin the action loop: launch browser, verify session, then run cycles. */
    async start(): Promise<void> {
        this.logger.info(`Starting action loop`);
        this.isRunning = true;

        // Mirror this account into SQLite up front: quotas/interactions carry
        // FKs to accounts(id), so without this every ledger write would fail.
        try {
            upsertAccountRow({
                id: this.accountId,
                username: this.accountId,
                safetyProfile: this.safetyProfile,
                authenticated: true,
                enabled: true,
                status: 'RUNNING',
            });
        } catch (err: any) {
            this.logger.warn(`Account row sync failed: ${err.message}`);
        }

        try {
            this.page = await this.browserEngine.launch(true);
        } catch (err: any) {
            this.logger.error(`Failed to launch browser: ${err.message}`);
            this.isRunning = false;
            return;
        }

        // Verify session is still valid before entering the loop
        try {
            await this.page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
            await Humanizer.randomPause(2, 5);

            const loginInput = await this.page.$('input[name="username"]');
            if (loginInput) {
                this.logger.error(`Session expired — login form detected. Stopping worker.`);
                this.isRunning = false;
                return;
            }
        } catch (err: any) {
            if (this.isAuthError(err)) {
                this.logger.error(`Session check failed due to auth error: ${err.message}. Stopping worker.`);
                this.isRunning = false;
                return;
            }
            this.logger.error(`Error during initial session check: ${err.message}`);
        }

        this.logger.success(`Session verified. Surfing and engaging...`);

        // --- MAIN EVENT LOOP ---
        while (this.isRunning) {
            try {
                // 1. Sleep cycle check
                if (this.sleepUntilMorning()) {
                    this.logger.info(`Sleep rhythm active. Waiting...`);
                    await Humanizer.randomPause(1800, 3600);
                    continue;
                }

                this.cycleCount++;

                // 2. DM sweep — runs every other cycle so the inbox is serviced
                //    promptly without crowding out engagement. Gated by its own
                //    DM quota inside DMEngine.
                if (config.modules.dmReply && this.cycleCount % 2 === 1) {
                    await this.runDMCycle(this.page);
                    await Humanizer.cooldownPause();
                    continue;
                }

                // 3. Engagement cycle — quota now comes from the transactional
                //    ledger, not the JSON stats file that nothing enforced.
                const canLike = QuotaLedger.hasBudget(this.accountId, 'LIKE', this.safetyProfile);
                const canComment = QuotaLedger.hasBudget(this.accountId, 'COMMENT', this.safetyProfile);

                if ((config.modules.hashtagLike && canLike) || (config.modules.hashtagComment && canComment)) {
                    await this.runCycle(this.page);
                } else {
                    const snap = QuotaLedger.snapshot(this.accountId);
                    const limits = getActiveLimits();
                    this.logger.info(
                        `Engagement quota reached (likes ${snap.likesToday}/${limits.dailyLikes}, ` +
                        `comments ${snap.commentsToday}/${limits.dailyComments}). Waiting...`
                    );
                    await Humanizer.randomPause(600, 1200);
                }

                // 4. Cooldown between cycles
                await Humanizer.cooldownPause();
            } catch (err: any) {
                if (this.isAuthError(err)) {
                    this.logger.error(`Auth error detected: ${err.message}. Stopping gracefully.`);
                    this.isRunning = false;
                    break;
                }
                this.logger.error(`Loop error: ${err.message}. Restarting in 60s...`);
                await Humanizer.randomPause(60, 120);
            }
        }

        this.logger.info(`Worker stopped.`);
    }

    /**
     * Run one DM inbox sweep. All safety gating lives in DMEngine; this method
     * only handles logging and letting auth errors bubble to the main loop.
     */
    async runDMCycle(page: Page): Promise<void> {
        this.logger.action('DM', 'Sweeping inbox for unread messages');
        const result = await this.dmEngine.sweepInbox(page);

        if (result.replied > 0) this.storage.addDM();
        if (result.escalated > 0) {
            this.logger.success(`${result.escalated} hot lead(s) flagged for human follow-up`);
        }
    }

    /** Signal the worker to stop after the current cycle completes. */
    stop(): void {
        this.logger.info(`Stop requested.`);
        this.isRunning = false;
    }

    /**
     * Perform one engagement cycle: pick a hashtag, browse posts,
     * check relevance via AIBrain, then like/comment within quota.
     */
    async runCycle(page: Page): Promise<void> {
        const hashtags = this.hashtags;
        const tag = hashtags[Math.floor(Math.random() * hashtags.length)];
        this.logger.action('Explore', `Surfing hashtag #${tag}`);

        await page.goto(`https://www.instagram.com/explore/tags/${tag}/`, { waitUntil: 'domcontentloaded' });
        await Humanizer.randomPause(3, 7);

        const posts = await page.$$('article a[href^="/p/"], article a[href^="/reel/"]');
        if (posts.length > 0) {
            // Open a random post from the top few
            await posts[Math.floor(Math.random() * Math.min(3, posts.length))].click();
            await Humanizer.randomPause(3, 6);

            let username = "someone";
            try { username = await page.locator('header span a').first().innerText(); } catch (e) {}

            let caption = "";
            try { caption = await page.locator('h1').innerText(); } catch (e) {}

            this.logger.action('AI Reading', `Post by @${username}: "${caption.slice(0, 40)}..."`);

            // --- STRICT RELEVANCE AI CHECK ---
            if (config.filtering.strictRelevance) {
                const isRelevant = await this.brain.isPostRelevant(caption, username);
                if (!isRelevant) {
                    this.logger.warn(`Skipping post by @${username}: Not relevant.`);
                    await page.keyboard.press('Escape');
                    return;
                }
                this.logger.success(`Post is relevant! Generating engagement...`);
            }

            const stats = this.storage.getStats();
            const limits = getActiveLimits();

            // Use the REAL post shortcode as the dedupe key. The previous
            // `${tag}-${Date.now()}` was unique on every call, so the duplicate
            // guard could never match and the same post could be re-actioned.
            const postId = await this.currentPostId(page, tag);

            if (QuotaLedger.hasInteracted(this.accountId, postId)) {
                this.logger.info(`Already interacted with ${postId} — skipping`);
                await page.keyboard.press('Escape');
                return;
            }

            // Like action — quota consumed atomically before the click.
            if (config.modules.hashtagLike) {
                if (QuotaLedger.consume(this.accountId, 'LIKE', this.safetyProfile)) {
                    try {
                        const likeSvg = page.locator('svg[aria-label="Like"]').first();
                        if (await likeSvg.count() > 0) {
                            await likeSvg.click();
                            this.storage.addLike();
                            QuotaLedger.recordInteraction(this.accountId, postId, 'LIKE');
                            this.logger.success(`Liked post by @${username}`);
                            await Humanizer.randomPause(1, 3);
                        }
                    } catch (e: any) {
                        this.logger.warn(`Like failed: ${e.message}`);
                    }
                } else {
                    this.logger.info(`Like quota exhausted — skipping like`);
                }
            }

            // Comment action
            if (config.modules.hashtagComment) {
                const generatedComment = await this.brain.generateComment(caption, username);

                if (QuotaLedger.consume(this.accountId, 'COMMENT', this.safetyProfile)) {
                    try {
                        const commentBox = page.locator('textarea[aria-label="Add a comment…"], textarea').first();
                        if (await commentBox.count() > 0) {
                            this.logger.info(`AI drafted comment: "${generatedComment}"`);
                            await Humanizer.humanType(page, 'textarea', generatedComment);

                            const postBtn = page.locator('div[role="button"]:has-text("Post")').first();
                            if (await postBtn.count() > 0) {
                                await postBtn.click();
                                this.storage.addComment(postId);
                                QuotaLedger.recordInteraction(this.accountId, postId, 'COMMENT');
                                this.logger.success(`Commented on @${username}'s post!`);
                            }
                        }
                    } catch (e: any) {
                        this.logger.warn(`Could not post comment. Box closed or disabled.`);
                    }
                } else {
                    this.logger.info(`Comment quota exhausted — skipping comment`);
                }
            }

            await page.keyboard.press('Escape');
        } else {
            this.logger.warn(`No posts found for hashtag #${tag}`);
        }
    }

    /**
     * Resolve the Instagram shortcode of the currently open post, e.g. "Cx1Ab2".
     * Falls back to a tag-scoped marker only if the URL cannot be parsed.
     */
    private async currentPostId(page: Page, tag: string): Promise<string> {
        try {
            const url = page.url();
            const m = url.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
            if (m) return m[1];
        } catch { /* fall through to marker */ }
        return `${tag}-unresolved`;
    }

    /** Check if the current time falls within the sleep window. */
    private sleepUntilMorning(): boolean {
        const now = new Date();
        const start = config.safety.sleepStart;
        const end = config.safety.sleepEnd;

        if (start > end) {
            return now.getHours() >= start || now.getHours() < end;
        }
        return now.getHours() >= start && now.getHours() < end;
    }

    /** Detect session expiry / auth errors from error messages. */
    private isAuthError(err: any): boolean {
        const msg = (err.message || '').toLowerCase();
        return msg.includes('login')
            || msg.includes('auth')
            || msg.includes('session')
            || msg.includes('checkpoint')
            || msg.includes('please log in');
    }
}
