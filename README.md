# Subscription Audit Assistant (Standalone)

Offline-first web app you can share with a link/QR code.

## Run locally

From this folder, start a local web server:

- Python: `python -m http.server 8000`
- Node: `npx serve .`

Then open `http://localhost:8000`.

## Share with people (free)

Host this folder on a free static host (GitHub Pages / Cloudflare Pages / Vercel).
Send the hosted URL via QR code. Users can “Install” it as an app (PWA).

## Notes

- No accounts, no backend. Data is stored locally in the user’s browser.
- “Unused” is reported as **No charge in last 90 days** (based on billing activity).

