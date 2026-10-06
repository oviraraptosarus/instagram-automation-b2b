import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { AccountRegistry, Account } from '../src/accounts/registry';
import { getDb, closeDb } from '../src/storage/db';
import { config } from '../src/config';
import { ActionQueue, SmartScheduler } from '../src/queue/scheduler';
import { migrateLegacyData } from '../src/utils/migrate-legacy';

function runTests() {
  console.log('==========================================');
  console.log('   RUNNING MULTI-ACCOUNT SYSTEM TESTS');
  console.log('==========================================\n');

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void) {
    try {
      fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (e: any) {
      console.error(`❌ FAIL: ${name} -> ${e.message}`);
      failed++;
    }
  }

  const db = getDb();

  // Clear test DB tables for a clean test run
  db.prepare('DELETE FROM action_jobs').run();
  db.prepare('DELETE FROM quotas').run();
  db.prepare('DELETE FROM accounts').run();

  // Seed DB with accounts
  db.prepare(`
    INSERT OR REPLACE INTO accounts (id, username, label, enabled, authenticated, status)
    VALUES ('test_acc_01', 'user_alpha', 'Alpha Account', 1, 1, 'IDLE')
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO accounts (id, username, label, enabled, authenticated, status)
    VALUES ('test_acc_02', 'user_beta', 'Beta Account', 1, 1, 'IDLE')
  `).run();

  // 1. Account Registry & Duplicate Username Test
  test('AccountRegistry prevents duplicate usernames', () => {
    const registry = AccountRegistry.getInstance();
    const acc1: Account = {
      id: 'test_acc_01',
      username: 'user_alpha',
      label: 'Alpha Account',
      enabled: true,
      authenticated: true,
      status: 'IDLE',
      safetyProfile: 'balanced',
      timezone: 'UTC',
      modules: ['hashtagLike'],
      targeting: { hashtags: ['tech'], accountContext: '' }
    };

    registry.add(acc1);

    const acc2: Account = {
      ...acc1,
      id: 'test_acc_03',
      username: 'user_alpha' // Duplicate username
    };

    assert.throws(() => {
      registry.add(acc2);
    }, /Duplicate username/);
  });

  // 2. Database Schema & Quota Isolation
  test('SQLite DB isolates quotas per account', () => {
    db.prepare(`
      INSERT OR REPLACE INTO quotas (account_id, likes_today, comments_today, dms_today, last_reset_day)
      VALUES ('test_acc_01', 10, 5, 0, 'Today')
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO quotas (account_id, likes_today, comments_today, dms_today, last_reset_day)
      VALUES ('test_acc_02', 2, 1, 0, 'Today')
    `).run();

    const q1 = db.prepare('SELECT likes_today FROM quotas WHERE account_id = ?').get('test_acc_01') as any;
    const q2 = db.prepare('SELECT likes_today FROM quotas WHERE account_id = ?').get('test_acc_02') as any;

    assert.strictEqual(q1.likes_today, 10);
    assert.strictEqual(q2.likes_today, 2);
  });

  // 3. Action Queue & Smart Scheduler Eligibility
  test('SmartScheduler selects eligible account', () => {
    const origSleepStart = config.safety.sleepStart;
    const origSleepEnd = config.safety.sleepEnd;
    config.safety.sleepStart = 0;
    config.safety.sleepEnd = 0;

    const jobId = ActionQueue.enqueue('HASHTAG_LIKE', { tag: 'coding', postId: 'post_999' });
    const job = ActionQueue.getNextQueuedJob();

    assert.ok(job);
    assert.strictEqual(job?.id, jobId);

    const eligibleAcc = SmartScheduler.selectEligibleAccount(job!);
    
    config.safety.sleepStart = origSleepStart;
    config.safety.sleepEnd = origSleepEnd;

    assert.ok(eligibleAcc !== null);
  });

  // 4. Legacy Migration Script Test
  test('Legacy data migration executes without error', () => {
    const migrated = migrateLegacyData();
    assert.strictEqual(typeof migrated, 'boolean');
  });

  console.log(`\n==========================================`);
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`==========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
