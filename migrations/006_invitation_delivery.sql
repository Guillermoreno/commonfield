BEGIN;
ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS secret_envelope bytea,
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'not_requested'
    CHECK(delivery_status IN ('not_requested','queued','sent','failed','uncertain')),
  ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0
    CHECK(delivery_attempts >= 0),
  ADD COLUMN IF NOT EXISTS last_delivery_at timestamptz;
COMMIT;
