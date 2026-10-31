# SafeCart Kids — Fundraising Agent ($0)

An agent that finds **investors** and **fundraising experts** for SafeCart Kids and emails them for you. It:

1. **Understands the app.** It reads safecartkids.com plus the facts you enter in *Your App*.
2. **Searches** the web and **public LinkedIn profiles** with short, simple searches, only in the USA (your business's country).
3. **Picks real people.** AI reads every result and keeps only named investors or real fundraising experts. Law firms, accountants, agencies and anyone outside the USA are skipped.
4. **Researches** the best ones: their website, contact page, portfolio or past clients, public email and phone, and **how they charge**. Anyone who wants money from you upfront is filtered out.
5. **Scores** each person 0-100 with reasons, concerns and the best opening hook.
6. **Writes the emails from your own text**, word for word, adding only the greeting, one sentence about the person and your booking link.
7. **Sends them automatically** from your Gmail (email 1, then day 4 / 10 / 21), stops when someone replies, and tags every thread **Investor** or **Fundraising Expert** in Gmail.
8. **Exports** everything to a Google Sheet with 3 tabs (Investors, Fundraising Experts, All).

Nothing is installed on your computer and nothing needs a credit card.

---

## 1. Free keys

| What | Where | Needed? |
|---|---|---|
| **Gemini API key** (AI) | https://aistudio.google.com/apikey | **Yes** (or Groq) |
| **Groq API key** (backup AI) | https://console.groq.com/keys | Recommended |
| **Serper API key** (Google results, 2,500 free, one-time) | https://serper.dev | **Yes** (or Tavily) |
| **Tavily API key** (1,000 free searches every month) | https://app.tavily.com | Recommended |

## 2. Deploy

### Railway
1. https://railway.com → **New Project → Deploy from GitHub repo** → pick this repo.
2. **Variables**: `APP_PASSWORD`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY`, `DATA_DIR=/data`, plus `GMAIL_SCRIPT_URL` and `GMAIL_SCRIPT_SECRET` (step 3).
3. **Add Volume** with mount path **`/data`** (keeps your lists safe).
4. **Settings → Networking → Generate Domain.** Build and start commands come from `railway.json`.

### Render (free) instead of Railway
Render's free plan wipes the server's disk on every restart, so the agent keeps your data in **your Google Drive** (folder *SafeCart Agent Data*) through the Gmail script.
- **New → Web Service** → connect GitHub → this repo → Language **Node**, Branch **main**.
- Build: `npm install && npm run build` · Start: `npm start` · Instance: **Free** · Health Check Path: `/api/health`.
- Environment: same keys as Railway **without `DATA_DIR`** (`DRIVE_BACKUP=1` is optional: the backup turns on by itself on Render).
- Free Render apps sleep after 15 minutes without visits. On **cron-job.org**, open `https://<your-app>.onrender.com/api/health` every 10 minutes so auto-email keeps running.
- Render's free plan includes 5 GB of outgoing data a month. The agent stays far below it: pages and data are compressed, open pages only download what changed, and the Drive backup is compressed and only sent when something changed (at most every 10 minutes).
- Never run Railway and Render at the same time: both would send the same emails.

## 3. Gmail script (sending, reply detection, labels, Google Sheets, Drive backup)

1. Sign in to the Gmail you send from → **https://script.google.com** → **New project** → paste all of `google-apps-script/Code.gs`.
2. On the `const SECRET = '…'` line, put your own password (letters and numbers). **Only there and in Railway/Render — never in the copy on GitHub.** Save.
3. Choose **doGet** → **▶ Run** → **Review permissions** → **Advanced → Go to … (unsafe)** → **Allow**.
4. **First time:** **Deploy → New deployment → ⚙ Web app** → Execute as **Me**, Who has access **Anyone** → **Deploy** → copy the Web app URL.
   **Every later change:** **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy** (same URL). Saving the code alone does NOT change the live script.
5. Put `GMAIL_SCRIPT_URL` (that URL) and `GMAIL_SCRIPT_SECRET` (the same password) in Railway/Render.
6. Check it: in the app, **Settings → Test Gmail helper connection** should say *Connected — password correct, script up to date (v5)*. Opening the URL in a browser shows the live script's `version` and `passwordLength`.

## 4. Settings to fill in once

- **Automatic email:** tick it, minimum score 50, 20-25 emails a day, your **company postal address** (required by US law in cold emails).
- **Calendar booking link:** in Google Calendar (as safecartkidsai@gmail.com) **Create → Appointment schedule** → 15 minutes → Save → open it → **Share** → copy the `https://calendar.app.google/…` link → paste it in Settings. Don't use `calendar.google.com/calendar/u/0/r`: that is your own calendar view, and nobody can book with it.
- **LinkedIn:** keep email notifications on for "invitation accepted" so the agent can see who accepted.

## 5. Using it

- **Looking for** dropdown (top): **Investors** or **Fundraising experts**. Each has its own list, and the number in brackets counts the people shown. "· N hidden" counts the ones filtered out (asks for money upfront, outside the USA, or not a real fundraising expert). They are not deleted, and **Show them** lists them with the reason.
- **Find investors / Find experts:** start with 50. The run quick-scans everyone, then deep-researches the best (Settings → Deep research). It survives restarts, has Pause / Resume, and **Start next run** never repeats a search. If searches keep returning nothing, it switches to simpler searches, and after 24 empty searches it stops and tells you to check your search key.
- **Research the ones I already have:** upgrades quick-scanned people and looks again for emails.
- **Outreach tab:** automatic email status, recent activity (tagged Investor / Fundraising Expert), the daily LinkedIn list, and accepted invitations. Emails written before a template change are rebuilt in the background, so what you see is what gets sent.
- **Open in Google Sheets** (Investors / Experts and Outreach tabs): one spreadsheet with 3 tabs and every detail (66 columns), saved in your Google Drive.

## 6. The emails

Your text, word for word, is in `src/data/emailTemplates.ts`: the investor email ("…the next $10 billion family-focused e-commerce company (the next Amazon)?"), and the fundraising-partnership email (5% success fee, no upfront fees, up to 0.5% equity). For each person the agent only adds the greeting ("Hi Lars,"), ONE sentence about them from their research (left out if nothing specific was found, never invented), and your booking link. To change the wording or the terms, edit that file.

## Free-tier limits

- **Serper:** 2,500 searches in total (one time). A 50-person run uses about 15-30. Check what's left at serper.dev.
- **Groq free:** about 1,000 AI requests a day. If a limit is hit, the run waits and carries on.
- **Gmail:** about 100 emails a day on a normal Gmail. Keep the daily limit at 20-25.
- **LinkedIn (free):** about 100 connection requests a week. The app never logs in to LinkedIn; you click Send yourself.
- **Railway:** the free plan gives $1 of credit a month after the trial. Use Render if it runs out.
- **Render free:** sleeps after 15 idle minutes (the cron-job.org ping prevents it), 750 free hours a month (enough for ONE always-on app per account), 5 GB outgoing data a month, short restarts when Render updates its servers or you push to GitHub.

## Honesty guardrails

- The AI never invents traction, people, emails or portfolio companies.
- An email or phone number is only saved if it is published on that person's own website.
- Every contact keeps its **source links**. Glance at them before sending anything by hand.

## Test on your computer (optional)

Node.js 20+ → `npm install` → copy `.env.example` to `.env` and fill in your keys → `npm run local` → open http://localhost:8080.

## Project layout

```
server/            Node backend, zero runtime dependencies
  index.ts         HTTP server, API routes, Google Sheet export, serves the app
  ai.ts            Gemini / Groq / OpenRouter / HF with automatic fallback and waiting on free limits
  search.ts        Tavily / Serper / DuckDuckGo search
  reader.ts        Website reader (emails, phones, contact pages)
  agent.ts         Find → research → score → write emails
  campaign.ts      Big runs, resumable, never repeats searches
  automation.ts    Auto-email, follow-ups, replies, LinkedIn accepts
  store.ts         Data file (+ Google Drive backup on Render)
  gmail.ts         Talks to the Gmail script
src/data/
  emailTemplates.ts  Your two emails and follow-ups
  audience.ts        Investors vs fundraising experts
  filters.ts         Who is hidden and never emailed
  geo.ts             USA-only rules
  queries.ts         Keeps searches short so they find people
google-apps-script/Code.gs   The Gmail script you paste into script.google.com
```
