/**
 * Account management CLI — the supported way to add accounts and feed each one
 * its own data (offer/context, hashtags, safety profile, modules).
 *
 * Before this, the only way to configure an account was hand-editing
 * data/accounts/<id>/state.json, and AIBrain ignored it anyway.
 *
 *   npm run account -- list
 *   npm run account -- add --id acc_01 --username myhandle --profile safe
 *   npm run account -- set --id acc_01 --context "We sell X to Y for $Z" --hashtags saas,b2b
 *   npm run account -- set --id acc_01 --modules hashtagLike,hashtagComment,dmReply
 *   npm run account -- enable --id acc_01
 *   npm run account -- disable --id acc_01
 *   npm run account -- show --id acc_01
 */
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { AccountRegistry, Account } from './accounts/registry';
import { upsertAccountRow } from './storage/db';
import { Logger } from './utils/logger';

const VALID_PROFILES = ['safe', 'balanced', 'active'] as const;
const VALID_MODULES = [
  'feedLike',
  'feedComment',
  'hashtagLike',
  'hashtagComment',
  'dmReply',
] as const;

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
  const args: Args = {};
  for (let i = cmd === 'help' ? 0 : 1; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return { cmd, args };
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function csv(args: Args, key: string): string[] | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

function accountDir(id: string): string {
  return path.join(config.paths.dataDir, 'accounts', id);
}

function stateFile(id: string): string {
  return path.join(accountDir(id), 'state.json');
}

/** Read state.json straight from disk (registry.get() needs discover() first). */
function readState(id: string): Partial<Account> | null {
  const f = stateFile(id);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e: any) {
    throw new Error(`state.json for "${id}" is corrupt: ${e.message}`);
  }
}

function writeState(id: string, state: Partial<Account>): void {
  const dir = accountDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(id), JSON.stringify(state, null, 2), 'utf8');
}

/** Mirror disk state into SQLite so FK-bound quota writes succeed. */
function syncToDb(state: Partial<Account>): void {
  if (!state.id) return;
  upsertAccountRow({
    id: state.id,
    username: state.username || state.id,
    safetyProfile: state.safetyProfile || 'balanced',
    authenticated: !!state.authenticated,
    enabled: state.enabled !== false,
    status: state.status || 'AUTH_REQUIRED',
    accountContext: state.targeting?.accountContext ?? null,
  });
}

function cmdList(): void {
  const registry = AccountRegistry.getInstance();
  const accounts = registry.discover();

  if (accounts.length === 0) {
    console.log('\nNo accounts yet. Create one:');
    console.log('  npm run account -- add --id acc_01 --username yourhandle\n');
    return;
  }

  console.log(`\n${accounts.length} account(s):\n`);
  for (const a of accounts) {
    const auth = a.authenticated ? 'AUTHED' : 'NEEDS LOGIN';
    const en = a.enabled ? 'enabled' : 'DISABLED';
    console.log(`  ${a.id}`);
    console.log(`    username : @${a.username}`);
    console.log(`    status   : ${auth} / ${en} / ${a.status}`);
    console.log(`    profile  : ${a.safetyProfile}`);
    console.log(`    modules  : ${a.modules.length ? a.modules.join(', ') : '(none)'}`);
    console.log(`    hashtags : ${a.targeting.hashtags.length ? a.targeting.hashtags.join(', ') : '(none)'}`);
    const ctx = a.targeting.accountContext;
    console.log(`    context  : ${ctx ? `"${ctx.slice(0, 70)}${ctx.length > 70 ? '...' : ''}"` : '(EMPTY — DMs will be generic)'}`);
    console.log('');
  }
}

function cmdAdd(args: Args): void {
  const id = str(args, 'id');
  const username = str(args, 'username');

  if (!id || !username) {
    throw new Error('add requires --id and --username');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`--id "${id}" must be alphanumeric/underscore/hyphen (it becomes a folder name)`);
  }
  if (readState(id)) {
    throw new Error(`Account "${id}" already exists. Use: set --id ${id}`);
  }

  const profile = str(args, 'profile') || 'balanced';
  if (!VALID_PROFILES.includes(profile as any)) {
    throw new Error(`--profile must be one of: ${VALID_PROFILES.join(', ')}`);
  }

  // Reject a duplicate handle across accounts; two dirs driving one login
  // means both workers fight over the same session and trip IG's heuristics.
  const existing = AccountRegistry.getInstance().discover();
  const clash = existing.find(a => a.username.toLowerCase() === username.toLowerCase());
  if (clash) {
    throw new Error(`Username "@${username}" is already used by account "${clash.id}"`);
  }

  const state: Partial<Account> = {
    id,
    username,
    label: str(args, 'label') || id,
    enabled: true,
    authenticated: false,
    status: 'AUTH_REQUIRED',
    safetyProfile: profile as Account['safetyProfile'],
    timezone: str(args, 'timezone') || 'UTC',
    modules: csv(args, 'modules') || ['hashtagLike', 'dmReply'],
    targeting: {
      hashtags: csv(args, 'hashtags') || [],
      accountContext: str(args, 'context') || '',
    },
  };

  const badModules = (state.modules || []).filter(m => !VALID_MODULES.includes(m as any));
  if (badModules.length) {
    throw new Error(`Unknown module(s): ${badModules.join(', ')}. Valid: ${VALID_MODULES.join(', ')}`);
  }

  // Scaffold the per-account dirs the engine expects.
  fs.mkdirSync(path.join(accountDir(id), 'profile'), { recursive: true });
  writeState(id, state);
  syncToDb(state);

  Logger.success(`Account "${id}" created (@${username}, profile=${profile})`);
  console.log(`\nNext:`);
  console.log(`  1. npm run account -- set --id ${id} --context "what you sell, to whom, price band"`);
  console.log(`  2. npm run login -- --account ${id}     (log in once, in the window that opens)`);
  console.log(`  3. npm start\n`);
}

