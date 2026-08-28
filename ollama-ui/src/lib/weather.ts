// Weather lookups via Open-Meteo — free, keyless, no account/config needed
// (unlike web_search, which depends on a self-hosted SearXNG instance). Used
// by the get_weather tool (src/app/api/chat/route.ts) instead of leaving
// weather questions to web_search: structured forecast data is both more
// reliable and cheaper than having the model try to extract numbers from
// search-result snippets — see the 2026-08 chat where a model announced
// it would search for weather and then never actually called any tool at
// all, likely in part because "search the web for a 3-day forecast" is a
// much fuzzier task than "call get_weather".
const GEOCODE_TIMEOUT_MS = 10_000;
const FORECAST_TIMEOUT_MS = 10_000;

interface GeocodeResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  timezone?: string;
}

interface GeocodeResponse {
  results?: GeocodeResult[];
}

interface ForecastResponse {
  timezone?: string;
  current?: {
    temperature_2m?: number;
    weather_code?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
  };
}

// WMO weather interpretation codes (the standard Open-Meteo uses) — mapped
// to short, human-readable descriptions. Codes not listed fall back to a
// generic label rather than throwing, since Open-Meteo's code set is fixed
// but this mapping is hand-maintained.
const WEATHER_CODES: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'dense freezing drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'heavy freezing rain',
  71: 'slight snow fall',
  73: 'moderate snow fall',
  75: 'heavy snow fall',
  77: 'snow grains',
  80: 'slight rain showers',
  81: 'moderate rain showers',
  82: 'violent rain showers',
  85: 'slight snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
};

function describeWeatherCode(code: number | undefined): string {
  if (code == null) return 'unknown';
  return WEATHER_CODES[code] ?? `unknown (code ${code})`;
}

export interface WeatherResult {
  location: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  current?: { temperatureC?: number; condition: string };
  daily: Array<{
    date: string;
    condition: string;
    tempMinC?: number;
    tempMaxC?: number;
    precipitationMm?: number;
  }>;
}

export async function getWeather(location: string, days: number): Promise<WeatherResult> {
  const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=de&format=json`;
  const geoRes = await fetch(geocodeUrl, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!geoRes.ok) throw new Error(`Geocoding failed (${geoRes.status})`);
  const geoData = (await geoRes.json()) as GeocodeResponse;
  const place = geoData.results?.[0];
  if (!place) throw new Error(`Location not found: "${location}"`);

  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum` +
    `&timezone=auto&forecast_days=${days}`;
  const forecastRes = await fetch(forecastUrl, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(FORECAST_TIMEOUT_MS),
  });
  if (!forecastRes.ok) throw new Error(`Forecast lookup failed (${forecastRes.status})`);
  const forecast = (await forecastRes.json()) as ForecastResponse;

  const dailyTimes = forecast.daily?.time ?? [];
  const daily = dailyTimes.map((date, i) => ({
    date,
    condition: describeWeatherCode(forecast.daily?.weather_code?.[i]),
    tempMinC: forecast.daily?.temperature_2m_min?.[i],
    tempMaxC: forecast.daily?.temperature_2m_max?.[i],
    precipitationMm: forecast.daily?.precipitation_sum?.[i],
  }));

  return {
    location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
    latitude: place.latitude,
    longitude: place.longitude,
    timezone: forecast.timezone,
    current: forecast.current
      ? {
          temperatureC: forecast.current.temperature_2m,
          condition: describeWeatherCode(forecast.current.weather_code),
        }
      : undefined,
    daily,
  };
}
