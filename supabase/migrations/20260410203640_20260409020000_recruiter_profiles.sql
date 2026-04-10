/*
  # Create recruiter_profiles table

  1. New Types
    - `hiring_focus_enum` - engineering, product, design, data, sales, marketing, finance, legal, hr, operations, executive, other
    - `tone_enum` - professional, friendly, direct, warm, formal

  2. New Tables
    - `recruiter_profiles` - one row per user with recruiter identity for draft personalization
      - id, user_id, full_name, company_name, job_title, hiring_focus, tone
      - created_at, updated_at

  3. Security
    - RLS enabled with owner-only SELECT/INSERT/UPDATE policies

  4. Functions & Triggers
    - `is_first_time_user()` - returns true if the calling user has no recruiter_profiles row
    - `update_recruiter_profiles_updated_at()` trigger - auto-updates updated_at on changes
*/

DO $$ BEGIN
  CREATE TYPE hiring_focus_enum AS ENUM (
    'engineering', 'product', 'design', 'data', 'sales',
    'marketing', 'finance', 'legal', 'hr', 'operations', 'executive', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE tone_enum AS ENUM (
    'professional', 'friendly', 'direct', 'warm', 'formal'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS recruiter_profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  company_name  text NOT NULL,
  job_title     text,
  hiring_focus  hiring_focus_enum,
  tone          tone_enum,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE recruiter_profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users can view their own recruiter profile"
    ON recruiter_profiles FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert their own recruiter profile"
    ON recruiter_profiles FOR INSERT
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update their own recruiter profile"
    ON recruiter_profiles FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION is_first_time_user()
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM recruiter_profiles WHERE user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION update_recruiter_profiles_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recruiter_profiles_updated_at ON recruiter_profiles;
CREATE TRIGGER recruiter_profiles_updated_at
  BEFORE UPDATE ON recruiter_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_recruiter_profiles_updated_at();
