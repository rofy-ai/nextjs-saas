import express, { type Request, Response, NextFunction } from "express";
import { registerBackendRoutes } from "./backend-routes";
import { serveStatic, log } from "./vite";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";
import cors from "cors";

const app = express();
app.use(cors());
app.options("*", cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const userAppDir = path.resolve(__dirname, "../client");

let viteProcess: ChildProcess | null = null;

function startViteDevServer() {
  const vite = spawn("npx", ["vite"], {
    cwd: userAppDir,
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  vite.on("exit", (code, signal) => {
    log(`vite exited with code ${code}, signal ${signal}`);
  });

  vite.on("error", (err: any) => {
    log("vite process error:", err);
  });

  viteProcess = vite;
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

// 💓 Health check route
app.get("/__health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// 🔁 Vite restart endpoint
app.post("/api/restart-vite", (_req, res) => {
  restartViteDevServer();
  res.json({ status: "vite restarted" });
});

// 🔁 Frontend Vite dev proxy (unchanged)
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

(async () => {
  try {
    const server = await registerBackendRoutes(app);

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

    const port = 5002;
    server.listen({ port, host: "0.0.0.0" }, () => {
      log(`Standalone user server listening on port ${port}`);
    });
  } catch (err) {
    console.error("❌ Failed to start user standalone server:", err);
    process.exit(1);
  }
})();
