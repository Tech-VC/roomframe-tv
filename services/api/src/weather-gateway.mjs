import { readFile } from 'node:fs/promises';
import http from 'node:http';

const port = Number(process.env.PORT ?? 8091);
const mode = process.env.ROOMFRAME_WEATHER_PROVIDER_MODE === 'commercial'
  ? 'commercial'
  : 'evaluation';
const requestTimeoutMs = Math.min(
  20_000,
  Math.max(2_000, Number(process.env.ROOMFRAME_WEATHER_REQUEST_TIMEOUT_MS ?? 8_000)),
);
const apiKeyFile = process.env.ROOMFRAME_WEATHER_API_KEY_FILE
  ?? '/run/secrets/weather_api_key';

const provider = mode === 'commercial'
  ? {
      geocoding: 'https://customer-geocoding-api.open-meteo.com/v1/search',
      forecast: 'https://customer-api.open-meteo.com/v1/forecast',
    }
  : {
      geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
      forecast: 'https://api.open-meteo.com/v1/forecast',
    };

const apiKey = mode === 'commercial'
  ? (await readFile(apiKeyFile, 'utf8').catch(() => '')).trim()
  : '';
if (mode === 'commercial' && !apiKey) throw new Error('weather_api_key_missing');

const json = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
};

const finiteNumber = (value, minimum, maximum) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
};

const timezoneValue = (value) => {
  const timezone = String(value ?? '').trim();
  if (!timezone || timezone.length > 100) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    return timezone;
  } catch {
    return null;
  }
};

const readLimitedBody = async (response, maximum = 1024 * 1024) => {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maximum) throw new Error('provider_response_too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('provider_response_missing');
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new Error('provider_response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
};

const providerJson = async (base, parameters) => {
  const url = new URL(base);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  if (apiKey) url.searchParams.set('apikey', apiKey);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'RoomFrame-TV weather gateway',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw new Error('weather_provider_unavailable');
  }
  const raw = await readLimitedBody(response);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('weather_provider_invalid_json');
  }
  if (!response.ok || payload?.error === true) throw new Error('weather_provider_rejected');
  return payload;
};

const searchParts = (query) => {
  const postalCode = query.match(/(?:^|\s)(\d{4,6})(?:\s|$)/)?.[1] ?? null;
  const name = query.replace(/(?:^|\s)\d{4,6}(?:\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  return { postalCode, upstream: name.length >= 2 ? name : postalCode ?? query };
};

const locationResult = (entry, requestedPostalCode) => {
  const latitude = finiteNumber(entry?.latitude, -90, 90);
  const longitude = finiteNumber(entry?.longitude, -180, 180);
  const timezone = timezoneValue(entry?.timezone);
  const name = String(entry?.name ?? '').trim();
  const postcodes = Array.isArray(entry?.postcodes)
    ? entry.postcodes.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const postcode = requestedPostalCode && postcodes.includes(requestedPostalCode)
    ? requestedPostalCode
    : postcodes.find((value) => /^\d{4,6}$/.test(value)) ?? '';
  if (latitude === null || longitude === null || !timezone || !name) return null;
  const detail = [entry.admin2, entry.admin1, entry.country]
    .map((value) => String(value ?? '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' · ');
  return {
    location: [name, postcode].filter(Boolean).join(' '),
    detail,
    latitude,
    longitude,
    timezone,
  };
};

const handleLocations = async (requestUrl) => {
  const query = String(requestUrl.searchParams.get('q') ?? '').trim().replace(/\s+/g, ' ');
  if (query.length < 2 || query.length > 120) {
    throw Object.assign(new Error('invalid_weather_search'), { statusCode: 400 });
  }
  const { postalCode, upstream } = searchParts(query);
  const payload = await providerJson(provider.geocoding, {
    name: upstream,
    count: 20,
    language: 'fr',
    format: 'json',
  });
  let entries = Array.isArray(payload?.results) ? payload.results : [];
  if (postalCode) {
    const matching = entries.filter((entry) => (
      Array.isArray(entry?.postcodes)
      && entry.postcodes.some((value) => String(value) === postalCode)
    ));
    if (matching.length) entries = matching;
  }
  const seen = new Set();
  const results = entries
    .map((entry) => locationResult(entry, postalCode))
    .filter((entry) => {
      if (!entry) return false;
      const key = `${entry.latitude}|${entry.longitude}|${entry.timezone}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
  return { results };
};

const handleCurrent = async (requestUrl) => {
  const latitude = finiteNumber(requestUrl.searchParams.get('latitude'), -90, 90);
  const longitude = finiteNumber(requestUrl.searchParams.get('longitude'), -180, 180);
  const timezone = timezoneValue(requestUrl.searchParams.get('timezone'));
  const units = requestUrl.searchParams.get('units') ?? 'metric';
  if (latitude === null || longitude === null || !timezone || !['metric', 'imperial'].includes(units)) {
    throw Object.assign(new Error('invalid_weather_location'), { statusCode: 400 });
  }
  const payload = await providerJson(provider.forecast, {
    latitude,
    longitude,
    timezone,
    forecast_days: 1,
    timeformat: 'unixtime',
    temperature_unit: units === 'imperial' ? 'fahrenheit' : 'celsius',
    current: 'temperature_2m,apparent_temperature,weather_code,is_day',
  });
  const current = payload?.current;
  const temperature = finiteNumber(current?.temperature_2m, -150, 160);
  const apparentTemperature = finiteNumber(current?.apparent_temperature, -170, 180);
  const weatherCode = finiteNumber(current?.weather_code, 0, 99);
  const observedAtSeconds = finiteNumber(current?.time, 0, 4_102_444_800);
  if (
    temperature === null
    || apparentTemperature === null
    || weatherCode === null
    || ![0, 1].includes(Number(current?.is_day))
    || observedAtSeconds === null
  ) {
    throw new Error('weather_provider_invalid_current');
  }
  return {
    temperature,
    apparentTemperature,
    weatherCode: Math.round(weatherCode),
    isDay: Number(current.is_day) === 1,
    observedAt: new Date(observedAtSeconds * 1000).toISOString(),
  };
};

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' });
    const requestUrl = new URL(request.url, 'http://weather-gateway');
    if (requestUrl.pathname === '/health') {
      return json(response, 200, { ok: true, service: 'roomframe-weather', mode });
    }
    if (requestUrl.pathname === '/locations') {
      return json(response, 200, await handleLocations(requestUrl));
    }
    if (requestUrl.pathname === '/current') {
      return json(response, 200, await handleCurrent(requestUrl));
    }
    return json(response, 404, { error: 'not_found' });
  } catch (error) {
    const status = Number(error?.statusCode ?? 502);
    return json(response, status, {
      error: status < 500 ? error.message : 'weather_provider_unavailable',
    });
  }
});

server.listen(port, '0.0.0.0');

const close = () => server.close(() => process.exit(0));
process.once('SIGTERM', close);
process.once('SIGINT', close);