function cmdSet(args: Args): void {
  const id = str(args, 'id');
  if (!id) throw new Error('set requires --id');

  const state = readState(id);
  if (!state) throw new Error(`Account "${id}" not found. Create it with: add --id ${id} --username <handle>`);

  state.targeting = state.targeting || { hashtags: [], accountContext: '' };
  const changes: string[] = [];

  const context = str(args, 'context');
  if (context !== undefined) {
    state.targeting.accountContext = context;
    changes.push('context');
  }

  const hashtags = csv(args, 'hashtags');
  if (hashtags !== undefined) {
    state.targeting.hashtags = hashtags;
    changes.push('hashtags');
  }

  const profile = str(args, 'profile');
  if (profile !== undefined) {
    if (!VALID_PROFILES.includes(profile as any)) {
      throw new Error(`--profile must be one of: ${VALID_PROFILES.join(', ')}`);
    }
    state.safetyProfile = profile as Account['safetyProfile'];
    changes.push('profile');
  }

  const modules = csv(args, 'modules');
  if (modules !== undefined) {
    const bad = modules.filter(m => !VALID_MODULES.includes(m as any));
    if (bad.length) {
      throw new Error(`Unknown module(s): ${bad.join(', ')}. Valid: ${VALID_MODULES.join(', ')}`);
    }
    state.modules = modules;
    changes.push('modules');
  }

  const label = str(args, 'label');
  if (label !== undefined) { state.label = label; changes.push('label'); }

  const timezone = str(args, 'timezone');
  if (timezone !== undefined) { state.timezone = timezone; changes.push('timezone'); }

  if (changes.length === 0) {
    throw new Error('set needs at least one of: --context --hashtags --profile --modules --label --timezone');
  }

  writeState(id, state);
  syncToDb(state);
  Logger.success(`Updated "${id}": ${changes.join(', ')}`);
}

function cmdToggle(args: Args, enabled: boolean): void {
  const id = str(args, 'id');
  if (!id) throw new Error(`${enabled ? 'enable' : 'disable'} requires --id`);

  const state = readState(id);
  if (!state) throw new Error(`Account "${id}" not found`);

  state.enabled = enabled;
  writeState(id, state);
  syncToDb(state);
  Logger.success(`Account "${id}" ${enabled ? 'enabled' : 'disabled'}`);
}

function cmdShow(args: Args): void {
  const id = str(args, 'id');
  if (!id) throw new Error('show requires --id');
  const state = readState(id);
  if (!state) throw new Error(`Account "${id}" not found`);
  console.log(JSON.stringify(state, null, 2));
}

function cmdHelp(): void {
  console.log(`
Instagram automation — account manager

  npm run account -- list
  npm run account -- add  --id <id> --username <handle> [--profile safe|balanced|active]
                          [--context "..."] [--hashtags a,b,c] [--modules ...] [--label ...]
  npm run account -- set  --id <id> [--context "..."] [--hashtags a,b,c]
                          [--profile ...] [--modules ...] [--label ...] [--timezone ...]
  npm run account -- show    --id <id>
  npm run account -- enable  --id <id>
  npm run account -- disable --id <id>

Modules: ${VALID_MODULES.join(', ')}
Profiles: ${VALID_PROFILES.join(', ')}

--context is the single most important field: it grounds every AI comment and
DM reply. Empty context means generic, obviously-botted messages.
`);
}

function main(): void {
  const { cmd, args } = parseArgs(process.argv.slice(2));

  try {
    switch (cmd) {
      case 'list': cmdList(); break;
      case 'add': cmdAdd(args); break;
      case 'set': cmdSet(args); break;
      case 'show': cmdShow(args); break;
      case 'enable': cmdToggle(args, true); break;
      case 'disable': cmdToggle(args, false); break;
      case 'help': cmdHelp(); break;
      default:
        Logger.error(`Unknown command "${cmd}"`);
        cmdHelp();
        process.exit(1);
    }
  } catch (e: any) {
    Logger.error(e.message);
    process.exit(1);
  }
}

main();
