BEGIN;
-- Existing local_capture records remain historical facts. Never infer transport
-- from today's mode, including when an invitation has no retained attempt.
ALTER TABLE invitation_delivery_attempts
  ALTER COLUMN transport DROP DEFAULT,
  ADD CONSTRAINT invitation_delivery_transport_valid
    CHECK (transport IN ('local_capture','smtp'));
COMMIT;
