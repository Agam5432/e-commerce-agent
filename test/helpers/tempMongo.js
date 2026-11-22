// A throwaway MongoDB for the tests that need real atomic updates and unique indexes (two team members taking one call).
// It starts `mongod` on a free local port with a temporary folder and removes both afterwards. When no mongod is on the
// machine the tests that need it are skipped (never failed): set MONGOD_PATH to a mongod binary to run them.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import mongoose from "mongoose";

function findMongod() {
  const candidates = [process.env.MONGOD_PATH, "C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe", "C:/Program Files/MongoDB/Server/8.0/bin/mongod.exe", "C:/Program Files/MongoDB/Server/7.0/bin/mongod.exe", "/usr/bin/mongod", "/usr/local/bin/mongod"].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["mongod"], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.split(/\r?\n/)[0].trim() : "";
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on("error", reject);
});

/** @returns {Promise<{available: boolean, uri?: string, stop?: () => Promise<void>}>} */
export async function startTempMongo() {
  const bin = findMongod();
  if (!bin) return { available: false };
  const dir = mkdtempSync(join(tmpdir(), "orbi-mongo-"));
  const port = await freePort();
  const args = ["--dbpath", dir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet", ...(process.platform === "win32" ? [] : ["--nounixsocket"])];
  const child = spawn(bin, args, { stdio: "ignore" });
  const uri = `mongodb://127.0.0.1:${port}/orbi_test`;
  const started = Date.now();
  for (;;) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 800 });
      break;
    } catch {
      if (Date.now() - started > 30_000) {
        child.kill();
        return { available: false };
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return {
    available: true,
    uri,
    async stop() {
      try { await mongoose.disconnect(); } catch { /* already closed */ }
      child.kill();
      await new Promise((r) => setTimeout(r, 400));
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder */ }
    },
  };
}
