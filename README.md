# 🤖 Instagram AI AutoPilot

A smart, stealth, background Instagram automation engine that auto-likes, auto-comments, and auto-replies to DMs using AI-generated responses — with built-in anti-ban safety limits so your account stays safe.

---

## What Does It Do?

| Feature | How |
| --- | --- |
| **Auto-Like Posts** | Randomly scrolls hashtag feeds and likes posts with human-like delays |
| **Auto-Comment** | Uses AI (OpenClaw / OpenAI / Gemini / any provider) to generate genuine, context-aware comments based on the post's caption — never generic "nice pic!" spam |
| **Auto-Reply to DMs** | Reads incoming DMs and drafts natural replies using AI |
| **Anti-Ban Engine** | Randomized delays, daily/hourly quotas, sleep-cycle simulation, browser stealth (no `webdriver` flag, spoofed fingerprint) |
| **Runs in Background** | Headless Chromium — your screen is free, bot runs silently |
| **Live Dashboard** | See likes, comments, DMs, and AI logs in a local web UI |

---

## 📁 Project Structure

```
instagram-automation/
├── 1-Install.bat           ← Step 1: double-click to install
├── 2-Login.bat             ← Step 2: log into Instagram once
├── 3-Start-Bot.bat         ← Step 3: run the bot in background
├── 4-Dashboard.bat         ← Step 4: open the live dashboard
├── .env.example            ← Config template (copy to .env)
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            ← Main bot daemon (the brain)
│   ├── login-helper.ts     ← One-time login flow
│   ├── config.ts           ← All settings + safety profiles
│   ├── ai/
│   │   └── brain.ts        ← AI comment/DM generator (multi-provider)
│   ├── engine/
│   │   ├── browser.ts      ← Stealth Chromium launcher
│   │   └── humanizer.ts    ← Random delays, human typing, scrolling
│   ├── dashboard/
│   │   ├── standalone.ts   ← Express server for dashboard
│   │   └── public/
│   │       └── index.html  ← Dashboard frontend
│   └── utils/
│       ├── logger.ts       ← Console + file logging
│       └── storage.ts      ← Stats persistence + daily reset
└── data/                   ← Created at runtime (browser profile, logs, stats)
```

---

## ⚡ Quick Start (4 Steps)

### Prerequisites

