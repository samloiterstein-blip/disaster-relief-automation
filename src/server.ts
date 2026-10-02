import { createServer, type Server } from "node:http";
import type { Scheduler } from "./scheduler.ts";
import type { Store } from "./store.ts";

export function startServer(port: number, store: Store, scheduler: Scheduler): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };

    if (url.pathname === "/health") {
      const sources = [...scheduler.health.values()];
      const unhealthy = sources.filter((s) => !s.healthy);
      const federalOk = sources.some((s) => s.id.startsWith("openfema") && s.healthy);
      return send(federalOk ? 200 : 503, { ok: federalOk, unhealthyCount: unhealthy.length, sources });
    }
    if (url.pathname === "/events") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
      return send(200, store.latestEvents(limit).map(({ tokens: _tokens, ...e }) => e));
    }
    if (url.pathname === "/") {
      return send(200, { service: "disaster-declaration-watch", endpoints: ["/health", "/events?limit=50"] });
    }
    send(404, { error: "not found" });
  });
  server.listen(port, () => console.log(`[http] listening on :${port} (/health, /events)`));
  return server;
}
