import { getDb, QuotaRow } from './db';
import { profiles } from '../config';
import { Logger } from '../utils/logger';

export type ActionKind = 'LIKE' | 'COMMENT' | 'DM';

/**
 * Transactional quota + dedupe ledger.
 *
 * This is the module the anti-ban guarantees actually rest on. Before this
 * existed, `quotas` and `interactions` were read by SmartScheduler but never
 * written by anything at runtime, so every quota gate silently passed and the
 * duplicate guard never fired.
 *
 * All mutations are single SQL statements (atomic under better-sqlite3's
 * synchronous driver) or wrapped in explicit transactions, so concurrent
 * account workers cannot interleave a read-modify-write and double-spend quota.
 */

const COLUMN_MAP: Record<ActionKind, { day: keyof QuotaRow; hour: keyof QuotaRow }> = {
  LIKE: { day: 'likes_today', hour: 'likes_this_hour' },
  COMMENT: { day: 'comments_today', hour: 'comments_this_hour' },
  DM: { day: 'dms_today', hour: 'dms_this_hour' },
};

const LIMIT_MAP: Record<ActionKind, { day: 'dailyLikes' | 'dailyComments' | 'dailyDMs'; hour: 'hourlyLikes' | 'hourlyComments' | 'hourlyDMs' }> = {
  LIKE: { day: 'dailyLikes', hour: 'hourlyLikes' },
  COMMENT: { day: 'dailyComments', hour: 'hourlyComments' },
  DM: { day: 'dailyDMs', hour: 'hourlyDMs' },
};

function currentDayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function currentHourKey(): string {
  return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

export interface QuotaSnapshot {
  accountId: string;
  likesToday: number;
  commentsToday: number;
  dmsToday: number;
  likesThisHour: number;
  commentsThisHour: number;
  dmsThisHour: number;
}

export class QuotaLedger {
  /**
   * Ensure a quota row exists and that stale day/hour counters are zeroed.
   * Rolling the counters here (rather than on a timer) means a worker that was
   * asleep across midnight still sees a correct budget on its next action.
   *
   * @param soft when true, returns false on a missing accounts row (FK
   *             violation) instead of throwing — used by consume().
   */
  static ensureFresh(accountId: string): QuotaSnapshot;
  static ensureFresh(accountId: string, soft: true): boolean;
  static ensureFresh(accountId: string, soft?: true): QuotaSnapshot | boolean {
    const db = getDb();
    const day = currentDayKey();
    const hour = currentHourKey();

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO quotas (account_id, last_reset_day, last_reset_hour)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO NOTHING
      `).run(accountId, day, hour);

      // Daily rollover: resets both day and hour buckets.
      db.prepare(`
        UPDATE quotas
        SET likes_today = 0, comments_today = 0, dms_today = 0,
            likes_this_hour = 0, comments_this_hour = 0, dms_this_hour = 0,
            last_reset_day = ?, last_reset_hour = ?
        WHERE account_id = ? AND last_reset_day != ?
      `).run(day, hour, accountId, day);

      // Hourly rollover only.
      db.prepare(`
        UPDATE quotas
        SET likes_this_hour = 0, comments_this_hour = 0, dms_this_hour = 0,
            last_reset_hour = ?
        WHERE account_id = ? AND last_reset_hour != ?
      `).run(hour, accountId, hour);
    });

    try {
      tx();
    } catch (err: any) {
      if (soft && String(err.code) === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return false;
      }
      throw err;
    }

    return soft ? true : this.snapshot(accountId);
  }

  static snapshot(accountId: string): QuotaSnapshot {
    const db = getDb();
    const row = db.prepare('SELECT * FROM quotas WHERE account_id = ?')
      .get(accountId) as QuotaRow | undefined;

    return {
      accountId,
      likesToday: row?.likes_today ?? 0,
      commentsToday: row?.comments_today ?? 0,
      dmsToday: row?.dms_today ?? 0,
      likesThisHour: row?.likes_this_hour ?? 0,
      commentsThisHour: row?.comments_this_hour ?? 0,
      dmsThisHour: row?.dms_this_hour ?? 0,
    };
  }

  /**
   * True when the account still has both daily and hourly budget for `kind`.
   */
  static hasBudget(accountId: string, kind: ActionKind, safetyProfile: string): boolean {
    // Fail closed: an unregistered account has no budget rather than crashing.
    if (!this.ensureFresh(accountId, true)) return false;

    const snap = this.snapshot(accountId);
    const limits = profiles[safetyProfile as keyof typeof profiles] || profiles.balanced;
    const cols = COLUMN_MAP[kind];
    const lim = LIMIT_MAP[kind];

    const usedDay = snap[camel(cols.day)];
    const usedHour = snap[camel(cols.hour)];

    return usedDay < limits[lim.day] && usedHour < limits[lim.hour];
  }

  /**
   * Atomically consume one unit of quota. Returns false when the budget is
   * exhausted, in which case nothing is written.
   *
   * The UPDATE carries the limit check in its WHERE clause, so the check and
   * the increment happen in one statement — two workers cannot both pass a
   * check and then both increment past the cap.
   */
  static consume(accountId: string, kind: ActionKind, safetyProfile: string): boolean {
    if (!this.ensureFresh(accountId, true)) {
      Logger.error(`[Quota] Cannot consume ${kind}: account "${accountId}" not registered in SQLite`);
      return false;
    }

    const db = getDb();
    const limits = profiles[safetyProfile as keyof typeof profiles] || profiles.balanced;
    const cols = COLUMN_MAP[kind];
    const lim = LIMIT_MAP[kind];

    const res = db.prepare(`
      UPDATE quotas
      SET ${cols.day} = ${cols.day} + 1,
          ${cols.hour} = ${cols.hour} + 1
      WHERE account_id = ?
        AND ${cols.day} < ?
        AND ${cols.hour} < ?
    `).run(accountId, limits[lim.day], limits[lim.hour]);

    if (res.changes === 0) {
      Logger.warn(`[Quota] ${accountId} exhausted ${kind} budget (${safetyProfile})`);
      return false;
    }
    return true;
  }

  /**
   * Record an interaction so the same target is never actioned twice.
   * Returns false when this (account, target, action) was already recorded.
   *
   * A dedupe/audit write must never crash a running worker, so a missing
   * accounts row (FK violation) is logged and reported as "not recorded"
   * rather than thrown. Callers treat false as "already seen / unavailable".
   */
  static recordInteraction(accountId: string, targetId: string, actionType: string): boolean {
    const db = getDb();
    try {
      const res = db.prepare(`
        INSERT INTO interactions (account_id, post_id, action_type)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id, post_id, action_type) DO NOTHING
      `).run(accountId, targetId, actionType);

      return res.changes > 0;
    } catch (err: any) {
      if (String(err.code) === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        Logger.error(
          `[Quota] Cannot record interaction: account "${accountId}" is not registered in SQLite. ` +
          `Call upsertAccountRow() before engaging.`
        );
        return false;
      }
      Logger.error(`[Quota] recordInteraction failed: ${err.message}`);
      return false;
    }
  }

  static hasInteracted(accountId: string, targetId: string, actionType?: string): boolean {
    const db = getDb();
    const row = actionType
      ? db.prepare('SELECT 1 FROM interactions WHERE account_id = ? AND post_id = ? AND action_type = ?')
          .get(accountId, targetId, actionType)
      : db.prepare('SELECT 1 FROM interactions WHERE account_id = ? AND post_id = ?')
          .get(accountId, targetId);
    return !!row;
  }

  /**
   * Timestamp of the most recent interaction of this type, or null.
   * Used by the DM engine to enforce a per-thread reply cooldown.
   */
  static lastInteractionAt(accountId: string, targetId: string, actionType: string): Date | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT interacted_at FROM interactions
      WHERE account_id = ? AND post_id = ? AND action_type = ?
    `).get(accountId, targetId, actionType) as { interacted_at: string } | undefined;

    if (!row) return null;
    // SQLite datetime('now') is UTC; append Z so Date parses it as such.
    const iso = row.interacted_at.includes('T')
      ? row.interacted_at
      : row.interacted_at.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
}

/** Map a snake_case QuotaRow column to its QuotaSnapshot camelCase key. */
function camel(col: keyof QuotaRow): keyof Omit<QuotaSnapshot, 'accountId'> {
  const map: Record<string, keyof Omit<QuotaSnapshot, 'accountId'>> = {
    likes_today: 'likesToday',
    comments_today: 'commentsToday',
    dms_today: 'dmsToday',
    likes_this_hour: 'likesThisHour',
    comments_this_hour: 'commentsThisHour',
    dms_this_hour: 'dmsThisHour',
  };
  return map[col as string];
}
