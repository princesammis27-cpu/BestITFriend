// netlify/functions/api.js
// One serverless function, mounted at /api/* (see netlify.toml), that backs
// the whole BestITFriend Online Sales frontend: auth, users, files/trash,
// chat, DMs, reviews, visits, uploads, and the existing M-Pesa flow.
//
// Talks to Supabase Postgres (via @supabase/supabase-js using the SERVICE
// ROLE key, which bypasses RLS — this function IS the trusted backend) and
// Supabase Storage for avatars/uploads/chat-media.

const express = require("express");
const serverless = require("serverless-http");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_JWT_SECRET,
  MPESA_ENV,
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_CALLBACK_URL,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_JWT_SECRET) {
  console.warn("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_JWT_SECRET env vars.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const app = express();
app.use(cors());
// Normalise the path however Netlify hands it over (/api/x, /.netlify/functions/api/x, or /x).
app.use((req, res, next) => {
  const fn = "/.netlify/functions/api";
  if (req.url.startsWith(fn)) req.url = req.url.slice(fn.length) || "/";
  if (!req.url.startsWith("/api")) req.url = "/api" + (req.url.startsWith("/") ? "" : "/") + req.url;
  next();
});
app.use(express.json({ limit: "12mb" })); // uploads arrive as base64 JSON, see /api/uploads

// ── helpers ──────────────────────────────────────────────────────────────
function signToken(email) {
  // Signed with the SAME secret Supabase Auth uses for its own JWTs, so a
  // token minted here and a token minted by Supabase Auth (Google sign-in)
  // both verify the same way below.
  return jwt.sign({ email, role: "authenticated" }, SUPABASE_JWT_SECRET, { expiresIn: "30d" });
}
function publicUser(row) {
  if (!row) return null;
  const { password_hash, ...safe } = row;
  return safe;
}
async function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, SUPABASE_JWT_SECRET);
    const email = payload.email;
    if (!email) return res.status(401).json({ error: "Invalid token" });
    const { data } = await supabase.from("users").select("*").eq("email", email).single();
    if (!data) return res.status(401).json({ error: "User not found" });
    req.user = data;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
function verifyOnly(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, SUPABASE_JWT_SECRET);
    if (!payload.email) return res.status(401).json({ error: "Invalid token" });
    req.tokenEmail = payload.email;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: "Admin access required" });
  next();
}
function wrap(fn) {
  return (req, res) => fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message || "Server error" });
  });
}

// ── AUTH ─────────────────────────────────────────────────────────────────
app.post("/api/auth/signup", wrap(async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password || password.length < 8) {
    return res.status(400).json({ error: "Missing or invalid username/email/password" });
  }
  const { data: existing } = await supabase.from("users").select("email").eq("email", email).maybeSingle();
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase
    .from("users")
    .insert({ email, username, password_hash: hash })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ token: signToken(email), user: publicUser(data) });
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: "Missing credentials" });
  let { data: user } = await supabase.from("users").select("*").eq("email", identifier).maybeSingle();
  if (!user) ({ data: user } = await supabase.from("users").select("*").eq("username", identifier).maybeSingle());
  if (!user || !user.password_hash) return res.status(401).json({ error: "Wrong email/username or password" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Wrong email/username or password" });
  res.json({ token: signToken(user.email), user: publicUser(user) });
}));

