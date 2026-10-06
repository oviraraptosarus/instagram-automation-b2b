import { BrowserEngine } from '../engine/browser';
import { AIBrain } from '../ai/brain';
import { Storage } from '../utils/storage';
import { Logger } from '../utils/logger';
import { Humanizer } from '../engine/humanizer';
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

    constructor(
        accountId: string,
        browserEngine: BrowserEngine,
        storage: Storage,
        logger: Logger,
        brain: AIBrain
    ) {
        this.accountId = accountId;
        this.browserEngine = browserEngine;
        this.storage = storage;
        this.logger = logger;
        this.brain = brain;
    }

    public getIsRunning(): boolean {
        return this.isRunning;
    }

    /** Begin the action loop: launch browser, verify session, then run cycles. */
    async start(): Promise<void> {
        this.logger.info(`Starting action loop`);
        this.isRunning = true;

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

                // 2. Quota check
                const stats = this.storage.getStats();
                const limits = getActiveLimits();

                if (config.modules.hashtagLike && stats.likesToday < limits.dailyLikes) {
                    await this.runCycle(this.page);
                } else {
                    this.logger.info(`Daily quota reached (likes: ${stats.likesToday}/${limits.dailyLikes}). Waiting...`);
                }

                // 3. Cooldown between cycles
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
        const hashtags = config.targeting.hashtags;
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

            const generatedComment = await this.brain.generateComment(caption, username);
            const stats = this.storage.getStats();
            const limits = getActiveLimits();
            const postIdContext = `${tag}-${Date.now()}`;

            // Like action
            if (config.modules.hashtagLike && stats.likesToday < limits.dailyLikes) {
                try {
                    const likeSvg = await page.locator('svg[aria-label="Like"]').first();
                    if (likeSvg) {
                        await likeSvg.click();
                        this.storage.addLike();
                        this.logger.success(`Liked post by @${username}`);
                        await Humanizer.randomPause(1, 3);
                    }
                } catch (e) {}
            }

            // Comment action
            if (config.modules.hashtagComment && stats.commentsToday < limits.dailyComments) {
                try {
                    const commentBox = await page.locator('textarea[aria-label="Add a comment…"], textarea').first();
                    if (commentBox) {
                        this.logger.info(`AI drafted comment: "${generatedComment}"`);
                        await Humanizer.humanType(page, 'textarea', generatedComment);

                        const postBtn = await page.locator('div[role="button"]:has-text("Post")');
                        if (postBtn) {
                            await postBtn.click();
                            this.storage.addComment(postIdContext);
                            this.logger.success(`Commented on @${username}'s post!`);
                        }
                    }
                } catch (e) {
                    this.logger.warn(`Could not post comment. Box closed or disabled.`);
                }
            }

            await page.keyboard.press('Escape');
        } else {
            this.logger.warn(`No posts found for hashtag #${tag}`);
        }
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
