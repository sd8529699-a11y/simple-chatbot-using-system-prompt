require("dotenv").config({ path: require("path").join(__dirname, ".env") });
{
  const envPath = require("path").join(__dirname, ".env");
  const exists = require("fs").existsSync(envPath);
  console.log("---- .env check ----");
  console.log(".env dhoondh raha hoon yahan:", envPath);
  console.log(".env file mili?:", exists ? "HAAN" : "NAHI (file ka naam ya folder galat hai)");
  console.log("PROVIDER:", process.env.PROVIDER || "(set nahi, default anthropic)");
  console.log("Gemini key:", process.env.GEMINI_API_KEY ? "mili (" + process.env.GEMINI_API_KEY.length + " characters)" : "nahi mili / khali hai");
  console.log("--------------------");
}
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// System prompt: system_prompt.txt se padhta hai (har request par, taaki restart ke bina badal sake)
function loadSystemPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, "system_prompt.txt"), "utf8").trim();
  } catch {
    return "You are a helpful assistant. Reply in the same language the user writes in.";
  }
}

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-env";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

// ---------- Database (aapka apna base: users.db file) ----------
const db = new Database(path.join(__dirname, "users.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

function setAuthCookie(res, user) {
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 3600 * 1000 });
}

function requireAuth(req, res, next) {
  try {
    req.user = jwt.verify(req.cookies.token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Pehle login karo." });
  }
}

// ---------- Auth routes ----------
app.post("/api/signup", (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email aur password teeno chahiye." });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Email sahi nahi hai." });
  if (password.length < 6) return res.status(400).json({ error: "Password kam se kam 6 character ka rakho." });

  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db
      .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
      .run(name.trim(), email.trim().toLowerCase(), hash);
    setAuthCookie(res, { id: info.lastInsertRowid, name: name.trim(), email: email.trim().toLowerCase() });
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Ye email pehle se registered hai." });
    console.error(e);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email aur password do." });
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Email ya password galat hai." });
  }
  setAuthCookie(res, user);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ name: req.user.name, email: req.user.email });
});

// ---------- AI chat route ----------
// .env me PROVIDER=anthropic | gemini | openai chun sakte ho
const PROVIDER = (process.env.PROVIDER || "gemini").toLowerCase();

class ConfigError extends Error {}

async function askAI(system, history) {
  if (PROVIDER === "gemini") {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new ConfigError("Server par GEMINI_API_KEY set nahi hai.");
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || "Gemini API error");
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  }

  if (PROVIDER === "openai") {
    // OpenAI aur OpenAI-jaisi API wali companies (Groq, OpenRouter, DeepSeek...) ke liye
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new ConfigError("Server par OPENAI_API_KEY set nahi hai.");
    const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...history] }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || "OpenAI API error");
    return data.choices?.[0]?.message?.content || "";
  }

  // default: Anthropic
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ConfigError("Server par gemini ki api set nahi hai");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages: history }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "gemini API error");
  return data.content?.map((c) => c.text || "").join("") || "";
}

app.post("/api/chat", requireAuth, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "Koi message nahi mila." });

  const history = messages.slice(-20).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }));
  const system = `${loadSystemPrompt()}\n\nThe user's name is ${req.user.name}.`;

  try {
    const reply = await askAI(system, history);
    res.json({ reply });
  } catch (e) {
    console.error(e);
    if (e instanceof ConfigError) return res.status(500).json({ error: e.message });
    res.status(502).json({ error: e.message || "AI se connect nahi ho paya." });
  }
});

app.listen(PORT, () => console.log(`Server chal raha hai: http://localhost:${PORT}`));