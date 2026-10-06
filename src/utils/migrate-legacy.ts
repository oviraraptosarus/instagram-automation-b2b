import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { getDb } from '../storage/db';
import { Logger } from './logger';

export function migrateLegacyData(): boolean {
  const legacyProfile = path.join(config.paths.dataDir, 'browser_profile');
  const legacyStats = path.join(config.paths.dataDir, 'stats.json');
  const legacyLogs = path.join(config.paths.dataDir, 'app.log');

  const hasLegacyData = fs.existsSync(legacyProfile) || fs.existsSync(legacyStats) || fs.existsSync(legacyLogs);
  if (!hasLegacyData) {
    Logger.info('[Migrate] No legacy single-account data found. Skipping migration.');
    return false;
  }

  Logger.info('[Migrate] Legacy single-account data detected. Migrating to "account_default"...');

  const defaultAccountDir = path.join(config.paths.dataDir, 'accounts', 'account_default');
  const targetProfile = path.join(defaultAccountDir, 'profile');
  const targetState = path.join(defaultAccountDir, 'state.json');
  const targetAuth = path.join(defaultAccountDir, 'auth.json');
  const targetLog = path.join(defaultAccountDir, 'app.log');

  fs.mkdirSync(defaultAccountDir, { recursive: true });

  // 1. Move browser profile
  if (fs.existsSync(legacyProfile) && !fs.existsSync(targetProfile)) {
    try {
      fs.renameSync(legacyProfile, targetProfile);
      Logger.success('[Migrate] Moved browser_profile to account_default/profile');
    } catch (e: any) {
      Logger.error(`[Migrate] Could not move profile: ${e.message}`);
    }
  }

  // 2. Migrate stats.json
  if (fs.existsSync(legacyStats)) {
    try {
      const raw = fs.readFileSync(legacyStats, 'utf8');
      const stats = JSON.parse(raw);
      const db = getDb();
      const now = new Date().toISOString();

      // Insert or update account in SQLite
      db.prepare(`
        INSERT INTO accounts (id, username, label, enabled, authenticated, status, safety_profile, created_at)
        VALUES ('account_default', 'account_default', 'Default Migrated Account', 1, 1, 'IDLE', 'balanced', ?)
        ON CONFLICT(username) DO UPDATE SET authenticated = 1
      `).run(now);

      // Insert quotas
      db.prepare(`
        INSERT INTO quotas (account_id, likes_today, comments_today, dms_today, last_reset_day)
        VALUES ('account_default', ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET likes_today = ?, comments_today = ?, dms_today = ?
      `).run(
        stats.likesToday || 0, stats.commentsToday || 0, stats.dMsToday || 0, stats.lastResetDate || new Date().toDateString(),
        stats.likesToday || 0, stats.commentsToday || 0, stats.dMsToday || 0
      );

      // Save state.json and auth.json
      fs.writeFileSync(targetState, JSON.stringify({
        id: 'account_default',
        username: 'account_default',
        label: 'Default Migrated Account',
        enabled: true,
        authenticated: true,
        status: 'IDLE',
        safetyProfile: 'balanced'
      }, null, 2));

      fs.writeFileSync(targetAuth, JSON.stringify({
        authenticated: true,
        lastLogin: now
      }, null, 2));

      // Backup legacy stats
      fs.renameSync(legacyStats, `${legacyStats}.bak`);
      Logger.success('[Migrate] Imported stats.json into SQLite DB and account_default state.');
    } catch (e: any) {
      Logger.error(`[Migrate] Failed migrating stats.json: ${e.message}`);
    }
  }

  // 3. Move app.log
  if (fs.existsSync(legacyLogs) && !fs.existsSync(targetLog)) {
    try {
      fs.renameSync(legacyLogs, targetLog);
      Logger.success('[Migrate] Moved app.log to account_default/app.log');
    } catch (e: any) {}
  }

  Logger.success('[Migrate] Legacy migration complete! All data safe under data/accounts/account_default.');
  return true;
}

if (require.main === module) {
  migrateLegacyData();
}
