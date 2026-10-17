import type { Assessment, Concern, Entity, Fact, Role } from "./contracts.ts";
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
  for (const zoneId of ["zone-a", "zone-b", "zone-c"]) {
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
  return {
    cutoffAt,
    policyVersion: "development-controls-1",
    observationIds: accepted.map((o) => o.id),
    concerns,
    unknowns: [...unknowns],
    supersedes,
  };
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
    closed: ["open"],
  };
  if (!edges[from]?.includes(to)) throw new Error("Invalid case transition.");
  if (reason.trim().length < 3) throw new Error("A reason is required.");
  if (to === "closed" && !verificationIds.length)
    throw new Error("Closure requires reviewed verification evidence.");
}
