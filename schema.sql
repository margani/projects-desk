-- The dashboard's two tables. Apply once to a new database:
--   npx wrangler d1 execute <name> --remote --file schema.sql
CREATE TABLE IF NOT EXISTS status (
  project TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  sha TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
