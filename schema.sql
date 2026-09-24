-- PrincesammisNewsFeed Enterprises — Daraja M-Pesa backend schema
-- Safe to run on a fresh database AND on an existing deployed one (all statements
-- are idempotent: CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so upgrading
-- an already-live deployment never drops or duplicates data.

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
  -- 'file'  = one-off item purchase (legacy / optional pathway, kept for backward compatibility)
  -- 'subscription' = a Premium Membership plan (day / week / month)
  kind TEXT NOT NULL DEFAULT 'file',
  plan TEXT,                   -- 'day' | 'week' | 'month' — only set when kind='subscription'
  expires_at TIMESTAMPTZ,       -- only set once a subscription payment has been verified successful
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upgrade path for a database created before these columns existed.
ALTER TABLE mpesa_transactions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'file';
ALTER TABLE mpesa_transactions ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE mpesa_transactions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_status ON mpesa_transactions(status);

-- Powers the /api/mpesa/premium-status lookup: "does this phone currently have an
-- active, backend-verified Premium subscription?"
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_premium_lookup
  ON mpesa_transactions(phone, kind, status, expires_at);
