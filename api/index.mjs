import { handle } from "../server.mjs";

export default async function vercelHandler(request, response) {
  const incoming = new URL(request.url || "/api", "http://localhost");
  const forwardedPath = incoming.searchParams.get("__path");
  if (forwardedPath !== null) {
    incoming.searchParams.delete("__path");
    const query = incoming.searchParams.toString();
    request.url = `/api/${forwardedPath}${query ? `?${query}` : ""}`;
  }
  return handle(request, response);
}
