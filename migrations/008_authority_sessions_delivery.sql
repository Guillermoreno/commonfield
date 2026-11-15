BEGIN;

ALTER TABLE writer_epoch
  ADD COLUMN IF NOT EXISTS owner_nonce uuid;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS deadline_version bigint NOT NULL DEFAULT 0
    CHECK (deadline_version >= 0);

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS current_delivery_attempt_id uuid;

ALTER TABLE invitation_delivery_attempts
  ADD COLUMN IF NOT EXISTS recipient_email text,
  ADD COLUMN IF NOT EXISTS selected_role text,
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'local_capture';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invitations_current_delivery_attempt_fk'
  ) THEN
    ALTER TABLE invitations
      ADD CONSTRAINT invitations_current_delivery_attempt_fk
      FOREIGN KEY (current_delivery_attempt_id)
      REFERENCES invitation_delivery_attempts(id);
  END IF;
END $$;

COMMIT;
