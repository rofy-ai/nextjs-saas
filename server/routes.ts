import type { Express } from "express";
import { createServer, type Server } from "http";
import { promises as fs } from "fs";
import path from "path";
import { createProjectZip } from "./zip";
import { fileURLToPath } from "url";

interface FileUpdatePayload {
  filePath: string;
  content: string;
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.post("/api/rofyUpdateFiles", async (req, res) => {
    const files: FileUpdatePayload[] = req.body;

    if (!Array.isArray(files)) {
      return res.status(400).json({
        error: "Invalid input",
        message: "Request body must be an array of file objects",
      });
    }

    const results: any[] = [];

    for (const file of files) {
      const { filePath: relativePath, content } = file;

      try {
        if (!relativePath || typeof relativePath !== "string") {
          throw new Error("Missing or invalid file path");
        }

        if (content === undefined || content === null) {
          throw new Error("Missing content");
        }

        const normalizedPath = path.normalize(relativePath);
        if (normalizedPath.includes("..") || path.isAbsolute(normalizedPath)) {
          throw new Error("Invalid file path (cannot contain '..' or be absolute)");
        }

        const projectRoot = process.cwd();
        const absolutePath = path.join(projectRoot, normalizedPath);

        const resolvedPath = path.resolve(absolutePath);
        const resolvedProjectRoot = path.resolve(projectRoot);
        if (!resolvedPath.startsWith(resolvedProjectRoot)) {
          throw new Error("Access denied: path must be within project directory");
        }

        const dir = path.dirname(absolutePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(absolutePath, content, "utf8");

        results.push({
          filePath: relativePath,
          status: "success",
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        results.push({
          filePath: file.filePath,
          status: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    await fetch("http://localhost:5001/api/restart-backend", {
      method: "POST",
    });

    res.json({ results });
  });

  app.post("/api/rofyDownloadFiles", async (req, res) => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const { projectName } = req.body;
    const sanitized = projectName.replace(/[^a-zA-Z0-9-_]/g, "_");
    const zipPath = await createProjectZip({ projectName: sanitized });

    const zipExists = await fs.access(zipPath).then(() => true).catch(() => false);
    if (!zipExists) {
      return res.status(500).json({ success: false, error: "Zip creation failed" });
    }

    const fileName = path.basename(zipPath);
    const publicPath = `/downloads/${fileName}`;
    const publicDir = path.join(__dirname, "../public/downloads");
    const dirExists = await fs.access(publicDir).then(() => true).catch(() => false);
    if (!dirExists) {
      await fs.mkdir(publicDir, { recursive: true });
    }

    const publicFilePath = path.join(publicDir, fileName);

    // Move file to public folder
    await fs.rename(zipPath, publicFilePath);

    await fetch("http://localhost:5001/api/restart-backend", {
      method: "POST",
    });

    return res.json({
      success: true,
      downloadUrl: publicPath, // relative browser-accessible path
    });

  } catch (err) {
    console.error("Error in rofyDownloadFiles:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});


  const httpServer = createServer(app);
  return httpServer;
}