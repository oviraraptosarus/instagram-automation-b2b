import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { Logger } from '../utils/logger';

export type AccountStatus = 'IDLE' | 'RUNNING' | 'SLEEPING' | 'ERROR' | 'AUTH_REQUIRED';

export interface Account {
    id: string;
    username: string;
    label: string;
    enabled: boolean;
    authenticated: boolean;
    status: AccountStatus;
    safetyProfile: 'safe' | 'balanced' | 'active';
    timezone: string;
    modules: string[];
    targeting: {
        hashtags: string[];
        accountContext: string;
    };
}

export class AccountRegistry {
    private static instance: AccountRegistry;
    private accounts: Map<string, Account> = new Map();

    private constructor() {}

    public static getInstance(): AccountRegistry {
        if (!AccountRegistry.instance) {
            AccountRegistry.instance = new AccountRegistry();
        }
        return AccountRegistry.instance;
    }

    /**
     * File-based account discovery reading from data/accounts/ directory.
     * Uses config.paths.dataDir to build the target path.
     */
    public discover(): Account[] {
        this.accounts.clear();
        const accountsDir = path.join(config.paths.dataDir, 'accounts');

        if (!fs.existsSync(accountsDir)) {
            Logger.info(`Accounts directory does not exist: ${accountsDir}`);
            return [];
        }

        const entries = fs.readdirSync(accountsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                try {
                    const account = this.loadAccountFromDir(accountsDir, entry.name);
                    if (account) {
                        this.ensureNoDuplicateUsername(account.username, account.id);
                        this.accounts.set(account.id, account);
                    }
                } catch (e: any) {
                    Logger.error(`Failed loading account from directory "${entry.name}": ${e.message || e}`);
                }
            }
        }

