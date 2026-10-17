ALTER TABLE ceremonies ADD COLUMN bootstrap INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ceremonies ADD COLUMN session_token_hash TEXT;

CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT NOT NULL,
  route TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, route)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_bucket ON rate_limits(bucket_start);
