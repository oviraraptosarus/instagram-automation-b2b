import { BrowserEngine } from './engine/browser';
import { AccountRegistry } from './accounts/registry';
import { Logger } from './utils/logger';

function getAccountIdArg(): string {
  const args = process.argv.slice(2);
  const accIdx = args.findIndex(a => a === '--account' || a === '-a');
  if (accIdx !== -1 && args[accIdx + 1]) {
    return args[accIdx + 1];
  }
  return process.env.INSTAGRAM_ACCOUNT_ID || 'account_default';
}

async function runLogin() {
  const accountId = getAccountIdArg();
  Logger.info(`Starting Login Helper for account "${accountId}"...`);
  Logger.info('A visible Chrome window will now open.');
  Logger.info('1. Log into Instagram in the browser window.');
  Logger.info('2. Complete any 2FA/SMS code if prompted.');
  Logger.info('3. Once your feed is visible, close the browser window to save session.');

  const engine = new BrowserEngine(accountId);
  const page = await engine.launch(false); // HEADLESS = false

  await page.goto('https://www.instagram.com', { waitUntil: 'networkidle' });

  const isAuth = await engine.checkSessionHealth();
  if (isAuth) {
    Logger.success(`Session health verified for "${accountId}"! Account authenticated.`);
    const registry = AccountRegistry.getInstance();
    const acc = registry.get(accountId);
    if (acc) {
      registry.update(accountId, { authenticated: true, status: 'IDLE' });
    }
  }

  page.on('close', async () => {
    Logger.info(`Browser closed by user. Session saved for account "${accountId}".`);
    process.exit(0);
  });
}

runLogin();
