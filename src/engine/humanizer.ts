import type { Page } from 'playwright'; 
import { getActiveLimits } from '../config';

export class Humanizer {
    /**
     * Pauses execution for a random number of seconds between min and max (simulating a human reading/looking).
     */
    static async randomPause(minSec: number, maxSec: number): Promise<void> {
        const ms = Math.floor((Math.random() * (maxSec - minSec) + minSec) * 1000);
        return new Promise(r => setTimeout(r, ms));
    }

    /**
     * Human-like typing with micro delays and optional typo corrections.
     */
    static async humanType(page: Page, selector: string, text: string) {
        await page.waitForSelector(selector);
        await page.click(selector);
        
        for (let i = 0; i < text.length; i++) {
            await page.locator(selector).type(text[i], { delay: Math.floor(Math.random() * 150) + 50 });
        }
        await this.randomPause(0.5, 1.5);
    }
    
    /**
     * Simulate human scrolling (short spurts, occasionally stopping).
     */
    static async humanScroll(page: Page) {
        for(let i = 0; i < 3; i++) {
            await page.mouse.wheel(0, Math.floor(Math.random() * 500) + 200);
            await this.randomPause(0.5, 2.0);
        }
    }

    /**
     * Big cooldown sleep, used between major action cycles to prevent IG rate limits.
     */
    static async cooldownPause() {
        const limits = getActiveLimits();
        await this.randomPause(limits.jitterMinSec, limits.jitterMaxSec);
    }
}
