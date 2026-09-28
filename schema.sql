-- BestITFriend Online Sales — full backend schema (Supabase / Postgres)
-- Run this in Supabase → SQL Editor. Safe to re-run: every statement is
-- idempotent (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
-- This is the schema the netlify/functions/api.js REST layer talks to, via
-- Supabase's built-in PostgREST + the @supabase/supabase-js service-role
-- client. No Supabase Auth users table is used — accounts (including Google
-- sign-in ones) live entirely in the `users` table below; auth is a signed
-- JWT minted by the function using SUPABASE_JWT_SECRET (see DEPLOY.md).

-- ══════════════════════════════════════════════════════════════
-- USERS — accounts
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  email             TEXT PRIMARY KEY,
  username          TEXT UNIQUE NOT NULL,
  password_hash     TEXT,           -- bcrypt hash, set server-side only. NULL for Google-only accounts.
  avatar_path       TEXT,           -- public/signed URL returned by /api/uploads (bucket: avatars)
  is_admin          BOOLEAN NOT NULL DEFAULT FALSE,
  premium_plan      TEXT,           -- 'day' | 'week' | 'month' | NULL
  premium_phone     TEXT,
  premium_expires_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ══════════════════════════════════════════════════════════════
-- FILES — marketplace items / notes (soft-delete via deleted_at = "trash")
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  caption          TEXT,
  category          TEXT,
  subcategory        TEXT,
  storage_path        TEXT NOT NULL,   -- URL returned by /api/uploads (bucket: uploads)
  size            INTEGER,        -- bytes, informational (frontend still shows it)
  mime_type         TEXT,
  uploaded_by         TEXT REFERENCES users(email) ON DELETE SET NULL,
  deleted_at         TIMESTAMPTZ,       -- NULL = live; set = in "trash"
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_files_category ON files(category, subcategory);
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);
ALTER TABLE files ADD COLUMN IF NOT EXISTS size INTEGER;
ALTER TABLE files ADD COLUMN IF NOT EXISTS mime_type TEXT;

-- ══════════════════════════════════════════════════════════════
-- CHAT — public community chat
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chat_messages (
  id             TEXT PRIMARY KEY,
  sender_email        TEXT REFERENCES users(email) ON DELETE SET NULL,
  sender_username      TEXT,
  text            TEXT,
  image_path         TEXT,           -- bucket: chat-media
  image_paths        JSONB,
  reply_to          TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  reply_label        TEXT,           -- display label ("@username") the UI uses instead of a real reply id
  likes            JSONB NOT NULL DEFAULT '[]'::jsonb, -- array of liker emails
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_label TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS likes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ══════════════════════════════════════════════════════════════
-- DIRECT MESSAGES — one row per message
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dm_messages (
  id             TEXT PRIMARY KEY,
  from_email         TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  to_email          TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  text            TEXT,
  image_path         TEXT,
  image_paths        JSONB,
  read            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation
  ON dm_messages(LEAST(from_email, to_email), GREATEST(from_email, to_email), created_at);
CREATE INDEX IF NOT EXISTS idx_dm_messages_unread ON dm_messages(to_email, read);
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS image_paths JSONB;

-- ══════════════════════════════════════════════════════════════
-- REVIEWS — star ratings & testimonials
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS reviews (
  id             TEXT PRIMARY KEY,
  user_email         TEXT REFERENCES users(email) ON DELETE SET NULL,
  username          TEXT,
  stars            SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created_at);

-- ══════════════════════════════════════════════════════════════
-- VISITS — presence / "who's online, what page, when last seen"
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS visits (
  user_email         TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  last_page          TEXT,
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No `sess` table — sessions are stateless signed JWTs (see DEPLOY.md), not
-- a database row, matching the schema's original note about replacing the
-- old local-only "sess" IndexedDB store with real auth.

-- ══════════════════════════════════════════════════════════════
-- MPESA TRANSACTIONS — unchanged, already live
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id BIGSERIAL PRIMARY KEY,
  product_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  merchant_request_id TEXT,
  checkout_request_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  result_code INTEGER,
  result_desc TEXT,
  mpesa_receipt TEXT,
  transaction_date TEXT,
  raw_callback JSONB,
  kind TEXT NOT NULL DEFAULT 'file',
  plan TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mpesa_transactions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'file';
ALTER TABLE mpesa_transactions ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE mpesa_transactions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_status ON mpesa_transactions(status);
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_premium_lookup
  ON mpesa_transactions(phone, kind, status, expires_at);

-- ══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- api.js talks to Postgres using the Supabase SERVICE ROLE key, which
-- bypasses RLS entirely — so RLS below is a second line of defense in case
-- the anon/public key is ever used directly against these tables. Enable it
-- and lock everything down to service-role-only.
-- ══════════════════════════════════════════════════════════════
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE mpesa_transactions ENABLE ROW LEVEL SECURITY;
-- (No policies are created, so with RLS on, only the service role — which
-- bypasses RLS by design — can read/write. The anon key gets nothing.)

-- ══════════════════════════════════════════════════════════════
-- STORAGE BUCKETS — create in Supabase dashboard → Storage → New bucket
-- (cannot be created via SQL). Names must match what api.js uploads to:
--
--   avatars      — profile photos           (users.avatar_path)
--   uploads      — marketplace files         (files.storage_path)
--   chat-media    — chat / DM images          (chat_messages/dm_messages image_path[s])
--
-- Make them Public if you want plain URLs (simplest, matches api.js
-- defaults below); keep them Private + use signed URLs if files should only
-- be reachable after a verified purchase/login.
-- ══════════════════════════════════════════════════════════════
