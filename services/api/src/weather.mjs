import crypto from 'node:crypto';

export const WEATHER_ATTRIBUTION = Object.freeze({
  label: 'Données météo : Open-Meteo',
  url: 'https://open-meteo.com/',
});

const weatherRefreshes = new Map();

const finiteNumber = (value, field, minimum, maximum) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw Object.assign(new Error(`invalid_${field}`), { statusCode: 400 });
  }
  return number;
};

const validTimezone = (value) => {
  const timezone = String(value ?? '').trim();
  if (!timezone || timezone.length > 100) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    return timezone;
  } catch {
    return null;
  }
};

export const weatherLocationKey = ({ latitude, longitude, timezone, units = 'metric' }) => {
  const lat = finiteNumber(latitude, 'weather_latitude', -90, 90);
  const lon = finiteNumber(longitude, 'weather_longitude', -180, 180);
  const zone = validTimezone(timezone);
  if (!zone) throw Object.assign(new Error('invalid_weather_timezone'), { statusCode: 400 });
  if (!['metric', 'imperial'].includes(units)) {
    throw Object.assign(new Error('invalid_weather_units'), { statusCode: 400 });
  }
  return crypto.createHash('sha256')
    .update(`${lat.toFixed(6)}|${lon.toFixed(6)}|${zone}|${units}`)
    .digest('hex');
};

export const weatherConditionFr = (code) => {
  const value = Number(code);
  if (value === 0) return 'Ciel dégagé';
  if ([1, 2].includes(value)) return 'Éclaircies';
  if (value === 3) return 'Couvert';
  if ([45, 48].includes(value)) return 'Brouillard';
  if ([51, 53, 55, 56, 57].includes(value)) return 'Bruine';
  if ([61, 63, 65, 66, 67].includes(value)) return 'Pluie';
  if ([71, 73, 75, 77].includes(value)) return 'Neige';
  if ([80, 81, 82].includes(value)) return 'Averses';
  if ([85, 86].includes(value)) return 'Averses de neige';
  if ([95, 96, 99].includes(value)) return 'Orage';
  return 'Conditions inconnues';
};

const locationFromNode = (node) => {
  if (node?.kind !== 'weather') return null;
  const props = node.props ?? {};
  const location = String(props.location ?? '').trim();
  const timezone = validTimezone(props.timezone);
  const units = props.units ?? 'metric';
  if (!location || !timezone || !['metric', 'imperial'].includes(units)) return null;
  let latitude;
  let longitude;
  try {
    latitude = finiteNumber(props.latitude, 'weather_latitude', -90, 90);
    longitude = finiteNumber(props.longitude, 'weather_longitude', -180, 180);
  } catch {
    return null;
  }
  const key = weatherLocationKey({ latitude, longitude, timezone, units });
  if (props.locationKey !== key) return null;
  return { key, location, latitude, longitude, timezone, units };
};

export const weatherLocationsFromScene = (scene) => {
  const unique = new Map();
  for (const node of scene?.nodes ?? []) {
    const location = locationFromNode(node);
    if (location) unique.set(location.key, location);
  }
  return [...unique.values()];
};

const limitedJson = async (response, maximum = 128 * 1024) => {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > maximum) throw new Error('weather_gateway_response_too_large');
  const text = await response.text();
  if (Buffer.byteLength(text) > maximum) throw new Error('weather_gateway_response_too_large');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('weather_gateway_invalid_json');
  }
};

const gatewayRequest = async (config, pathname, query) => {
  const base = new URL(config.weatherGatewayUrl);
  if (base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/') {
    throw new Error('invalid_weather_gateway_url');
  }
  const url = new URL(pathname, base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(config.weatherRequestTimeoutMs),
    });
  } catch {
    throw Object.assign(new Error('weather_gateway_unavailable'), { statusCode: 503 });
  }
  const payload = await limitedJson(response);
  if (!response.ok) {
    throw Object.assign(new Error(
      typeof payload?.error === 'string' ? payload.error : 'weather_gateway_unavailable',
    ), { statusCode: response.status >= 500 ? 503 : 400 });
  }
  return payload;
};