        Logger.info(`Discovered ${this.accounts.size} account(s) from ${accountsDir}`);
        return this.list();
    }

    private loadAccountFromDir(accountsDir: string, dirName: string): Account | null {
        const accountDir = path.join(accountsDir, dirName);
        const stateFile = path.join(accountDir, 'state.json');
        const authFile = path.join(accountDir, 'auth.json');

        let accountData: Partial<Account> = {};

        // Read state.json if present
        if (fs.existsSync(stateFile)) {
            try {
                const raw = fs.readFileSync(stateFile, 'utf8');
                accountData = JSON.parse(raw);
            } catch (e: any) {
                Logger.warn(`Failed reading state.json for ${dirName}: ${e.message || e}`);
            }
        }

        // Check auth.json for authentication status
        let isAuth = false;
        if (fs.existsSync(authFile)) {
            try {
                const authRaw = fs.readFileSync(authFile, 'utf8');
                const authParsed = JSON.parse(authRaw);
                isAuth = !!authParsed.authenticated;
            } catch (e: any) {
                Logger.warn(`Failed reading auth.json for ${dirName}: ${e.message || e}`);
            }
        }

        const account: Account = {
            id: accountData.id || dirName,
            username: accountData.username || dirName,
            label: accountData.label || dirName,
            enabled: accountData.enabled !== undefined ? accountData.enabled : true,
            authenticated: isAuth || !!accountData.authenticated,
            status: accountData.status || (isAuth ? 'IDLE' : 'AUTH_REQUIRED'),
            safetyProfile: accountData.safetyProfile || 'balanced',
            timezone: accountData.timezone || 'UTC',
            modules: Array.isArray(accountData.modules) ? accountData.modules : [],
            targeting: accountData.targeting || { hashtags: [], accountContext: '' }
        };

        this.validateAccount(account);
        return account;
    }

    /**
     * Add a new account to the registry and persist to disk.
     */
    public add(account: Account): Account {
        this.validateAccount(account);
        this.ensureNoDuplicateUsername(account.username, account.id);
        this.accounts.set(account.id, { ...account });
        this.persistAccount(account);
        Logger.info(`Account added: ${account.username} (${account.id})`);
        return { ...account };
    }

    /**
     * List all registered accounts.
     */
    public list(): Account[] {
        return Array.from(this.accounts.values()).map(a => ({ ...a }));
    }

    /**
     * Get account by ID.
     */
    public get(id: string): Account | undefined {
        const acc = this.accounts.get(id);
        return acc ? { ...acc } : undefined;
    }

    /**
     * Update existing account fields and persist.
     */
    public update(id: string, updates: Partial<Omit<Account, 'id'>>): Account {
        const existing = this.getAccountOrThrow(id);
        if (updates.username !== undefined && updates.username !== existing.username) {
            this.ensureNoDuplicateUsername(updates.username, id);
        }

        const updated: Account = {
            ...existing,
            ...updates,
            id // Ensure ID remains immutable
        };

        this.validateAccount(updated);
        this.accounts.set(id, updated);
        this.persistAccount(updated);
        Logger.info(`Account updated: ${id}`);
        return { ...updated };
    }

    /**
     * Enable an account.
     */
    public enable(id: string): Account {
        return this.update(id, { enabled: true });
    }

    /**
     * Disable an account.
     */
    public disable(id: string): Account {
        return this.update(id, { enabled: false });
    }

    /**
     * Remove an account from registry and delete disk directory.
     */
    public remove(id: string): boolean {
        const existing = this.getAccountOrThrow(id);
        this.accounts.delete(id);

        const accountsDir = path.join(config.paths.dataDir, 'accounts');
        const accountDir = path.join(accountsDir, id);

        if (fs.existsSync(accountDir)) {
            fs.rmSync(accountDir, { recursive: true, force: true });
        }

        Logger.info(`Account removed: ${id} (${existing.username})`);
        return true;
    }

    /**
     * Check if account is authenticated (reading from auth.json dynamically if available).
     */
    public checkAuthentication(id: string): boolean {
        const account = this.getAccountOrThrow(id);
        const accountsDir = path.join(config.paths.dataDir, 'accounts');
        const authFile = path.join(accountsDir, id, 'auth.json');

        if (fs.existsSync(authFile)) {
            try {
                const raw = fs.readFileSync(authFile, 'utf8');
                const auth = JSON.parse(raw);
                const isAuth = !!auth.authenticated;
                if (account.authenticated !== isAuth) {
                    this.update(id, { authenticated: isAuth });
                }
                return isAuth;
            } catch (e) {
                return account.authenticated;
            }
        }
        return account.authenticated;
    }

    /**
     * Get account state including refreshed authentication status.
     */
    public getAccountState(id: string): Account | undefined {
        const account = this.get(id);
        if (!account) return undefined;

        const authenticated = this.checkAuthentication(id);
        return {
            ...account,
            authenticated
        };
    }

    // --- Helper & Validation Methods ---

    private validateAccount(account: Account): void {
        if (!account.id || typeof account.id !== 'string' || account.id.trim() === '') {
            throw new Error('Account id is required and must be a non-empty string');
        }
        if (!account.username || typeof account.username !== 'string' || account.username.trim() === '') {
            throw new Error(`Account ${account.id}: username is required and must be a non-empty string`);
        }
        const validStatuses: AccountStatus[] = ['IDLE', 'RUNNING', 'SLEEPING', 'ERROR', 'AUTH_REQUIRED'];
        if (account.status && !validStatuses.includes(account.status)) {
            throw new Error(`Account ${account.id}: invalid status "${account.status}"`);
        }
    }

    private ensureNoDuplicateUsername(username: string, excludeId: string): void {
        for (const [id, acc] of this.accounts.entries()) {
            if (id !== excludeId && acc.username.toLowerCase() === username.toLowerCase()) {
                throw new Error(`Duplicate username "${username}" detected (already used by account ${id})`);
            }
        }
    }

    private getAccountOrThrow(id: string): Account {
        const acc = this.accounts.get(id);
        if (!acc) {
            throw new Error(`Account not found with id: ${id}`);
        }
        return acc;
    }

    private persistAccount(account: Account): void {
        const accountsDir = path.join(config.paths.dataDir, 'accounts');
        const accountDir = path.join(accountsDir, account.id);
        fs.mkdirSync(accountDir, { recursive: true });

        const stateFile = path.join(accountDir, 'state.json');
        fs.writeFileSync(stateFile, JSON.stringify(account, null, 2));

        const authFile = path.join(accountDir, 'auth.json');
        fs.writeFileSync(authFile, JSON.stringify({
            authenticated: account.authenticated,
            username: account.username
        }, null, 2));
    }
}

export const accountRegistry = AccountRegistry.getInstance();
