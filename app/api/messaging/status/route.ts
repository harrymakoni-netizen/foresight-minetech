// Delivery receipts. SMSGate sms:sent/delivered/failed may be registered here.
import { POST as smsWebhook } from "../sms/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = smsWebhook;
