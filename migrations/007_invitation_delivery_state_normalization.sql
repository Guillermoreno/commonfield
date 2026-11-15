BEGIN;

ALTER TABLE invitations
  DROP CONSTRAINT IF EXISTS invitations_delivery_status_check;

UPDATE invitations
SET delivery_status = CASE delivery_status
  WHEN 'unsent' THEN 'not_requested'
  WHEN 'sending' THEN 'queued'
  ELSE delivery_status
END
WHERE delivery_status IN ('unsent', 'sending');

ALTER TABLE invitations
  ALTER COLUMN delivery_status SET DEFAULT 'not_requested',
  ADD CONSTRAINT invitations_delivery_status_check
    CHECK (delivery_status IN ('not_requested','queued','sent','failed','uncertain'));

COMMIT;
