# OutreachAI

## Project Overview
OutreachAI is a Chrome browser extension for recruiters and talent sourcers. It automates candidate research and outreach by capturing candidate names from LinkedIn profiles and using a backend pipeline to enrich that data (emails, titles, companies) and generate personalized outreach drafts using Anthropic's Claude LLMs.

## Architecture

### Chrome Extension (Frontend)
- **Location**: `extension/`
- **Manifest V3** Chrome extension
- **No bundler** — vanilla JavaScript, loaded directly by Chrome
- Key files:
  - `extension/manifest.json` — Extension configuration and permissions
  - `extension/background.js` — Service worker for background tasks
  - `extension/content.js` — DOM scraping logic for LinkedIn
  - `extension/config.js` — API endpoints and configuration constants
  - `extension/core/` — Shared logic (API wrappers, auth, credits)
  - `extension/modes/` — UI/logic for different user types
  - `extension/ui/popup.html` — Extension popup UI

### Backend (Supabase Edge Functions)
- **Location**: `supabase/functions/`
- **Runtime**: Deno (via Supabase Edge Functions)
- **Database**: Supabase PostgreSQL
- **Auth**: Supabase GoTrue
- Key functions:
  - `enrichment-pipeline/` — Main AI/enrichment logic
  - `lookup-email/` — Dedicated email discovery
- **APIs used**: Anthropic (Claude AI), FullEnrich (email lookup), Stripe (payments)

### Auth Callback Page
- **Location**: `docs/index.html`
- A simple static page used as the OAuth callback for the Chrome extension's Supabase auth flow

## Replit Setup
- **Workflow**: "Start application" runs `node server.js` on port 5000
- `server.js` — Simple Node.js HTTP static file server serving project files
- The server serves the `docs/index.html` auth page and all extension assets

## External Services
- **Supabase**: `https://szxjcitbjcpkhxtjztay.supabase.co`
- **FullEnrich**: Email enrichment API
- **Anthropic**: Claude 3.5 Sonnet / 4.5 Haiku for AI draft generation
- **Stripe**: Payments (Sourcer and Pro tiers)

## Loading the Extension in Chrome
1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension/` directory
