import { BrowserEngine } from '../engine/browser';
import { Logger } from '../utils/logger';
import { getDb, AccountRow } from '../storage/db';

// ---------------------------------------------------------------------------
// AccountWorker – tracks the runtime state of a single account's worker
// ---------------------------------------------------------------------------

export interface WorkerState {
  accountId: string;
  status: 'idle' | 'running' | 'stopped' | 'crashed';
  engine: BrowserEngine | null;
  error: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

export class AccountWorker {
  readonly accountId: string;
  engine: BrowserEngine | null = null;
  state: WorkerState['status'] = 'idle';
  error: string | null = null;
  startedAt: string | null = null;
  stoppedAt: string | null = null;

  constructor(accountId: string) {
    this.accountId = accountId;
  }

  async start(): Promise<void> {
    this.state = 'running';
    this.error = null;
    this.startedAt = new Date().toISOString();
    this.stoppedAt = null;
    try {
      this.engine = new BrowserEngine(this.accountId);
      await this.engine.launch(true);
      Logger.success(`Worker for account "${this.accountId}" started`);
    } catch (err: any) {
      this.state = 'crashed';
      this.error = err.message;
      Logger.error(`Worker for account "${this.accountId}" crashed: ${err.message}`);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.engine) {
      await this.engine.stop();
      this.engine = null;
    }
    this.state = 'stopped';
    this.stoppedAt = new Date().toISOString();
    Logger.info(`Worker for account "${this.accountId}" stopped`);
  }

  getState(): WorkerState {
    return {
      accountId: this.accountId,
      status: this.state,
      engine: this.engine,
      error: this.error,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// AccountRegistry – checks account state before starting workers
// ---------------------------------------------------------------------------

export class AccountRegistry {
  /** Return the AccountRow for a given accountId, or null if not found */
  static getAccount(accountId: string): AccountRow | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as AccountRow | undefined;
    return row ?? null;
  }

  /** Return all account rows that are enabled AND authenticated */
  static getEnabledAccounts(): AccountRow[] {
    const db = getDb();
    return db.prepare(
      'SELECT * FROM accounts WHERE enabled = 1 AND authenticated = 1'
    ).all() as AccountRow[];
  }

  static isEnabled(accountId: string): boolean {
    const acc = this.getAccount(accountId);
    return acc ? acc.enabled === 1 : false;
  }

  static isAuthenticated(accountId: string): boolean {
    const acc = this.getAccount(accountId);
    return acc ? acc.authenticated === 1 : false;
  }
}

// ---------------------------------------------------------------------------
// WorkerManager – central orchestrator for all account workers
// ---------------------------------------------------------------------------

export class WorkerManager {
  private workers: Map<string, AccountWorker> = new Map();

  /**
   * Start a worker for the given accountId.
   * Idempotent: if a worker is already running for this account, do nothing.
   * Checks AccountRegistry first (must be enabled + authenticated).
   */
  async startAccount(accountId: string): Promise<AccountWorker> {
    const existing = this.workers.get(accountId);
    if (existing && existing.state === 'running') {
      Logger.warn(`startAccount("${accountId}"): worker already running — skipping (idempotent)`);
      return existing;
    }
    if (existing && (existing.state === 'idle' || existing.state === 'stopped')) {
      Logger.info(`startAccount("${accountId}"): restarting existing worker`);
      await existing.stop();
    }

    // Check account state via AccountRegistry
    if (!AccountRegistry.isEnabled(accountId)) {
      throw new Error(`Account "${accountId}" is not enabled`);
    }
    if (!AccountRegistry.isAuthenticated(accountId)) {
      throw new Error(`Account "${accountId}" is not authenticated`);
    }

    const worker = new AccountWorker(accountId);
    this.workers.set(accountId, worker);

    try {
      await worker.start();
    } catch (err: any) {
      // Keep the worker in crashed state for recoverAfterFailure
      Logger.error(`startAccount("${accountId}") failed: ${err.message}`);
      throw err;
    }

    return worker;
  }

  /** Stop the worker for the given accountId. No-op if no worker exists. */
  async stopAccount(accountId: string): Promise<void> {
    const worker = this.workers.get(accountId);
    if (!worker) {
      Logger.warn(`stopAccount("${accountId}"): no worker found`);
      return;
    }
    await worker.stop();
  }

  /** Start all enabled + authenticated accounts. Returns list of started workers. */
  async startAll(): Promise<AccountWorker[]> {
    const accounts = AccountRegistry.getEnabledAccounts();
    const started: AccountWorker[] = [];

    for (const acc of accounts) {
      try {
        const worker = await this.startAccount(String(acc.id));
        started.push(worker);
      } catch (err: any) {
        Logger.error(`startAll: failed to start account ${acc.id}: ${err.message}`);
      }
    }

    Logger.info(`startAll: started ${started.length}/${accounts.length} workers`);
    return started;
  }

  /** Stop all running workers. */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.workers.values()).map(w => w.stop());
    await Promise.all(promises);
    Logger.info(`stopAll: stopped ${promises.length} workers`);
  }

  /** Get the current WorkerState for an account, or null if no worker exists. */
  getWorkerStatus(accountId: string): WorkerState | null {
    const worker = this.workers.get(accountId);
    return worker ? worker.getState() : null;
  }

  /** Return array of states for all managed workers. */
  listWorkers(): WorkerState[] {
    return Array.from(this.workers.values()).map(w => w.getState());
  }

  /**
   * Recover a crashed worker: stop the old one and start a fresh worker.
   * Only acts if the worker is in 'crashed' state.
   */
  async recoverAfterFailure(accountId: string): Promise<AccountWorker> {
    const existing = this.workers.get(accountId);
    if (existing && existing.state !== 'crashed') {
      Logger.warn(`recoverAfterFailure("${accountId}"): worker not crashed (state=${existing.state}) — calling startAccount instead`);
      return this.startAccount(accountId);
    }

    Logger.info(`recoverAfterFailure("${accountId}"): restarting crashed worker`);
    if (existing) {
      try { await existing.stop(); } catch {}
    }

    return this.startAccount(accountId);
  }

  /** Return a snapshot of all workers as [accountId, WorkerState] pairs. */
  getAllStatuses(): [string, WorkerState][] {
    return Array.from(this.workers.entries()).map(([id, w]) => [id, w.getState()]);
  }

  /** Number of tracked workers. */
  get size(): number {
    return this.workers.size;
  }
}
