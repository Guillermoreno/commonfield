ALTER TABLE memberships
  DROP CONSTRAINT IF EXISTS memberships_team_id_user_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_active_per_user_team
  ON memberships(team_id, user_id)
  WHERE status = 'active';

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS canonical_origin text,
  ADD COLUMN IF NOT EXISTS envelope_ciphertext bytea,
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'unsent'
    CHECK (delivery_status IN ('unsent','sending','sent','failed','uncertain'));

CREATE TABLE IF NOT EXISTS invitation_delivery_attempts (
  id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL REFERENCES invitations ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('sending','sent','failed','uncertain')),
  outcome_code text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(invitation_id, generation)
);
