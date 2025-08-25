import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { log } from "./vite"; // serveStatic removed from prod path
import { spawn, ChildProcess, fork } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";
import cors from "cors";
import http from "http";

const allowedRoutes = [
  "/api/rofyDownloadFiles",
  "/api/rofyUpdateFiles",
  "/api/restart-frontend",
  "/api/rofyLogs",
];

const app = express();

// CORS
app.use(cors());
app.options("*", cors());

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

let viteProcess: ChildProcess | null = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const userAppDir = path.resolve(__dirname, "../client");

let userApiProcess: ChildProcess | null = null;

/* ------------------------------ logging ------------------------------ */
function logErrors(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
  fetch("http://localhost:3000/api/logs", {
    method: "POST",
    body: JSON.stringify({ ts: Date.now(), kind: "error", data: message }),
    headers: { "Content-Type": "application/json" },
  }).catch((err) => {
    console.error("Failed to send log:", err);
  });
}

/* ----------------------- dev server (Next @5173) ---------------------- */
function startDevServer() {
  // Keep your existing command; ensure it starts Next on port 5173.
  const devServer = spawn("npm", ["run", "dev"], {
    cwd: userAppDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1", PORT: "5173" },
  });

  devServer.on("exit", (code, signal) => {
    log(`dev server exited with code ${code}, signal ${signal}`);
  });

  devServer.on("error", (err: any) => {
    log("dev server process error:", err);
  });

  devServer.stderr.on("data", (buf) => {
    const block = buf.toString();
    console.log("INSIDE HERE", block);
    if (!block.trim()) return;
    logErrors(block.trim());
  });

  viteProcess = devServer;
}

function stopDevServer() {
  if (viteProcess) {
    viteProcess.kill("SIGTERM");
    viteProcess = null;
  }
}

function restartDevServer() {
  stopDevServer();
  startDevServer();
}

/* ----------------------------- middleware ---------------------------- */
// Access logs (kept)
app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json.bind(res);
  (res as any).json = function (bodyJson: any, ...args: any[]) {
    capturedJsonResponse = bodyJson;
    return originalResJson(bodyJson, ...args);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api")) {
      let line = `${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) line += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      if (line.length > 80) line = line.slice(0, 79) + "…";
      log(line);
    }
  });

  next();
});

// Serve downloads locally (guard)
app.use("/api/downloads", express.static(path.join(__dirname, "../public/downloads")));

/* ------------------------ unified proxy to :5173 ---------------------- */
// One proxy instance reused for all non-guarded requests.
const proxyToNext5173 = createProxyMiddleware({
  target: "http://localhost:5173",
  changeOrigin: true,
  ws: true, // websocket/HMR/SSE
});

// Guarded routes handled locally -> next()
app.use((req, res, next) => {
  if (
    allowedRoutes.includes(req.originalUrl) ||
    req.originalUrl.startsWith("/api/downloads/")
  ) {
    return next();
  }
  // Everything else (both /api/** and page routes) -> Next on :5173
  return proxyToNext5173(req, res, next);
});

/* ---------------------------- local routes ---------------------------- */
// Restart Next dev server
app.post("/api/restart-frontend", (_req, res) => {
  restartDevServer();
  res.json({ status: "dev server restarted" });
});
/* -------------------------------- boot -------------------------------- */
(async () => {
  const server = await registerRoutes(app);

  console.log("Serving static from:", path.join(__dirname, "../public/downloads"));

  // Start your dev server in development
  if (app.get("env") === "development") {
    startDevServer();
  }

  // Make sure WS upgrades also flow to Next/HMR
  // (Attach after server is created)
  (server as http.Server).on("upgrade", (req, socket, head) => {
    proxyToNext5173.upgrade(req, socket as any, head);
  });

  const port = 5001;
  (server as http.Server).listen({ port, host: "0.0.0.0" }, () => {
    log(`Main server listening on port ${port}`);
  });
})();

/* ----------------------------- notes ----------------------------------
- All non-guarded requests (including /api/**) are proxied to Next on :5173.
- Guarded local routes still terminate on this Express app.
- In production, run your Next server on :5173 and keep this proxy layer as-is,
  or front everything with a reverse proxy (Fly/Nginx) if preferred.
------------------------------------------------------------------------ */
