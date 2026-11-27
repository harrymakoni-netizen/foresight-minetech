// Mock SMSGate-compatible gateway for tests and phone-less demos (spec §6.6).
// It never sends an SMS. API shapes follow the official SMSGate client 4.4.0:
//   POST /messages {id, textMessage:{text}, phoneNumbers, withDeliveryReport}
//   GET  /messages/:id   GET /health
// Control endpoints (test only) drive webhooks back to Foresight:
//   POST /__control/deliver/:id  /__control/fail/:id  /__control/inbound {phoneNumber,message}
//   POST /__control/health {status, battery}  GET /__control/sent
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

export type MockGateway = { url: string; sent: any[]; server: Server; close: () => Promise<void> };
export async function startMockGateway(opts: { port?: number; webhookUrl?: string; username?: string; password?: string } = {}): Promise<MockGateway> {
  const sent: any[] = [];
  let health = { status: "pass", battery: 80 };
  const auth = "Basic " + Buffer.from(`${opts.username || "mock"}:${opts.password || "mock-password"}`).toString("base64");
  const hook = async (event: string, payload: unknown) => {
    if (!opts.webhookUrl) return;
    await fetch(opts.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: randomUUID(), event, deviceId: "mock-device", payload }) });
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {};
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url || "/", "http://mock");
    if (url.pathname.startsWith("/__control/")) {
      const [, , action, id] = url.pathname.split("/");
      const msg = sent.find((m) => m.id === id);
      if (action === "sent") return send(200, sent);
      if (action === "health") { health = { ...health, ...body }; return send(200, health); }
      if (action === "deliver" && msg) { msg.state = "Delivered"; await hook("sms:delivered", { messageId: msg.id, phoneNumber: msg.phoneNumbers[0], deliveredAt: new Date().toISOString() }); return send(200, msg); }
      if (action === "fail" && msg) { msg.state = "Failed"; await hook("sms:failed", { messageId: msg.id, phoneNumber: msg.phoneNumbers[0], reason: body.reason || "Mock failure", failedAt: new Date().toISOString() }); return send(200, msg); }
      if (action === "inbound") { const id2 = randomUUID(); await hook("sms:received", { messageId: id2, phoneNumber: body.phoneNumber, sender: body.phoneNumber, message: body.message, receivedAt: new Date().toISOString() }); return send(200, { id: id2 }); }
      return send(404, { error: "unknown control" });
    }
    if (req.headers.authorization !== auth) return send(401, { message: "Unauthorized" });
    if (req.method === "GET" && url.pathname === "/health") {
      if (health.status === "offline") { res.destroy(); return; }
      return send(200, { status: health.status, version: "mock", checks: { "battery:level": { status: health.battery < 10 ? "warn" : "pass", observedValue: health.battery, observedUnit: "percent" } } });
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      if (!Array.isArray(body.phoneNumbers) || !body.textMessage?.text) return send(400, { message: "Invalid message" });
      const message = { id: body.id || randomUUID(), state: "Pending", phoneNumbers: body.phoneNumbers, text: body.textMessage.text, recipients: body.phoneNumbers.map((p: string) => ({ phoneNumber: p, state: "Pending" })) };
      sent.push(message);
      return send(202, { id: message.id, state: "Pending", recipients: message.recipients });
    }
    const m = url.pathname.match(/^\/messages\/(.+)$/);
    if (req.method === "GET" && m) { const msg = sent.find((x) => x.id === m[1]); return msg ? send(200, msg) : send(404, { message: "Not found" }); }
    send(404, { message: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(opts.port || 0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, sent, server, close: () => new Promise((r) => server.close(() => r())) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const g = await startMockGateway({ port: Number(process.env.MOCK_GATEWAY_PORT || 8300), webhookUrl: process.env.MOCK_GATEWAY_WEBHOOK_URL, username: process.env.SMSGATE_USERNAME, password: process.env.SMSGATE_PASSWORD });
  console.log(`Mock SMS gateway (sends nothing) at ${g.url}; webhooks → ${process.env.MOCK_GATEWAY_WEBHOOK_URL || "(none)"}`);
}
