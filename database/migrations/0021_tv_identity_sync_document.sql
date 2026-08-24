BEGIN;

-- Force une synchronisation unique des TV déjà enrôlées afin qu'elles
-- reçoivent le nouveau document device.json sans réinitialisation.
UPDATE sync_state
SET revision = revision + 1,
    updated_at = now()
WHERE singleton = true;

COMMIT;
