import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";
import { fileURLToPath } from "url";

dotenv.config();
const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Daraja base URL — sandbox by default. Set MPESA_ENV=production (and the matching
// production Consumer Key/Secret/Shortcode/Passkey) once Safaricom has approved the app
// for a production go-live; nothing else in this file needs to change.
const DARAJA_BASE =
  process.env.MPESA_BASE_URL || // escape hatch used only by automated tests
  (process.env.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke");

// ── PREMIUM PLAN PRICING — the single source of truth. ──
// The frontend shows these same numbers for display, but the browser can never actually
// set its own price: whatever amount a client sends for a "premium_<plan>" purchase is
// ignored below, and the server always looks the real price up here instead. This is what
// makes the pricing "verified" rather than merely trusted.
const PLAN_PRICES = { day: 200, week: 500, month: 1000 };
const PLAN_DURATION_DAYS = { day: 1, week: 7, month: 30 };

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function normalizePhone(v) {
  const p = String(v || "").replace(/\s+/g, "").replace(/-/g, "");
  if (/^07\d{8}$/.test(p) || /^01\d{8}$/.test(p)) return "254" + p.slice(1);
  if (/^\+254[71]\d{8}$/.test(p)) return p.slice(1);
  if (/^254[71]\d{8}$/.test(p)) return p;
  return null;
}

// Resolve what a productId is actually paying for, and the amount that must be charged.
// Returns null if the request is not a recognised, payable product — the caller must then
// reject the request. This is the ONE place amount is decided; nothing downstream may
// override it with a client-supplied number.
function resolveProduct(productId, clientAmount) {
  const id = String(productId || "").trim();
  if (id.startsWith("premium_")) {
    const plan = id.slice("premium_".length);
    if (!Object.prototype.hasOwnProperty.call(PLAN_PRICES, plan)) return null;
    return { kind: "subscription", plan, amount: PLAN_PRICES[plan] };
  }
  // Legacy / optional pathway: a one-off file purchase. Not used by the current frontend
  // (downloads are gated behind Premium Membership instead), kept only for backward
  // compatibility with any existing integration that still calls it directly.
  if (!id) return null;
  const amt = Math.round(Number(clientAmount));
  if (!Number.isFinite(amt) || amt < 1) return null;
  return { kind: "file", plan: null, amount: amt };
}

async function getAccessToken() {
  const key = required("MPESA_CONSUMER_KEY");
  const secret = required("MPESA_CONSUMER_SECRET");
  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  const r = await fetch(`${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(d.errorMessage || "Daraja OAuth failed");
  return d.access_token;
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "princesammis-daraja-backend" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/mpesa/stk-push", async (req, res) => {
  try {
    const productId = String(req.body.productId || "").trim();
    const phone = normalizePhone(req.body.phone);

    if (!productId) return res.status(400).json({ error: "productId is required" });
    if (!phone) return res.status(400).json({ error: "Invalid Kenyan phone number" });

    const product = resolveProduct(productId, req.body.amount);
    if (!product) return res.status(400).json({ error: "Unknown product or invalid amount" });
    const { kind, plan, amount } = product;

    const shortcode = required("MPESA_SHORTCODE");
    const passkey = required("MPESA_PASSKEY");
    const callback = required("MPESA_CALLBACK_URL");
    const transactionType = process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline";
    const ts = timestamp();
    const password = Buffer.from(`${shortcode}${passkey}${ts}`).toString("base64");
    const token = await getAccessToken();

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: transactionType,
      Amount: amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: callback,
      AccountReference: `PNF-${productId.slice(0, 20)}`,
      TransactionDesc: kind === "subscription" ? `Premium membership (${plan})` : "Digital product purchase",
    };

    const r = await fetch(`${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok || !d.CheckoutRequestID) {
      return res.status(502).json({ error: d.errorMessage || d.ResponseDescription || "Daraja STK Push failed", details: d });
    }

    await pool.query(
      `INSERT INTO mpesa_transactions
        (product_id,phone,amount,merchant_request_id,checkout_request_id,status,kind,plan)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)`,
      [productId, phone, amount, d.MerchantRequestID, d.CheckoutRequestID, kind, plan]
    );

    res.json({
      ok: true,
      checkoutRequestId: d.CheckoutRequestID,
      merchantRequestId: d.MerchantRequestID,
      responseDescription: d.ResponseDescription,
      amount,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/mpesa/status/:checkoutRequestId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status,result_code,result_desc,mpesa_receipt,kind,plan,expires_at
         FROM mpesa_transactions WHERE checkout_request_id=$1`,
      [req.params.checkoutRequestId]
    );
    if (!rows.length) return res.status(404).json({ status: "unknown" });
    const x = rows[0];
    res.json({
      status: x.status,
      resultCode: x.result_code,
      message: x.result_desc,
      receipt: x.mpesa_receipt,
      kind: x.kind,
      plan: x.plan,
      expiresAt: x.expires_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Backend-verified premium check. This is the only source of truth the frontend is allowed
// to treat as authoritative for "does this phone currently have an active Premium
// membership" — it reads straight from the transactions the Daraja callback itself wrote,
// never from anything the browser claims about itself.
app.get("/api/mpesa/premium-status", async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) return res.status(400).json({ error: "Invalid Kenyan phone number" });

    const { rows } = await pool.query(
      `SELECT plan, expires_at
         FROM mpesa_transactions
        WHERE phone=$1 AND kind='subscription' AND status='success' AND expires_at IS NOT NULL
        ORDER BY expires_at DESC
        LIMIT 1`,
      [phone]
    );

    if (!rows.length) return res.json({ active: false, plan: null, expiresAt: null });

    const row = rows[0];
    const active = new Date(row.expires_at).getTime() > Date.now();
    res.json({ active, plan: active ? row.plan : null, expiresAt: active ? row.expires_at : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    const checkout = cb.CheckoutRequestID;
    const code = Number(cb.ResultCode);
    let receipt = null,
      transactionDate = null;
    const items = cb.CallbackMetadata?.Item || [];
    for (const item of items) {
      if (item.Name === "MpesaReceiptNumber") receipt = String(item.Value);
      if (item.Name === "TransactionDate") transactionDate = String(item.Value);
    }
    const status = code === 0 ? "success" : "failed";

    // Single atomic UPDATE: expires_at is computed here, server-side, from the plan that was
    // already recorded at STK-push time — never from anything in this callback payload —
    // and only for a successful subscription payment. Every other row is left untouched.
    await pool.query(
      `UPDATE mpesa_transactions
          SET status=$1, result_code=$2, result_desc=$3, mpesa_receipt=$4,
              transaction_date=$5, raw_callback=$6, updated_at=NOW(),
              expires_at = CASE
                WHEN $1='success' AND kind='subscription' THEN
                  NOW() + CASE plan
                    WHEN 'day'   THEN INTERVAL '1 day'
                    WHEN 'week'  THEN INTERVAL '7 days'
                    WHEN 'month' THEN INTERVAL '30 days'
                    ELSE INTERVAL '0'
                  END
                ELSE expires_at
              END
        WHERE checkout_request_id=$7`,
      [status, code, cb.ResultDesc || null, receipt, transactionDate, req.body, checkout]
    );
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ResultCode: 1, ResultDesc: "Callback processing failed" });
  }
});

// Vercel imports this Express app as a serverless function (see api/index.js and
// api/[...path].js). When run directly with `node server.js` (local dev/testing) it also
// starts a real listener, so `npm start` / `npm run dev` work as expected.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Daraja backend listening on :${port}`));
}

export default app;
