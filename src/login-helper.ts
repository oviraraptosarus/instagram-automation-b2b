import { BrowserEngine } from './engine/browser';
import { Logger } from './utils/logger';

async function runLogin() {
    Logger.info('Starting Login Helper...');
    Logger.info('A visible Chrome window will now open.');
    Logger.info('Please log in to your Instagram account manually.');
    Logger.info('If it asks for 2FA/SMS code, enter it.');
    Logger.info('Once you are logged in and see your News Feed, come back to this terminal and press CTRL+C to save session.');
    
    const engine = new BrowserEngine();
    const page = await engine.launch(false); // HEADLESS = false

    await page.goto('https://www.instagram.com', { waitUntil: 'networkidle' });

    // Keep it open
    page.on('close', () => {
        Logger.info('Browser closed by user. Session saved.');
        process.exit(0);
    });
}

runLogin();
