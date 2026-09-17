import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATABASE_URL = process.env.DATABASE_URL || "";
const ACCESS_PASSWORD = process.env.SHIFTPLAN_PASSWORD || process.env.AWP_PASSWORD || "weihnachtspaeckli";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 60 * 60 * 24 * 30);

if (!process.env.SHIFTPLAN_PASSWORD && !process.env.AWP_PASSWORD) {
  console.warn("[config] SHIFTPLAN_PASSWORD is not set. Temporary fallback password is: weihnachtspaeckli");
}

if (!process.env.SESSION_SECRET) {
  console.warn("[config] SESSION_SECRET is not set. Tokens will be invalid after each restart.");
}

function jsonHeaders(req) {
  const origin = req.headers.origin;
  const configured = process.env.FRONTEND_ORIGIN || "*";
  const allowed = configured.split(",").map((s) => s.trim()).filter(Boolean);
  const allowOrigin = configured === "*" || allowed.includes("*")
    ? (origin || "*")
    : (origin && allowed.includes(origin) ? origin : allowed[0]);

  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": allowOrigin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function sendJson(req, res, status, payload) {
  res.writeHead(status, jsonHeaders(req));
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function parseBody(req) {
  const raw = await readRequestBody(req);
  const type = (req.headers["content-type"] || "").toLowerCase();
  if (!raw) return {};
  if (type.includes("application/json")) return JSON.parse(raw);
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  return { raw };
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function createToken() {
  const payload = Buffer.from(JSON.stringify({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return false;
  const [payload, signature] = token.split(".");
  if (!timingSafeEqualText(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.exp && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  const [, token] = header.match(/^Bearer\s+(.+)$/i) || [];
  return verifyToken(token);
}

async function loadSeedRows() {
  const seedUrl = new URL("./shifts.seed.json", import.meta.url);
  const seed = JSON.parse(await readFile(seedUrl, "utf8"));
  const rows = [];
  let id = 1;

  for (const day of seed.days || []) {
    for (const block of day.timeBlocks || []) {
      for (const task of block.tasks || []) {
        const places = Number(task.places || 0);
        for (let i = 0; i < places; i += 1) {
          rows.push({
            id: id++,
            date: day.date,
            time: block.time,
            task: task.task,
            status: "open",
            name: null,
            phone_nr: null,
            organisation: null
          });
        }
      }
    }
  }

  return rows;
}

function createMemoryStore(seedRows) {
  let rows = seedRows.map((row) => ({ ...row }));

  return {
    kind: "memory",
    async list(from, to) {
      return rows
        .filter((row) => (!from || row.date >= from) && (!to || row.date <= to))
        .sort((a, b) => `${a.date}|${a.time}|${a.task}|${a.id}`.localeCompare(`${b.date}|${b.time}|${b.task}|${b.id}`));
    },
    async book(id, data) {
      const row = rows.find((item) => item.id === id);
      if (!row) return { status: 404 };
      if (row.status === "taken") return { status: 409 };
      row.status = "taken";
      row.name = data.name;
      row.phone_nr = data.phone_nr || null;
      row.organisation = data.organisation || null;
      return { status: 200, row };
    }
  };
}

function mapDbRow(row) {
  return {
    id: Number(row.id),
    date: row.date,
    time: row.time,
    task: row.task,
    status: row.status,
    name: row.name,
    phone_nr: row.phone_nr,
    organisation: row.organisation
  };
}

async function createPostgresStore(seedRows) {
  const { Pool } = await import("pg");
  const dbUrl = new URL(DATABASE_URL);
  const sslMode = dbUrl.searchParams.get("sslmode");
  const useSsl = sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full" || dbUrl.hostname.includes("railway");

  const pool = new Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    max: Number(process.env.PG_POOL_MAX || 5),
    ssl: useSsl ? { rejectUnauthorized: false } : undefined
  });

  await pool.query("select 1");
  await pool.query(`
    create table if not exists shifts (
      id bigserial primary key,
      shift_date date not null,
      time_range text not null,
      task text not null,
      status text not null default 'open',
      name text,
      phone_nr text,
      organisation text,
      created_at timestamptz not null default now(),
      booked_at timestamptz
    )
  `);

  const { rows: countRows } = await pool.query("select count(*)::int as count from shifts");
  if (countRows[0]?.count === 0) {
    for (const row of seedRows) {
      await pool.query(
        "insert into shifts (shift_date, time_range, task, status) values ($1, $2, $3, 'open')",
        [row.date, row.time, row.task]
      );
    }
    console.log(`[db] Seeded ${seedRows.length} shifts.`);
  }

  return {
    kind: "postgres",
    async list(from, to) {
      const params = [];
      const where = [];
      if (from) {
        params.push(from);
        where.push(`shift_date >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        where.push(`shift_date <= $${params.length}`);
      }
      const { rows } = await pool.query(`
        select id, to_char(shift_date, 'YYYY-MM-DD') as date, time_range as time, task, status, name, phone_nr, organisation
        from shifts
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by shift_date, time_range, task, id
      `, params);
      return rows.map(mapDbRow);
    },
    async book(id, data) {
      const { rows } = await pool.query(`
        update shifts
        set status = 'taken',
            name = $2,
            phone_nr = $3,
            organisation = $4,
            booked_at = now()
        where id = $1 and status = 'open'
        returning id, to_char(shift_date, 'YYYY-MM-DD') as date, time_range as time, task, status, name, phone_nr, organisation
      `, [id, data.name, data.phone_nr || null, data.organisation || null]);

      if (rows[0]) return { status: 200, row: mapDbRow(rows[0]) };

      const exists = await pool.query("select id from shifts where id = $1", [id]);
      return { status: exists.rows[0] ? 409 : 404 };
    }
  };
}

const seedRows = await loadSeedRows();
let store = createMemoryStore(seedRows);
let dbStatus = DATABASE_URL ? "initializing" : "not_configured";
let dbError = null;

if (DATABASE_URL) {
  createPostgresStore(seedRows)
    .then((postgresStore) => {
      store = postgresStore;
      dbStatus = "connected";
      dbError = null;
      console.log("[db] Connected to Postgres.");
    })
    .catch((error) => {
      dbStatus = "error";
      dbError = error.message || String(error);
      console.error("[db] Could not connect to Postgres. Falling back to in-memory store.", error);
    });
} else {
  console.warn("[db] DATABASE_URL is not set. Using in-memory store.");
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, jsonHeaders(req));
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(req, res, 200, {
      ok: true,
      store: store.kind,
      database: {
        configured: Boolean(DATABASE_URL),
        status: dbStatus,
        error: dbError
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendJson(req, res, 200, {
      name: "Aktion Weihnachtspäckli Shiftplan API",
      ok: true,
      store: store.kind,
      database: {
        configured: Boolean(DATABASE_URL),
        status: dbStatus
      },
      endpoints: ["/health", "/auth/login", "/shifts", "/shifts/:id/book"]
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = await parseBody(req);
    if (timingSafeEqualText(body.password || "", ACCESS_PASSWORD)) {
      sendJson(req, res, 200, { token: createToken() });
      return;
    }
    sendJson(req, res, 401, { error: "invalid_password" });
    return;
  }

  if (url.pathname.startsWith("/shifts") && !isAuthorized(req)) {
    sendJson(req, res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/shifts") {
    const from = url.searchParams.get("from_date");
    const to = url.searchParams.get("to_date");
    sendJson(req, res, 200, await store.list(from, to));
    return;
  }

  const bookingMatch = url.pathname.match(/^\/shifts\/(\d+)\/book$/);
  if (req.method === "POST" && bookingMatch) {
    const id = Number(bookingMatch[1]);
    const body = await parseBody(req);
    const name = String(body.name || "").trim();
    if (!name) {
      sendJson(req, res, 422, { error: "name_required" });
      return;
    }

    const result = await store.book(id, {
      name,
      phone_nr: body.phone_nr ? String(body.phone_nr).trim() : null,
      organisation: body.organisation ? String(body.organisation).trim() : null
    });

    if (result.status === 200) sendJson(req, res, 200, result.row);
    else if (result.status === 409) sendJson(req, res, 409, { error: "already_booked" });
    else sendJson(req, res, 404, { error: "shift_not_found" });
    return;
  }

  sendJson(req, res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    sendJson(req, res, error.status || 500, { error: "server_error" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Shiftplan API listening on ${HOST}:${PORT} using ${store.kind}.`);
});
