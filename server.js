import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

import multer from "multer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

import crypto from "crypto";
import fs from "fs/promises";

import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

/* =======================
   Paths
======================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =======================
   ✅ Render proxy support (important for secure cookies + rate limit)
======================= */
app.set("trust proxy", 1); // Render / proxies
app.disable("x-powered-by");

/* =======================
   ✅ Plan settings (Free vs Pro)
======================= */
const FREE_DAILY_LIMIT = 2; // ✅ 2 attempts/day
const FREE_MAX_QUESTIONS = 5; // ✅ limited questions
const FREE_COOLDOWN_MS = 25_000; // ✅ "انتظار" للـ Free فقط (25 ثانية)

const DATA_DIR = path.join(__dirname, "data");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const RESULTS_FILE = path.join(DATA_DIR, "results.json");

/* =======================
   CORS
======================= */
app.use(
  cors({
    origin: [
      "https://wodoh.onrender.com",
      "https://wodoh.org",
      "https://www.wodoh.org",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

/* =======================
   Security headers
======================= */
app.use(
  helmet({
    contentSecurityPolicy: false, // لأن عندك CDN + PayPal + PDF.js
    crossOriginEmbedderPolicy: false,
  })
);

/* =======================
   Cookies
======================= */
app.use(cookieParser());

/* =======================
   Body
   ✅ Keep rawBody for PayPal webhooks verification
======================= */
app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf; // مهم للتحقق من PayPal webhook
    },
  })
);

/* =======================
   Basic rate limit for APIs
======================= */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", apiLimiter);

/* ✅ Rate limit for auth routes only */
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/auth", authLimiter);

/* =======================
   Static
======================= */
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

/* =======================
   ✅ JWT helpers (HttpOnly Cookie)
======================= */
function mustHaveJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error("Missing JWT_SECRET in environment variables");
  }
}

function signToken(payload) {
  mustHaveJwtSecret();
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("wodoh_token", token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie("wodoh_token", { path: "/" });
}

function requireAuth(req, res, next) {
  try {
    mustHaveJwtSecret();
    const token = req.cookies?.wodoh_token;
    if (!token) return res.status(401).json({ ok: false, error: "UNAUTH" });

    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "UNAUTH" });
  }
}

// ✅ Optional auth: لا يكسر أي شيء (لو ما في كوكي يكمل عادي)
function optionalAuth(req, _res, next) {
  try {
    mustHaveJwtSecret();
    const token = req.cookies?.wodoh_token;
    if (!token) {
      req.user = null;
      return next();
    }
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    req.user = null;
    return next();
  }
}

