/**
 * End-to-end proof that DMEngine.processThread() enforces its safety gates and
 * that escalations/replies land in SQLite. Drives the engine against a fake
 * Playwright Page so no real Instagram traffic or login is required.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'igdm-e2e-'));

import { config } from '../src/config';
(config.paths as any).dataDir = TMP;
(config.paths as any).statsFile = path.join(TMP, 'stats.json');
(config.paths as any).logsFile = path.join(TMP, 'app.log');

import { getDb, closeDb, upsertAccountRow } from '../src/storage/db';
import { QuotaLedger } from '../src/storage/quota-ledger';
import { DMEngine } from '../src/engine/dm-engine';
import { AIBrain, DMIntent } from '../src/ai/brain';
import { Logger } from '../src/utils/logger';

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`PASS: ${name}`); passed++; }
  else { console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const ACC = 'e2e_acct';
upsertAccountRow({ id: ACC, username: 'e2e', safetyProfile: 'balanced', authenticated: true });

/** Minimal fake Page implementing only what DMEngine touches. */
function makeFakePage(opts: {
  threads: Array<{ threadId: string; senderName: string; lastMessage: string; isUnread: boolean }>;
  convo: { history: string[]; lastInbound: string | null; lastIsOutbound: boolean };
}) {
  const sent: string[] = [];
  let evalCall = 0;

  const locatorStub = (found: boolean) => ({
    first: () => locatorStub(found),
    last: () => locatorStub(found),
    count: async () => (found ? 1 : 0),
    isVisible: async () => found,
    waitFor: async () => { if (!found) throw new Error('not found'); },
    click: async () => { if (!found) throw new Error('not found'); },
  });

  const page: any = {
    _sent: sent,
    url: () => 'https://www.instagram.com/direct/t/1/',
    goto: async () => {},
    waitForSelector: async () => {},
    locator: (sel: string) => {
      // The composer must be findable so sendMessage() can succeed.
      const isComposer = sel.includes('textbox') || sel.includes('Message') || sel.includes('lexical');
      return locatorStub(isComposer);
    },
    keyboard: {
      type: async (ch: string) => { sent.push(ch); },
      press: async (key: string) => { if (key === 'Enter') sent.push('\n[ENTER]'); },
    },
    evaluate: async () => {
      // First evaluate() = listThreads, second = readConversation.
      evalCall++;
      return evalCall === 1 ? opts.threads : opts.convo;
    },
  };
  return page;
}

/** AIBrain stub with a forced intent + reply. */
function makeBrain(intent: DMIntent, reply: string | null): AIBrain {
  const b = new AIBrain();
  (b as any).classifyDMIntent = async () => intent;
  (b as any).generateDMReply = async () => reply;
  return b;
}

