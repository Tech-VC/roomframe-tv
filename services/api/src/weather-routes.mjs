import { requirePermission, requireSession } from './auth.mjs';
import {
  ensureWeatherLocation,
  searchWeatherLocations,
  weatherLocationKey,
} from './weather.mjs';

const cleanLocation = (value) => {
  const location = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!location || location.length > 200 || /[\u0000-\u001f\u007f]/.test(location)) {
    throw Object.assign(new Error('invalid_weather_location'), { statusCode: 400 });
  }
  return location;
};
export const registerWeatherRoutes = ({ app, pool, config }) => {
  const authenticated = requireSession(pool, config);

  app.get('/api/v1/weather/locations', {
    preHandler: [authenticated, requirePermission('studio:read')],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request) => searchWeatherLocations(config, request.query?.q));

  app.get('/api/v1/weather/current', {
    preHandler: [authenticated, requirePermission('studio:read')],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request) => {
    const location = {
      location: cleanLocation(request.query?.location),
      latitude: request.query?.latitude,
      longitude: request.query?.longitude,
      timezone: request.query?.timezone,
      units: request.query?.units ?? 'metric',
    };
    location.key = weatherLocationKey(location);
    if (request.query?.locationKey && request.query.locationKey !== location.key) {
      throw Object.assign(new Error('invalid_weather_location_key'), { statusCode: 400 });
    }
    const result = await ensureWeatherLocation(pool, config, location);
    return { weather: result.item };
  });
};
