import { Server } from "socket.io";
import http from "node:http";
import { clerkClient } from "@clerk/express";
import { db } from "@workspace/db";
import { profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

let _io: Server | null = null;

function workspaceRoom(workspaceId: number): string {
  return `workspace:${workspaceId}`;
}

/**
 * Socket.io intercepts requests on the raw httpServer before Express
 * middleware runs, so the app's clerkMiddleware() never sees socket
 * handshakes — auth has to happen here, manually, using the same session
 * cookie the browser already sends. Never trust a client-supplied
 * workspaceId; it's always resolved server-side from the authenticated
 * Clerk user's profile.
 */
export function createSocketServer(httpServer: http.Server): Server {
  _io = new Server(httpServer, {
    // credentials:true together with origin:"*" is invalid per the CORS
    // spec (browsers reject that combination outright on the polling
    // transport's XHR handshake) — a real, spec-level bug that could
    // explain some of the "socket sometimes connects" intermittency
    // depending on which transport/browser was used. Auth now travels via
    // the handshake `auth` payload (a Bearer token, see the auth
    // middleware below), not cookies, so credentials aren't needed here.
    cors: { origin: "*", methods: ["GET", "POST"] },
    path: "/api/socket.io/",
  });

  _io.use(async (socket, next) => {
    try {
      const headers = socket.handshake.headers;
      const host = headers.host ?? "localhost";
      const proto = (headers["x-forwarded-proto"] as string) ?? "https";
      const url = `${proto}://${host}${socket.handshake.url ?? "/"}`;
      const webHeaders = new Headers();
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === "string") webHeaders.set(key, value);
        else if (Array.isArray(value)) webHeaders.set(key, value.join(", "));
      }

      // The frontend sends the Clerk session token via the Socket.IO
      // handshake's `auth` payload (a field distinct from HTTP headers —
      // socket.io-client's `auth` option is delivered in the connect
      // packet, not as a request header). Prefer it when present, since
      // that's what an authenticated cross-origin frontend actually sends;
      // fall back to any Authorization header / cookie already on the
      // handshake for same-origin or other future clients.
      const handshakeToken = socket.handshake.auth?.["token"];
      if (typeof handshakeToken === "string" && handshakeToken && !webHeaders.has("authorization")) {
        webHeaders.set("authorization", `Bearer ${handshakeToken}`);
      }

      const request = new Request(url, { headers: webHeaders });

      const requestState = await clerkClient.authenticateRequest(request);
      const auth = requestState.toAuth();
      const userId = auth && "userId" in auth ? auth.userId : null;
      if (!userId) {
        next(new Error("Unauthorized"));
        return;
      }

      const [profile] = await db
        .select()
        .from(profilesTable)
        .where(eq(profilesTable.clerkUserId, userId))
        .limit(1);
      if (!profile) {
        next(new Error("Unauthorized"));
        return;
      }

      socket.data.workspaceId = profile.workspaceId;
      next();
    } catch (err) {
      logger.warn({ err }, "Socket auth failed");
      next(new Error("Unauthorized"));
    }
  });

  _io.on("connection", (socket) => {
    const workspaceId = socket.data.workspaceId as number;
    socket.join(workspaceRoom(workspaceId));
  });

  return _io;
}

export function getIO(): Server | null {
  return _io;
}

/**
 * Emit an event to every connected client belonging to one workspace.
 * Safe to call even before the socket server is initialized.
 */
export function emit(workspaceId: number, event: string, data: unknown): void {
  _io?.to(workspaceRoom(workspaceId)).emit(event, data);
}