/* =======================
   ✅ Auth endpoints (Step 1)
======================= */
app.post("/api/auth/dev-login", (req, res) => {
  try {
    const token = signToken({
      id: "demo",
      name: "Demo User",
      email: "demo@wodoh",
      subActive: false, // ✅ Free by default
    });
    setAuthCookie(res, token);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

/* =======================
   ✅ Plan helpers
======================= */
function isProUser(req) {
  return !!(req.user && req.user.subActive === true);
}

function clientKey(req) {
  const uid = req.user?.id ? String(req.user.id) : "";
  if (uid) return `u:${uid}`;
  const ip =
    (req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0] : "") ||
    req.ip ||
    "unknown";
  return `ip:${ip.trim()}`;
}

function todayKey() {
  const d = new Date();
  // key per UTC date is fine; if you prefer local server date, keep as is.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw || "") ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
}

// ✅ Free: 2 attempts/day + cooldown
async function enforceFreeLimits(req, res) {
  if (isProUser(req)) return { ok: true };

  const key = clientKey(req);
  const day = todayKey();

  const usage = await readJsonSafe(USAGE_FILE, {});
  usage[day] = usage[day] || {};
  usage[day][key] = usage[day][key] || { count: 0, lastAt: 0 };

  const row = usage[day][key];

  // cooldown
  const now = Date.now();
  if (row.lastAt && now - row.lastAt < FREE_COOLDOWN_MS) {
    const waitMs = FREE_COOLDOWN_MS - (now - row.lastAt);
    return {
      ok: false,
      status: 429,
      body: {
        ok: false,
        error: "WAIT",
        message: "Please wait before trying again.",
        retryAfterMs: waitMs,
      },
    };
  }

  // daily limit
  if ((row.count || 0) >= FREE_DAILY_LIMIT) {
    return {
      ok: false,
      status: 402,
      body: {
        ok: false,
        error: "FREE_LIMIT",
        message: "Daily free limit reached.",
        limit: FREE_DAILY_LIMIT,
      },
    };
  }

  // reserve attempt now (so parallel requests still count)
  row.count = (row.count || 0) + 1;
  row.lastAt = now;

  usage[day][key] = row;
  await writeJsonSafe(USAGE_FILE, usage);

  return { ok: true };
}

async function maybeSaveResult(req, payload) {
  // ✅ Pro only + explicitly requested
  if (!isProUser(req)) return;
  const save = String(payload?.save || "").toLowerCase();
  if (save !== "1" && save !== "true" && save !== "yes") return;

  const results = await readJsonSafe(RESULTS_FILE, []);
  results.push({
    id: crypto.randomUUID(),
    userId: req.user?.id || null,
    createdAt: new Date().toISOString(),
    lang: payload?.lang || "ar",
    meta: {
      questionMode: payload?.questionMode ?? null,
      questionCount: payload?.questionCount ?? null,
      mode: payload?.mode ?? "full",
    },
    sourceText: payload?.sourceText || "",
    outputText: payload?.outputText || "",
  });

  // keep file not too big
  if (results.length > 2000) results.splice(0, results.length - 2000);
  await writeJsonSafe(RESULTS_FILE, results);
}

/* =======================
   Prompt builder (AR/EN/HE)
======================= */
function normalizeLang(lang) {
  const l = String(lang || "").toLowerCase().trim();
  if (l === "he" || l.startsWith("he")) return "he";
  if (l === "en" || l.startsWith("en")) return "en";
  return "ar";
}

function normalizeQuestionMode(qm) {
  const m = String(qm || "").toLowerCase().trim();
  if (m === "mcq" || m === "tf" || m === "both") return m;
  return "both";
}

// ✅ Make summaries longer (scale better)
function summaryPlanByLength(text) {
  const n = String(text || "").trim().length;

  if (n < 1200) return { minParas: 3, maxParas: 4, sentences: "3–5", bullets: 6 };
  if (n < 3000) return { minParas: 4, maxParas: 6, sentences: "3–6", bullets: 8 };
  return { minParas: 6, maxParas: 8, sentences: "3–7", bullets: 10 };
}

/**
 * Backward compatible inputs:
 * - Old:
 *   - count (number) => questions count
 *   - mode ("full" | "more")
 * - New:
 *   - questionCount (number) => overrides count when provided (Pro only)
 *   - questionMode ("both" | "mcq" | "tf") => (Pro only)
 */
function buildPrompts({ text, count, questionCount, mode, questionMode, lang, previous, isPro }) {
  const L = normalizeLang(lang);

  // ✅ Free: ignore questionCount/questionMode (limited)
  const effectiveQuestionMode = isPro ? normalizeQuestionMode(questionMode) : "both";

  const resolvedCountRaw = isPro
    ? (questionCount !== undefined && questionCount !== null && String(questionCount).trim() !== ""
        ? Number(questionCount)
        : Number(count || 5))
    : Number(count || 5);

  const cappedCount = isPro
    ? Math.min(Math.max(Number(resolvedCountRaw || 5), 1), 20)
    : Math.min(Math.max(Number(resolvedCountRaw || 5), 1), FREE_MAX_QUESTIONS);

  const safeCount = cappedCount;

  const isAr = L === "ar";
  const isHe = L === "he";

  const headerSummary = isAr ? "ملخص" : isHe ? "סיכום" : "Summary";
  const headerMCQ = isAr ? "اختيار من متعدد" : isHe ? "רב־ברירה" : "Multiple Choice";
  const headerTF = isAr ? "صح/خطأ" : isHe ? "נכון/לא נכון" : "True/False";

  const ansCorrectLabel = isAr ? "الإجابة الصحيحة" : isHe ? "תשובה נכונה" : "Correct answer";
  const ansLabel = isAr ? "الإجابة" : isHe ? "תשובה" : "Answer";

  const baseRules = isAr
    ? "اكتب كل شيء بالعربية الفصحى فقط."
    : isHe
      ? "כתוב הכול בעברית בלבד."
      : "Write everything in English only.";

  const forbidRepeat =
    Array.isArray(previous) && previous.length
      ? (isAr
          ? `ممنوع تكرار أي سؤال أو إعادة صياغته من القائمة التالية:
${previous.map((q, i) => `${i + 1}) ${q}`).join("\n")}`
          : isHe
            ? `אסור לחזור על שאלה או לנסח מחדש רעיון מהרשימה הבאה:
${previous.map((q, i) => `${i + 1}) ${q}`).join("\n")}`
            : `Do NOT repeat or paraphrase any question from this list:
${previous.map((q, i) => `${i + 1}) ${q}`).join("\n")}`)
      : "";

  const plan = summaryPlanByLength(text);

  const summaryInstruction = isAr
    ? `1) [${headerSummary}] اكتب ملخصًا مكوّنًا من:
- فقرات (${plan.minParas} إلى ${plan.maxParas} فقرات). كل فقرة ${plan.sentences} جمل.
- ثم اكتب بعد الفقرات مباشرة نقاطًا مختصرة (Bullet Points) عددها ${plan.bullets} على الأقل، تبدأ كل نقطة بـ "- ".
اجعل الطول يتناسب مع طول النص (النص الأطول = تفاصيل أكثر).`
    : isHe
      ? `1) [${headerSummary}] כתוב סיכום שמורכב מ:
- פסקאות (${plan.minParas}–${plan.maxParas} פסקאות). בכל פסקה ${plan.sentences} משפטים.
- ואז מיד לאחר הפסקאות, כתוב נקודות Bullet קצרות (לפחות ${plan.bullets}), כל נקודה מתחילה ב "- ".
האורך צריך להתאים לאורך הטקסט (טקסט ארוך יותר = יותר פירוט).`
      : `1) [${headerSummary}] Write a summary consisting of:
- Paragraphs (${plan.minParas}–${plan.maxParas} paragraphs). Each paragraph ${plan.sentences} sentences.
- Then immediately after the paragraphs, add bullet points (at least ${plan.bullets}), each bullet must start with "- ".
Length should scale with the text (longer text = more detail).`;

  const mcqInstruction = isAr
    ? `2) [${headerMCQ}] أنشئ ${safeCount} سؤال اختيار من متعدد بصيغة A/B/C/D وحدد ${ansCorrectLabel}: A`
    : isHe
      ? `2) [${headerMCQ}] צור ${safeCount} שאלות רב־ברירה A/B/C/D וציין ${ansCorrectLabel}: A`
      : `2) [${headerMCQ}] Create ${safeCount} MCQ questions A/B/C/D and specify ${ansCorrectLabel}: A`;

  const tfInstruction = isAr
    ? `3) [${headerTF}] أنشئ ${safeCount} سؤال ${headerTF}. اكتب في سطر الإجابة ${ansLabel}: T أو F فقط.`
    : isHe
      ? `3) [${headerTF}] צור ${safeCount} שאלות ${headerTF}. בשורת התשובה כתוב ${ansLabel}: T או F בלבד.`
      : `3) [${headerTF}] Create ${safeCount} ${headerTF} questions. In the answer line write ${ansLabel}: T or F only.`;

  const wantsMCQ = effectiveQuestionMode === "both" || effectiveQuestionMode === "mcq";
  const wantsTF = effectiveQuestionMode === "both" || effectiveQuestionMode === "tf";
  const includeSummary = mode !== "more";

  const sectionsExample = [
    includeSummary
      ? `[${headerSummary}]
Paragraph 1...

Paragraph 2...

- Bullet point 1
- Bullet point 2`
      : null,

    wantsMCQ
      ? `[${headerMCQ}]
1) ...
A) ...
B) ...
C) ...
D) ...
${ansCorrectLabel}: A`
      : null,

    wantsTF
      ? `[${headerTF}]
1) ... (${headerTF})
${ansLabel}: T`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  // full prompt
  if (mode !== "more") {
    const parts = [];
    parts.push("You are an educational assistant.");
    parts.push(baseRules);
    parts.push("");
    parts.push("Requirements:");
    if (includeSummary) parts.push(summaryInstruction);
    if (wantsMCQ) parts.push(mcqInstruction);
    if (wantsTF) parts.push(tfInstruction);
    parts.push("");
    parts.push("Follow EXACT format:");
    parts.push("");
    parts.push(sectionsExample);
    parts.push("");
    parts.push("Text:");
    parts.push(text);

    return { prompt: parts.join("\n").trim(), lang: L };
  }

  // more prompt (questions only)
  const moreReq = [];
  if (wantsMCQ) moreReq.push(mcqInstruction);
  if (wantsTF) moreReq.push(tfInstruction);

  const noRepeatLine = isAr
    ? "✋ ممنوع التكرار أو إعادة الصياغة لنفس الفكرة."
    : isHe
      ? "✋ אסור לחזור על אותו רעיון או לנסח אותו מחדש."
      : "✋ No repeats or paraphrases.";

  const promptMore = `
You are an educational assistant.
${baseRules}

${forbidRepeat}

Requirements (questions only, no summary):
${moreReq.join("\n")}

${noRepeatLine}

Follow EXACT format:

${sectionsExample}

Text:
${text}
`.trim();

  return { prompt: promptMore, lang: L };
}

