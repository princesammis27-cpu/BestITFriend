import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";
import { fileURLToPath } from "url";

// 1. IMPORT THE SEPARATE SUPABASE CLIENT INTRODUCED PREVIOUSLY
import { supabase } from "./utils/supabaseClient.js";

dotenv.config();
const { Pool } = pg;
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// SERVERLESS DATABASE POOL CONFIGURATION
let pool;
if (!pool) {
  pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    max: 1, // Single connection per warm serverless invocation to protect Supabase limits
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
}

// Daraja base URL — sandbox by default. Set MPESA_ENV=production in production [1]
const DARAJA_BASE =
  process.env.MPESA_BASE_URL || 
  (process.env.MPESA_ENV === "production"
    ? "https://safaricom.co.ke"
    : "https://safaricom.co.ke");

// PREMIUM PLAN PRICING — The immutable server source of truth [1]
const PLAN_PRICES = { day: 200, week: 500, month: 1000 };

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
  if (/^07\d{8}\(/.test(p) \vert{}\vert{} /^01\d{8}\)/.test(p)) return "254" + p.slice(1);
  if (/^\+254\d{8}\$/.test(p)) return p.slice(1);
  if (/^254\d{8}\$/.test(p)) return p;
  return null;
}

function resolveProduct(productId, clientAmount) {
  const id = String(productId || "").trim();
  if (id.startsWith("premium_")) {
    const plan = id.slice("premium_".length);
    if (!Object.prototype.hasOwnProperty.call(PLAN_PRICES, plan)) return null;
    return { kind: "subscription", plan, amount: PLAN_PRICES[plan] };
  }
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

// System Health Endpoint [1]
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "princesammis-daraja-backend" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// TEST ENDPOINT: Demonstrates how your imported 'supabase' instance securely runs
app.get("/api/supabase-test", async (req, res) => {
  try {
    const { data, error } = await supabase.from("mpesa_transactions").select("*").limit(5);
    if (error) throw error;
    res.json({ success: true, message: "Connected to Supabase successfully!", data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Initiate M-Pesa STK Push Payment Request [1]
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
        (product_id, phone, amount, merchant_request_id, checkout_request_id, status, kind, plan)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
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

// Check payment transaction status using polling [1]
app.get("/api/mpesa/status/:checkoutRequestId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status, result_code, result_desc, mpesa_receipt, kind, plan, expires_at
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

// Check if a client phone number currently has active Premium Access [1]
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

// Secure automated Callback URL Webhook receiving data from Safaricom Daraja [1]
app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    const checkout = cb.CheckoutRequestID;
    const code = Number(cb.ResultCode);
    let receipt = null, transactionDate = null;
    
    const items = cb.CallbackMetadata?.Item || [];
    for (const item of items) {
      if (item.Name === "MpesaReceiptNumber") receipt = String(item.Value);
      if (item.Name === "TransactionDate") transactionDate = String(item.Value);
    }
    const status = code === 0 ? "success" : "failed";

    // Convert object payload to pure JSON string for target driver parsing stability
    const rawCallbackString = JSON.stringify(req.body);

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
      [status, code, cb.ResultDesc || null, receipt, transactionDate, rawCallbackString, checkout]
    );
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ResultCode: 1, ResultDesc: "Callback processing failed" });
  }
});

// Environment evaluation safety loop for platform runners [1]
try {
  if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Daraja backend listening on :${port}`));
  }
} catch (err) {
  // Gracefully handle serverless environments omitting file URLs
}

export default app;
