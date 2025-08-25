import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic, log } from "./vite";
import { spawn, ChildProcess, fork } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";
import cors from "cors";
import http from "http";

const allowedRoutes = [
  '/api/rofyDownloadFiles',
  '/api/rofyUpdateFiles',
  '/api/restart-backend',
  '/api/rofyLogs'
];

const app = express();

// ✅ Allow Vite dev server on 5174 to call the Express server on 5001
app.use(cors());
app.options("*", cors());

// 🔁 Only handle /api/rofyUpdateFiles locally; proxy all other /api/* to 5002
app.use(async (req, res, next) => {
  if (allowedRoutes.includes(req.originalUrl) || req.originalUrl.startsWith("/api/downloads/")) {
    return next();
  }

  if (req.originalUrl.startsWith("/api/")) {
    const alive = await isUserApiAlive();
    if (!alive) {
      return res.status(502).json({ error: "User API server unavailable" });
    }

    console.log(`Proxying to 5002: ${req.method} ${req.originalUrl}`);
    return createProxyMiddleware({
      target: "http://localhost:5002",
      changeOrigin: true,
    })(req, res, next);
  }

  return next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

let viteProcess: ChildProcess | null = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const userAppDir = path.resolve(__dirname, "../client");

let userApiProcess: ChildProcess | null = null;

function logErrors(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
  fetch('http://localhost:3000/api/logs', {
    method: 'POST',
    body: JSON.stringify({ ts: Date.now(), kind: 'error', data: message }),
    headers: { 'Content-Type': 'application/json' }
  }).catch(err => {
    console.error("Failed to send log:", err);
  });
}

// 🧠 Start user API server in separate process (isolated)
function startUserApiServer() {
  try {
    const scriptPath = path.join(__dirname, "backend-entry.js"); // compiled .js
    const child = fork(scriptPath, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], // add 'ipc' here for fork
      env: { ...process.env, FORCE_COLOR: "1" },
    });
    userApiProcess = child;

    child.stderr?.on('data', (buf) => {
      // const block = (buf.toString().match(/\[user-api\]([\s\S]*?)^\s*at/m) || [])[1] ?? '';
      const block = buf.toString();
      console.log("INSIDE HERE", block);
      if (!block.trim()) return;
      logErrors(block.trim());
    });

    console.log("✅ User API server process forked");
  } catch (err) {
    console.error("❌ Failed to start user API server:", err);
  }
}

function stopUserApiServer() {
  if (userApiProcess) {
    userApiProcess.kill("SIGTERM");
    userApiProcess = null;
  }
}


function startViteDevServer() {
  const devServer = spawn("npm", ["run", "dev"], {
    cwd: userAppDir,
    stdio: ['ignore', 'pipe', 'pipe'], // inherit for main process, pipe for logging
    env: { ...process.env, FORCE_COLOR: "1", PORT: "5173" },
  });

  devServer.on("exit", (code, signal) => {
    log(`dev server exited with code ${code}, signal ${signal}`);
  });

  devServer.on("error", (err: any) => {
    log("dev server process error:", err);
  });

  devServer.stderr.on('data', buf => {
    const block = buf.toString();
    console.log("INSIDE HERE", block);
    if (!block.trim()) return;
    logErrors(block.trim());
  }); 

  viteProcess = devServer;
}

function stopViteDevServer() {
  if (viteProcess) {
    viteProcess.kill("SIGTERM");
    viteProcess = null;
  }
}

function restartViteDevServer() {
  stopViteDevServer();
  startViteDevServer();
}

// 💓 Check if 5002 server is alive
const isUserApiAlive = async (): Promise<boolean> => {
  return new Promise((resolve) => {
    const req = http.get("http://localhost:5002/__health", (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(300, () => {
      req.destroy();
      resolve(false);
    });
  });
};

// 🛡 Logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }
      log(logLine);
    }
  });

  next();
});


// 🔁 Existing Vite dev server proxy (untouched)
if (app.get("env") === "development") {
  console.log("Development mode detected, setting up Vite middleware");
  app.use(
    "/",
    createProxyMiddleware({
      target: "http://localhost:5173",
      changeOrigin: true,
      ws: true,
      pathFilter: (path, req) => {
        return !/^\/api(\/|$)/.test(path);
      },
    })
  );
}

// 🔁 Vite restart endpoint
app.post("/api/restart-vite", (req, res) => {
  restartViteDevServer();
  res.json({ status: "vite restarted" });
});

app.post("/api/restart-backend", (req, res) => {
  console.log("Restarting user API server...");
  stopUserApiServer();
  startUserApiServer();
  res.json({ status: "user API restarted" });
});

app.use('/api/downloads', express.static(path.join(__dirname, '../public/downloads')));

(async () => {
  const server = await registerRoutes(app);

  console.log('Serving static from:', path.join(__dirname, '../public/downloads'));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    throw err;
  });

  if (app.get("env") === "development") {
    startViteDevServer();
  } else {
    serveStatic(app);
  }

  // 🧠 Start the user API process
  startUserApiServer();

  const port = 5001;
  server.listen({ port, host: "0.0.0.0" }, () => {
    log(`Main server listening on port ${port}`);
  });
})();