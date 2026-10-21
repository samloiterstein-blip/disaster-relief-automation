import pg from "pg";
import { config } from "./config.ts";

/** Prefer the dashboard recipient list when DATABASE_URL is set. Env DIGEST_TO / DIGEST_CC stay the fallback. */
export async function applyDashboardRecipients(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim().replace(/^"|"$/g, "");
  if (!url) return;

  const client = new pg.Client({
    connectionString: url.replace("sslmode=require", "sslmode=verify-full"),
    connectionTimeoutMillis: 20_000,
  });
  try {
    await client.connect();
    const { rows } = await client.query<{ email: string; kind: "to" | "cc" }>(
      "select email, kind from recipients order by kind, lower(email)",
    );
    const to = rows.filter((row) => row.kind === "to").map((row) => row.email);
    const cc = rows.filter((row) => row.kind === "cc").map((row) => row.email);
    if (to.length) config.digest.to = to;
    if (cc.length) config.digest.cc = cc;
    console.log(`[daily] using ${to.length} direct and ${cc.length} CC recipient(s) from the dashboard`);
  } catch (error) {
    console.error(
      `[daily] dashboard recipients unavailable, using DIGEST_TO / DIGEST_CC. ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
