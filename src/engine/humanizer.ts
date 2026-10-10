import type { Page } from 'playwright'; 
import { getActiveLimits } from '../config';

/**
 * Multiplier applied to every human-pacing delay.
 *
 * Production keeps 1 (full human delays — this IS the anti-ban budget).
 * Tests set IG_PACING_SCALE=0 to exercise logic without minutes of sleeping.
 * Read once at module load so nothing can shorten delays mid-run.
 */
const PACING_SCALE = (() => {
    const raw = process.env.IG_PACING_SCALE;
    if (raw === undefined) return 1;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 1;
})();

export class Humanizer {
    /**
     * Pauses execution for a random number of seconds between min and max (simulating a human reading/looking).
     *
     * Scaled by IG_PACING_SCALE (default 1 = full human delays). Tests set it
     * to 0 to exercise logic without burning wall clock on sleeps. Read once at
     * module load so live runtime code can never speed up a real account.
     */
    static async randomPause(minSec: number, maxSec: number): Promise<void> {
        const ms = Math.floor((Math.random() * (maxSec - minSec) + minSec) * 1000 * PACING_SCALE);
        if (ms <= 0) return;
        return new Promise(r => setTimeout(r, ms));
    }

    /**
     * Human-like typing with micro delays.
     *
     * Resolves the element handle ONCE and types into that handle. The previous
     * implementation called page.locator(selector).type() inside the per-char
     * loop, issuing a fresh DOM query for every keystroke (~40ms of waste per
     * character, and a crash if the node re-rendered mid-type).
     */
    static async humanType(page: Page, selector: string, text: string) {
        const el = page.locator(selector).first();
        await el.waitFor({ state: 'visible', timeout: 15000 });
        await el.click();
        await this.randomPause(0.2, 0.6);

        for (let i = 0; i < text.length; i++) {
            await page.keyboard.type(text[i], { delay: Humanizer.keystrokeDelay() });

            // Occasional "thinking" pause mid-sentence, like a real typist.
            if (Math.random() < 0.06) {
                await this.randomPause(0.3, 1.1);
            }
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
    /** Per-character typing delay in ms, scaled by IG_PACING_SCALE. */
    static keystrokeDelay(): number {
        return Math.floor((Math.random() * 110 + 40) * PACING_SCALE);
    }

    static async cooldownPause() {
        const limits = getActiveLimits();
        await this.randomPause(limits.jitterMinSec, limits.jitterMaxSec);
    }
}