// ── UPLOADS (avatars / uploads / chat-media buckets) ───────────────────────
app.post("/api/uploads", requireAuth, wrap(async (req, res) => {
  const { bucket, filename, dataUrl } = req.body || {};
  if (!bucket || !dataUrl) return res.status(400).json({ error: "bucket and dataUrl are required" });
  const allowed = ["avatars", "uploads", "chat-media"];
  if (!allowed.includes(bucket)) return res.status(400).json({ error: "Unknown bucket" });

  const m = /^data:(.+?);base64,(.+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: "dataUrl must be a base64 data: URL" });
  const contentType = m[1];
  const buffer = Buffer.from(m[2], "base64");
  const safeName = (filename || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${req.user.email}/${Date.now()}_${safeName}`;

  const { error: upErr } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (upErr) return res.status(400).json({ error: upErr.message });

  const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
  res.json({ path, url: pub.publicUrl });
}));

// ── USERS ────────────────────────────────────────────────────────────────
app.get("/api/users", requireAuth, wrap(async (req, res) => {
  const { data, error } = await supabase.from("users").select("*").order("username");
  if (error) return res.status(400).json({ error: error.message });
  res.json((data || []).map(publicUser));
}));

app.get("/api/users/:email", wrap(async (req, res) => {
  const { data } = await supabase.from("users").select("*").eq("email", req.params.email).maybeSingle();
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json(publicUser(data));
}));

// Upsert profile — token email must match. Works for first-time Google users
// (no row yet) because it only verifies the JWT. Premium fields are never
// trusted from the client: they are only kept if a successful M-Pesa premium
// transaction for that phone proves them.
app.put("/api/users/:email", verifyOnly, wrap(async (req, res) => {
  const email = req.params.email;
  if (req.tokenEmail !== email) return res.status(403).json({ error: "Not allowed" });
  const body = req.body || {};
  const { data: existing } = await supabase.from("users").select("*").eq("email", email).maybeSingle();

  let plan = existing ? existing.premium_plan : null;
  let phone = existing ? existing.premium_phone : null;
  let exp = existing ? existing.premium_expires_at : null;
  if (body.premium_phone) {
    const { data: tx } = await supabase.from("mpesa_transactions").select("*")
      .eq("phone", body.premium_phone).eq("kind", "premium").eq("status", "success")
      .order("expires_at", { ascending: false }).limit(1).maybeSingle();
    if (tx && tx.expires_at && new Date(tx.expires_at) > new Date()) {
      plan = tx.plan; phone = body.premium_phone; exp = tx.expires_at;
    }
  }
  const patch = {
    email,
    username: body.username || (existing && existing.username) || email.split("@")[0],
    avatar_path: body.avatar_path ?? (existing ? existing.avatar_path : null),
    premium_plan: plan, premium_phone: phone, premium_expires_at: exp,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("users").upsert(patch).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(publicUser(data));
}));

app.patch("/api/users/:email/password", requireAuth, wrap(async (req, res) => {
  if (req.user.email !== req.params.email && !req.user.is_admin) {
    return res.status(403).json({ error: "Not allowed" });
  }
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  const hash = await bcrypt.hash(password, 10);
  const { error } = await supabase.from("users").update({ password_hash: hash }).eq("email", req.params.email);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
}));

// ── FILES (files + trash share one table; deleted_at is the switch) ───────
app.get("/api/files", wrap(async (req, res) => {
  let q = supabase.from("files").select("*").order("created_at", { ascending: false });
  if (req.query.deleted === "true") q = q.not("deleted_at", "is", null);
  else if (req.query.deleted === "false") q = q.is("deleted_at", null);
  if (req.query.category) q = q.eq("category", req.query.category);
  if (req.query.subcategory) q = q.eq("subcategory", req.query.subcategory);
  const { data, error } = await q;
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
}));

app.get("/api/files/:id", wrap(async (req, res) => {
  const { data } = await supabase.from("files").select("*").eq("id", req.params.id).maybeSingle();
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json(data);
}));

app.put("/api/files/:id", requireAuth, requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const row = {
    id: req.params.id,
    name: b.name,
    caption: b.caption || "",
    category: b.category,
    subcategory: b.subcategory || "",
    storage_path: b.storage_path || "",
    size: b.size || null,
    mime_type: b.type || null,
    uploaded_by: b.uploaded_by || req.user.email,
    deleted_at: b.deleted ? new Date().toISOString() : null,
  };
  const { data, error } = await supabase.from("files").upsert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.patch("/api/files/:id", requireAuth, requireAdmin, wrap(async (req, res) => {
  const patch = {};
  if ("deleted" in req.body) patch.deleted_at = req.body.deleted ? new Date().toISOString() : null;
  const { data, error } = await supabase.from("files").update(patch).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.delete("/api/files/:id", requireAuth, requireAdmin, wrap(async (req, res) => {
  const { error } = await supabase.from("files").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).end();
}));

// ── CHAT ─────────────────────────────────────────────────────────────────
app.get("/api/chat-messages", wrap(async (req, res) => {
  const { data, error } = await supabase.from("chat_messages").select("*").order("created_at");
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
}));

app.put("/api/chat-messages/:id", requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const row = {
    id: req.params.id,
    sender_email: req.user.email,
    sender_username: b.sender_username || req.user.username,
    text: b.text || null,
    image_path: b.image_path || null,
    image_paths: b.image_paths || null,
    reply_label: b.reply_label || null,
    likes: b.likes || [],
  };
  const { data, error } = await supabase.from("chat_messages").upsert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.delete("/api/chat-messages/:id", requireAuth, wrap(async (req, res) => {
  const { data: msg } = await supabase.from("chat_messages").select("sender_email").eq("id", req.params.id).maybeSingle();
  if (msg && msg.sender_email !== req.user.email && !req.user.is_admin) {
    return res.status(403).json({ error: "Not allowed" });
  }
  const { error } = await supabase.from("chat_messages").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).end();
}));

// ── DIRECT MESSAGES ──────────────────────────────────────────────────────
app.get("/api/dm-messages", requireAuth, wrap(async (req, res) => {
  let q = supabase.from("dm_messages").select("*").order("created_at");
  // Only ever return conversations the caller is part of.
  q = q.or(`from_email.eq.${req.user.email},to_email.eq.${req.user.email}`);
  if (req.query.from) q = q.eq("from_email", req.query.from);
  if (req.query.to) q = q.eq("to_email", req.query.to);
  const { data, error } = await q;
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
}));

app.put("/api/dm-messages/:id", requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.from_email && b.from_email !== req.user.email) {
    return res.status(403).json({ error: "from_email must be you" });
  }
  const row = {
    id: req.params.id,
    from_email: req.user.email,
    to_email: b.to_email,
    text: b.text || null,
    image_path: b.image_path || null,
    image_paths: b.image_paths || null,
    read: !!b.read,
  };
  const { data, error } = await supabase.from("dm_messages").upsert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.delete("/api/dm-messages/:id", requireAuth, wrap(async (req, res) => {
  const { data: msg } = await supabase.from("dm_messages").select("from_email").eq("id", req.params.id).maybeSingle();
  if (msg && msg.from_email !== req.user.email && !req.user.is_admin) {
    return res.status(403).json({ error: "Not allowed" });
  }
  const { error } = await supabase.from("dm_messages").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).end();
}));

// ── REVIEWS ──────────────────────────────────────────────────────────────
app.get("/api/reviews", wrap(async (req, res) => {
  const { data, error } = await supabase.from("reviews").select("*").order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
}));

app.put("/api/reviews/:id", requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const row = {
    id: req.params.id,
    user_email: req.user.email,
    username: b.username || req.user.username,
    stars: b.stars,
    text: b.text || null,
  };
  const { data, error } = await supabase.from("reviews").upsert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.delete("/api/reviews/:id", requireAuth, wrap(async (req, res) => {
  const { data: rev } = await supabase.from("reviews").select("user_email").eq("id", req.params.id).maybeSingle();
  if (rev && rev.user_email !== req.user.email && !req.user.is_admin) {
    return res.status(403).json({ error: "Not allowed" });
  }
  const { error } = await supabase.from("reviews").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).end();
}));

// ── VISITS (presence) ────────────────────────────────────────────────────
app.get("/api/visits", requireAuth, requireAdmin, wrap(async (req, res) => {
  const { data, error } = await supabase.from("visits").select("*, users(username, avatar_path)").order("last_seen_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  const shaped = (data || []).map((v) => ({
    user_email: v.user_email,
    last_page: v.last_page,
    last_seen_at: v.last_seen_at,
    username: v.users ? v.users.username : "",
    avatar: v.users ? v.users.avatar_path : "",
  }));
  res.json(shaped);
}));

app.put("/api/visits/:email", requireAuth, wrap(async (req, res) => {
  if (req.user.email !== req.params.email) return res.status(403).json({ error: "Not allowed" });
  const b = req.body || {};
  const row = { user_email: req.params.email, last_page: b.last_page || "", last_seen_at: b.last_seen_at || new Date().toISOString() };
  const { error } = await supabase.from("visits").upsert(row);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
}));

// ── M-PESA (Daraja STK push) ─────────────────────────────────────────────
const MPESA_BASE = MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

async function mpesaToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString("base64");
  const r = await fetch(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const d = await r.json();
  return d.access_token;
}
function mpesaTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const PLAN_DAYS = { day: 1, week: 7, month: 30 };

app.post("/api/mpesa/stk-push", wrap(async (req, res) => {
  const { productId, phone, amount, kind, plan } = req.body || {};
  if (!phone || !amount) return res.status(400).json({ error: "phone and amount are required" });
  const timestamp = mpesaTimestamp();
  const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString("base64");
  const token = await mpesaToken();

  const r = await fetch(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: productId || "PNFOrder",
      TransactionDesc: "BestITFriend purchase",
    }),
  });
  const d = await r.json();
  if (!d.CheckoutRequestID) return res.status(400).json({ error: d.errorMessage || "STK push failed" });

  const expiresAt = plan ? new Date(Date.now() + (PLAN_DAYS[plan] || 0) * 86400000).toISOString() : null;
  await supabase.from("mpesa_transactions").insert({
    product_id: productId || null,
    phone,
    amount,
    merchant_request_id: d.MerchantRequestID,
    checkout_request_id: d.CheckoutRequestID,
    kind: kind || "file",
    plan: plan || null,
    expires_at: expiresAt,
  });
  res.json({ checkoutRequestId: d.CheckoutRequestID });
}));

app.post("/api/mpesa/callback", wrap(async (req, res) => {
  const stk = req.body && req.body.Body && req.body.Body.stkCallback;
  if (!stk) return res.json({ ResultCode: 0, ResultDesc: "Ignored" });
  const items = (stk.CallbackMetadata && stk.CallbackMetadata.Item) || [];
  const get = (name) => { const it = items.find((i) => i.Name === name); return it ? it.Value : null; };
  await supabase
    .from("mpesa_transactions")
    .update({
      status: stk.ResultCode === 0 ? "success" : "failed",
      result_code: stk.ResultCode,
      result_desc: stk.ResultDesc,
      mpesa_receipt: get("MpesaReceiptNumber"),
      transaction_date: get("TransactionDate") ? String(get("TransactionDate")) : null,
      raw_callback: req.body,
      updated_at: new Date().toISOString(),
    })
    .eq("checkout_request_id", stk.CheckoutRequestID);
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}));

app.get("/api/mpesa/status/:checkoutId", wrap(async (req, res) => {
  const { data } = await supabase.from("mpesa_transactions").select("*").eq("checkout_request_id", req.params.checkoutId).maybeSingle();
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ status: data.status, receipt: data.mpesa_receipt, plan: data.plan, expiresAt: data.expires_at });
}));

app.get("/api/mpesa/premium-status", wrap(async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: "phone is required" });
  const { data } = await supabase
    .from("mpesa_transactions")
    .select("*")
    .eq("phone", phone)
    .eq("kind", "premium")
    .eq("status", "success")
    .order("expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const active = !!(data && data.expires_at && new Date(data.expires_at) > new Date());
  res.json({ active, plan: data ? data.plan : null, expiresAt: data ? data.expires_at : null });
}));

// 404 fallback for anything under /api not matched above
app.use("/api", (req, res) => res.status(404).json({ error: "Unknown endpoint" }));

module.exports.handler = serverless(app);
