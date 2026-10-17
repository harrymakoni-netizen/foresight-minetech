import { getAuth } from "@/lib/server/auth";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return (await getAuth()).handler(request);
}
export async function POST(request: Request) {
  return (await getAuth()).handler(request);
}
