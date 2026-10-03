-- BestITFriend Online Sales — schema for plain PHP + PostgreSQL
-- Run once: psql "$DATABASE_URL" -f schema.sql   (safe to re-run — every
-- statement is idempotent). This is the same data model as the
-- Supabase/Netlify version, minus anything Supabase-specific (Storage
-- buckets, RLS) since public/api/index.php connects directly as a trusted
-- backend user via PDO, and uploaded files are written to the local
-- public/uploads/ folder instead of a Storage bucket.

CREATE TABLE IF NOT EXISTS users (
  email             TEXT PRIMARY KEY,
  username          TEXT UNIQUE NOT NULL,
  password_hash     TEXT,           -- PHP password_hash() (bcrypt). NULL for Google-only accounts.
  avatar_path       TEXT,           -- URL under /uploads/avatars/...
  is_admin          BOOLEAN NOT NULL DEFAULT FALSE,
  premium_plan      TEXT,           -- 'day' | 'week' | 'month' | NULL
  premium_phone     TEXT,
  premium_expires_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  caption          TEXT,
  category          TEXT,
  subcategory        TEXT,
  storage_path        TEXT NOT NULL,   -- URL under /uploads/uploads/...
  size            INTEGER,
  mime_type         TEXT,
  uploaded_by         TEXT REFERENCES users(email) ON DELETE SET NULL,
  deleted_at         TIMESTAMPTZ,       -- NULL = live; set = "trash"
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_files_category ON files(category, subcategory);
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id             TEXT PRIMARY KEY,
  sender_email        TEXT REFERENCES users(email) ON DELETE SET NULL,
  sender_username      TEXT,
  text            TEXT,
  image_path         TEXT,           -- URL under /uploads/chat-media/...
  image_paths        JSONB,
  reply_to          TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  reply_label        TEXT,
  likes            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);

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

CREATE TABLE IF NOT EXISTS reviews (
  id             TEXT PRIMARY KEY,
  user_email         TEXT REFERENCES users(email) ON DELETE SET NULL,
  username          TEXT,
  stars            SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created_at);

CREATE TABLE IF NOT EXISTS visits (
  user_email         TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  last_page          TEXT,
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No `sess` table: sessions are stateless signed JWTs minted by
-- public/api/index.php (JWT_SECRET in .env), not a database row.

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
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_status ON mpesa_transactions(status);
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_premium_lookup
  ON mpesa_transactions(phone, kind, status, expires_at);

-- Create a least-privilege application role instead of connecting as the
-- Postgres superuser. Run these once, then put the password in .env:
--
--   CREATE ROLE pnf_app LOGIN PASSWORD 'choose-a-strong-password';
--   GRANT CONNECT ON DATABASE your_db TO pnf_app;
--   GRANT USAGE ON SCHEMA public TO pnf_app;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pnf_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pnf_app;
