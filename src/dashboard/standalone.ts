import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { config, profiles } from '../config';
import { AccountRegistry } from '../accounts/registry';
import { WorkerManager } from '../workers/manager';
import { getDb, QuotaRow } from '../storage/db';

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const registry = AccountRegistry.getInstance();
const workerManager = new WorkerManager();

// GET /api/status - Global status overview
app.get('/api/status', (req, res) => {
  const accounts = registry.discover();
  const db = getDb();
  
  const totalLikes = db.prepare('SELECT SUM(likes_today) as total FROM quotas').get() as { total: number };
  const totalComments = db.prepare('SELECT SUM(comments_today) as total FROM quotas').get() as { total: number };

  res.json({
    status: 'ONLINE',
    config: {
      ai_provider: config.ai.provider,
      ai_model: config.ai.model,
      safety_profile: config.safety.profile
    },
    accountsCount: accounts.length,
    activeWorkersCount: workerManager.listWorkers().filter(w => w.status === 'running').length,
    aggregateStats: {
      likesToday: totalLikes?.total || 0,
      commentsToday: totalComments?.total || 0
    }
  });
});

// GET /api/accounts - List all registered accounts
app.get('/api/accounts', (req, res) => {
  const accounts = registry.discover();
  const db = getDb();

  const accountsWithStats = accounts.map(account => {
    const quotaRow = db.prepare('SELECT * FROM quotas WHERE account_id = ?').get(account.id) as QuotaRow | undefined;
    const workerStatus = workerManager.getWorkerStatus(account.id);

    return {
      ...account,
      workerStatus: workerStatus ? workerStatus.status : 'stopped',
      stats: {
        likesToday: quotaRow ? quotaRow.likes_today : 0,
        commentsToday: quotaRow ? quotaRow.comments_today : 0,
        dmsToday: quotaRow ? quotaRow.dms_today : 0,
        likesThisHour: quotaRow ? quotaRow.likes_this_hour : 0,
        commentsThisHour: quotaRow ? quotaRow.comments_this_hour : 0
      }
    };
  });

  res.json({ accounts: accountsWithStats });
});

// GET /api/dm/escalations - Hot leads flagged for human follow-up.
// Without this the HOT_LEAD handoff would be invisible and leads would rot.
app.get('/api/dm/escalations', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT account_id, message, created_at FROM account_logs
      WHERE message LIKE '[DM:ESCALATED_HOT_LEAD]%'
      ORDER BY created_at DESC LIMIT 100
    `).all();
    res.json({ escalations: rows, count: rows.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dm/activity - Recent DM engine activity across all accounts.
app.get('/api/dm/activity', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT account_id, level, message, created_at FROM account_logs
      WHERE message LIKE '[DM:%'
      ORDER BY created_at DESC LIMIT 200
    `).all();
    res.json({ activity: rows, count: rows.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/accounts - Register new account
app.post('/api/accounts', (req, res) => {
  try {
    const { id, username, label, safetyProfile, targeting } = req.body;
    if (!id || !username) {
      return res.status(400).json({ error: 'id and username are required' });
    }

    const newAccount = registry.add({
      id,
      username,
      label: label || username,
      enabled: true,
      authenticated: false,
      status: 'AUTH_REQUIRED',
      safetyProfile: safetyProfile || 'balanced',
      timezone: 'UTC',
      modules: ['hashtagLike', 'hashtagComment'],
      targeting: targeting || { hashtags: ['tech'], accountContext: '' }
    });

    res.status(201).json({ account: newAccount });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/accounts/:id/start - Start specific worker
app.post('/api/accounts/:id/start', async (req, res) => {
  const { id } = req.params;
  try {
    const worker = await workerManager.startAccount(id);
    res.json({ message: `Account ${id} worker started`, status: worker.getState().status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/accounts/:id/stop - Stop specific worker
app.post('/api/accounts/:id/stop', async (req, res) => {
  const { id } = req.params;
  try {
    await workerManager.stopAccount(id);
    res.json({ message: `Account ${id} worker stopped` });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/accounts/:id/restart - Restart specific worker
app.post('/api/accounts/:id/restart', async (req, res) => {
  const { id } = req.params;
  try {
    await workerManager.stopAccount(id);
    const worker = await workerManager.startAccount(id);
    res.json({ message: `Account ${id} worker restarted`, status: worker.getState().status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/accounts/:id/logs - Get account logs
app.get('/api/accounts/:id/logs', (req, res) => {
  const { id } = req.params;
  const accountLogFile = path.join(config.paths.dataDir, 'accounts', id, 'app.log');

  if (!fs.existsSync(accountLogFile)) {
    return res.json({ logs: [] });
  }

  try {
    const data = fs.readFileSync(accountLogFile, 'utf8');
    const lines = data.split('\n').filter(l => l.trim().length > 0).slice(-50);
    res.json({ logs: lines });
  } catch (e: any) {
    res.json({ logs: [] });
  }
});

const PORT = config.dashboard.port || 3456;
app.listen(PORT, () => {
  console.log(chalk.green(`
=========================================
🌐 INSTAGRAM MULTI-ACCOUNT DASHBOARD RUNNING 
=========================================
URL: http://localhost:${PORT}

Press CTRL+C anytime to close the dashboard server.
`));
});
