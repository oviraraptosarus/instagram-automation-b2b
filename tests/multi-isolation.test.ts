/**
 * Multi-account isolation proof.
 *
 * The bug this guards: AIBrain used to read ONLY the global .env config, so
 * every account in a multi-account run shared one offer/tone. Account B's
 * pricing could be pitched inside account A's DMs.
 *
 * Verifies the real prompt text sent to the LLM, not just stored config.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'igmulti-'));

import { config } from '../src/config';
(config.paths as any).dataDir = TMP;
(config.paths as any).statsFile = path.join(TMP, 'stats.json');
(config.paths as any).logsFile = path.join(TMP, 'app.log');
// Global defaults that must NOT leak into a configured account.
(config.targeting as any).accountContext = 'GLOBAL_FALLBACK_OFFER';
(config.targeting as any).hashtags = ['globaltag'];

import { AIBrain } from '../src/ai/brain';
import { AccountRegistry } from '../src/accounts/registry';
import { closeDb } from '../src/storage/db';

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`PASS: ${name}`); passed++; }
  else { console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

/** Capture the exact prompts a brain would send, without any network call. */
function capturePrompts(brain: AIBrain): { system: string; user: string }[] {
  const seen: { system: string; user: string }[] = [];
  (brain as any).callLLM = async (system: string, user: string) => {
    seen.push({ system, user });
    return 'stubbed';
  };
  return seen;
}

function writeAccount(id: string, state: any) {
  const dir = path.join(TMP, 'accounts', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ authenticated: true, username: state.username }));
}

const AGENCY = 'We run paid ads for B2B SaaS founders, 5k-15k/mo retainers';
const FITNESS = 'Online fitness coaching for busy execs, 300/mo';

writeAccount('acc_agency', {
  id: 'acc_agency', username: 'duxio_main', label: 'Agency', enabled: true,
  authenticated: true, status: 'IDLE', safetyProfile: 'safe', timezone: 'UTC',
  modules: ['hashtagLike', 'dmReply'],
  targeting: { hashtags: ['saas', 'b2b'], accountContext: AGENCY },
});

writeAccount('acc_fitness', {
  id: 'acc_fitness', username: 'fitcoach_io', label: 'Fitness', enabled: true,
  authenticated: true, status: 'IDLE', safetyProfile: 'balanced', timezone: 'UTC',
  modules: ['hashtagLike', 'dmReply'],
  targeting: { hashtags: ['fitness', 'gym'], accountContext: FITNESS },
});

writeAccount('acc_bare', {
  id: 'acc_bare', username: 'bare_handle', label: 'Bare', enabled: true,
  authenticated: true, status: 'IDLE', safetyProfile: 'balanced', timezone: 'UTC',
  modules: ['dmReply'],
  targeting: { hashtags: [], accountContext: '' },
});

(async () => {
  console.log('\n--- Registry loads each account\'s own config from disk ---');
  const registry = AccountRegistry.getInstance();
  const all = registry.discover();
  check('all three accounts discovered', all.length === 3, `found=${all.length}`);

  const agency = registry.get('acc_agency')!;
  const fitness = registry.get('acc_fitness')!;
  check('agency keeps its own context', agency.targeting.accountContext === AGENCY);
  check('fitness keeps its own context', fitness.targeting.accountContext === FITNESS);
  check('agency keeps its own hashtags', agency.targeting.hashtags.join(',') === 'saas,b2b');
  check('fitness keeps its own hashtags', fitness.targeting.hashtags.join(',') === 'fitness,gym');
  check('per-account safety profiles differ',
    agency.safetyProfile === 'safe' && fitness.safetyProfile === 'balanced');

  console.log('\n--- Each brain is grounded in its OWN offer ---');
  const agencyBrain = new AIBrain({ accountId: 'acc_agency', accountContext: agency.targeting.accountContext });
  const fitnessBrain = new AIBrain({ accountId: 'acc_fitness', accountContext: fitness.targeting.accountContext });

  check('agency brain reports its own context', agencyBrain.getAccountContext() === AGENCY);
  check('fitness brain reports its own context', fitnessBrain.getAccountContext() === FITNESS);

  console.log('\n--- DM prompts carry the right offer and NO cross-leak ---');
  const aPrompts = capturePrompts(agencyBrain);
  await agencyBrain.generateDMReply('whats the pricing?', 'lead_one', { history: [], intent: 'WARM_LEAD' });
  const aText = JSON.stringify(aPrompts);
  check('agency DM prompt contains the agency offer', aText.includes('5k-15k/mo retainers'));
  check('agency DM prompt does NOT contain the fitness offer', !aText.includes('300/mo'));
  check('agency DM prompt does NOT fall back to the global offer', !aText.includes('GLOBAL_FALLBACK_OFFER'));

  const fPrompts = capturePrompts(fitnessBrain);
  await fitnessBrain.generateDMReply('whats the pricing?', 'lead_two', { history: [], intent: 'WARM_LEAD' });
  const fText = JSON.stringify(fPrompts);
  check('fitness DM prompt contains the fitness offer', fText.includes('300/mo'));
  check('fitness DM prompt does NOT contain the agency offer', !fText.includes('5k-15k/mo retainers'));

  console.log('\n--- Intent classification is also per-account ---');
  const aCls = capturePrompts(agencyBrain);
  await agencyBrain.classifyDMIntent('do you take new clients?', 'lead_three');
  const aClsText = JSON.stringify(aCls);
  check('agency classifier sees the agency offer', aClsText.includes('5k-15k/mo retainers'));
  check('agency classifier does not see the fitness offer', !aClsText.includes('300/mo'));

  console.log('\n--- Comment prompts are per-account too ---');
  const aCom = capturePrompts(agencyBrain);
  await agencyBrain.generateComment('scaling our SaaS to 10k MRR', 'founder_x');
  check('agency comment prompt does not leak the fitness offer',
    !JSON.stringify(aCom).includes('300/mo'));

  console.log('\n--- An unconfigured account falls back to the global .env ---');
  const bare = registry.get('acc_bare')!;
  const bareBrain = new AIBrain({ accountId: 'acc_bare', accountContext: bare.targeting.accountContext || undefined });
  check('empty per-account context falls back to global',
    bareBrain.getAccountContext() === 'GLOBAL_FALLBACK_OFFER',
    bareBrain.getAccountContext());

  console.log('\n==========================================');
  console.log(`   MULTI-ACCOUNT ISOLATION: ${passed} PASSED, ${failed} FAILED`);
  console.log('==========================================');

  closeDb();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed === 0 ? 0 : 1);
})();
