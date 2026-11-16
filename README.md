# Evergreen & Ember: shop with secure checkout

Storefront (`public/index.html`) + backend (`server.js`) + order admin (`/admin`).
Secret keys live only in server environment variables. The browser never sees them.

## How it works
1. Customer fills delivery details and picks **Card** or **Cash on delivery**.
2. Server re-prices the cart from its own product list, saves the order, then
   - card: creates a Stripe Checkout session and redirects to Stripe's secure page;
   - COD: sends the customer straight to the confirmation page.
3. Stripe calls `/api/webhook` (signature checked). Only then is the order marked **paid**.
4. Customer lands on the order confirmation page (private link with a token).
5. You manage orders at `/admin` (password login, status changes: paid → processing → shipped → delivered).

## Run locally
Needs Node 20+ and a Postgres URL (a free Neon database works).
```
npm install
cp .env.example .env      # fill in values; use Stripe TEST keys
npm run dev               # http://localhost:3000   admin: /admin
```
## Free deployment: Render (server) + Neon (database)
1. Neon: create a free project, copy its connection string into `DATABASE_URL`.
2. GitHub: upload this folder (never `.env`). Render: New > Web Service > pick repo > Instance type **Free**, build `npm install`, start `node server.js` (or use the Blueprint in `render.yaml`).
3. Set env vars: `NODE_ENV=production`, `DATABASE_URL`, `SITE_URL` (your onrender.com or custom domain, no trailing slash), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_PASSWORD`, `SESSION_SECRET`.
4. Add a free UptimeRobot monitor on `https://YOUR-SITE/healthz` every 5 minutes so Render rarely sleeps.

## Connect Stripe
1. Stripe Dashboard → Developers → API keys → copy the **Secret key** into `STRIPE_SECRET_KEY` (host settings only).
2. Developers → Webhooks → Add endpoint `https://YOUR-DOMAIN/api/webhook`, events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
3. Copy the endpoint's **Signing secret** into `STRIPE_WEBHOOK_SECRET`.
4. Settings → Customer emails → turn on successful-payment receipts.
5. Test with test keys, place an order, confirm it shows **paid** in `/admin`. Then swap in live keys and a live-mode webhook.

## Before going live
- Edit products in BOTH `server.js` (`PRODUCTS`, prices in cents) and the `P` list in `public/index.html`. The server's prices always win.
- Check Stripe supports the country your business is registered in. If it does not, use a business entity in a supported country, or swap the card step for a local gateway. Only the `/api/checkout` and `/api/webhook` code in `server.js` would change.
- Add your terms, returns and privacy pages, and charge tax/duties if your market requires it.
- Back up `shop.db` regularly (download from the disk or use your host's snapshots).