- **Windows 10 or 11** (Mac/Linux users: use `npm run` commands instead of `.bat` files)
- **Node.js 18+** — Download from [nodejs.org](https://nodejs.org)
- **An AI API Key** (any ONE of these):
  - [OpenClaw](https://openclaw.com) — recommended
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Google Gemini](https://aistudio.google.com/apikey)
  - [OpenRouter](https://openrouter.ai/keys)
  - Or set `AI_PROVIDER=none` to use built-in template comments (no AI needed)

---

### Step 1 — Install

```
Double-click:  1-Install.bat
```

Or manually:
```bash
npm install
npx playwright install chromium
```

This installs all packages and downloads a clean Chromium browser (separate from your main Chrome — your personal browser is never touched).

---

### Step 2 — Configure

1. Copy `.env.example` to `.env`:
   ```bash
   copy .env.example .env
   ```

2. Open `.env` in any text editor (Notepad, VS Code, etc.) and fill in:

   ```dotenv
   # Your AI provider (openclaw, openai, gemini, openrouter, ollama, or none)
   AI_PROVIDER=openclaw

   # Your API key from whoichever provider you chose
   AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxx

   # What model to use
   AI_MODEL_NAME=gpt-4o-mini

   # Hashtags to engage with (comma separated, no # symbol)
   TARGET_HASHTAGS=tech,coding,software,developer,startups
   
   # Safety profile: "safe" (very slow), "balanced" (recommended), "active" (faster)
   SAFETY_PROFILE=balanced
   ```

   **That's it.** Everything else has good defaults.

---

### Step 3 — Login (One Time Only)

```
Double-click:  2-Login.bat
```

A visible Chrome window opens → go to instagram.com → log in normally (username, password, 2FA if asked) → once you see your feed, close the window. **Your session is saved locally** in `data/browser_profile/` and reused silently by the bot.

> **You only need to do this once.** The bot reuses the saved session. If Instagram logs you out (rare), just run this step again.

---

### Step 4 — Start the Bot

```
Double-click:  3-Start-Bot.bat
```

The bot now runs **headlessly in the background**. You'll see colored log output:

```
[10:23:15] INFO: Initializing Instagram AutoPilot AI Daemon...
[10:23:15] INFO: Configured AI: openclaw | Model: gpt-4o-mini
[10:23:18] SUCCESS: Session verified! Automatically surfing and engaging...
[10:23:42] [Explore]: Surfing hashtag #coding
[10:23:49] [AI Reading]: Post by @devguy: "Finally deployed my first..."
[10:23:50] SUCCESS: Liked post by @devguy
[10:23:52] INFO: AI drafted comment: "congrats on shipping! deploy day hits different 🚀"
[10:23:55] SUCCESS: Commented on @devguy's post!
[10:24:38] [Explore]: Surfing hashtag #startups
```

Press `CTRL+C` to stop the bot anytime.

---

### Step 5 (Optional) — Live Dashboard

```
Double-click:  4-Dashboard.bat
```

Opens `http://localhost:3456` in your browser with a dark live dashboard showing:
- Likes / Comments / DMs count vs daily limits
- Active AI model and safety profile
- Target hashtags
- Real-time scrolling terminal logs

---

## 🛡️ Anti-Ban Safety System

Instagram bans bots that act like bots. This tool doesn't:

| Protection | How |
| --- | --- |
| **Daily Quotas** | Hard caps on likes/comments/DMs per day (configurable) |
| **Hourly Throttle** | Spread actions across the day, never burst |
| **Random Human Delays** | Every action waits 30–120 seconds (randomized gaussian), not fixed intervals |
| **Human Typing** | Comments are typed character-by-character with random speed, not pasted instantly |
| **Sleep Cycle** | Bot goes dormant 11PM–8AM (configurable) like a real person |
| **Stealth Browser** | No `navigator.webdriver` flag, spoofed Chrome fingerprint, no automation traces |
| **Persistent Session** | Uses saved cookies, never re-logs in repeatedly (which triggers suspicion) |
| **AI Comments** | Each comment is unique and contextual — not from a repeated template list |
| **Duplicate Guard** | Tracks interacted posts, never comments on the same post twice |

### Safety Profiles

| Profile | Daily Likes | Daily Comments | Daily DMs | Delay Between Actions |
| --- | --- | --- | --- | --- |
| `safe` | 30 | 10 | 15 | 45–120 sec |
| `balanced` | 70 | 25 | 30 | 30–90 sec |
| `active` | 150 | 50 | 60 | 15–45 sec |

> **Recommendation:** Start with `safe` for the first week. After that, move to `balanced`. Only use `active` on accounts older than 6 months with an established posting history.

---

## 🧠 AI Configuration

The bot supports **any OpenAI-compatible API**. Just set the provider in `.env`:

| Provider | `AI_PROVIDER` | `AI_API_KEY` | `AI_MODEL_NAME` |
| --- | --- | --- | --- |
| OpenClaw | `openclaw` | Your OpenClaw key | Any model they serve |
| OpenAI | `openai` | `sk-...` | `gpt-4o-mini`, `gpt-4o` |
| Google Gemini | `gemini` | Your Gemini key | `gemini-2.0-flash` |
| OpenRouter | `openrouter` | `sk-or-...` | Any model slug |
| Local Ollama | `ollama` | (leave blank) | `llama3.1`, etc. |
| No AI | `none` | (leave blank) | (ignored) |

### Tone Customization

Edit `AI_TONE_INSTRUCTION` in `.env` to change how the AI sounds:

```dotenv
# Casual tech bro:
AI_TONE_INSTRUCTION="Sound like a chill software engineer who genuinely finds the post interesting. Max 8 words."

# Supportive creator:
AI_TONE_INSTRUCTION="Be warm and encouraging, like a fellow creator who's been there."

# Minimal:
AI_TONE_INSTRUCTION="Super short reactions. 3-5 words max. No emojis."
```

---

## 🧩 Module Toggles

Enable or disable specific features in `.env`:

```dotenv
ENABLE_AUTO_LIKE_FEED=true        # Like posts from your main feed
ENABLE_AUTO_COMMENT_FEED=true     # Comment on feed posts
ENABLE_AUTO_LIKE_HASHTAGS=true    # Like posts from hashtag explore
ENABLE_AUTO_COMMENT_HASHTAGS=true # Comment on hashtag posts
ENABLE_DM_AUTO_REPLY=true         # Auto-reply to incoming DMs

### Supercharge with Niche Relevance (For Agencies / B2B)
Want the bot to only interact with potential leads or peers? Use the Relevance Engine!

```dotenv
# Define your business:
ACCOUNT_CONTEXT="We are a web design agency looking for small business owners and startups."

# Turn the filter on:
STRICT_RELEVANCE_CHECK=true
```
When this is enabled, the AI reads every post against your `ACCOUNT_CONTEXT`. If it decides the post is irrelevant (e.g., someone's personal vacation photo rather than a business post), it entirely skips liking and commenting!
```

---

## ⚠️ Important Notes

1. **This is for educational/personal use.** Automating Instagram actions violates their ToS. Use responsibly.
2. **Start slow.** New accounts get flagged faster. Use `safe` profile and 3-5 hashtags max.
3. **Don't run 24/7.** The sleep cycle helps, but taking 1-2 days off per week is smarter.
4. **The bot uses its own browser profile.** Your personal Chrome, cookies, and passwords are never touched.
5. **API keys stay local.** Your `.env` file is gitignored and never leaves your machine.

---

## Manual Commands (for Mac/Linux or advanced users)

```bash
# Install
npm install && npx playwright install chromium

# Configure
cp .env.example .env   # then edit .env

# Login (opens visible browser)
npm run login

# Build TypeScript
npm run build

# Start bot (headless background)
npm start

# Start dashboard
npm run dashboard
```

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `NOT logged in` error | Run `2-Login.bat` again and log in manually |
| `AI request failed` | Check your `AI_API_KEY` in `.env` — make sure it's valid and has credits |
| Bot stops after a while | Instagram may have rate-limited you. Wait 24h, then restart with `safe` profile |
| `playwright install` fails | Run as Administrator, or manually: `npx playwright install chromium` |
| Dashboard shows 0 stats | Make sure the bot (`3-Start-Bot.bat`) is running alongside the dashboard |
| Port 3456 in use | Change `DASHBOARD_PORT=3457` in `.env` |

---

## License

MIT — do whatever you want with it.
