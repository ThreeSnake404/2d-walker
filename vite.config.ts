import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const rootDir = import.meta.dirname;
const modelDir = path.resolve(rootDir, "model");
const cameraFile = path.resolve(rootDir, "public/camera-start.json");

function sendJson(res: { setHeader(name: string, value: string): void; end(body: string): void }, body: unknown) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function walkerProjectPlugin(): Plugin {
  return {
    name: "walker-project",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const urlPath = decodeURIComponent((req.url ?? "").split("?")[0]);
        if (!urlPath.startsWith("/model/")) {
          next();
          return;
        }

        const filePath = path.resolve(modelDir, `.${urlPath.slice("/model".length)}`);
        if (!filePath.startsWith(modelDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          next();
          return;
        }

        const extension = path.extname(filePath);
        res.setHeader(
          "Content-Type",
          extension === ".gltf" ? "model/gltf+json" : "application/octet-stream",
        );
        res.setHeader("Cache-Control", "no-cache");
        fs.createReadStream(filePath).pipe(res);
      });

      server.middlewares.use("/api/camera-start", (req, res) => {
        if (req.method === "GET") {
          if (!fs.existsSync(cameraFile)) {
            res.statusCode = 404;
            sendJson(res, { error: "not found" });
            return;
          }
          sendJson(res, JSON.parse(fs.readFileSync(cameraFile, "utf8")));
          return;
        }

        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              fs.mkdirSync(path.dirname(cameraFile), { recursive: true });
              fs.writeFileSync(cameraFile, `${JSON.stringify(payload, null, 2)}\n`);
              sendJson(res, { ok: true, path: "public/camera-start.json" });
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : "invalid json" });
            }
          });
          return;
        }

        res.statusCode = 405;
        sendJson(res, { error: "method not allowed" });
      });
    },
    closeBundle() {
      const outDir = path.resolve(rootDir, "dist/model");
      fs.mkdirSync(outDir, { recursive: true });
      for (const file of fs.readdirSync(modelDir)) {
        fs.copyFileSync(path.join(modelDir, file), path.join(outDir, file));
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), walkerProjectPlugin()],
});
