import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DATA_FILE = path.join(__dirname, "data", "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;
const PLATFORMS = ["twitch", "youtube", "tiktok", "kick", "facebook", "other"];

function emptyDb() {
  return { users: [], sessions: [], dashboards: [] };
}

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return emptyDb();
  }
}

let db = loadDb();
let writing = Promise.resolve();

function saveDb() {
  const snapshot = JSON.stringify(db, null, 2);
  writing = writing.then(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, snapshot);
    fs.renameSync(tmp, DATA_FILE);
  });
  return writing;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash || hash.length !== 128) return false;
  const next = crypto.scryptSync(password, salt, 64);
  const prev = Buffer.from(hash, "hex");
  if (next.length !== prev.length) return false;
  return crypto.timingSafeEqual(next, prev);
}

function id() {
  return crypto.randomBytes(12).toString("hex");
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function publicDashboard(item) {
  return {
    id: item.id,
    name: item.name,
    sessionId: item.sessionId,
    accounts: item.accounts,
    createdAt: item.createdAt,
    live: item.accounts.some((account) => account.live),
  };
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function currentUser(req) {
  const token = readCookie(req, "live_desk");
  if (!token) return null;
  const now = Date.now();
  const session = db.sessions.find((item) => item.token === token && item.expiresAt > now);
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function sessionCookie(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `live_desk=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`;
}

function clearCookie() {
  return "live_desk=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 160;
}

function validSessionId(sessionId) {
  return /^[A-Za-z0-9_-]{4,80}$/.test(sessionId);
}

function cleanAccounts(accounts) {
  if (!Array.isArray(accounts)) return [];
  return accounts.slice(0, 12).map((account) => {
    const platform = PLATFORMS.includes(account?.platform) ? account.platform : "other";
    return {
      id: cleanText(account?.id, 40) || id(),
      platform,
      handle: cleanText(account?.handle, 80),
      live: Boolean(account?.live),
    };
  }).filter((account) => account.handle);
}

const loginAttempts = new Map();

function tooManyAttempts(key) {
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
  loginAttempts.set(key, recent);
  return recent.length >= 8;
}

function noteAttempt(key) {
  const recent = loginAttempts.get(key) || [];
  recent.push(Date.now());
  loginAttempts.set(key, recent);
}

async function handleApi(req, res, url) {
  const user = currentUser(req);

  if (req.method === "GET" && url.pathname === "/api/me") {
    send(res, 200, { user: user ? publicUser(user) : null });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    const body = await readBody(req);
    const name = cleanText(body.name, 80);
    const email = cleanText(body.email, 160).toLowerCase();
    const password = String(body.password || "");
    if (name.length < 2) return send(res, 400, { error: "Enter your name." });
    if (!validEmail(email)) return send(res, 400, { error: "Enter a valid email." });
    if (password.length < 8) return send(res, 400, { error: "Use a password of at least 8 characters." });
    if (db.users.some((item) => item.email === email)) {
      return send(res, 409, { error: "An account with that email already exists." });
    }
    const created = {
      id: id(),
      name,
      email,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    db.users.push(created);
    const token = crypto.randomBytes(32).toString("hex");
    db.sessions.push({ token, userId: created.id, expiresAt: Date.now() + SESSION_MS });
    await saveDb();
    send(res, 201, { user: publicUser(created) }, { "Set-Cookie": sessionCookie(token) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const email = cleanText(body.email, 160).toLowerCase();
    const password = String(body.password || "");
    const key = `${req.socket.remoteAddress || ""}:${email}`;
    if (tooManyAttempts(key)) {
      return send(res, 429, { error: "Too many sign-in attempts. Wait a few minutes and try again." });
    }
    const found = db.users.find((item) => item.email === email);
    if (!found || !verifyPassword(password, found.passwordHash)) {
      noteAttempt(key);
      return send(res, 401, { error: "Email or password is incorrect." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    db.sessions.push({ token, userId: found.id, expiresAt: Date.now() + SESSION_MS });
    await saveDb();
    send(res, 200, { user: publicUser(found) }, { "Set-Cookie": sessionCookie(token) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = readCookie(req, "live_desk");
    db.sessions = db.sessions.filter((item) => item.token !== token);
    await saveDb();
    send(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
    return;
  }

  if (!user) return send(res, 401, { error: "Sign in required." });

  if (req.method === "GET" && url.pathname === "/api/dashboards") {
    const isLive = (item) => item.accounts.some((account) => account.live);
    const mine = db.dashboards
      .filter((item) => item.userId === user.id)
      .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.createdAt.localeCompare(a.createdAt));
    send(res, 200, { dashboards: mine.map(publicDashboard) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dashboards") {
    const body = await readBody(req);
    const name = cleanText(body.name, 80);
    const sessionId = cleanText(body.sessionId, 80);
    const accounts = cleanAccounts(body.accounts);
    if (name.length < 2) return send(res, 400, { error: "Name the show." });
    if (!validSessionId(sessionId)) {
      return send(res, 400, { error: "Session ID should be 4–80 letters, numbers, _ or -." });
    }
    if (!accounts.length) return send(res, 400, { error: "Add at least one platform account." });
    const created = {
      id: id(),
      userId: user.id,
      name,
      sessionId,
      accounts,
      createdAt: new Date().toISOString(),
    };
    db.dashboards.push(created);
    await saveDb();
    send(res, 201, { dashboard: publicDashboard(created) });
    return;
  }

  const match = url.pathname.match(/^\/api\/dashboards\/([a-f0-9]+)$/);
  if (match) {
    const dashboard = db.dashboards.find((item) => item.id === match[1] && item.userId === user.id);
    if (!dashboard) return send(res, 404, { error: "Dashboard not found." });

    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (body.name !== undefined) {
        const name = cleanText(body.name, 80);
        if (name.length < 2) return send(res, 400, { error: "Name the show." });
        dashboard.name = name;
      }
      if (body.sessionId !== undefined) {
        const sessionId = cleanText(body.sessionId, 80);
        if (!validSessionId(sessionId)) {
          return send(res, 400, { error: "Session ID should be 4–80 letters, numbers, _ or -." });
        }
        dashboard.sessionId = sessionId;
      }
      if (body.accounts !== undefined) {
        const accounts = cleanAccounts(body.accounts);
        if (!accounts.length) return send(res, 400, { error: "Add at least one platform account." });
        dashboard.accounts = accounts;
      }
      await saveDb();
      send(res, 200, { dashboard: publicDashboard(dashboard) });
      return;
    }

    if (req.method === "DELETE") {
      db.dashboards = db.dashboards.filter((item) => item.id !== dashboard.id);
      await saveDb();
      send(res, 200, { ok: true });
      return;
    }
  }

  send(res, 404, { error: "Not found." });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, { error: "Forbidden." });
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, { error: "Not found." });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: "Method not allowed." });
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    send(res, 400, { error: error.message || "Request failed." });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Live Desk running at http://127.0.0.1:${PORT}`);
});