const cleanLocationResult = (entry) => {
  const location = String(entry?.location ?? '').trim();
  const detail = String(entry?.detail ?? '').trim();
  const timezone = validTimezone(entry?.timezone);
  const units = 'metric';
  if (!location || location.length > 200 || detail.length > 300 || !timezone) return null;
  let latitude;
  let longitude;
  try {
    latitude = finiteNumber(entry.latitude, 'weather_latitude', -90, 90);
    longitude = finiteNumber(entry.longitude, 'weather_longitude', -180, 180);
  } catch {
    return null;
  }
  return {
    key: weatherLocationKey({ latitude, longitude, timezone, units }),
    location,
    detail,
    latitude,
    longitude,
    timezone,
    units,
  };
};

export const searchWeatherLocations = async (config, query) => {
  const text = String(query ?? '').trim().replace(/\s+/g, ' ');
  if (text.length < 2 || text.length > 120) {
    throw Object.assign(new Error('invalid_weather_search'), { statusCode: 400 });
  }
  const payload = await gatewayRequest(config, '/locations', { q: text });
  const results = Array.isArray(payload?.results)
    ? payload.results.map(cleanLocationResult).filter(Boolean).slice(0, 8)
    : [];
  return { results, attribution: WEATHER_ATTRIBUTION };
};

const normalizeCurrent = (payload) => {
  const temperature = finiteNumber(payload?.temperature, 'weather_temperature', -150, 160);
  const apparentTemperature = finiteNumber(
    payload?.apparentTemperature,
    'weather_apparent_temperature',
    -170,
    180,
  );
  const weatherCode = Math.round(finiteNumber(payload?.weatherCode, 'weather_code', 0, 99));
  if (typeof payload?.isDay !== 'boolean') throw new Error('invalid_weather_is_day');
  const observedAt = new Date(payload?.observedAt);
  if (Number.isNaN(observedAt.getTime())) throw new Error('invalid_weather_observed_at');
  return {
    temperature,
    apparentTemperature,
    weatherCode,
    isDay: payload.isDay,
    observedAt,
  };
};

const rowReadingChanged = (row, current) => (
  !row
  || Number(row.temperature) !== current.temperature
  || Number(row.apparent_temperature) !== current.apparentTemperature
  || Number(row.weather_code) !== current.weatherCode
  || row.is_day !== current.isDay
  || new Date(row.observed_at).getTime() !== current.observedAt.getTime()
);

const readCacheRow = async (pool, key) => {
  const result = await pool.query('SELECT * FROM weather_cache WHERE location_key = $1', [key]);
  return result.rows[0] ?? null;
};

const serializeWeatherRow = (row, location, now = new Date()) => {
  const hasReading = row?.temperature !== null && row?.temperature !== undefined;
  const expired = !row?.expires_at || new Date(row.expires_at) <= now;
  const status = hasReading ? (expired || row.last_error_code ? 'stale' : 'ready') : 'unavailable';
  const temperature = hasReading ? Number(row.temperature) : null;
  const apparentTemperature = hasReading ? Number(row.apparent_temperature) : null;
  const weatherCode = hasReading ? Number(row.weather_code) : null;
  return {
    key: location.key,
    location: location.location,
    timezone: location.timezone,
    units: location.units,
    status,
    temperatureUnit: location.units === 'imperial' ? '°F' : '°C',
    temperature,
    apparentTemperature,
    weatherCode,
    condition: hasReading ? weatherConditionFr(weatherCode) : null,
    isDay: hasReading ? Boolean(row.is_day) : null,
    observedAt: hasReading ? new Date(row.observed_at).toISOString() : null,
    fetchedAt: hasReading ? new Date(row.fetched_at).toISOString() : null,
    errorCode: row?.last_error_code ?? null,
  };
};

