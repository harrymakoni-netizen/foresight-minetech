import { z } from "zod";
import { publishedModel } from "./mine-model.ts";
import { atomic, DomainError, get, hash, idempotent, insert, list, update, type Context } from "./repository.ts";

const code = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const source = z.enum(["physical", "demo"]);
const device = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("receiver"), code, source, zoneId: code }).strict(),
  z.object({ kind: z.literal("wearable"), code, source, personId: z.string().uuid() }).strict(),
]);
const packet = z.object({
  mineId: z.string().uuid(),
  eventId: code,
  receiverId: code,
  deviceId: code.optional(),
  type: z.enum(["heartbeat", "observation", "sos"]),
  observedAt: z.string().datetime({ offset: true }),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  rssi: z.number().int().min(-127).max(0).optional(),
  batteryPercent: z.number().min(0).max(100).optional(),
}).strict().refine((p) => (p.type === "heartbeat") === (p.deviceId === undefined), "Supply a wearable for observations and SOS only.");

function requireOperator(ctx: Context) {
  if (!["supervisor", "administrator"].includes(ctx.role))
    throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator is required.");
}

export async function provisionPersonnelDevice(ctx: Context, input: unknown) {
  requireOperator(ctx);
  const body = device.parse(input);
  if (body.source === "demo") await requireDemoMine(ctx);
  if (body.kind === "wearable") await get(ctx, body.personId, "person");
  const devices = await list(ctx, "personnel-device");
  if (devices.some(({ data }) => data.source === body.source &&
    (data.code === body.code || (body.kind === "wearable" && data.personId === body.personId))))
    throw new DomainError(409, "DEVICE_EXISTS", "This device or person already has an assignment for this source.");
  return insert(ctx, "personnel-device", body, body.kind === "receiver" ? body.zoneId : null,
    body.kind === "wearable" ? [{ id: body.personId, relation: "person" }] : []);
}

async function requireDemoMine(ctx: Context) {
  if (process.env.FORESIGHT_PERSONNEL_DEMO !== "1" ||
    ((await publishedModel(ctx))?.data.model as { meta?: { fictional?: boolean } } | undefined)?.meta?.fictional !== true)
    throw new DomainError(403, "DEMO_DISABLED", "Demo telemetry requires an enabled fictional mine.");
}

export async function ingestPersonnel(ctx: Context, input: unknown, origin: z.infer<typeof source>, receipt = new Date()) {
  if (origin === "demo") {
    requireOperator(ctx);
    await requireDemoMine(ctx);
  }
  const event = packet.parse(input);
  if (event.mineId !== ctx.workspaceId)
    throw new DomainError(403, "MINE_SCOPE", "The gateway is scoped to a different mine.");
  const observed = Date.parse(event.observedAt);
  const receivedAt = receipt.toISOString();
  if (observed > receipt.getTime() + 30_000)
    throw new DomainError(422, "CLOCK_SKEW", "Observation time is ahead of the server clock.");
  return idempotent(ctx, `telemetry_${hash([origin, event.receiverId, event.eventId])}`, event, async () => {
    const devices = (await list(ctx, "personnel-device")).filter((d) => d.data.source === origin);
    const receiver = devices.find((d) => d.data.kind === "receiver" && d.data.code === event.receiverId);
    const wearable = devices.find((d) => d.data.kind === "wearable" && d.data.code === event.deviceId);
    if (!receiver || (event.type !== "heartbeat" && !wearable))
      throw new DomainError(422, "UNKNOWN_DEVICE", "Provision the receiver and wearable for this source first.");
    const newer = (data: Record<string, unknown>) => {
      const previous = Date.parse(String(data.observedAt));
      return !Number.isFinite(previous) || observed > previous ||
        (observed === previous && event.receiverId === data.receiverId && event.sequence > Number(data.sequence));
    };
    const stamp = { observedAt: new Date(observed).toISOString(), receivedAt, sequence: event.sequence, receiverId: event.receiverId };
    const applied = newer((wearable ?? receiver).data);
    if (newer(receiver.data)) await update(ctx, receiver, receiver.revision, { ...receiver.data, ...stamp });
    if (wearable && applied) await update(ctx, wearable, wearable.revision, { ...wearable.data, ...stamp,
      lastZoneId: receiver.zoneId, rssi: event.rssi ?? null, batteryPercent: event.batteryPercent ?? null });
    // A late SOS is still evidence. It must not move the tag backwards.
    if (wearable && event.type === "sos") {
      const duplicate = (await list(ctx, "personnel-alert")).some(({ data }) =>
        data.source === origin && data.deviceId === event.deviceId && data.eventId === event.eventId);
      if (!duplicate) await insert(ctx, "personnel-alert", {
        source: origin, status: "open", zoneId: receiver.zoneId, personId: wearable.data.personId,
        deviceId: event.deviceId, ...stamp, eventId: event.eventId,
      }, null, [{ id: wearable.id, relation: "wearable" }]);
    }
    return { applied, receivedAt };
  }, { category: "personnel-telemetry", maximum: 20_000 });
}

export async function acknowledgePersonnelAlert(ctx: Context, id: string) {
  requireOperator(ctx);
  return atomic(async () => {
    const alert = await get(ctx, id, "personnel-alert");
    if (alert.data.acknowledgedAt) return alert;
    return update(ctx, alert, alert.revision, {
      ...alert.data, acknowledgedAt: new Date().toISOString(), acknowledgedBy: ctx.actor,
    });
  });
}