function errMsg(lang, type) {
  const L = normalizeLang(lang);
  const ar = L === "ar";
  const he = L === "he";

  if (type === "empty") return ar ? "النص فارغ" : he ? "הטקסט ריק" : "Text is empty";
  if (type === "noKey") return ar ? "GEMINI_API_KEY غير موجود في .env" : he ? "חסר GEMINI_API_KEY בקובץ .env" : "GEMINI_API_KEY is missing in .env";
  if (type === "rate") return ar ? "تم الوصول للحد المؤقت. انتظر قليلًا ثم أعد المحاولة." : he ? "הגעת למגבלת קצב. המתן מעט ונסה שוב." : "Rate limit reached. Please wait and try again.";
  if (type === "genErr") return ar ? "حدث خطأ أثناء الإنشاء. حاول لاحقًا." : he ? "אירעה שגיאה ביצירה. נסה שוב מאוחר יותר." : "Error generating content. Please try again later.";
  if (type === "noText") return ar ? "لم يتم إرجاع نص" : he ? "לא הוחזר טקסט" : "No text returned";
  if (type === "noFile") return ar ? "لا يوجد ملف" : he ? "אין קובץ" : "No file uploaded";
  if (type === "badType") return ar ? "نوع الملف غير مدعوم. استخدم TXT أو PDF أو DOCX" : he ? "סוג קובץ לא נתמך. השתמש ב-TXT / PDF / DOCX" : "Unsupported file type. Use TXT, PDF, or DOCX";
  if (type === "noExtract") return ar ? "لم يتم استخراج نص من الملف" : he ? "לא חולץ טקסט מהקובץ" : "No text extracted from file";
  return "Server error";
}

