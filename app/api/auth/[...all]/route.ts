import { getAuth } from "@/lib/server/auth";
import { ConfigurationError } from "@/lib/server/configuration";
export const runtime = "nodejs";
async function handler(request: Request) {
  try {
    return await (await getAuth()).handler(request);
  } catch (error) {
    if (error instanceof ConfigurationError)
      return Response.json(
        { code: error.code, message: error.message },
        { status: 503 },
      );
    console.error("Authentication startup failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json(
      {
        code: "AUTH_UNAVAILABLE",
        message: "Session service is temporarily unavailable. Please retry.",
      },
      { status: 503 },
    );
  }
}
export const GET = handler;
export const POST = handler;
