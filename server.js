const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 65536 });

app.use(
  helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }),
);
app.use(express.json({ limit: "16kb" }));
app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(express.static(path.join(__dirname, "public")));

const boards = new Map();
const BOARD_TTL = 24 * 60 * 60 * 1000;
const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genBoardId() {
  let id;
  do {
    id = "";
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) id += ID_CHARS[bytes[i] % ID_CHARS.length];
  } while (boards.has(id));
  return id;
}

function genSecret() {
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars
}

setInterval(
  () => {
    const now = Date.now();
    for (const [id, b] of boards) {
      if (now - b.lastActive > BOARD_TTL) {
        try {
          if (b.boardWs) b.boardWs.close();
        } catch (_) {}
        try {
          if (b.companionWs) b.companionWs.close();
        } catch (_) {}
        boards.delete(id);
      }
    }
  },
  5 * 60 * 1000,
);

app.get("/api/health", (_, res) => res.json({ ok: true, boards: boards.size }));

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.msgWindow = Date.now();
  ws.role = null;
  ws.boardId = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - ws.msgWindow > 60000) {
      ws.msgCount = 0;
      ws.msgWindow = now;
    }
    if (++ws.msgCount > 120) {
      safeSend(ws, { type: "error", message: "Rate limited" });
      return;
    }
    let msg;
    try {
      const str = raw.toString();
      if (str.length > 65536) return;
      msg = JSON.parse(str);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.type !== "string" || msg.type.length > 64) return;
    handleMsg(ws, msg);
  });

  ws.on("close", () => {
    if (!ws.boardId) return;
    const b = boards.get(ws.boardId);
    if (!b) return;

    if (b.boardWs === ws) {
      b.boardWs = null;
      safeSend(b.companionWs, { type: "board_disconnected" });
    }
    if (b.companionWs === ws) {
      b.companionWs = null;
      safeSend(b.boardWs, { type: "companion_disconnected" });
    }
    // Clear pending if the pending companion disconnected
    if (b.pendingWs === ws) {
      b.pendingWs = null;
    }
  });
  ws.on("error", () => {});
});

function safeSend(ws, obj) {
  if (ws && ws.readyState === 1)
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {}
}