async function callGemini(prompt, apiKey) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
    apiKey;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });

  const data = await response.json();
  return { response, data };
}

/* =======================
   JSON: /api/generate
   ✅ Plan split applied here
======================= */
app.post("/api/generate", optionalAuth, async (req, res) => {
  try {
    // ✅ enforce Free limits
    const limit = await enforceFreeLimits(req, res);
    if (!limit.ok) return res.status(limit.status).json(limit.body);

    const text = String(req.body?.text || "").trim();
    const mode = String(req.body?.mode || "full");

    // old param
    const count = Number(req.body?.count || 5);

    // new params (Pro only)
    const questionCount = req.body?.questionCount;
    const questionMode = req.body?.questionMode;

    const lang = normalizeLang(req.body?.lang || "ar");
    const previous = Array.isArray(req.body?.previous) ? req.body.previous : [];

    if (!text) return res.status(400).json({ error: errMsg(lang, "empty") });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: errMsg(lang, "noKey") });

    const { prompt } = buildPrompts({
      text,
      count,
      questionCount,
      mode,
      questionMode,
      lang,
      previous,
      isPro: isProUser(req),
    });

    const { response, data } = await callGemini(prompt, apiKey);

    if (!response.ok) {
      if (response.status === 429) return res.status(429).json({ error: errMsg(lang, "rate") });
      return res.status(500).json({ error: errMsg(lang, "genErr") });
    }

    const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!result) return res.status(500).json({ error: errMsg(lang, "noText") });

    // ✅ Pro: save results if requested
    await maybeSaveResult(req, {
      save: req.body?.save,
      lang,
      mode,
      questionMode,
      questionCount,
      sourceText: text,
      outputText: result,
    });

    res.json({ text: result, sourceText: text, pro: isProUser(req) });
  } catch (err) {
    res.status(500).json({ error: "Server error", details: String(err) });
  }
});

