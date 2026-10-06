import { getDb, ActionJobRow, QuotaRow } from '../storage/db';
import { AccountRegistry, Account } from '../accounts/registry';
import { config, profiles } from '../config';
import { Logger } from '../utils/logger';

export interface ActionJob {
  id: string;
  type: string; // 'HASHTAG_ENGAGE' | 'FEED_LIKE' | 'DM_REPLY'
  payload: Record<string, any>;
  assignedAccountId?: string;
  status: 'QUEUED' | 'ASSIGNED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  attempts: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export class ActionQueue {
  /**
   * Enqueue a new action job.
   */
  static enqueue(type: string, payload: Record<string, any>): string {
    const db = getDb();
    const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const payloadStr = JSON.stringify(payload);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO action_jobs (id, type, payload, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'QUEUED', 0, ?, ?)
    `).run(id, type, payloadStr, now, now);

    Logger.info(`[ActionQueue] Enqueued job ${id} (${type})`);
    return id;
  }

  /**
   * Get next queued job.
   */
  static getNextQueuedJob(): ActionJob | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM action_jobs WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1
    `).get() as ActionJobRow | undefined;

    if (!row) return null;
    return this.mapRowToJob(row);
  }

  /**
   * Update job status and assigned account.
   */
  static updateStatus(id: string, status: ActionJob['status'], assignedAccountId?: string, errorMsg?: string): void {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE action_jobs 
      SET status = ?, assigned_account_id = ?, error_message = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `).run(status, assignedAccountId || null, errorMsg || null, now, id);
  }

  private static mapRowToJob(row: ActionJobRow): ActionJob {
    let payload = {};
    try {
      payload = JSON.parse(row.payload);
    } catch (e) {}

    return {
      id: String(row.id),
      type: row.type,
      payload,
      assignedAccountId: row.assigned_account_id ? String(row.assigned_account_id) : undefined,
      status: row.status as ActionJob['status'],
      attempts: row.attempts,
      errorMessage: row.error_message || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

export class SmartScheduler {
  /**
   * Select the best eligible account for a given action job.
   */
  static selectEligibleAccount(job: ActionJob): Account | null {
    const registry = AccountRegistry.getInstance();
    const accounts = registry.discover();

    const db = getDb();
    const now = new Date();
    const currentHour = now.getHours();

    for (const account of accounts) {
      // 1. Account enabled & authenticated check
      if (!account.enabled || !account.authenticated) continue;
      if (account.status === 'ERROR' || account.status === 'AUTH_REQUIRED') continue;

      // 2. Sleep hours check
      const startSleep = config.safety.sleepStart;
      const endSleep = config.safety.sleepEnd;
      let isSleeping = false;
      if (startSleep > endSleep) {
        if (currentHour >= startSleep || currentHour < endSleep) isSleeping = true;
      } else {
        if (currentHour >= startSleep && currentHour < endSleep) isSleeping = true;
      }
      if (isSleeping) continue;

      // 3. Quota check
      const safetyLimits = profiles[account.safetyProfile] || profiles.balanced;
      const quotaRow = db.prepare('SELECT * FROM quotas WHERE account_id = ?').get(account.id) as QuotaRow | undefined;

      const likesToday = quotaRow ? quotaRow.likes_today : 0;
      const commentsToday = quotaRow ? quotaRow.comments_today : 0;
      const likesThisHour = quotaRow ? quotaRow.likes_this_hour : 0;
      const commentsThisHour = quotaRow ? quotaRow.comments_this_hour : 0;

      if (job.type.includes('LIKE') && (likesToday >= safetyLimits.dailyLikes || likesThisHour >= safetyLimits.hourlyLikes)) {
        continue;
      }
      if (job.type.includes('COMMENT') && (commentsToday >= safetyLimits.dailyComments || commentsThisHour >= safetyLimits.hourlyComments)) {
        continue;
      }

      // 4. Deduplication check (if payload contains post_id)
      if (job.payload && job.payload.postId) {
        const interacted = db.prepare(`
          SELECT 1 FROM interactions WHERE account_id = ? AND post_id = ?
        `).get(account.id, job.payload.postId);
        if (interacted) continue;
      }

      // Account is eligible!
      return account;
    }

    return null;
  }
}
