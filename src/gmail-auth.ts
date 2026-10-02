import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { config } from "./config.ts";

/** Must be listed under the OAuth client's authorized redirect URIs (or the client must be a Desktop app). */
const PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth/callback`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "openid", "email"];

function setEnv(key: string, value: string, file = ".env"): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * One-time browser consent that stores a Gmail refresh token in .env. Asks only to send mail
 * and to read the account's address, which becomes DIGEST_FROM when that isn't set.
 */
export async function authorizeGmail(): Promise<string> {
  const { clientId, clientSecret } = config.gmail;
  if (!clientId || !clientSecret) throw new Error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.");
  const state = randomBytes(24).toString("hex");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES.join(" "),
    state,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT_URI);
      if (u.pathname !== "/oauth/callback") return void res.writeHead(404).end();
      const error = u.searchParams.get("error");
      const got = u.searchParams.get("code");
      const ok = !error && got && u.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" }).end(ok ? "Gmail authorized. You can close this tab." : `Authorization failed: ${error ?? "state mismatch"}`);
      server.close();
      if (ok) resolve(got);
      else reject(new Error(`Google authorization failed: ${error ?? "state mismatch"}`));
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Opening Google sign-in in your browser. If it doesn't open, visit:\n${url}\n`);
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url.toString()], { detached: true, stdio: "ignore" }).unref();
    });
    setTimeout(() => {
      server.close();
      reject(new Error("Gmail authorization timed out after 5 minutes."));
    }, 5 * 60_000).unref();
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string };
  if (!res.ok || !token.refresh_token) throw new Error(`Token exchange failed: ${token.error ?? "Google returned no refresh token"}`);
  const info = (await (await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token.access_token}`)).json()) as { email?: string };

  setEnv("GMAIL_REFRESH_TOKEN", token.refresh_token);
  setEnv("MAIL_PROVIDER", "gmail");
  if (info.email && !config.digest.from) setEnv("DIGEST_FROM", info.email);
  return info.email ?? "unknown account";
}
