import type { Assessment, Concern, Entity, Fact, Role } from "./contracts.ts";
import { FORECAST_FRESH_HOURS, forecastAgeHours, isHeavyRain, type ForecastSummary, type WeatherConfig } from "./weather.ts";
import type { PreEntryRecord } from "./precheck.ts";

/** Extra inputs for policy development-controls-2 (spec §10). */
export type AssessContext = {
  /** People declared underground right now, by zone id. */
  declaredByZone: Record<string, number>;
  shafts: { id: string; name: string; zoneIds: string[] }[];
  forecast: { id: string; retrievedAt: string; summary: ForecastSummary } | null;
  weather: WeatherConfig | null;
  preEntry: PreEntryRecord[];
  subsidence: { id: string; zoneId: string; markedAt: string; note: string }[];
  /** Development defaults; not validated site values. */
  urgentPeopleThreshold: number;
  repeatedNoWindowDays: number;
  newMarkDays: number;
};
export const developmentContextDefaults = { urgentPeopleThreshold: 3, repeatedNoWindowDays: 7, newMarkDays: 7 } as const;
const SUPPORT_OR_SHAFT = /support|shaft|ladder|hoist|headgear|headframe|roof|rock|bolt|cage|winder/i;
export function can(
  role: Role,
  operation: "read" | "submit" | "review" | "close" | "admin",
) {
  return {
    read: ["viewer", "reporter", "supervisor", "administrator"],
    submit: ["reporter", "supervisor", "administrator"],
    review: ["supervisor", "administrator"],
    close: ["supervisor", "administrator"],
    admin: ["administrator"],
  }[operation].includes(role);
}
export function assess(
  observations: Entity[],
  cutoffAt: string,
  supersedes: string | null,
  extra?: AssessContext,
): Assessment {
  const candidates = observations.filter(
    (o) =>
      o.kind === "observation" &&
      o.data.quality === "accepted" &&
      Date.parse(o.createdAt) <= Date.parse(cutoffAt) &&
      (!o.data.observedAt ||
        Date.parse(String(o.data.observedAt)) <= Date.parse(cutoffAt)),
  );
  const corrected = new Set(
    candidates.flatMap(
      (o) => (o.data.correctionOfObservationIds || []) as string[],
    ),
  );
  const accepted = candidates.filter((o) => !corrected.has(o.id));
  const concerns: Concern[] = [],
    unknowns = new Set<string>([
      "Continuous sensor coverage unavailable.",
      "Site-specific control policy and physical measurements need review.",
    ]);
  for (const o of accepted) {
    const f = o.data as unknown as Fact;
    if (!f.observedAt)
      unknowns.add(
        `${o.id}: observation time is unknown; submission time is not a measurement time.`,
      );
    const stale =
      !!f.observedAt &&
      Date.parse(cutoffAt) - Date.parse(f.observedAt) > 24 * 3600e3;
    if (stale) {
      unknowns.add(
        `${o.id}: observation is stale (development freshness window 24 hours).`,
      );
      if (!f.serious) continue;
    }
    if (f.polarity !== "affirmed" || f.action === "proposed") continue;
    if (!f.zoneId) {
      unknowns.add(`${o.id}: zone needs review.`);
      continue;
    }
    const relevant =
      f.serious ||
      ["water", "drainage", "restricted-entry", "ppe", "inspection"].includes(
        f.category,
      );
    if (!relevant) continue;
    const failed =
      /fail|stop|rising|rise|missing|restrict|overdue|defer|unverified|ingress|flood|overflow/i.test(
        f.condition,
      ) || f.serious;
    if (!failed) continue;
    concerns.push({
      id: `concern-${o.id}`,
      zoneId: f.zoneId,
      title: `${f.category === "drainage" ? "Drainage control" : f.category} needs review`,
      reason: f.condition,
      observationIds: [o.id],
      controlState: stale
        ? "stale"
        : f.category === "inspection"
          ? "unverified"
          : "reported-failed",
      priority: f.serious ? "urgent-review" : "review",
    });
  }
  // Water and pump reports belong to one physical evidence group; neither is counted as an independent compound trigger.
  for (const zoneId of new Set(["zone-a", "zone-b", "zone-c", ...concerns.map((c) => c.zoneId)])) {
    const physical = concerns.filter(
      (c) =>
        c.zoneId === zoneId &&
        accepted.some(
          (o) =>
            c.observationIds.includes(o.id) &&
            ["water", "drainage"].includes(String(o.data.category)),
        ),
    );
    const inspection = concerns.filter(
      (c) => c.zoneId === zoneId && c.controlState === "unverified",
    );
    if (physical.length && inspection.length)
      concerns.push({
        id: `compound-${zoneId}`,
        zoneId,
        title: "Drainage concern with unverified inspection",
        reason:
          "Independent physical reports and an unverified inspection require a coordinated review.",
        observationIds: [...physical, ...inspection].flatMap(
          (c) => c.observationIds,
        ),
        controlState: "unverified",
        priority: "urgent-review",
      });
  }
  if (extra) applyControls2(concerns, unknowns, accepted, cutoffAt, extra);
  return {
    cutoffAt,
    policyVersion: extra ? "development-controls-2" : "development-controls-1",
    observationIds: accepted.map((o) => o.id),
    concerns,
    unknowns: [...unknowns],
    supersedes,
  };
}
/** development-controls-2 additions. Mutates the concern and unknown lists. */
function applyControls2(concerns: Concern[], unknowns: Set<string>, accepted: Entity[], cutoffAt: string, x: AssessContext) {
  for (const c of concerns) c.rules = [c.id.startsWith("compound-") ? "physical-condition+unverified-control" : "supervisor-accepted-observation"];
  const zoneOf = (shaftId: string) => x.shafts.find((s) => s.id === shaftId)?.zoneIds[0] ?? "all";
  const peopleIn = (zoneId: string) => (zoneId === "all" ? Object.values(x.declaredByZone).reduce((a, b) => a + b, 0) : x.declaredByZone[zoneId] || 0);
  // 1. Rain forecast. Only a fresh forecast is used; its absence is stated.
  if (!x.weather) unknowns.add("Rain forecast not used: no mine location is configured.");
  else if (!x.forecast) unknowns.add("Rain forecast not used: none has been retrieved yet.");
  else if (forecastAgeHours(x.forecast.retrievedAt, cutoffAt) > FORECAST_FRESH_HOURS)
    unknowns.add(`Rain forecast not used: the latest was retrieved more than ${FORECAST_FRESH_HOURS} hours ago (${x.forecast.retrievedAt}).`);
  else {
    const rain = isHeavyRain(x.forecast.summary, x.weather);
    if (rain.heavy) {
      const f = x.forecast.summary;
      const detail = `peak ${f.maxMmPerHour ?? "unknown"} mm/h${f.peakAt ? ` at ${f.peakAt}` : ""}, ${f.totalMm24h ?? "unknown"} mm over the next 24 h (thresholds ${x.weather.heavyRainMmPerHour} mm/h or ${x.weather.heavyRainMm24h} mm; development defaults unless set by the mine)`;
      const evidence = [{ id: x.forecast.id, kind: "forecast", summary: `Open-Meteo forecast retrieved ${x.forecast.retrievedAt}: ${detail}` }];
      const withInspection = new Map<string, Concern[]>();
      for (const c of concerns) {
        if (c.controlState !== "unverified") continue;
        const text = accepted.filter((o) => c.observationIds.includes(o.id)).map((o) => `${o.data.condition} ${o.data.assetId ?? ""}`).join(" ");
        if (!SUPPORT_OR_SHAFT.test(text)) continue;
        withInspection.set(c.zoneId, [...(withInspection.get(c.zoneId) || []), c]);
      }
      for (const [zoneId, list] of withInspection)
        concerns.push({
          id: `rain-compound-${zoneId}`,
          zoneId,
          title: "Heavy rain forecast with overdue support or shaft inspection",
          reason: `Heavy rain is forecast (${detail}) while a support or shaft inspection in this zone is unverified or overdue.`,
          observationIds: list.flatMap((c) => c.observationIds),
          controlState: "unverified",
          priority: "urgent-review",
          rules: ["rain-forecast", "overdue-support-or-shaft-inspection"],
          evidence,
        });
      concerns.push({
        id: "rain-advisory",
        zoneId: "all",
        title: "Heavy rain forecast",
        reason: `Heavy rain is forecast (${detail}). An authorised user may send a do-not-enter advisory; nothing is sent automatically.`,
        observationIds: [],
        controlState: "forecast",
        priority: "advisory",
        rules: ["rain-forecast"],
        evidence,
      });
    }
  }
  // 2. Pre-entry checks: a "no" raises a concern for that shaft; repeated "no" escalates.
  const fresh = x.preEntry.filter((r) => Date.parse(r.at) <= Date.parse(cutoffAt) && Date.parse(cutoffAt) - Date.parse(r.at) <= 24 * 3600e3);
  for (const shaft of x.shafts) {
    const checks = fresh.filter((r) => r.shaftId === shaft.id).sort((a, b) => b.at.localeCompare(a.at));
    const latest = checks[0];
    if (!latest) continue;
    const failed = latest.answers.filter((a) => a.answer === "no");
    if (!failed.length) continue;
    const windowStart = Date.parse(cutoffAt) - x.repeatedNoWindowDays * 86400e3;
    const history = x.preEntry.filter((r) => r.shaftId === shaft.id && Date.parse(r.at) >= windowStart && Date.parse(r.at) <= Date.parse(cutoffAt));
    const repeated = failed.filter((a) => history.filter((r) => r.answers.some((b) => b.key === a.key && b.answer === "no")).length >= 2);
    const zoneId = zoneOf(shaft.id);
    concerns.push({
      id: `precheck-${latest.id}`,
      zoneId,
      shaftId: shaft.id,
      title: `Pre-entry check failed at ${shaft.name}`,
      reason: `Answered no: ${failed.map((a) => a.text).join(" ")}${repeated.length ? ` Repeated no in the last ${x.repeatedNoWindowDays} days: ${repeated.map((a) => a.key).join(", ")}.` : ""}`,
      observationIds: [],
      controlState: "reported-failed",
      priority: repeated.length ? "urgent-review" : "review",
      rules: [repeated.length ? "pre-entry-repeated-no" : "pre-entry-no"],
      evidence: checks.slice(0, 3).map((r) => ({ id: r.id, kind: "pre-entry-check", summary: `${r.at}: ${r.answers.filter((a) => a.answer === "no").length} no of ${r.answers.length}, by ${r.by}` })),
    });
  }
  // 3. Subsidence marks (recorded by surveyors): a new mark near a zone is a concern for review.
  for (const m of x.subsidence) {
    const age = (Date.parse(cutoffAt) - Date.parse(m.markedAt)) / 86400e3;
    if (age < 0 || age > x.newMarkDays) continue;
    concerns.push({
      id: `subsidence-${m.id}`,
      zoneId: m.zoneId,
      title: "New subsidence mark",
      reason: `A subsidence mark was recorded on ${m.markedAt}: ${m.note || "no note"}. A surveyor or engineer should review it.`,
      observationIds: [],
      controlState: "reported-failed",
      priority: "review",
      rules: ["subsidence-mark"],
      evidence: [{ id: m.id, kind: "subsidence-mark", summary: `${m.markedAt}: ${m.note || "no note"}` }],
    });
  }
  // 4. People at risk: priority rises with people declared underground in the zone now.
  for (const c of concerns) {
    const n = peopleIn(c.zoneId);
    c.peopleAtRisk = n;
    if (n > 0 && c.priority === "review" && n >= x.urgentPeopleThreshold) {
      c.priority = "urgent-review";
      c.rules = [...(c.rules || []), "people-at-risk"];
      c.reason += ` Raised to urgent because ${n} people are declared underground in ${c.zoneId === "all" ? "the mine" : "this zone"} now (threshold ${x.urgentPeopleThreshold}).`;
    }
  }
}
export function validTransition(
  from: string,
  to: string,
  reason: string,
  verificationIds: string[],
) {
  const edges: Record<string, string[]> = {
    open: ["acknowledged"],
    acknowledged: ["action-in-progress", "awaiting-verification"],
    "action-in-progress": ["awaiting-verification"],
    "awaiting-verification": ["action-in-progress", "closed"],
    // "open" is kept for records reopened before the register merge.
    closed: ["reopened", "open"],
    reopened: ["acknowledged", "action-in-progress"],
  };
  if (!edges[from]?.includes(to)) throw new Error("Invalid case transition.");
  if (reason.trim().length < 3) throw new Error("A reason is required.");
  if (to === "closed" && !verificationIds.length)
    throw new Error("Closure requires reviewed verification evidence.");
}
