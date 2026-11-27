// Rain forecast handling (spec §10). Pure: parses the documented Open-Meteo
// response (`hourly.time` + `hourly.precipitation`, requested with
// `timezone=UTC`) and summarises it. Nothing here fetches; the server polls.
import { z } from "zod";

export const weatherConfigSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    // Development defaults, NOT validated site values: set per mine.
    heavyRainMmPerHour: z.number().min(0.1).max(500),
    heavyRainMm24h: z.number().min(1).max(2000),
  })
  .strict();
export type WeatherConfig = z.infer<typeof weatherConfigSchema>;
export const developmentRainThresholds = { heavyRainMmPerHour: 10, heavyRainMm24h: 50 } as const;

export const OPEN_METEO_SOURCE = "Open-Meteo (open-meteo.com), free tier for non-commercial use";
/** Forecasts older than this are not used for concerns. */
export const FORECAST_FRESH_HOURS = 12;

export type ForecastHour = { time: string; mm: number | null };
export type ForecastSummary = {
  hours: ForecastHour[];
  /** Largest hourly precipitation over the 24 hourly values starting with the retrieval hour. */
  maxMmPerHour: number | null;
  peakAt: string | null;
  /** Sum of the next 24 hourly values from retrieval (missing hours counted as 0 and listed). */
  totalMm24h: number | null;
  missingHours: number;
};
const responseSchema = z.object({
  hourly: z.object({
    time: z.array(z.string().min(10)),
    precipitation: z.array(z.number().finite().nullable()),
  }),
});
/** Open-Meteo returns UTC times like "2026-11-26T12:00" when timezone=UTC. */
const asInstant = (t: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + (t.length === 16 ? ":00Z" : "Z"));
export function parseOpenMeteo(json: unknown, retrievedAt: string): ForecastSummary {
  const parsed = responseSchema.parse(json);
  if (parsed.hourly.time.length !== parsed.hourly.precipitation.length)
    throw new Error("Forecast response has mismatched time and precipitation lengths.");
  const hours: ForecastHour[] = parsed.hourly.time.map((t, i) => {
    const iso = new Date(asInstant(t)).toISOString();
    return { time: iso, mm: parsed.hourly.precipitation[i] };
  });
  // The 24 hourly values starting with the hour that contains the retrieval time.
  const start = Math.floor(Date.parse(retrievedAt) / 3600e3) * 3600e3;
  const window = hours.filter((h) => Date.parse(h.time) >= start && Date.parse(h.time) < start + 24 * 3600e3);
  if (!window.length) throw new Error("Forecast response has no hours in the next 24 hours.");
  const known = window.filter((h) => h.mm !== null) as { time: string; mm: number }[];
  const peak = known.reduce<{ time: string; mm: number } | null>((a, h) => (!a || h.mm > a.mm ? h : a), null);
  return {
    hours,
    maxMmPerHour: peak ? peak.mm : null,
    peakAt: peak ? peak.time : null,
    totalMm24h: known.length ? Number(known.reduce((s, h) => s + h.mm, 0).toFixed(2)) : null,
    missingHours: window.length - known.length,
  };
}
export const OPEN_METEO_DEFAULT_BASE = "https://api.open-meteo.com/v1/forecast";
/** `base` lets a paid deployment point at its commercial or self-hosted endpoint (OPEN_METEO_BASE_URL). */
export function openMeteoUrl(latitude: number, longitude: number, base = OPEN_METEO_DEFAULT_BASE) {
  const q = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: "precipitation",
    forecast_days: "2",
    timezone: "UTC",
  });
  return base + "?" + q.toString();
}
export function isHeavyRain(f: Pick<ForecastSummary, "maxMmPerHour" | "totalMm24h">, c: Pick<WeatherConfig, "heavyRainMmPerHour" | "heavyRainMm24h">) {
  const hourly = f.maxMmPerHour !== null && f.maxMmPerHour >= c.heavyRainMmPerHour;
  const daily = f.totalMm24h !== null && f.totalMm24h >= c.heavyRainMm24h;
  return { heavy: hourly || daily, hourly, daily };
}
export const forecastAgeHours = (retrievedAt: string, now: string) => (Date.parse(now) - Date.parse(retrievedAt)) / 3600e3;
