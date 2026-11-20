import { apiErrorResponse } from "@/lib/api-utils";
import { pickDirectory } from "@/lib/cwd-picker";
import { isLoopbackHost } from "@/lib/hosts/host-login";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";

// POST /api/cwd/pick  body: { hostId?: string } → { path } | { cancelled: true }
// Opens the OS folder dialog on this machine. A page opened from another machine has no desktop
// here, and another host's paths do not exist here either, so both cases are refused.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { hostId?: unknown };
    const hostId = typeof body.hostId === "string" && body.hostId ? body.hostId : LOCAL_HOST_ID;
    const picked = hostId === LOCAL_HOST_ID && isLoopbackHost(new URL(req.url).hostname) ? await pickDirectory() : null;
    if (!picked) {
      return Response.json({ error: "The folder dialog is only available on this machine", code: "picker_unavailable" }, { status: 501 });
    }
    return Response.json(picked);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
