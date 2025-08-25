import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";

/** HTTP verbs Express recognises (same list as `http.METHODS`, lower-cased later). */
const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/**
 * Wrap every handler so that:
 *  • rejected promises are forwarded to Express error middleware
 *  • a handler that forgets to end the response is closed with 204 No Content
 */
function wrap<
  H extends (req: Request, res: Response, next?: NextFunction) => any
>(handler: H) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const maybePromise = handler(req, res, next);
      if (maybePromise instanceof Promise) await maybePromise;
      if (!res.headersSent) res.status(204).end();
    } catch (err) {
      next(err as Error);
    }
  };
}

/** Rudimentary check for an Express Router instance. */
function isRouter(obj: unknown): obj is { use: Function } {
  return typeof obj === "function" && typeof (obj as any).use === "function";
}

export async function registerBackendRoutes(app: Express): Promise<Server> {
  const userApiDir = path.resolve(process.cwd(), "server/apis");

  /* simple health probe --------------------------------------------------- */
  app.get("/__health", (_req, res) => res.json({ status: "ok" }));

  /* dynamic route loading -------------------------------------------------- */
  try {
    const files = await fs.readdir(userApiDir);

    for (const file of files) {
      if (!/\.(c?[jt]s|m?[jt]s)$/i.test(file)) continue; // skip non-JS/TS files

      const routePath = `/api/${file.replace(/\.(c?[jt]s|m?[jt]s)$/i, "")}`;
      const fullPath = path.join(userApiDir, file);
      // cache-bust so edits are picked up in dev
      const moduleUrl = `${pathToFileURL(fullPath).href}?t=${Date.now()}`;

      try {
        const mod = await import(moduleUrl);

        /* 1 ─ Verb-named exports  (e.g.  export const GET = …) */
        let registered = false;
        for (const VERB of HTTP_METHODS) {
          const fn = mod[VERB];
          if (typeof fn === "function") {
            app[VERB.toLowerCase()](routePath, wrap(fn));
            registered = true;
          }
        }

        /* 2 ─ Default export as Router or plain handler */
        if (!registered && mod.default) {
          if (isRouter(mod.default)) {
            app.use(routePath, mod.default);
          } else if (typeof mod.default === "function") {
            app.all(routePath, wrap(mod.default));
          } else {
            console.warn(`⚠️  ${file}: default export is neither Router nor function`);
          }
        }

        console.log(`✅ Routes ready at ${routePath}`);
      } catch (err) {
        console.error(`❌ Failed loading ${file}:`, err);
      }
    }
  } catch (err) {
    console.error("❌ Error scanning api folder:", err);
  }

  /* start HTTP server ------------------------------------------------------ */
  return createServer(app);
}
