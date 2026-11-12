-- Registre des coins lancés via le launchpad
CREATE TABLE IF NOT EXISTS coins (
  mint TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  image TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quote_mint TEXT NOT NULL,
  quote_symbol TEXT NOT NULL DEFAULT '',
  tier INTEGER NOT NULL,
  creator TEXT NOT NULL,
  signature TEXT NOT NULL,
  launched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS coins_launched_at ON coins (launched_at DESC);
