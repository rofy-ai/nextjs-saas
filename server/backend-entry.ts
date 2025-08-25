import express from "express";
import { registerBackendRoutes } from "./backend-routes";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Health check route for main server
app.get("/__health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

(async () => {
  try {
    const server = await registerBackendRoutes(app);
    const port = 5002;
    server.listen(port, () => {
      console.log(`✅ User API server running on port ${port}`);
    });
  } catch (err) {
    console.error("❌ Failed to start user API server:", err);
    process.exit(1); // exit if user routes fail
  }
})();
