// Evergreen & Ember shop backend: orders, Stripe payments, admin. Secrets come from env vars only.
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const { SITE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_PASSWORD, SESSION_SECRET } = process.env;
const PROD = process.env.NODE_ENV === "production";
if (!ADMIN_PASSWORD || !SESSION_SECRET) { console.error("Set ADMIN_PASSWORD and SESSION_SECRET."); process.exit(1); }
const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;
const SITE = (SITE_URL || "http://localhost:3000").replace(/\/$/, "");

// Prices are decided here, never by the browser. Keep in sync with the storefront list. Amounts in cents.
const PRODUCTS = {
  1: { name: "Electric wine opener & aerator", price: 2900 },
  2: { name: "Christmas advent calendar", price: 2400 },
  3: { name: "Lighted nativity wall decor", price: 3900 },
  4: { name: "Enamel 3-piece cookware set", price: 7900 },
  5: { name: "Cosy pet bed & stocking", price: 2700 },
  6: { name: "Flameless candle glow set", price: 2200 },
};
const COUNTRIES = { "United States": "US", Canada: "CA", "United Kingdom": "GB", "Saudi Arabia": "SA" };
const STATUSES = ["pending_payment", "paid", "cod_pending", "processing", "shipped", "delivered", "cancelled"];
const FREE_SHIPPING_FROM = 5000, SHIPPING = 500;

