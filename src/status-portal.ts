type PortalStatus = "succeeded" | "degraded" | "failed";

export interface PortalLog {
  logged_at?: string;
  level: "info" | "warn" | "error";
  message: string;
}

/** Posts one watch run to the Chamber status portal. Reporting trouble never changes the watch result. */
export async function reportWatchRun(input: {
  externalId: string;
  status: PortalStatus;
  startedAt: string;
  finishedAt?: string;
  summary: string;
  logs?: PortalLog[];
  html?: string;
}): Promise<void> {
  const base = process.env.STATUS_PORTAL_URL?.trim();
  const token = process.env.STATUS_INGEST_TOKEN?.trim();
  if (!base || !token) {
    console.log("[status] STATUS_PORTAL_URL or STATUS_INGEST_TOKEN is unset, so this run was not sent to the portal.");
    return;
  }

  const html = input.html && input.html.length > 0 && input.html.length <= 1_000_000 ? input.html : undefined;
  try {
    const response = await fetch(new URL("/api/ingest", base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        external_id: input.externalId,
        status: input.status,
        started_at: input.startedAt,
        finished_at: input.finishedAt ?? new Date().toISOString(),
        summary: input.summary.slice(0, 4000),
        logs: (input.logs ?? []).slice(0, 500).map((line) => ({
          logged_at: line.logged_at,
          level: line.level,
          message: line.message.slice(0, 8000),
        })),
        html,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[status] portal rejected the run (${response.status}): ${text.slice(0, 300)}`);
    }
  } catch (error) {
    console.error(`[status] could not reach the portal: ${error instanceof Error ? error.message : error}`);
  }
}
