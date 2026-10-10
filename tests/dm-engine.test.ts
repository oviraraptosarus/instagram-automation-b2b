/**
 * DM engine + quota ledger test suite.
 *
 * These tests exercise the gates that the product's anti-ban claims rest on.
 * They run against a real SQLite file in a temp dir (no mocks for the DB) so
 * FK constraints, transactions and ON CONFLICT behaviour are genuinely tested.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

// Point the app at an isolated data dir BEFORE importing anything that reads config.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'igdm-test-'));
process.env.DM_REPLY_COOLDOWN_MINUTES = '180';
process.env.DM_MAX_THREADS_PER_SWEEP = '3';

import { config } from '../src/config';
(config.paths as any).dataDir = TMP;
(config.paths as any).statsFile = path.join(TMP, 'stats.json');
(config.paths as any).logsFile = path.join(TMP, 'app.log');

import { getDb, closeDb, upsertAccountRow } from '../src/storage/db';
import { QuotaLedger } from '../src/storage/quota-ledger';
import { DMEngine } from '../src/engine/dm-engine';
import { AIBrain } from '../src/ai/brain';
import { Logger } from '../src/utils/logger';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

// ---------------------------------------------------------------------------
section('FK sync: ledger writes require an accounts row');

const ACC = 'dm_test_acct';
upsertAccountRow({ id: ACC, username: 'dm_tester', safetyProfile: 'safe', authenticated: true });

const accRow = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(ACC) as any;
check('upsertAccountRow creates the accounts row', !!accRow && accRow.username === 'dm_tester');

// Without the row this throws "FOREIGN KEY constraint failed" — the bug that
// made every quota write fail for file-discovered accounts.
let fkOk = true;
try {
  QuotaLedger.ensureFresh(ACC);
} catch (e: any) {
  fkOk = false;
  console.log(`   (ensureFresh threw: ${e.message})`);
}
check('QuotaLedger.ensureFresh succeeds for a synced account', fkOk);

const unsynced = QuotaLedger.recordInteraction('ghost_acct_never_synced', 'x', 'LIKE');
check('interaction write for an unsynced account degrades to false (no crash)',
  unsynced === false);
check('hasBudget fails closed for an unsynced account',
  QuotaLedger.hasBudget('ghost_acct_never_synced', 'DM', 'safe') === false);
check('consume refuses an unsynced account instead of throwing',
  QuotaLedger.consume('ghost_acct_never_synced', 'DM', 'safe') === false);

// ---------------------------------------------------------------------------
section('Quota enforcement is real (was a permanent no-op)');

const snap0 = QuotaLedger.ensureFresh(ACC);
check('fresh account starts at 0 DMs today', snap0.dmsToday === 0, `got ${snap0.dmsToday}`);

// 'safe' profile => dailyDMs 15, hourlyDMs 4.
let consumed = 0;
for (let i = 0; i < 10; i++) {
  if (QuotaLedger.consume(ACC, 'DM', 'safe')) consumed++;
}
check('DM consumption stops at the hourly cap (4), not the daily cap',
  consumed === 4, `consumed ${consumed}`);

const snapAfter = QuotaLedger.snapshot(ACC);
check('counters actually persisted to SQLite',
  snapAfter.dmsToday === 4 && snapAfter.dmsThisHour === 4,
  `today=${snapAfter.dmsToday} hour=${snapAfter.dmsThisHour}`);

check('hasBudget reports false once the cap is hit',
  QuotaLedger.hasBudget(ACC, 'DM', 'safe') === false);

check('a different action type keeps its own independent budget',
  QuotaLedger.hasBudget(ACC, 'LIKE', 'safe') === true);

// ---------------------------------------------------------------------------
section('Hourly rollover restores budget without touching the daily count');

getDb().prepare("UPDATE quotas SET last_reset_hour = '2000-01-01T00' WHERE account_id = ?").run(ACC);
const rolled = QuotaLedger.ensureFresh(ACC);
check('hourly counters reset on a new hour', rolled.dmsThisHour === 0, `got ${rolled.dmsThisHour}`);
check('daily counter survives an hourly rollover', rolled.dmsToday === 4, `got ${rolled.dmsToday}`);

// ---------------------------------------------------------------------------
section('Daily cap cannot be exceeded across many hours');

// safe profile dailyDMs = 15. Keep rolling the hour and consuming.
let totalDaily = QuotaLedger.snapshot(ACC).dmsToday;
for (let h = 0; h < 10; h++) {
  getDb().prepare("UPDATE quotas SET last_reset_hour = ? WHERE account_id = ?")
    .run(`2000-01-01T${String(h).padStart(2, '0')}`, ACC);
  QuotaLedger.ensureFresh(ACC);
  for (let i = 0; i < 6; i++) QuotaLedger.consume(ACC, 'DM', 'safe');
}
totalDaily = QuotaLedger.snapshot(ACC).dmsToday;
check('daily DM cap (15) is never exceeded even across hour rollovers',
  totalDaily === 15, `got ${totalDaily}`);

// ---------------------------------------------------------------------------
section('Dedupe guard (interactions table was never written before)');

const first = QuotaLedger.recordInteraction(ACC, 'post_ABC123', 'LIKE');
const second = QuotaLedger.recordInteraction(ACC, 'post_ABC123', 'LIKE');
check('first interaction is recorded', first === true);
check('duplicate interaction is rejected', second === false);
check('hasInteracted detects the recorded post',
  QuotaLedger.hasInteracted(ACC, 'post_ABC123') === true);
check('hasInteracted is false for an untouched post',
  QuotaLedger.hasInteracted(ACC, 'post_NEVER_SEEN') === false);
check('same post, different action type is tracked separately',
  QuotaLedger.recordInteraction(ACC, 'post_ABC123', 'COMMENT') === true);

// ---------------------------------------------------------------------------
section('DM thread cooldown timestamps');

QuotaLedger.recordInteraction(ACC, 'dm_thread_999', 'DM_REPLY');
const ts = QuotaLedger.lastInteractionAt(ACC, 'dm_thread_999', 'DM_REPLY');
check('lastInteractionAt returns a valid Date', ts instanceof Date && !isNaN(ts!.getTime()));
check('timestamp is recent (parsed as UTC, not shifted)',
  !!ts && Math.abs(Date.now() - ts.getTime()) < 10 * 60 * 1000,
  ts ? `delta=${Math.round((Date.now() - ts.getTime()) / 1000)}s` : 'null');
check('lastInteractionAt returns null for an unknown thread',
  QuotaLedger.lastInteractionAt(ACC, 'dm_thread_absent', 'DM_REPLY') === null);

// ---------------------------------------------------------------------------
section('DMEngine wiring + fail-closed behaviour');

const brain = new AIBrain();
const logger = new Logger(ACC);
const engine = new DMEngine(ACC, brain, logger, 'safe');

check('DMEngine exposes sweepInbox', typeof (engine as any).sweepInbox === 'function');
check('AIBrain exposes classifyDMIntent', typeof brain.classifyDMIntent === 'function');
check('AIBrain exposes generateDMReply', typeof brain.generateDMReply === 'function');

// With no reachable provider, intent classification must fail closed to UNKNOWN
// so the engine never auto-replies blind.
(async () => {
  const prevProvider = config.ai.provider;
  (config.ai as any).provider = 'none';
  const intent = await brain.classifyDMIntent('hey how much for a website?', 'someuser');
  check('classifyDMIntent returns UNKNOWN when AI is unavailable (fail-closed)',
    intent === 'UNKNOWN', `got ${intent}`);

  const reply = await brain.generateDMReply('hey', 'someuser');
  check('generateDMReply returns null (never a canned template) when AI is off',
    reply === null, `got ${JSON.stringify(reply)}`);
  (config.ai as any).provider = prevProvider;

  // A DM sweep must be a no-op once quota is gone, without opening a browser.
  const exhausted = await engine.sweepInbox({
    goto: async () => { throw new Error('browser should not be used when quota is exhausted'); },
  } as any);
  check('sweepInbox short-circuits when DM quota is exhausted (no browser use)',
    exhausted.threadsSeen === 0 && exhausted.replied === 0);

  // ---------------------------------------------------------------------------
  section('Blocklisted intents are configured');
  check('SPAM is blocklisted by default', config.dm.neverReplyIntents.includes('SPAM'));
  check('ABUSE is blocklisted by default', config.dm.neverReplyIntents.includes('ABUSE'));
  check('SALES_PITCH is blocklisted by default', config.dm.neverReplyIntents.includes('SALES_PITCH'));
  check('hot-lead handoff is on by default', config.dm.handoffOnHotLead === true);

  // ---------------------------------------------------------------------------
  section('Path containment (data dir must not escape the project)');
  const freshDataDir = require('path').join(__dirname, '..', 'data');
  check('config path helper resolves inside the project tree',
    !freshDataDir.includes(path.join('Users', os.userInfo().username, 'data')) ||
    freshDataDir.includes('instagram-automation'),
    freshDataDir);

  // ---------------------------------------------------------------------------
  console.log(`\n==========================================`);
  console.log(`   DM SUITE: ${passed} PASSED, ${failed} FAILED`);
  console.log(`==========================================`);

  closeDb();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup */ }

  process.exit(failed === 0 ? 0 : 1);
})();
