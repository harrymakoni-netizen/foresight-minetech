import { z } from "zod";
import { instant, zoneId } from "./contracts.ts";
export const ENGINE_VERSION = "lumped-water-1.0.0";
const id = z.string().min(1).max(100),
  nonnegative = z.number().finite().min(0).max(1e9);
const geometry = z
  .array(
    z
      .object({
        volumeM3: nonnegative,
        levelM: z.number().finite().min(-10000).max(10000),
      })
      .strict(),
  )
  .min(2)
  .max(100);
const event = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("inflow"),
      atSeconds: nonnegative,
      nodeId: id,
      rateM3s: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("pump_availability"),
      atSeconds: nonnegative,
      pumpId: id,
      available: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("pump_capacity"),
      atSeconds: nonnegative,
      pumpId: id,
      capacityM3s: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("route_availability"),
      atSeconds: nonnegative,
      edgeId: id,
      available: z.boolean(),
    })
    .strict(),
]);
export const scenarioSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    workspaceId: id,
    baselineSnapshotId: id,
    modelId: z.literal("lumped-water-v1"),
    modelVersion: z.literal(ENGINE_VERSION),
    timeOrigin: instant,
    horizonSeconds: z.number().min(1).max(86400),
    outputIntervalSeconds: z.number().min(1).max(86400),
    maxStepSeconds: z.number().min(0.05).max(30),
    seed: z.number().int().min(0).max(4294967295),
    units: z
      .object({
        volume: z.literal("m3"),
        level: z.literal("m"),
        time: z.literal("s"),
        flow: z.literal("m3/s"),
      })
      .strict(),
    nodes: z
      .array(
        z
          .object({
            id,
            zoneId,
            geometry,
            initialVolumeM3: nonnegative,
            inflowM3s: z.number().min(0).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    pumps: z
      .array(
        z
          .object({
            id,
            nodeId: id,
            capacityM3s: z.number().min(0).max(100),
            available: z.boolean(),
            startLevelM: z.number().finite().nullable(),
            stopLevelM: z.number().finite().nullable(),
          })
          .strict(),
      )
      .max(6),
    transfers: z
      .array(
        z
          .object({
            id,
            from: id,
            to: id,
            capacityM3s: z.number().min(0).max(100),
            assumption: z.string().min(3).max(1000),
          })
          .strict(),
      )
      .max(12),
    events: z.array(event).max(200),
    thresholds: z
      .array(
        z
          .object({
            id,
            nodeId: id,
            levelM: z.number().finite(),
            edgeIds: z.array(id).max(80),
            label: z.string().max(200),
            source: z.string().min(3).max(1000),
          })
          .strict(),
      )
      .max(50),
    routeGraph: z
      .object({
        version: id,
        nodes: z
          .array(z.object({ id, zoneId: zoneId.nullable() }).strict())
          .max(50),
        edges: z
          .array(
            z
              .object({
                id,
                from: id,
                to: id,
                zoneId,
                lengthM: z.number().min(0.01).max(100000),
                speedMps: z.number().min(0.05).max(5),
                delaySeconds: z.number().min(0).max(86400),
                availability: z.enum(["available", "blocked", "unknown"]),
                bidirectional: z.boolean(),
                source: z.string().min(3).max(1000),
              })
              .strict(),
          )
          .max(80),
      })
      .strict(),
    movements: z
      .array(
        z
          .object({
            id,
            startNodes: z.array(id).min(1).max(50),
            targetNode: id,
            departureSeconds: nonnegative,
            responseDelaySeconds: nonnegative,
            assumption: z.string().min(3).max(1000),
          })
          .strict(),
      )
      .max(50),
    provenance: z
      .array(
        z
          .object({
            id,
            source: z.string().min(3).max(1000),
            quality: z.enum(["assumed", "measured", "stale", "unverified"]),
            originalUnit: z.enum(["m3", "m3/h", "m3/s", "m"]),
            checkedAt: instant.nullable(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();
export type Scenario = z.infer<typeof scenarioSchema>;
export type SimulationResult = {
  status: string;
  engineVersion: string;
  inputHash: string;
  series: {
    atSeconds: number;
    nodes: Record<
      string,
      {
        volumeM3: number;
        levelM: number;
        pumpDischargeM3s: number;
        cumulativeDischargeM3: number;
        cumulativeOverflowM3: number;
      }
    >;
    cumulativeInflowM3: number;
    cumulativeDischargeM3: number;
    cumulativeOverflowM3: number;
  }[];
  thresholds: {
    id: string;
    label: string;
    firstCrossingSeconds: number | null;
    censored: boolean;
    crossings: { atSeconds: number; direction: string }[];
  }[];
  summary: {
    initialStorageM3: number;
    finalStorageM3: number;
    externalInflowM3: number;
    externalDischargeM3: number;
    overflowM3: number;
    peakVolumeM3: Record<string, number>;
  };
  diagnostics: {
    conservationResidualM3: number;
    relativeResidual: number;
    internalSteps: number;
    durationMs: number;
    maxStepSeconds: number;
    thresholdTimePrecisionSeconds: number;
  };
  warnings: string[];
  routes: {
    movements: {
      id: string;
      assumption: string;
      positionStatus: string;
      allStartingNodesFeasible: boolean;
      alternatives: {
        startingNode: string;
        status: string;
        departureSeconds: number;
        arrivalSeconds?: number;
        travelSeconds?: number;
        edgeSequence?: string[];
      }[];
    }[];
    blockedIntervals: Record<
      string,
      { fromSeconds: number; toSeconds: number }[]
    >;
    method: string;
  };
};
export function fictionalScenario(
  workspaceId: string,
  baselineSnapshotId: string,
  timeOrigin: string,
): Scenario {
  return {
    schemaVersion: "1.0",
    workspaceId,
    baselineSnapshotId,
    modelId: "lumped-water-v1",
    modelVersion: ENGINE_VERSION,
    timeOrigin,
    horizonSeconds: 21600,
    outputIntervalSeconds: 60,
    maxStepSeconds: 10,
    seed: 42,
    units: { volume: "m3", level: "m", time: "s", flow: "m3/s" },
    nodes: [
      {
        id: "S1",
        zoneId: "zone-b",
        geometry: [
          { volumeM3: 0, levelM: 0 },
          { volumeM3: 150, levelM: 5 },
        ],
        initialVolumeM3: 30,
        inflowM3s: 18 / 3600,
      },
    ],
    pumps: [
      {
        id: "P1",
        nodeId: "S1",
        capacityM3s: 12 / 3600,
        available: true,
        startLevelM: null,
        stopLevelM: null,
      },
      {
        id: "P2",
        nodeId: "S1",
        capacityM3s: 12 / 3600,
        available: false,
        startLevelM: null,
        stopLevelM: null,
      },
    ],
    transfers: [],
    events: [
      {
        type: "pump_availability",
        atSeconds: 3600,
        pumpId: "P2",
        available: true,
      },
    ],
    thresholds: [
      {
        id: "east-route-water",
        nodeId: "S1",
        levelM: 3,
        edgeIds: ["east-direct"],
        label: "Assumed east route water threshold",
        source: "Fictional laboratory assumption; not a safe-depth policy",
      },
    ],
    routeGraph: {
      version: "conceptual-1",
      nodes: [
        { id: "east", zoneId: "zone-b" },
        { id: "junction", zoneId: "zone-a" },
        { id: "south", zoneId: "zone-c" },
        { id: "muster", zoneId: null },
      ],
      edges: [
        {
          id: "east-direct",
          from: "east",
          to: "junction",
          zoneId: "zone-b",
          lengthM: 300,
          speedMps: 1,
          delaySeconds: 0,
          availability: "available",
          bidirectional: true,
          source: "Manually drawn fictional training graph",
        },
        {
          id: "east-south",
          from: "east",
          to: "south",
          zoneId: "zone-b",
          lengthM: 500,
          speedMps: 1,
          delaySeconds: 0,
          availability: "available",
          bidirectional: true,
          source: "Manually drawn fictional training graph",
        },
        {
          id: "south-junction",
          from: "south",
          to: "junction",
          zoneId: "zone-c",
          lengthM: 350,
          speedMps: 1,
          delaySeconds: 0,
          availability: "available",
          bidirectional: true,
          source: "Manually drawn fictional training graph",
        },
        {
          id: "exit",
          from: "junction",
          to: "muster",
          zoneId: "zone-a",
          lengthM: 200,
          speedMps: 1,
          delaySeconds: 0,
          availability: "available",
          bidirectional: true,
          source: "Manually drawn fictional training graph",
        },
      ],
    },
    movements: [
      {
        id: "east-crew-assumption",
        startNodes: ["east"],
        targetNode: "muster",
        departureSeconds: 3600,
        responseDelaySeconds: 300,
        assumption:
          "Fictional crew assumed at east node; assignment is not a live location; no queues",
      },
    ],
    provenance: ["S1", "P1", "P2"].map((id) => ({
      id,
      source:
        "Owner-editable fictional laboratory parameters; no physical measurement",
      quality: "assumed",
      originalUnit: "m3/h",
      checkedAt: null,
    })),
  };
}

/** Explicitly fictional pump-failure exercise; never inferred from a report. */
export function pumpFailureDemonstration(
  base: Scenario,
  backupHour: number,
): Scenario {
  const s = fictionalScenario(
    base.workspaceId,
    base.baselineSnapshotId,
    base.timeOrigin,
  );
  s.pumps[1].capacityM3s = 24 / 3600;
  s.events = [
    {
      type: "pump_availability",
      atSeconds: 3600,
      pumpId: "P1",
      available: false,
    },
    {
      type: "pump_availability",
      atSeconds: backupHour * 3600,
      pumpId: "P2",
      available: true,
    },
  ];
  s.thresholds[0].levelM = 2;
  s.thresholds[0].label = "Reviewed fictional direct-route limit: 2 m";
  s.thresholds[0].source =
    "Reviewed for this fictional exercise only; not an operational water-depth limit";
  s.movements[0].departureSeconds = 2 * 3600 + 18 * 60;
  s.movements[0].responseDelaySeconds = 0;
  s.movements[0].assumption =
    "Assumed crew at east, departing at 2 h 18 min at 1 m/s with zero response delay; direct edge takes 5 min, alternative route 17 min 30 s. Calculated arrival is not human muster.";
  s.provenance = [
    {
      id: "S1",
      source:
        "Fictional: initial 30 m³; inflow 18 m³/h; linear storage area 30 m²; capacity 150 m³",
      quality: "assumed",
      originalUnit: "m3/h",
      checkedAt: null,
    },
    {
      id: "P1",
      source:
        "Fictional: primary 12 m³/h fails at exactly 1 h; failure time is not extracted from a report",
      quality: "assumed",
      originalUnit: "m3/h",
      checkedAt: null,
    },
    {
      id: "P2",
      source: `Fictional: backup 24 m³/h activates at ${backupHour} h`,
      quality: "assumed",
      originalUnit: "m3/h",
      checkedAt: null,
    },
  ];
  return scenarioSchema.parse(s);
}