// ---------- database (Postgres, e.g. free Neon) ----------
if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL."); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }, max: 5 });
pool.on("error", (e) => console.error("DB pool error:", e.message));
const q = (sql, p) => pool.query(sql, p);
const init = () => q(`CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, token TEXT NOT NULL, status TEXT NOT NULL, method TEXT NOT NULL,
  items TEXT NOT NULL, subtotal INTEGER NOT NULL, shipping INTEGER NOT NULL, total INTEGER NOT NULL,
  customer TEXT NOT NULL, stripe_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);

// ---------- helpers ----------
const str = (v, n = 120) => String(v ?? "").trim().slice(0, n);
const same = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const sign = (v) => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("hex");
const newToken = () => { const exp = String(Date.now() + 12 * 3600e3); return `${exp}.${sign(exp)}`; };
const validToken = (t) => { const [e, s] = String(t || "").split("."); return !!(e && s && Number(e) > Date.now() && same(s, sign(e))); };
const cookie = (req, name) => (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1];
function cleanCustomer(c = {}) {
  const o = { email: str(c.email), first: str(c.first, 60), last: str(c.last, 60), phone: str(c.phone, 30), addr: str(c.addr, 160), city: str(c.city, 80), zip: str(c.zip, 20), country: str(c.country, 40), notes: str(c.notes, 300) };
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email) && o.first && o.last && o.phone && o.addr && o.city && o.zip && COUNTRIES[o.country];
  return ok ? o : null;
}
const publicOrder = (o) => ({ id: o.id, status: o.status, method: o.method, items: JSON.parse(o.items), subtotal: o.subtotal, shipping: o.shipping, total: o.total, customer: { first: JSON.parse(o.customer).first, email: JSON.parse(o.customer).email } });

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["https://fonts.gstatic.com"], imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"] } } }));

// Stripe webhook: raw body required for signature check. This is what marks an order as paid.
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).send("Bad signature"); }
  try {
    const s = ev.data.object, id = s.metadata?.order_id;
    const set = (st) => q("UPDATE orders SET status=$1, updated_at=$2 WHERE id=$3 AND status='pending_payment'", [st, new Date().toISOString(), id]);
    if (id && ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(ev.type) && s.payment_status === "paid") {
      const { rows: [o] } = await q("SELECT total FROM orders WHERE id=$1", [id]);
      if (o && o.total === s.amount_total) await set("paid"); else console.error("Amount mismatch for", id);
    } else if (id && ["checkout.session.expired", "checkout.session.async_payment_failed"].includes(ev.type)) {
      await set("cancelled");
    }
    res.json({ received: true });
  } catch (e) { console.error(e.message); res.status(500).end(); } // Stripe will retry
});

app.use(express.json({ limit: "20kb" }));
app.get("/healthz", (_, res) => res.send("ok"));

// Create order, then pay by card (Stripe) or cash on delivery.
const checkoutLimit = rateLimit({ windowMs: 15 * 60e3, limit: 30 });
app.post("/api/checkout", checkoutLimit, async (req, res) => {
  try {
    const customer = cleanCustomer(req.body.customer);
    if (!customer) return res.status(400).json({ error: "Please complete all delivery details." });
    const method = req.body.customer?.pay === "cod" ? "cod" : "card";
    if (method === "card" && !stripe) return res.status(503).json({ error: "Card payments are not available yet." });
    const items = (Array.isArray(req.body.items) ? req.body.items : [])
      .filter((i) => PRODUCTS[i.id] && Number.isInteger(i.q) && i.q > 0 && i.q <= 20)
      .map((i) => ({ id: +i.id, name: PRODUCTS[i.id].name, price: PRODUCTS[i.id].price, q: i.q }));
    if (!items.length) return res.status(400).json({ error: "Your cart is empty." });
    const subtotal = items.reduce((t, i) => t + i.price * i.q, 0);
    const shipping = subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING;
    const id = "EE-" + crypto.randomBytes(4).toString("hex").toUpperCase(), token = crypto.randomBytes(16).toString("hex"), now = new Date().toISOString();
    const status = method === "cod" ? "cod_pending" : "pending_payment";
    await q("INSERT INTO orders (id,token,status,method,items,subtotal,shipping,total,customer,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [id, token, status, method, JSON.stringify(items), subtotal, shipping, subtotal + shipping, JSON.stringify(customer), now, now]);
    const confirm = `${SITE}/?order=${id}&t=${token}`;
    if (method === "cod") return res.json({ url: confirm });
    const session = await stripe.checkout.sessions.create({
      mode: "payment", customer_email: customer.email, client_reference_id: id, metadata: { order_id: id },
      line_items: items.map((i) => ({ quantity: i.q, price_data: { currency: "usd", product_data: { name: i.name }, unit_amount: i.price } })),
      shipping_options: [{ shipping_rate_data: { display_name: shipping ? "Standard shipping" : "Free shipping", type: "fixed_amount", fixed_amount: { amount: shipping, currency: "usd" } } }],
      payment_intent_data: { metadata: { order_id: id }, shipping: { name: `${customer.first} ${customer.last}`, phone: customer.phone, address: { line1: customer.addr, city: customer.city, postal_code: customer.zip, country: COUNTRIES[customer.country] } } },
      success_url: confirm, cancel_url: `${SITE}/?cancelled=1`,
    });
    await q("UPDATE orders SET stripe_session=$1 WHERE id=$2", [session.id, id]);
    res.json({ url: session.url });
  } catch (e) { console.error(e.message); res.status(500).json({ error: "Could not start checkout." }); }
});

// Order confirmation (needs the private token from the confirmation link).
app.get("/api/order/:id", async (req, res) => {
  const { rows: [o] } = await q("SELECT * FROM orders WHERE id=$1", [req.params.id]).catch(() => ({ rows: [] }));
  if (!o || !same(o.token, req.query.t || "")) return res.status(404).json({ error: "Not found" });
  res.json(publicOrder(o));
});

// ---------- admin ----------
const loginLimit = rateLimit({ windowMs: 15 * 60e3, limit: 10 });
const admin = (req, res, next) => (validToken(cookie(req, "admin")) ? next() : res.status(401).json({ error: "Login required" }));
app.post("/api/admin/login", loginLimit, (req, res) => {
  if (!same(req.body.password || "", ADMIN_PASSWORD)) return res.status(401).json({ error: "Wrong password" });
  res.setHeader("Set-Cookie", `admin=${newToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${PROD ? "; Secure" : ""}`);
  res.json({ ok: true });
});
app.post("/api/admin/logout", (_, res) => { res.setHeader("Set-Cookie", "admin=; HttpOnly; Path=/; Max-Age=0"); res.json({ ok: true }); });
app.get("/api/admin/orders", admin, async (_, res) => {
  const { rows } = await q("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500");
  res.json(rows.map((o) => ({ ...o, token: undefined, items: JSON.parse(o.items), customer: JSON.parse(o.customer) })));
});
app.patch("/api/admin/orders/:id", admin, async (req, res) => {
  if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: "Invalid status" });
  const r = await q("UPDATE orders SET status=$1, updated_at=$2 WHERE id=$3", [req.body.status, new Date().toISOString(), req.params.id]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
});

app.get("/admin", (_, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.use(express.static(path.join(__dirname, "public")));
const port = process.env.PORT || 3000;
init().then(() => app.listen(port, () => console.log(`Shop running on port ${port}`))).catch((e) => { console.error("DB init failed:", e.message); process.exit(1); });
