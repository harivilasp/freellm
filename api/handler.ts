import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "../src/server.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const route = url.searchParams.get("__route");
  if (route) request.url = route;
  await handleRequest(request, response);
}
