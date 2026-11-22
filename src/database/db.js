import { alert } from "../observability/alerts.js";
import { reportError } from "../observability/errors.js";
import mongoose from "mongoose";

// Fail fast instead of letting a request hang for long when the database is unreachable.
mongoose.set("bufferTimeoutMS", Number(process.env.DB_BUFFER_TIMEOUT_MS) || 5000);

let listenersInstalled = false;

export async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!listenersInstalled) {
    listenersInstalled = true;
    mongoose.connection.on("disconnected", () => {
      console.warn("[db] MongoDB disconnected");
      alert("db_disconnected", "MongoDB disconnected: chats, limits and logs are degraded until it reconnects.");
    });
    mongoose.connection.on("reconnected", () => console.log("[db] MongoDB reconnected"));
    mongoose.connection.on("error", (error) => {
      console.error("[db] MongoDB error:", error.message);
      reportError(error, { scope: "db" });
    });
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.DB_NAME,
    serverSelectionTimeoutMS: Number(process.env.DB_SERVER_SELECTION_TIMEOUT_MS) || 10000,
    maxPoolSize: Number(process.env.DB_MAX_POOL_SIZE) || 20,
  });

  console.log("MongoDB connected");

  return mongoose.connection;
}