import { chromium } from 'playwright-extra';
import type { BrowserContext, Page } from 'playwright';
// @ts-ignore
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';
import { Logger } from '../utils/logger';

// Apply the stealth plugin to avoid detection
chromium.use(stealthPlugin());

export class BrowserEngine {
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private readonly accountId: string;
    private readonly userDataDir: string;

    constructor(accountId: string = 'default') {
        this.accountId = accountId;
        this.userDataDir = path.join(process.cwd(), 'data', 'accounts', accountId, 'profile');
    }

    async launch(headless: boolean = true): Promise<Page> {
        try {
            // Ensure account-specific profile dir exists
            if (!fs.existsSync(this.userDataDir)) {
                fs.mkdirSync(this.userDataDir, { recursive: true });
            }

            Logger.info(`Launching BrowserEngine for account "${this.accountId}" (profile: ${this.userDataDir})`);

            // Launch persistent context with account-isolated userDataDir
            this.context = await chromium.launchPersistentContext(this.userDataDir, {
                headless,
                viewport: { width: 1280, height: 800 },
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--no-sandbox',
                    '--window-size=1280,800',
                ],
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            });

            // Stealth init scripts
            await this.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                (globalThis as any).window = (globalThis as any).window || {};
                (globalThis as any).window.chrome = { runtime: {}, app: {}, loadTimes: () => ({}) };
            });

            const pages = this.context.pages();
            this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

            Logger.info(`BrowserEngine for account "${this.accountId}" launched successfully`);
            return this.page;
        } catch (err: any) {
            Logger.error(`Browser launch failed for account "${this.accountId}": ${err.message}`);
            throw err;
        }
    }

    async stop(): Promise<void> {
        if (this.context) {
            Logger.info(`Closing BrowserEngine context for account "${this.accountId}"`);
            await this.context.close();
            this.context = null;
            this.page = null;
        }
    }

    getPage(): Page | null {
        return this.page;
    }

    /**
     * Session health check: navigates to instagram.com and detects whether
     * the session is still valid. A session is INVALID if:
     *   - the page URL redirects to /accounts/login/, OR
     *   - an input[name='username'] element is present on the page.
     * Returns true if the session appears valid (user is logged in).
     */
    async checkSessionHealth(): Promise<boolean> {
        if (!this.page) {
            Logger.warn(`Session health check failed for account "${this.accountId}": no active page`);
            return false;
        }

        try {
            await this.page.goto('https://www.instagram.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

            const currentUrl = this.page.url();

            // Detect login redirect
            if (currentUrl.includes('/accounts/login/')) {
                Logger.info(`Session health check: account "${this.accountId}" redirected to login — session invalid`);
                return false;
            }

            // Detect username input field (login page presence)
            const usernameInput = await this.page.$("input[name='username']");
            if (usernameInput) {
                Logger.info(`Session health check: account "${this.accountId}" username input found — session invalid`);
                return false;
            }

            Logger.info(`Session health check: account "${this.accountId}" session valid`);
            return true;
        } catch (err: any) {
            Logger.error(`Session health check error for account "${this.accountId}": ${err.message}`);
            return false;
        }
    }
}
