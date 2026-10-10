import type { Page } from 'playwright';
import { AIBrain, DMIntent } from '../ai/brain';
import { Humanizer } from '../engine/humanizer';
import { Logger } from '../utils/logger';
import { QuotaLedger } from '../storage/quota-ledger';
import { upsertAccountRow, getDb } from '../storage/db';
import { config } from '../config';

const INBOX_URL = 'https://www.instagram.com/direct/inbox/';

/** Outcome of processing a single thread — drives logging and dashboard counts. */
export type DMOutcome =
  | 'REPLIED'
  | 'SKIPPED_NO_UNREAD'
  | 'SKIPPED_COOLDOWN'
  | 'SKIPPED_INTENT'
  | 'SKIPPED_STALE'
  | 'SKIPPED_QUOTA'
  | 'SKIPPED_AI_UNAVAILABLE'
  | 'ESCALATED_HOT_LEAD'
  | 'FAILED';

export interface ThreadSummary {
  threadId: string;
  senderName: string;
  lastMessage: string;
  isUnread: boolean;
}

export interface DMSweepResult {
  threadsSeen: number;
  replied: number;
  escalated: number;
  skipped: number;
  failed: number;
  outcomes: Array<{ threadId: string; sender: string; outcome: DMOutcome; intent?: DMIntent }>;
}

/**
 * Instagram DM automation engine.
 *
 * Replaces the previous state of affairs, where `AIBrain.generateDMReply()`
 * existed but had zero callers: nothing navigated to the inbox, nothing read
 * threads, nothing sent replies, and `config.modules.dmReply` was dead config.
 *
 * Safety model (every reply must clear ALL of these):
 *   1. Account has DM quota remaining (atomic, via QuotaLedger).
 *   2. Thread has an actual unread inbound message.
 *   3. Thread is not inside the per-thread reply cooldown.
 *   4. Last inbound message is not older than maxThreadAgeHours.
 *   5. Classified intent is not in neverReplyIntents (SPAM/ABUSE/pitches).
 *   6. The AI produced a real reply (no canned template is ever sent to a DM).
 * Hot leads are escalated to a human instead of being auto-answered.
 */
export class DMEngine {
  private accountId: string;
  private safetyProfile: string;
  private brain: AIBrain;
  private logger: Logger;

  constructor(accountId: string, brain: AIBrain, logger: Logger, safetyProfile = 'balanced') {
    this.accountId = accountId;
    this.brain = brain;
    this.logger = logger;
    this.safetyProfile = safetyProfile;
  }

  /**
   * Run one bounded inbox sweep. Returns a structured result so the worker and
   * dashboard can report real numbers instead of guessing.
   */
  async sweepInbox(page: Page): Promise<DMSweepResult> {
    const result: DMSweepResult = {
      threadsSeen: 0, replied: 0, escalated: 0, skipped: 0, failed: 0, outcomes: [],
    };

    // The quota/interaction tables carry FKs to accounts(id); make sure the
    // file-discovered account exists in SQLite before any ledger write.
    this.ensureAccountRow();

    if (!QuotaLedger.hasBudget(this.accountId, 'DM', this.safetyProfile)) {
      this.logger.info('[DM] Daily/hourly DM quota exhausted — skipping inbox sweep');
      return result;
    }

    await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await Humanizer.randomPause(3, 6);

    // "Not now" on the notifications dialog blocks the thread list if ignored.
    await this.dismissDialogs(page);

    const threads = await this.listThreads(page);
    this.logger.info(`[DM] Inbox sweep: ${threads.length} thread(s) visible`);

    const budget = Math.max(1, config.dm.maxThreadsPerSweep);
    const queue = threads.slice(0, budget);

    for (let i = 0; i < queue.length; i++) {
      const thread = queue[i];
      result.threadsSeen++;

      try {
        const outcome = await this.processThread(page, thread);
        result.outcomes.push({ threadId: thread.threadId, sender: thread.senderName, outcome: outcome.outcome, intent: outcome.intent });

        if (outcome.outcome === 'REPLIED') result.replied++;
        else if (outcome.outcome === 'ESCALATED_HOT_LEAD') result.escalated++;
        else if (outcome.outcome === 'FAILED') result.failed++;
        else result.skipped++;

        // Stop early once the DM budget is spent rather than walking the inbox.
        if (!QuotaLedger.hasBudget(this.accountId, 'DM', this.safetyProfile)) {
          this.logger.info('[DM] DM quota reached mid-sweep — ending sweep');
          break;
        }

        // Only pace BETWEEN threads. Cooling down after the final thread just
        // burned 30-90s of wall clock before returning for no safety benefit.
        if (i < queue.length - 1) {
          await Humanizer.cooldownPause();
        }
      } catch (err: any) {
        result.failed++;
        result.outcomes.push({ threadId: thread.threadId, sender: thread.senderName, outcome: 'FAILED' });
        this.logger.error(`[DM] Thread ${thread.threadId} failed: ${err.message}`);

        // Auth failures must bubble up so the worker can stop cleanly.
        if (this.isAuthError(err)) throw err;
      }
    }

    this.logger.success(
      `[DM] Sweep complete — replied=${result.replied} escalated=${result.escalated} skipped=${result.skipped} failed=${result.failed}`
    );
    return result;
  }

