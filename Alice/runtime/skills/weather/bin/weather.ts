#!/usr/bin/env npx tsx
/**
 * weather CLI — 天气查询。
 *
 * 用法: npx tsx weather.ts <city>
 * 输出: JSON to stdout
 *
 * 接入 Open-Meteo API（免费、无 API key、全球覆盖）。
 * 两步流程：Geocoding → Forecast。
 *
 * @see https://open-meteo.com/en/docs
 */

// ── WMO Weather Code → emoji + 中文描述 ──

const WMO_CODES: Record<number, { emoji: string; desc: string }> = {
  0: { emoji: "☀️", desc: "Ясно" },
  1: { emoji: "🌤️", desc: "В основном ясно" },
  2: { emoji: "⛅", desc: "Переменная облачность" },
  3: { emoji: "☁️", desc: "Пасмурно" },
  45: { emoji: "🌫️", desc: "Туман" },
  48: { emoji: "🌫️", desc: "Туман с изморозью" },
  51: { emoji: "🌦️", desc: "Слабая морось" },
  53: { emoji: "🌦️", desc: "Морось" },
  55: { emoji: "🌦️", desc: "Сильная морось" },
  56: { emoji: "🌧️", desc: "Лёгкая ледяная морось" },
  57: { emoji: "🌧️", desc: "Ледяная морось" },
  61: { emoji: "🌧️", desc: "Небольшой дождь" },
  63: { emoji: "🌧️", desc: "Дождь" },
  65: { emoji: "🌧️", desc: "Сильный дождь" },
  66: { emoji: "🌧️", desc: "Ледяной дождь" },
  67: { emoji: "🌧️", desc: "Сильный ледяной дождь" },
  71: { emoji: "🌨️", desc: "Небольшой снег" },
  73: { emoji: "🌨️", desc: "Снег" },
  75: { emoji: "❄️", desc: "Сильный снег" },
  77: { emoji: "❄️", desc: "Снежная крупа" },
  80: { emoji: "🌦️", desc: "Небольшой ливень" },
  81: { emoji: "🌧️", desc: "Ливень" },
  82: { emoji: "⛈️", desc: "Сильный ливень" },
  85: { emoji: "🌨️", desc: "Кратковременный снег" },
  86: { emoji: "❄️", desc: "Сильный снегопад" },
  95: { emoji: "⛈️", desc: "Гроза" },
  96: { emoji: "⛈️", desc: "Гроза с небольшим градом" },
  99: { emoji: "⛈️", desc: "Гроза с крупным градом" },
};

function decodeWMO(code: number): { emoji: string; desc: string } {
  return WMO_CODES[code] ?? { emoji: "🌡️", desc: `Код погоды ${code}` };
}

function windDirection(degrees: number): string {
  const dirs = [
    "северный",
    "северо-восточный",
    "восточный",
    "юго-восточный",
    "южный",
    "юго-западный",
    "западный",
    "северо-западный",
  ];
  const idx = Math.round(degrees / 45) % 8;
  return dirs[idx];
}

// ── main ──

const city = process.argv[2];
if (!city) {
  console.error("Usage: weather.ts <city>");
  process.exit(1);
}

const signal = AbortSignal.timeout(10_000);

// Step 1: Geocode
const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru&format=json`;
const geoRes = await fetch(geoUrl, { signal });
if (!geoRes.ok) {
  console.error(`Geocoding failed: ${geoRes.status}`);
  process.exit(1);
}
const geoData = (await geoRes.json()) as {
  results?: {
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    admin1?: string;
  }[];
};
const geo = geoData.results?.[0];
if (!geo) {
  console.error(`City not found: ${city}`);
  process.exit(1);
}

// Step 2: Forecast
const forecastParams = new URLSearchParams({
  latitude: String(geo.latitude),
  longitude: String(geo.longitude),
  current:
    "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day",
  daily: "temperature_2m_max,temperature_2m_min",
  timezone: "auto",
  forecast_days: "1",
});
const forecastRes = await fetch(`https://api.open-meteo.com/v1/forecast?${forecastParams}`, {
  signal,
});
if (!forecastRes.ok) {
  console.error(`Forecast failed: ${forecastRes.status}`);
  process.exit(1);
}
const forecast = (await forecastRes.json()) as {
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    weather_code: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    is_day: number;
  };
  daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
};

const { current, daily } = forecast;
const wmo = decodeWMO(current.weather_code);
const locationName = geo.admin1
  ? `${geo.name}, ${geo.admin1}, ${geo.country}`
  : `${geo.name}, ${geo.country}`;

// 程序自己 print 格式化输出——LLM 直接读 stdout
const temp = Math.round(current.temperature_2m);
const feels = Math.round(current.apparent_temperature);
const hi = Math.round(daily.temperature_2m_max[0]);
const lo = Math.round(daily.temperature_2m_min[0]);
const wind = `ветер ${windDirection(current.wind_direction_10m)}, ${current.wind_speed_10m} km/h`;

console.log(`${wmo.emoji} Weather — ${locationName}`);
console.log(`${wmo.desc} ${temp}°C (ощущается как ${feels}°C)`);
console.log(`${lo}°C ~ ${hi}°C | влажность ${current.relative_humidity_2m}% | ${wind}`);
