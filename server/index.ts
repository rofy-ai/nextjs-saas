import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { log } from "./vite"; // serveStatic removed from prod path
import { spawn, ChildProcess, fork } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";
import cors from "cors";
import http from "http";
import fs from "fs";
import 'dotenv/config';

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

let previewHost: string | null = null;

let viteProcess: ChildProcess | null = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const userAppDir = path.resolve(__dirname, "../client");


function shrinkError(rawError:string|Error): string {
  const text = typeof rawError === "string" ? rawError : rawError.stack || String(rawError);

  const lines = text.split("\n");

  // 1. Keep the first line (always has error message)
  const firstLine = lines[0];

  // 2. Grab any inline codeframe block (lines that look like " 37 | foo")
  const codeframe = lines.filter(l => /^\s*\d+\s*\|/.test(l) || /^\s*>/.test(l)).join("\n");

  // 3. Grab framework/plugin hint lines (vite, plugin, module, caused by)
  const hints = lines.filter(l =>
    /(Module|Caused by|File:|Request URL:)/i.test(l)
  ).join("\n");

  // 4. Compose output without stack trace "at ..."
  return [firstLine, codeframe].filter(Boolean).join("\n\n");
}

function stripAnsi(str: string): string {
  return str.replace(
    // regex to match ANSI escape codes
    /\u001b\[[0-9;]*m/g,
    ''
  );
}

function extractChatId(): string | null {
  if (!previewHost) return null;
  const m = previewHost.toLowerCase().match(/^preview-([^.]+)\./);
  return m ? m[1] : null;
}


/* ------------------------------ logging ------------------------------ */
function logErrors(message: string) {
  const shrunk = shrinkError(message);
  const stripAnsiString = stripAnsi(shrunk);
  const chatId = extractChatId();
  
  fetch('https://api.rezzo.ai/reviewer/review-errors', {
    method: 'POST',
    body: JSON.stringify({ chatId, errorLogs: [stripAnsiString] }),
    headers: { 'Content-Type': 'application/json' }
  }).catch(err => {
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

/* ------------------------ HTML injection helpers ---------------------- */
function isNavigationRequest(req: import("http").IncomingMessage) {
  const h = req.headers;
  const accept = String(h["accept"] || "");
  const dest = String(h["sec-fetch-dest"] || "");
  const mode = String(h["sec-fetch-mode"] || "");
  const site = String(h["sec-fetch-site"] || "");
  return (
    req.method === "GET" &&
    accept.includes("text/html") &&
    dest === "document" &&
    mode === "navigate" &&
    (site === "none" || site === "same-origin" || site === "cross-site")
  );
}

function injectHeadTag(html: string) {
  if (html.includes('data-rofy="console-capture"')) return html;
  const tag = `<script type="module" src="https://preview.rezzo.dev/js/reviewer.js" data-rofy="console-capture" defer></script>`;
  if (html.includes("</head>")) return html.replace("</head>", `${tag}</head>`);
  if (html.includes("</body>")) return html.replace("</body>", `${tag}</body>`);
  return `${html}\n${tag}`;
}

app.use(async (req, res, next) => {
  if (!previewHost) {
    previewHost = req.headers.host || '';
  }
  next();
});

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
// Now set selfHandleResponse to inject the logger only for navigations.
const proxyToNext5173 = createProxyMiddleware({
  target: "http://localhost:5173",
  changeOrigin: true,
  ws: true, // websocket/HMR/SSE
  selfHandleResponse: true,
  on: {
    proxyReq: (proxyReq, req, _res) => {
    // Serve /log-viewer.js locally; don't proxy it.
    if (req.url === "/log-viewer.js") return;

    // For real navigations, force identity encoding so we can inject safely.
    if (isNavigationRequest(req)) {
      proxyReq.setHeader("accept-encoding", "identity");
      console.log("[injector] Navigation detected → will inject logger");
    }
  },
    proxyRes: (proxyRes, req, res) => {
    // Let our local /log-viewer.js route handle itself.
    if (req.url === "/log-viewer.js") {
      res.statusCode = 404;
      res.end();
      return;
    }

    // Only rewrite top-level navigations; stream everything else unmodified.
    if (!isNavigationRequest(req)) {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers as any);
      proxyRes.pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    proxyRes.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    proxyRes.on("end", () => {
      let body = Buffer.concat(chunks).toString("utf8");
      body = injectHeadTag(body);

      const headers = { ...(proxyRes.headers as any) };
      delete headers["content-length"]; // changed size
      headers["content-type"] = "text/html; charset=utf-8";
      headers["cache-control"] = "no-store"; // avoid dev staleness

      res.writeHead(proxyRes.statusCode || 200, headers);
      res.end(body, "utf8");
    });
  }
  }
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

if (app.get("env") === "development") {
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
}

/* ----------------------------- notes ----------------------------------
- /log-viewer.js is served locally with no-store and injected into the main
  HTML document returned by Next for navigations.
- Injection triggers only on real page navigations (based on Sec-Fetch-* headers),
  so module/asset requests pass through untouched.
- Works for dev and prod as long as your Next app is reachable at :5173.
------------------------------------------------------------------------ */