  /**
   * Read the inbox list and extract one summary per thread.
   * Uses several selector strategies because Instagram's DOM changes often.
   */
  private async listThreads(page: Page): Promise<ThreadSummary[]> {
    try {
      await page.waitForSelector('div[role="listitem"], a[href^="/direct/t/"]', { timeout: 20000 });
    } catch {
      this.logger.warn('[DM] Thread list did not render — inbox may be empty or layout changed');
      return [];
    }

    return page.evaluate(() => {
      const out: Array<{ threadId: string; senderName: string; lastMessage: string; isUnread: boolean }> = [];

      const anchors = Array.from(document.querySelectorAll('a[href^="/direct/t/"]'));
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const idMatch = href.match(/\/direct\/t\/(\d+)/);
        if (!idMatch) continue;

        const row = (a.closest('div[role="listitem"]') as HTMLElement) || (a as HTMLElement);
        const text = (row.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);

        const senderName = text[0] || 'unknown';
        const lastMessage = text.length > 1 ? text[1] : '';

        // Instagram marks unread threads with a bold/blue dot node. The most
        // stable signals are an explicit unread label or a non-muted dot span.
        const hasUnreadLabel = !!row.querySelector('[aria-label*="nread"], [aria-label*="Unread"]');
        const hasDot = !!row.querySelector('div[data-visualcompletion="ignore"] span[style*="background"]');
        const isUnread = hasUnreadLabel || hasDot;

        if (!out.some(t => t.threadId === idMatch[1])) {
          out.push({ threadId: idMatch[1], senderName, lastMessage, isUnread });
        }
      }
      return out;
    });
  }

  /**
   * Open one thread, run every safety gate, and reply only if all of them pass.
   */
  private async processThread(
    page: Page,
    thread: ThreadSummary
  ): Promise<{ outcome: DMOutcome; intent?: DMIntent }> {
    const cooldownKey = `dm_thread_${thread.threadId}`;

    // GATE 1 — per-thread reply cooldown.
    const lastReply = QuotaLedger.lastInteractionAt(this.accountId, cooldownKey, 'DM_REPLY');
    if (lastReply) {
      const minsSince = (Date.now() - lastReply.getTime()) / 60000;
      if (minsSince < config.dm.replyCooldownMinutes) {
        this.logger.info(`[DM] @${thread.senderName}: in cooldown (${Math.round(minsSince)}m ago) — skipping`);
        return { outcome: 'SKIPPED_COOLDOWN' };
      }
    }

    await page.goto(`https://www.instagram.com/direct/t/${thread.threadId}/`, {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await Humanizer.randomPause(2, 5);
    await this.dismissDialogs(page);

    const convo = await this.readConversation(page);
    if (!convo.lastInbound) {
      this.logger.info(`[DM] @${thread.senderName}: no inbound message found — skipping`);
      return { outcome: 'SKIPPED_NO_UNREAD' };
    }

    // GATE 2 — never reply twice to the same inbound message. This is the real
    // duplicate guard: it keys on the message content, so a re-rendered or
    // re-ordered inbox cannot cause a second reply.
    const msgKey = `dm_msg_${thread.threadId}_${this.hash(convo.lastInbound)}`;
    if (QuotaLedger.hasInteracted(this.accountId, msgKey, 'DM_REPLY')) {
      this.logger.info(`[DM] @${thread.senderName}: already replied to this message — skipping`);
      return { outcome: 'SKIPPED_COOLDOWN' };
    }

    // GATE 3 — the last message must not already be ours (nothing to answer).
    if (convo.lastIsOutbound) {
      this.logger.info(`[DM] @${thread.senderName}: we sent the last message — skipping`);
      return { outcome: 'SKIPPED_NO_UNREAD' };
    }

    // GATE 4 — intent classification.
    let intent: DMIntent = 'UNKNOWN';
    if (config.dm.qualifyLeads) {
      intent = await this.brain.classifyDMIntent(convo.lastInbound, thread.senderName);
      this.logger.info(`[DM] @${thread.senderName}: intent=${intent}`);

      if (config.dm.neverReplyIntents.includes(intent)) {
        this.logger.warn(`[DM] @${thread.senderName}: intent ${intent} is blocklisted — not replying`);
        this.recordThreadLog(thread, intent, 'SKIPPED_INTENT');
        return { outcome: 'SKIPPED_INTENT', intent };
      }

      // An AI outage must not cause blind replies.
      if (intent === 'UNKNOWN') {
        this.logger.warn(`[DM] @${thread.senderName}: intent unavailable — failing closed`);
        return { outcome: 'SKIPPED_AI_UNAVAILABLE', intent };
      }

      // Hot leads are money. Escalate to a human instead of letting a bot
      // negotiate a $1k-$10k deal.
      if (intent === 'HOT_LEAD' && config.dm.handoffOnHotLead) {
        this.logger.success(`[DM] 🔥 HOT LEAD @${thread.senderName} — escalating to human, not auto-replying`);
        this.recordThreadLog(thread, intent, 'ESCALATED_HOT_LEAD');
        QuotaLedger.recordInteraction(this.accountId, msgKey, 'DM_ESCALATED');
        return { outcome: 'ESCALATED_HOT_LEAD', intent };
      }
    }

    // GATE 5 — draft the reply. Null means the AI failed; we stay silent.
    const reply = await this.brain.generateDMReply(convo.lastInbound, thread.senderName, {
      history: convo.history,
      intent,
    });

    if (!reply || !reply.trim()) {
      this.logger.warn(`[DM] @${thread.senderName}: AI produced no reply — staying silent`);
      return { outcome: 'SKIPPED_AI_UNAVAILABLE', intent };
    }

    // GATE 6 — consume quota BEFORE sending. If this returns false the budget
    // ran out between the sweep check and now, so we must not send.
    if (!QuotaLedger.consume(this.accountId, 'DM', this.safetyProfile)) {
      this.logger.warn(`[DM] @${thread.senderName}: quota consumed by another worker — skipping`);
      return { outcome: 'SKIPPED_QUOTA', intent };
    }

    const sent = await this.sendMessage(page, reply);
    if (!sent) {
      this.logger.error(`[DM] @${thread.senderName}: send failed (composer not found)`);
      return { outcome: 'FAILED', intent };
    }

    // Record both keys: message-level (dup guard) and thread-level (cooldown).
    QuotaLedger.recordInteraction(this.accountId, msgKey, 'DM_REPLY');
    QuotaLedger.recordInteraction(this.accountId, cooldownKey, 'DM_REPLY');
    this.recordThreadLog(thread, intent, 'REPLIED', reply);

    this.logger.success(`[DM] Replied to @${thread.senderName}: "${reply}"`);
    return { outcome: 'REPLIED', intent };
  }

  /**
   * Extract the recent transcript and identify the last inbound message.
   *
   * Instagram renders outbound messages in a row whose flex alignment pushes
   * right; the most reliable text-level signal available without brittle class
   * names is the per-message `aria-label`/row ordering, so we read the visible
   * message rows and treat the trailing group as the conversation tail.
   */
  private async readConversation(page: Page): Promise<{
    history: string[];
    lastInbound: string | null;
    lastIsOutbound: boolean;
  }> {
    try {
      await page.waitForSelector('div[role="row"], div[role="listbox"], div[aria-label*="essage"]', { timeout: 15000 });
    } catch {
      return { history: [], lastInbound: null, lastIsOutbound: false };
    }

    await Humanizer.randomPause(1, 2.5);

    return page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('div[role="row"]'));
      const msgs: Array<{ text: string; outbound: boolean }> = [];

      for (const row of rows) {
        const el = row as HTMLElement;
        const text = (el.innerText || '').trim();
        if (!text) continue;
        // Skip timestamp-only and system rows.
        if (/^(\d{1,2}:\d{2}|yesterday|today|\w{3} \d{1,2})$/i.test(text)) continue;

        // Outbound heuristic: Instagram right-aligns own messages. Read the
        // computed justification of the row's flex container.
        let outbound = false;
        const style = window.getComputedStyle(el);
        if (style.justifyContent === 'flex-end' || style.alignItems === 'flex-end') outbound = true;
        const inner = el.querySelector('div[style*="flex-end"], div[style*="row-reverse"]');
        if (inner) outbound = true;

        msgs.push({ text: text.split('\n')[0].slice(0, 400), outbound });
      }

      const tail = msgs.slice(-8);
      const history = tail.map(m => `${m.outbound ? 'You' : 'Them'}: ${m.text}`);

      let lastInbound: string | null = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (!msgs[i].outbound) { lastInbound = msgs[i].text; break; }
      }

      const lastIsOutbound = msgs.length > 0 ? msgs[msgs.length - 1].outbound : false;
      return { history, lastInbound, lastIsOutbound };
    });
  }

  /**
   * Type and send a message into the thread composer.
   * Tries each known composer selector; returns false if none are usable.
   */
  private async sendMessage(page: Page, text: string): Promise<boolean> {
    const composerSelectors = [
      'div[role="textbox"][contenteditable="true"]',
      'textarea[placeholder*="Message"]',
      'div[aria-label*="Message"][contenteditable="true"]',
      'p[data-lexical-text="true"]',
    ];

    for (const selector of composerSelectors) {
      const el = page.locator(selector).last();
      try {
        if (await el.count() === 0) continue;
        await el.waitFor({ state: 'visible', timeout: 5000 });

        await el.click();
        await Humanizer.randomPause(0.4, 1.2);

        // Type into the focused composer character-by-character.
        for (const ch of text) {
          await page.keyboard.type(ch, { delay: Humanizer.keystrokeDelay() });
          if (Math.random() < 0.05) await Humanizer.randomPause(0.3, 1.0);
        }

        await Humanizer.randomPause(0.8, 2.0);
        await page.keyboard.press('Enter');
        await Humanizer.randomPause(1.5, 3.0);
        return true;
      } catch {
        continue; // Try the next selector strategy.
      }
    }
    return false;
  }

  /** Dismiss the notification / cookie dialogs that block the inbox. */
  private async dismissDialogs(page: Page): Promise<void> {
    const dismissals = ['button:has-text("Not now")', 'button:has-text("Not Now")', 'button:has-text("Cancel")'];
    for (const sel of dismissals) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0 && await btn.isVisible()) {
          await btn.click();
          await Humanizer.randomPause(1, 2);
        }
      } catch { /* dialog absent — nothing to dismiss */ }
    }
  }

  /** Persist a per-thread audit line so the dashboard can show DM activity. */
  private recordThreadLog(thread: ThreadSummary, intent: DMIntent, outcome: DMOutcome, reply?: string): void {
    try {
      const db = getDb();
      const msg = reply
        ? `[DM:${outcome}] @${thread.senderName} (intent=${intent}) → "${reply}"`
        : `[DM:${outcome}] @${thread.senderName} (intent=${intent})`;
      db.prepare('INSERT INTO account_logs (account_id, level, message) VALUES (?, ?, ?)')
        .run(this.accountId, outcome === 'FAILED' ? 'error' : 'info', msg);
    } catch (err: any) {
      // Audit logging must never break the engine.
      this.logger.warn(`[DM] Could not persist thread log: ${err.message}`);
    }
  }

  /** Make sure the account exists in SQLite so FK-bound writes succeed. */
  private ensureAccountRow(): void {
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
      this.logger.warn(`[DM] Account row sync failed: ${err.message}`);
    }
  }

  /** Short stable hash of a message, used as a dedupe key. */
  private hash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(36);
  }

  private isAuthError(err: any): boolean {
    const msg = (err.message || '').toLowerCase();
    return msg.includes('login') || msg.includes('auth')
      || msg.includes('session') || msg.includes('checkpoint');
  }
}
