<div align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/e/e7/Instagram_logo_2016.svg" width="100" />
  <h1>The Client Acquisition Operating System (IG)</h1>
  <p><b>How We Recover $10,000 to $30,000/Month in Leaked Pipeline for $3,000+ Coaches & Agencies in Under 30 Days — Without Spending an Extra Dollar on Ads.</b></p>
</div>

---

## 🚫 The Agency Death Spiral

Cold DM spam is dead. Dropping Calendly links in inboxes destroys your authority.

Every day you spend 4 hours manually scrolling hashtags, double-tapping posts, and leaving forced "great post 🔥" comments. Or worse, you hire a $500/mo VA who gets your account shadowbanned within two weeks because they copy-paste the same 4 comments on 200 posts an hour.

You open your calendar and find 3 no-shows and a lead asking for a discount 5 minutes in.

We don't sell hype or chat toys. We install hardened, backend infrastructure that recovers dead pipeline, engages organically, and filters out broke leads.

---

## ⚙️ The Proprietary Mechanism: Multi-Account Swarm OS

**The Client Acquisition Operating System** isn't a simple bot script. It is an enterprise-grade, multi-account orchestration engine built on isolated Playwright browser contexts and transactional SQLite.

### Why This Evades Bans When Everything Else Fails:
1. **Isolated Browser Contexts**: Each account receives an entirely quarantined signature (`data/accounts/<id>/profile`). No shared cookies. No shared `navigator.webdriver` footprint.
2. **SQLite WAL Quota Enforcement**: Atomic database transactions guarantee your accounts never exceed exactly 70 likes and 25 comments per day. No write-lock race conditions.
3. **The Humanizer Typist**: The bot types character-by-character with 50ms–150ms Gaussian jitter. It scrolls unpredictably.
4. **Circadian Sleep Cycles**: The engine forces dormancy between 11 PM and 8 AM local time.
5. **Contextual LLM Engagement**: Integrated with OpenAI, Gemini, and OpenClaw. The AI reads the target's caption and generates a highly specific, 1-2 sentence response. *Zero duplicated comments, ever.*

---

## 🏗️ Multi-Account Isolated Architecture

```text
                    ACCOUNT REGISTRY (AccountRegistry)
                                   |
                                   v
                      JOB / TASK QUEUE (ActionQueue)
                                   |
              +--------------------+--------------------+
              |                    |                    |
              v                    v                    v
          ACCOUNT A            ACCOUNT B            ACCOUNT C
        (AccountWorker)      (AccountWorker)      (AccountWorker)
              |                    |                    |
          Browser A            Browser B            Browser C
       data/accounts/       data/accounts/       data/accounts/
      account_01/profile   account_02/profile   account_03/profile
              |                    |                    |
              +--------------------+--------------------+
                                   |
                                   v
                        TRANSACTIONAL SQLITE DB
                       (data/accounts/instagram.db)
```

---

## ⚡ Deployment & Operator Instructions

*You won't touch a single line of config during operation. We build the architecture, monitor uptime, and maintain the workflows. You just take the qualified calls.*

### 1. Bare-Metal Dependencies
```bash
npm install
npx playwright install chromium
```

### 2. Inject Client Accounts
Log into your target Instagram accounts independently into isolated browser profiles:
```bash
npm run login -- --account agency_alpha
npm run login -- --account founder_beta
```

### 3. Ignite The Swarm
```bash
npm run build
npm start
```

### 4. Live Command Center (Operator GUI)
```bash
npm run dashboard
# Dashboard live at http://localhost:3456
```

---

## 📊 Dashboard REST API Endpoints

Complete programmatic control over your deployed fleet:

| Endpoint | Method | Response |
|---|---|---|
| `/api/status` | `GET` | Global aggregate metrics and active worker count. |
| `/api/accounts` | `GET` | Live quotas, daily execution stats, and worker states. |
| `/api/accounts/:id/start` | `POST` | Safely awake an account drone. |
| `/api/accounts/:id/stop` | `POST` | Safely sleep an account drone. |
| `/api/accounts/:id/restart`| `POST` | Graceful worker cycle. |
| `/api/accounts/:id/logs` | `GET` | Filtered, account-specific tail logs. |

---

## ⚖️ Disqualification & Integrity

Strictly for B2B offers priced **$1,000 to $10,000+**. 
**Do NOT clone or apply this setup if you are a pre-revenue beginner.**

Automating Instagram actions violates their Terms of Service. This software is provided as an infrastructural framework for educational proof-of-concept design. It is not licensed for commercial resale without establishing proper operator liability coverage.
