/*
  # Create saved_jobs table

  1. New Tables
    - `saved_jobs` - stores saved job postings per user
      - id, user_id, label, job_url, role_title, company, highlights
      - created_at, updated_at

  2. Security
    - RLS enabled with owner-only CRUD policies
*/

CREATE TABLE IF NOT EXISTS saved_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  job_url     TEXT,
  role_title  TEXT,
  company     TEXT,
  highlights  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, label)
);

CREATE INDEX IF NOT EXISTS saved_jobs_user_id_idx ON saved_jobs(user_id);

ALTER TABLE saved_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own saved jobs"
  ON saved_jobs FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own saved jobs"
  ON saved_jobs FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own saved jobs"
  ON saved_jobs FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own saved jobs"
  ON saved_jobs FOR DELETE USING (auth.uid() = user_id);
