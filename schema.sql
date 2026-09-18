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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_status ON mpesa_transactions(status);