function handleMsg(ws, msg) {
  switch (msg.type) {
    // ── Board registers ──
    case "register_board": {
      const boardId = genBoardId();
      const secret = genSecret();
      boards.set(boardId, {
        boardWs: ws,
        companionWs: null,
        pendingWs: null,
        secret,
        settings: null,
        messages: null,
        mode: "messages",
        locked: false, // true when companion is connected
        createdAt: Date.now(),
        lastActive: Date.now(),
      });
      ws.boardId = boardId;
      ws.role = "board";
      safeSend(ws, { type: "registered", boardId, secret });
      console.log(`Board created: ${boardId}`);
      break;
    }

    // ── Companion requests pairing ──
    case "pair": {
      const id =
        typeof msg.boardId === "string"
          ? msg.boardId
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "")
              .slice(0, 6)
          : "";
      const secret =
        typeof msg.secret === "string"
          ? msg.secret
              .replace(/[^a-f0-9]/gi, "")
              .slice(0, 32)
              .toLowerCase()
          : "";
      if (id.length !== 6) {
        safeSend(ws, { type: "error", message: "Invalid code" });
        return;
      }

      const b = boards.get(id);
      if (!b) {
        safeSend(ws, { type: "error", message: "Board not found" });
        return;
      }
      if (!b.boardWs || b.boardWs.readyState !== 1) {
        safeSend(ws, { type: "error", message: "Board is offline" });
        return;
      }

      // If board is locked (already has a companion), reject
      if (b.locked && b.companionWs && b.companionWs.readyState === 1) {
        safeSend(ws, {
          type: "error",
          message: "Board is locked. Disconnect current companion first.",
        });
        return;
      }

      // Check if secret matches (QR code path) → auto-approve
      if (secret.length === 32 && secret === b.secret) {
        completePairing(b, ws, id);
        return;
      }

      // Manual code path → require board-side approval
      // Store as pending, ask board to approve
      if (b.pendingWs) {
        safeSend(b.pendingWs, {
          type: "error",
          message: "Another device is waiting for approval",
        });
      }
      b.pendingWs = ws;
      ws.boardId = id; // tentative
      safeSend(ws, {
        type: "waiting_approval",
        message: "Waiting for TV to approve...",
      });
      safeSend(b.boardWs, { type: "pair_request" });
      console.log(`Pair request pending: ${id}`);
      break;
    }

    // ── Board approves pending companion ──
    case "approve_pair": {
      if (ws.role !== "board" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b || !b.pendingWs) return;
      completePairing(b, b.pendingWs, ws.boardId);
      b.pendingWs = null;
      break;
    }

    // ── Board rejects pending companion ──
    case "reject_pair": {
      if (ws.role !== "board" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b || !b.pendingWs) return;
      safeSend(b.pendingWs, {
        type: "error",
        message: "Connection rejected by TV",
      });
      b.pendingWs.boardId = null;
      b.pendingWs = null;
      safeSend(ws, { type: "pair_rejected" });
      console.log(`Pair rejected: ${ws.boardId}`);
      break;
    }

    // ── Companion disconnects cleanly ──
    case "companion_disconnect": {
      if (ws.role !== "companion" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b) return;
      b.companionWs = null;
      b.locked = false;
      // Generate new code+secret for next pairing
      boards.delete(ws.boardId);
      const newId = genBoardId();
      const newSecret = genSecret();
      boards.set(newId, {
        ...b,
        companionWs: null,
        pendingWs: null,
        secret: newSecret,
        locked: false,
        lastActive: Date.now(),
      });
      if (b.boardWs) {
        b.boardWs.boardId = newId;
      }
      safeSend(b.boardWs, {
        type: "companion_disconnected_new_code",
        boardId: newId,
        secret: newSecret,
      });
      ws.boardId = null;
      ws.role = null;
      safeSend(ws, { type: "disconnected" });
      break;
    }

    // ── Board kicks companion ──
    case "kick_companion": {
      if (ws.role !== "board" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b) return;
      if (b.companionWs) {
        safeSend(b.companionWs, { type: "kicked" });
        b.companionWs.boardId = null;
        b.companionWs.role = null;
        b.companionWs = null;
      }
      b.locked = false;
      // New code+secret
      boards.delete(ws.boardId);
      const newId = genBoardId();
      const newSecret = genSecret();
      boards.set(newId, {
        ...b,
        companionWs: null,
        pendingWs: null,
        secret: newSecret,
        locked: false,
        lastActive: Date.now(),
      });
      ws.boardId = newId;
      safeSend(ws, { type: "new_code", boardId: newId, secret: newSecret });
      console.log(`Board kicked, new code: ${newId}`);
      break;
    }

    // ── Board reconnects ──
    case "reconnect_board": {
      const id =
        typeof msg.boardId === "string"
          ? msg.boardId
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "")
              .slice(0, 6)
          : "";
      const b = boards.get(id);
      if (!b) {
        safeSend(ws, { type: "error", message: "Board expired" });
        return;
      }
      b.boardWs = ws;
      b.lastActive = Date.now();
      ws.boardId = id;
      ws.role = "board";
      safeSend(ws, {
        type: "reconnected",
        boardId: id,
        secret: b.secret,
        settings: b.settings,
        messages: b.messages,
        mode: b.mode,
        locked: b.locked,
      });
      safeSend(b.companionWs, { type: "board_reconnected" });
      console.log(`Board reconnected: ${id}`);
      break;
    }

    // ── Forward companion → board commands ──
    case "update_settings":
    case "update_messages":
    case "play_sequence":
    case "next_message":
    case "reset_board":
    case "flip_message":
    case "set_mode": {
      if (ws.role !== "companion" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b) return;
      b.lastActive = Date.now();
      if (
        msg.type === "update_settings" &&
        msg.settings &&
        typeof msg.settings === "object"
      )
        b.settings = msg.settings;
      if (msg.type === "update_messages" && typeof msg.messages === "string")
        b.messages = msg.messages.slice(0, 10000);
      if (msg.type === "set_mode" && typeof msg.mode === "string")
        b.mode = msg.mode;
      safeSend(b.boardWs, msg);
      break;
    }

    case "board_state": {
      if (ws.role !== "board" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b) return;
      b.lastActive = Date.now();
      safeSend(b.companionWs, msg);
      break;
    }
  }
}

function completePairing(b, companionWs, boardId) {
  // Replace existing companion if any
  if (b.companionWs && b.companionWs !== companionWs) {
    safeSend(b.companionWs, { type: "replaced" });
    b.companionWs.boardId = null;
    b.companionWs.role = null;
  }
  b.companionWs = companionWs;
  b.locked = true;
  b.lastActive = Date.now();
  b.pendingWs = null;
  companionWs.boardId = boardId;
  companionWs.role = "companion";
  safeSend(companionWs, {
    type: "paired",
    boardId,
    settings: b.settings,
    messages: b.messages,
    mode: b.mode,
  });
  safeSend(b.boardWs, { type: "companion_joined" });
  console.log(`Paired: ${boardId} (locked)`);
}

const hb = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(hb));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  splitflap.org server on http://localhost:${PORT}\n`);
  console.log(`  Board:     http://localhost:${PORT}/board.html`);
  console.log(`  Companion: http://localhost:${PORT}/companion.html\n`);
});
