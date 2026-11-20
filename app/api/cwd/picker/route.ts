import { pickerCommand } from "@/lib/cwd-picker";
import { isLoopbackHost } from "@/lib/hosts/host-login";

// GET /api/cwd/picker → { available } — may this page open the server machine's folder dialog?
// Only a page opened on the machine itself: a remote browser has no desktop here.
export function GET(request: Request) {
  const loopback = isLoopbackHost(new URL(request.url).hostname);
  return Response.json({ available: loopback && pickerCommand() !== null });
}
