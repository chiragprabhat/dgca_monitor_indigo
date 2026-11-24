ALTER TABLE updates ADD COLUMN IF NOT EXISTS email_delivery_started_at text;
CREATE INDEX IF NOT EXISTS idx_notifications_update_sent ON notifications(update_id) WHERE status = 'sent';
ALTER TABLE car_changes
  ADD COLUMN IF NOT EXISTS previous_history_id bigint REFERENCES car_history(id),
  ADD COLUMN IF NOT EXISTS compare_pdf_url text;

CREATE TABLE IF NOT EXISTS dgca_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  scope text NOT NULL,
  input jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status integer,
  result text
);

CREATE UNIQUE INDEX IF NOT EXISTS dgca_jobs_active
  ON dgca_jobs (kind, scope) WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS dgca_jobs_history ON dgca_jobs (kind, created_at DESC);

CREATE TABLE IF NOT EXISTS dgca_upload_sessions (
  id uuid PRIMARY KEY,
  filename text NOT NULL,
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 41943040),
  expires_at timestamptz NOT NULL,
  job_id uuid REFERENCES dgca_jobs(id)
);

CREATE TABLE IF NOT EXISTS dgca_upload_chunks (
  upload_id uuid NOT NULL REFERENCES dgca_upload_sessions(id) ON DELETE CASCADE,
  part integer NOT NULL CHECK (part BETWEEN 0 AND 13),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 3145728),
  PRIMARY KEY (upload_id, part)
);
