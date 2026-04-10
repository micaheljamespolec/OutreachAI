/*
  # Add raw_data column to saved_profiles

  1. Modified Tables
    - `saved_profiles` - adds raw_data JSONB column to store full FullEnrich API response
*/

ALTER TABLE saved_profiles ADD COLUMN IF NOT EXISTS raw_data JSONB;
