import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(join(rootDir, ".env"));
loadEnvFile(join(rootDir, ".env.local"));

type Rewrite = { source: string; destination: string };

function loadRewrites(): Rewrite[] {
  const raw = JSON.parse(readFileSync(join(rootDir, "vercel.json"), "utf8"));
  return Array.isArray(raw.rewrites) ? raw.rewrites : [];
}

interface DevRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
  cookies: Record<string, string>;
  body: unknown;
}

interface DevResponse extends ServerResponse {
  status(code: number): DevResponse;
  json(payload: unknown): DevResponse;
  send(payload: unknown): DevResponse;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (!key) continue;
    cookies[key] = decodeURIComponent(rest.join("=") ?? "");
  }
  return cookies;
}

function augmentResponse(res: ServerResponse): DevResponse {
  const dev = res as DevResponse;
  dev.status = (code: number) => {
    dev.statusCode = code;
    return dev;
  };
  dev.json = (payload: unknown) => {
    if (!dev.getHeader("content-type")) dev.setHeader("content-type", "application/json; charset=utf-8");
    dev.end(JSON.stringify(payload));
    return dev;
  };
  dev.send = (payload: unknown) => {
    if (payload === undefined) {
      dev.end();
      return dev;
    }
    if (Buffer.isBuffer(payload)) {
      if (!dev.getHeader("content-type")) dev.setHeader("content-type", "application/octet-stream");
      dev.end(payload);
      return dev;
    }
    if (typeof payload === "string") {
      if (!dev.getHeader("content-type")) dev.setHeader("content-type", "text/plain; charset=utf-8");
      dev.end(payload);
      return dev;
    }
    return dev.json(payload);
  };
  return dev;
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function splitDestination(destination: string) {
  const [pathname, search] = destination.split("?");
  const query: Record<string, string> = {};
  if (search) for (const [key, value] of new URLSearchParams(search)) query[key] = value;
  return { pathname, query };
}

async function loadHandlerModule(apiPathname: string) {
  const relative = apiPathname.replace(/^\/api\//, "");
  const modulePath = join(rootDir, "api", `${relative}.ts`);
  if (!existsSync(modulePath)) return null;
  return import(pathToFileURL(modulePath).href);
}

const rewrites = loadRewrites();

const server = createServer(async (req, res) => {
  const dev = augmentResponse(res);
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname = url.pathname;
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    const rewrite = rewrites.find((r) => r.source === pathname);
    if (rewrite) {
      const destination = splitDestination(rewrite.destination);
      pathname = destination.pathname;
      Object.assign(query, destination.query, query);
    }

    if (!pathname.startsWith("/api/")) {
      dev.status(404).send("Not found");
      return;
    }

    const mod = await loadHandlerModule(pathname);
    if (!mod || typeof mod.default !== "function") {
      dev.status(404).send("Not found");
      return;
    }

    const devReq = req as DevRequest;
    devReq.query = query;
    devReq.cookies = parseCookies(req.headers.cookie);

    const bodyParserDisabled = mod.config?.api?.bodyParser === false;
    if (!bodyParserDisabled && req.method !== "GET" && req.method !== "HEAD") {
      const raw = await readRawBody(req);
      const contentType = req.headers["content-type"] ?? "";
      if (raw.length && contentType.includes("application/json")) {
        try {
          devReq.body = JSON.parse(raw.toString("utf8"));
        } catch {
          devReq.body = {};
        }
      } else {
        devReq.body = raw.toString("utf8");
      }
    }

    await mod.default(devReq, dev);
  } catch (error) {
    console.error("dev_server_request_failed", error instanceof Error ? error.message : error);
    if (!dev.headersSent) dev.status(500).json({ error: "Internal dev server error" });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`Servidor local listo en http://localhost:${port}`);
  console.log("Rutas: / /conversations /automations /catalog /library /settings /api/health /api/catalog /api/webhook");
});