/* =======================
   FILE: /api/generate-file
   ✅ Plan split applied here too
======================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

app.post("/api/generate-file", optionalAuth, upload.single("file"), async (req, res) => {
  try {
    // ✅ enforce Free limits
    const limit = await enforceFreeLimits(req, res);
    if (!limit.ok) return res.status(limit.status).json(limit.body);

    const file = req.file;
    const mode = String(req.body?.mode || "full");

    // old param
    const count = Number(req.body?.count || 5);

    // new params (Pro only)
    const questionCount = req.body?.questionCount;
    const questionMode = req.body?.questionMode;

    const lang = normalizeLang(req.body?.lang || "ar");

    let previous = [];
    try {
      previous = req.body?.previous ? JSON.parse(req.body.previous) : [];
      if (!Array.isArray(previous)) previous = [];
    } catch {
      previous = [];
    }

    if (!file) return res.status(400).json({ error: errMsg(lang, "noFile") });

    let text = "";
    const name = (file.originalname || "").toLowerCase();
    const mimetype = (file.mimetype || "").toLowerCase();

    if (name.endsWith(".txt") || mimetype.includes("text/plain")) {
      text = file.buffer.toString("utf8");
    } else if (name.endsWith(".pdf") || mimetype.includes("pdf")) {
      const parsed = await pdfParse(file.buffer);
      text = parsed.text || "";
    } else if (name.endsWith(".docx") || mimetype.includes("wordprocessingml")) {
      const r = await mammoth.extractRawText({ buffer: file.buffer });
      text = r.value || "";
    } else {
      return res.status(400).json({ error: errMsg(lang, "badType") });
    }

    text = String(text).trim();
    if (!text) return res.status(400).json({ error: errMsg(lang, "noExtract") });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: errMsg(lang, "noKey") });

    const { prompt } = buildPrompts({
      text,
      count,
      questionCount,
      mode,
      questionMode,
      lang,
      previous,
      isPro: isProUser(req),
    });

    const { response, data } = await callGemini(prompt, apiKey);

    if (!response.ok) {
      if (response.status === 429) return res.status(429).json({ error: errMsg(lang, "rate") });
      return res.status(500).json({ error: errMsg(lang, "genErr") });
    }

    const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!result) return res.status(500).json({ error: errMsg(lang, "noText") });

    // ✅ Pro: save results if requested
    await maybeSaveResult(req, {
      save: req.body?.save,
      lang,
      mode,
      questionMode,
      questionCount,
      sourceText: text,
      outputText: result,
    });

    res.json({ text: result, sourceText: text, pro: isProUser(req) });
  } catch (err) {
    res.status(500).json({ error: "Server error", details: String(err) });
  }
});

/* =======================
   PayPal (Webhook + Verify)
======================= */
function paypalBase() {
  const mode = String(process.env.PAYPAL_MODE || "live").toLowerCase();
  return mode === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
}

app.get("/api/paypal/webhook-health", (req, res) => {
  res.json({
    ok: true,
    mode: String(process.env.PAYPAL_MODE || "live"),
    hasWebhookId: !!process.env.PAYPAL_WEBHOOK_ID,
    hasClientId: !!process.env.PAYPAL_CLIENT_ID,
    hasClientSecret: !!process.env.PAYPAL_CLIENT_SECRET,
  });
});

let paypalTokenCache = { token: "", exp: 0 };

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET");

  const now = Date.now();
  if (paypalTokenCache.token && paypalTokenCache.exp > now + 10_000) return paypalTokenCache.token;

  const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const resp = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`PayPal token failed: ${resp.status} ${t}`);
  }

  const data = await resp.json();
  const token = data.access_token;
  const expires = Number(data.expires_in || 300);
  paypalTokenCache = { token, exp: now + expires * 1000 };
  return token;
}

