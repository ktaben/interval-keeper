// Fit Bites break reminders: stores push subscriptions in D1 and, once a minute,
// sends a reminder to anyone whose break is due within their working hours.
import { buildPushHTTPRequest } from "@pushforge/builder";

const ORIGINS = ["https://ktaben.github.io", "http://localhost:8765"];
const CONTACT = "https://ktaben.github.io/interval-keeper/";
const BITES = [
  "2-min squats", "a 10-min walk", "1-min plank", "3 min of stairs", "a 5-min stretch",
  "2-min wall push-ups", "4-min desk mobility", "a 5-min dance break",
];

const DEFAULTS = { on: true, every: 50, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5], tz: "UTC" };

function cleanSettings(s = {}) {
  const hhmm = v => (/^\d{2}:\d{2}$/.test(v) ? v : null);
  let tz = DEFAULTS.tz;
  try { if (s.tz) { new Intl.DateTimeFormat("en-US", { timeZone: s.tz }); tz = s.tz; } } catch {}
  return {
    on: s.on !== false,
    every: [30, 45, 50, 60, 90].includes(+s.every) ? +s.every : DEFAULTS.every,
    start: hhmm(s.start) || DEFAULTS.start,
    end: hhmm(s.end) || DEFAULTS.end,
    days: Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter(d => d >= 0 && d <= 6))] : DEFAULTS.days,
    tz,
  };
}

const mins = hhmm => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

// Local weekday (0 = Sunday) and minutes since midnight in the given time zone.
function localNow(now, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { day, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

// When the next reminder is due (ms), or null if not today.
function nextDue(row, now) {
  const s = JSON.parse(row.settings);
  if (!s.on) return null;
  const { day, minute } = localNow(now, s.tz);
  const start = mins(s.start), end = mins(s.end);
  const dayStart = now - (minute - start) * 60000 - (now % 60000);
  const anchor = Math.max(row.last_ack || 0, row.last_sent || 0, row.paused_until || 0, dayStart);
  const due = anchor + s.every * 60000;
  const dueMinute = minute + Math.round((due - now) / 60000);
  if (!s.days.includes(day) || dueMinute >= end) return null;
  return due;
}

async function send(env, row, payload) {
  try { return await sendOnce(env, row, payload); } catch (e) { console.log("push failed", row.id, String(e)); return "error"; }
}
async function sendOnce(env, row, payload) {
  const req = await buildPushHTTPRequest({
    privateJWK: env.VAPID_PRIVATE_JWK,
    subscription: JSON.parse(row.sub),
    message: { payload, adminContact: CONTACT, options: { ttl: 900, urgency: "high", topic: "break" } },
  });
  const res = await fetch(req.endpoint, { method: "POST", headers: req.headers, body: req.body });
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(row.id).run();
    return "gone";
  }
  return res.ok ? "sent" : `error ${res.status}`;
}

function reminder(every) {
  const bite = BITES[Math.floor(Math.random() * BITES.length)];
  return { title: "Time for a Fit Bite", body: `${every} minutes since your last break. How about ${bite}?`, url: "./#bites" };
}

async function runReminders(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT * FROM subs").all();
  for (const row of results) {
    const s = JSON.parse(row.settings);
    const { day, minute } = localNow(now, s.tz);
    if (!s.on || (row.paused_until || 0) > now || !s.days.includes(day)) continue;
    if (minute < mins(s.start) || minute >= mins(s.end)) continue;
    const due = nextDue(row, now);
    if (due === null || now < due - 30000) continue;
    const result = await send(env, row, reminder(s.every));
    if (result === "sent") await env.DB.prepare("UPDATE subs SET last_sent = ? WHERE id = ?").bind(now, row.id).run();
  }
}

function cors(req) {
  const o = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
const json = (req, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(req) } });

async function status(env, id) {
  const row = await env.DB.prepare("SELECT * FROM subs WHERE id = ?").bind(id).first();
  if (!row) return null;
  return { settings: JSON.parse(row.settings), nextAt: nextDue(row, Date.now()), pausedUntil: row.paused_until || 0 };
}

async function handle(req, env) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const id = String(body.id || url.searchParams.get("id") || "");
  const now = Date.now();

  if (url.pathname === "/subscribe" && req.method === "POST") {
    const sub = body.subscription;
    if (!/^https:\/\//.test(sub?.endpoint || "") || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(req, { error: "Missing subscription" }, 400);
    const newId = /^[a-z0-9]{20,40}$/.test(id) ? id : crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare(`INSERT INTO subs (id, sub, settings, last_ack, last_sent, paused_until, created) VALUES (?, ?, ?, ?, 0, 0, ?)
      ON CONFLICT(id) DO UPDATE SET sub = excluded.sub, settings = excluded.settings`)
      .bind(newId, JSON.stringify(sub), JSON.stringify(cleanSettings(body.settings)), now, now).run();
    return json(req, { id: newId, ...(await status(env, newId)) });
  }
  if (!/^[a-z0-9]{20,40}$/.test(id)) return json(req, { error: "Unknown device" }, 404);
  const exists = await env.DB.prepare("SELECT id FROM subs WHERE id = ?").bind(id).first();
  if (!exists) return json(req, { error: "Unknown device" }, 404);

  if (url.pathname === "/status") return json(req, await status(env, id));
  if (req.method !== "POST") return json(req, { error: "Not found" }, 404);

  if (url.pathname === "/settings") {
    await env.DB.prepare("UPDATE subs SET settings = ? WHERE id = ?").bind(JSON.stringify(cleanSettings(body.settings)), id).run();
  } else if (url.pathname === "/ack") {
    await env.DB.prepare("UPDATE subs SET last_ack = ? WHERE id = ?").bind(now, id).run();
  } else if (url.pathname === "/pause") {
    const m = Math.max(0, Math.min(24 * 60, +body.minutes || 0));
    await env.DB.prepare("UPDATE subs SET paused_until = ? WHERE id = ?").bind(m ? now + m * 60000 : 0, id).run();
  } else if (url.pathname === "/test") {
    const row = await env.DB.prepare("SELECT * FROM subs WHERE id = ?").bind(id).first();
    const result = await send(env, row, { title: "Fit Bites", body: "Reminders are on. This is what a break reminder looks like.", url: "./#bites" });
    return json(req, { result });
  } else if (url.pathname === "/unsubscribe") {
    await env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(id).run();
    return json(req, { ok: true });
  } else return json(req, { error: "Not found" }, 404);
  return json(req, await status(env, id));
}

export default {
  fetch: (req, env) => handle(req, env).catch(e => json(req, { error: "Server error" }, 500)),
  scheduled: (event, env, ctx) => ctx.waitUntil(runReminders(env)),
};