(async () => {
  const logger = new Logger(ACC);

  // -------------------------------------------------------------------------
  console.log('\n--- SPAM intent must never receive a reply ---');
  const spamPage = makeFakePage({
    threads: [{ threadId: '501', senderName: 'spammer', lastMessage: 'crypto x100', isUnread: true }],
    convo: { history: ['Them: free crypto x100'], lastInbound: 'free crypto x100', lastIsOutbound: false },
  });
  const spamEngine = new DMEngine(ACC, makeBrain('SPAM', 'should never send'), logger, 'balanced');
  const spamRes = await spamEngine.sweepInbox(spamPage);

  check('spam thread is skipped, not replied to', spamRes.replied === 0, `replied=${spamRes.replied}`);
  check('no keystrokes were sent for a spam thread', spamPage._sent.length === 0, `sent=${spamPage._sent.length}`);
  check('outcome is SKIPPED_INTENT', spamRes.outcomes[0]?.outcome === 'SKIPPED_INTENT', spamRes.outcomes[0]?.outcome);

  const dmsAfterSpam = QuotaLedger.snapshot(ACC).dmsToday;
  check('spam thread consumed ZERO DM quota', dmsAfterSpam === 0, `dmsToday=${dmsAfterSpam}`);

  // -------------------------------------------------------------------------
  console.log('\n--- HOT_LEAD must escalate to a human, not auto-reply ---');
  const hotPage = makeFakePage({
    threads: [{ threadId: '502', senderName: 'bigclient', lastMessage: 'whats your price?', isUnread: true }],
    convo: { history: ['Them: whats your price?'], lastInbound: 'whats your price?', lastIsOutbound: false },
  });
  const hotEngine = new DMEngine(ACC, makeBrain('HOT_LEAD', 'our price is $5000'), logger, 'balanced');
  const hotRes = await hotEngine.sweepInbox(hotPage);

  check('hot lead is escalated', hotRes.escalated === 1, `escalated=${hotRes.escalated}`);
  check('hot lead is NOT auto-replied', hotRes.replied === 0, `replied=${hotRes.replied}`);
  check('no price was typed into the DM', hotPage._sent.join('').includes('5000') === false);
  check('hot lead consumed ZERO DM quota', QuotaLedger.snapshot(ACC).dmsToday === 0);

  const esc = getDb().prepare(
    "SELECT * FROM account_logs WHERE message LIKE '[DM:ESCALATED_HOT_LEAD]%'"
  ).all() as any[];
  check('escalation is persisted for the dashboard', esc.length === 1, `rows=${esc.length}`);
  check('escalation row names the sender', !!esc[0] && esc[0].message.includes('bigclient'));

  // -------------------------------------------------------------------------
  console.log('\n--- WARM_LEAD gets a real reply, quota is consumed once ---');
  const warmPage = makeFakePage({
    threads: [{ threadId: '503', senderName: 'curious', lastMessage: 'how does it work?', isUnread: true }],
    convo: { history: ['Them: how does it work?'], lastInbound: 'how does it work?', lastIsOutbound: false },
  });
  const warmEngine = new DMEngine(ACC, makeBrain('WARM_LEAD', 'happy to walk you through it'), logger, 'balanced');
  const warmRes = await warmEngine.sweepInbox(warmPage);

  check('warm lead receives a reply', warmRes.replied === 1, `replied=${warmRes.replied}`);
  check('reply text was actually typed', warmPage._sent.join('').includes('happy to walk you through it'));
  check('Enter was pressed to send', warmPage._sent.join('').includes('[ENTER]'));
  check('exactly one DM of quota was consumed',
    QuotaLedger.snapshot(ACC).dmsToday === 1, `dmsToday=${QuotaLedger.snapshot(ACC).dmsToday}`);

  // -------------------------------------------------------------------------
  console.log('\n--- Same message must never be answered twice (dup guard) ---');
  const dupPage = makeFakePage({
    threads: [{ threadId: '503', senderName: 'curious', lastMessage: 'how does it work?', isUnread: true }],
    convo: { history: ['Them: how does it work?'], lastInbound: 'how does it work?', lastIsOutbound: false },
  });
  const dupEngine = new DMEngine(ACC, makeBrain('WARM_LEAD', 'happy to walk you through it'), logger, 'balanced');
  const dupRes = await dupEngine.sweepInbox(dupPage);

  check('re-sweeping the same thread does not reply again', dupRes.replied === 0, `replied=${dupRes.replied}`);
  check('no new keystrokes on the duplicate sweep', dupPage._sent.length === 0);
  check('DM quota still shows exactly 1 consumed', QuotaLedger.snapshot(ACC).dmsToday === 1);

  // -------------------------------------------------------------------------
  console.log('\n--- A thread whose last message is ours is skipped ---');
  const ourTurnPage = makeFakePage({
    threads: [{ threadId: '504', senderName: 'pending', lastMessage: 'ok', isUnread: false }],
    convo: { history: ['You: already replied'], lastInbound: 'earlier question', lastIsOutbound: true },
  });
  const ourTurnEngine = new DMEngine(ACC, makeBrain('QUESTION', 'another reply'), logger, 'balanced');
  const ourRes = await ourTurnEngine.sweepInbox(ourTurnPage);
  check('thread awaiting their response is skipped',
    ourRes.replied === 0 && ourRes.outcomes[0]?.outcome === 'SKIPPED_NO_UNREAD',
    ourRes.outcomes[0]?.outcome);

  // -------------------------------------------------------------------------
  console.log('\n--- AI outage must cause silence, not a canned template ---');
  const deadAiPage = makeFakePage({
    threads: [{ threadId: '505', senderName: 'someone', lastMessage: 'hey', isUnread: true }],
    convo: { history: ['Them: hey'], lastInbound: 'hey', lastIsOutbound: false },
  });
  const deadAiEngine = new DMEngine(ACC, makeBrain('QUESTION', null), logger, 'balanced');
  const deadRes = await deadAiEngine.sweepInbox(deadAiPage);

  check('no reply is sent when the AI returns nothing', deadRes.replied === 0);
  check('no template text leaked into the DM',
    !deadAiPage._sent.join('').match(/Love this|Vibes|Respect|hits different/i));
  check('outcome is SKIPPED_AI_UNAVAILABLE',
    deadRes.outcomes[0]?.outcome === 'SKIPPED_AI_UNAVAILABLE', deadRes.outcomes[0]?.outcome);

  // -------------------------------------------------------------------------
  console.log('\n==========================================');
  console.log(`   DM E2E SUITE: ${passed} PASSED, ${failed} FAILED`);
  console.log('==========================================');

  closeDb();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed === 0 ? 0 : 1);
})();