async function verifyPayPalWebhookSignature(reqHeaders, webhookEvent) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error("Missing PAYPAL_WEBHOOK_ID");

  const token = await getPayPalAccessToken();

  const payload = {
    auth_algo: reqHeaders["paypal-auth-algo"],
    cert_url: reqHeaders["paypal-cert-url"],
    transmission_id: reqHeaders["paypal-transmission-id"],
    transmission_sig: reqHeaders["paypal-transmission-sig"],
    transmission_time: reqHeaders["paypal-transmission-time"],
    webhook_id: webhookId,
    webhook_event: webhookEvent,
  };

  const resp = await fetch(`${paypalBase()}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`verify-webhook-signature failed: ${resp.status}`);

  return data?.verification_status === "SUCCESS";
}

/* local storage (simple) */
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");

async function readSubs() {
  try {
    const raw = await fs.readFile(SUBS_FILE, "utf8");
    return JSON.parse(raw || "{}") || {};
  } catch {
    return {};
  }
}

async function writeSubs(obj) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SUBS_FILE, JSON.stringify(obj, null, 2), "utf8");
}

/* =======================
   Users storage (local)
======================= */
const USERS_FILE = path.join(DATA_DIR, "users.json");

async function readUsers() {
  try {
    const raw = await fs.readFile(USERS_FILE, "utf8");
    return JSON.parse(raw || "[]") || [];
  } catch {
    return [];
  }
}

async function writeUsers(users) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function mapStatusFromEventType(eventType, resource) {
  switch (eventType) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
      return "ACTIVE";
    case "BILLING.SUBSCRIPTION.CANCELLED":
      return "CANCELLED";
    case "BILLING.SUBSCRIPTION.SUSPENDED":
      return "SUSPENDED";
    case "BILLING.SUBSCRIPTION.EXPIRED":
      return "EXPIRED";
    case "BILLING.SUBSCRIPTION.UPDATED":
      return String(resource?.status || "UPDATED").toUpperCase();
    case "BILLING.SUBSCRIPTION.CREATED":
      return "CREATED";
    case "BILLING.SUBSCRIPTION.RE-ACTIVATED":
    case "BILLING.SUBSCRIPTION.REACTIVATED":
      return "ACTIVE";
    default:
      return "UNKNOWN";
  }
}

app.post("/api/paypal/webhook", async (req, res) => {
  try {
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [String(k).toLowerCase(), v])
    );
    const event = req.body;

    if (!event || !event.event_type) {
      return res.status(400).json({ ok: false, error: "Bad webhook payload" });
    }

    const ok = await verifyPayPalWebhookSignature(headers, event);
    if (!ok) return res.status(400).json({ ok: false, error: "Invalid signature" });

    const eventType = event.event_type;
    const resource = event.resource || {};
    const subId = resource.id || resource?.billing_agreement_id || resource?.subscription_id;

    if (subId) {
      const subs = await readSubs();
      subs[subId] = {
        id: subId,
        status: mapStatusFromEventType(eventType, resource),
        updatedAt: new Date().toISOString(),
        eventType,
      };
      await writeSubs(subs);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/subscription/verify", async (req, res) => {
  try {
    const subscriptionId = String(req.body?.subscriptionId || "").trim();
    if (!subscriptionId) return res.status(400).json({ ok: false, error: "Missing subscriptionId" });

    const token = await getPayPalAccessToken();
    const resp = await fetch(`${paypalBase()}/v1/billing/subscriptions/${subscriptionId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(500).json({ ok: false, error: "PayPal verify failed", details: data });

    const status = String(data?.status || "").toUpperCase();
    const active = status === "ACTIVE";

    const subs = await readSubs();
    subs[subscriptionId] = {
      id: subscriptionId,
      status,
      updatedAt: new Date().toISOString(),
      source: "verify",
    };
    await writeSubs(subs);

    res.json({ ok: true, active, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/subscription/status", async (req, res) => {
  const subId = String(req.query?.subId || "").trim();
  if (!subId) return res.status(400).json({ ok: false, error: "Missing subId" });

  const subs = await readSubs();
  const row = subs[subId];
  res.json({ ok: true, found: !!row, data: row || null });
});

app.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
});