const refreshWeatherLocation = async (pool, config, location) => {
  const before = await readCacheRow(pool, location.key);
  if (before?.expires_at && new Date(before.expires_at) > new Date() && !before.last_error_code) {
    return { item: serializeWeatherRow(before, location), changed: false };
  }
  if (
    before?.last_error_code
    && before.updated_at
    && new Date(before.updated_at).getTime() > Date.now() - 5 * 60_000
  ) {
    return { item: serializeWeatherRow(before, location), changed: false };
  }
  let current;
  try {
    const payload = await gatewayRequest(config, '/current', {
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: location.timezone,
      units: location.units,
    });
    current = normalizeCurrent(payload);
  } catch (error) {
    const errorCode = String(error?.message ?? 'weather_unavailable').slice(0, 100);
    const result = await pool.query(
      `INSERT INTO weather_cache (
         location_key, location_label, latitude, longitude, timezone, units,
         last_error_code, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (location_key) DO UPDATE SET
         location_label = EXCLUDED.location_label,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         timezone = EXCLUDED.timezone,
         units = EXCLUDED.units,
         last_error_code = EXCLUDED.last_error_code,
         updated_at = now()
       RETURNING *`,
      [
        location.key,
        location.location,
        location.latitude,
        location.longitude,
        location.timezone,
        location.units,
        errorCode,
      ],
    );
    return { item: serializeWeatherRow(result.rows[0], location), changed: false };
  }
  const fetchedAt = new Date();
  const expiresAt = new Date(fetchedAt.getTime() + config.weatherCacheMinutes * 60_000);
  const changed = rowReadingChanged(before, current);
  const result = await pool.query(
    `INSERT INTO weather_cache (
       location_key, location_label, latitude, longitude, timezone, units,
       temperature, apparent_temperature, weather_code, is_day,
       observed_at, fetched_at, expires_at, last_error_code, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, now())
     ON CONFLICT (location_key) DO UPDATE SET
       location_label = EXCLUDED.location_label,
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       timezone = EXCLUDED.timezone,
       units = EXCLUDED.units,
       temperature = EXCLUDED.temperature,
       apparent_temperature = EXCLUDED.apparent_temperature,
       weather_code = EXCLUDED.weather_code,
       is_day = EXCLUDED.is_day,
       observed_at = EXCLUDED.observed_at,
       fetched_at = EXCLUDED.fetched_at,
       expires_at = EXCLUDED.expires_at,
       last_error_code = NULL,
       updated_at = now()
     RETURNING *`,
    [
      location.key,
      location.location,
      location.latitude,
      location.longitude,
      location.timezone,
      location.units,
      current.temperature,
      current.apparentTemperature,
      current.weatherCode,
      current.isDay,
      current.observedAt,
      fetchedAt,
      expiresAt,
    ],
  );
  return { item: serializeWeatherRow(result.rows[0], location), changed };
};

export const ensureWeatherLocation = async (pool, config, location) => {
  const normalized = {
    ...location,
    location: String(location.location ?? '').trim(),
    timezone: validTimezone(location.timezone),
    units: location.units ?? 'metric',
  };
  normalized.key = weatherLocationKey(normalized);
  if (!normalized.location || normalized.location.length > 200 || !normalized.timezone) {
    throw Object.assign(new Error('invalid_weather_location'), { statusCode: 400 });
  }
  if (!weatherRefreshes.has(normalized.key)) {
    const refresh = refreshWeatherLocation(pool, config, normalized)
      .finally(() => weatherRefreshes.delete(normalized.key));
    weatherRefreshes.set(normalized.key, refresh);
  }
  return weatherRefreshes.get(normalized.key);
};

export const refreshWeatherForScene = async (pool, config, scene) => {
  const locations = weatherLocationsFromScene(scene);
  const results = await Promise.all(locations.map(
    (location) => ensureWeatherLocation(pool, config, location),
  ));
  if (results.some((result) => result.changed)) {
    await pool.query(
      'UPDATE sync_state SET revision = revision + 1, updated_at = now() WHERE singleton = true',
    );
  }
  return {
    schemaVersion: 1,
    provider: 'open-meteo',
    attribution: WEATHER_ATTRIBUTION,
    items: results.map((result) => result.item),
  };
};

export const weatherDocumentForScene = async (pool, scene) => {
  const locations = weatherLocationsFromScene(scene);
  const items = await Promise.all(locations.map(async (location) => (
    serializeWeatherRow(await readCacheRow(pool, location.key), location)
  )));
  return {
    schemaVersion: 1,
    provider: 'open-meteo',
    attribution: WEATHER_ATTRIBUTION,
    items,
  };
};
