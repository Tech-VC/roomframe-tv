BEGIN;

CREATE TABLE IF NOT EXISTS experience_seed_history (
  bundle_id text NOT NULL,
  version text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  applied_to_empty_instance boolean NOT NULL DEFAULT true,
  PRIMARY KEY (bundle_id, version)
);

-- Cette migration ne charge aucun contenu. Le bundle neutre est appliqué par l'API uniquement
-- lorsqu'aucune instance n'existe, puis son historique empêche toute réapplication destructive.

COMMIT;
