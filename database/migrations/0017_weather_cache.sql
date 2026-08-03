BEGIN;

CREATE TABLE weather_cache (
  location_key char(64) PRIMARY KEY
    CHECK (location_key ~ '^[a-f0-9]{64}$'),
  location_label text NOT NULL
    CHECK (char_length(location_label) BETWEEN 1 AND 200),
  latitude double precision NOT NULL
    CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL
    CHECK (longitude BETWEEN -180 AND 180),
  timezone text NOT NULL
    CHECK (char_length(timezone) BETWEEN 1 AND 100),
  units text NOT NULL
    CHECK (units IN ('metric', 'imperial')),
  temperature double precision,
  apparent_temperature double precision,
  weather_code smallint,
  is_day boolean,
  observed_at timestamptz,
  fetched_at timestamptz,
  expires_at timestamptz,
  last_error_code text
    CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (
      temperature IS NULL
      AND apparent_temperature IS NULL
      AND weather_code IS NULL
      AND is_day IS NULL
      AND observed_at IS NULL
      AND fetched_at IS NULL
      AND expires_at IS NULL
    )
    OR (
      temperature BETWEEN -150 AND 160
      AND apparent_temperature BETWEEN -170 AND 180
      AND weather_code BETWEEN 0 AND 99
      AND is_day IS NOT NULL
      AND observed_at IS NOT NULL
      AND fetched_at IS NOT NULL
      AND expires_at > fetched_at
    )
  )
);

CREATE INDEX weather_cache_expiry_idx ON weather_cache (expires_at);

COMMIT;
