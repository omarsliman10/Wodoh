import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

import multer from "multer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

import fs from "fs";
import fsp from "fs/promises";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ==========================================
   IMPORTANT: Keep rawBody for PayPal webhooks
   - PayPal webhook signature verification needs the exact raw bytes
========================================== */
app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      // store raw body for webhook verification
      req.rawBody = buf;
    },
  })
);

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

/* =======================
   Prompt builder (AR/EN/HE)
======================= */
function normalizeLang(lang) {
  const l = String(lang || "").toLowerCase().trim();
  if (l === "he" || l.startsWith("he")) return "he";
  if (l === "en" || l.startsWith("en")) return "en";
  return "ar";
}

// ✅ Make summaries longer (scale better)
function summaryPlanByLength(text) {
  const n = String(text || "").trim().length;

  // short text
  if (n < 1200) return { minParas: 3, maxParas: 4, sentences: "3–5" };
  // medium text
  if (n < 3000) return { minParas: 4, maxParas: 6, sentences: "3–6" };
  // long text
  return { minParas: 6, maxParas: 8, sentences: "3–7" };
}

function buildPrompts({ text, count, mode, lang, previous }) {
  const safeCount = Math.min(Math.max(Number(count || 5), 1), 20);
  const L = normalizeLang(lang);

  const isAr = L === "ar";
  const isHe = L === "he";
  const isEn = L === "en";

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
    ? `1) [${headerSummary}] اكتب ملخصًا على شكل فقرات (${plan.minParas} إلى ${plan.maxParas} فقرات). كل فقرة ${plan.sentences} جمل. اجعل الطول يتناسب مع طول النص (النص الأطول = تفاصيل أكثر).`
    : isHe
      ? `1) [${headerSummary}] כתוב סיכום בפסקאות (${plan.minParas}–${plan.maxParas} פסקאות). בכל פסקה ${plan.sentences} משפטים. האורך צריך להתאים לאורך הטקסט (טקסט ארוך יותר = יותר פירוט).`
      : `1) [${headerSummary}] Write a paragraph-style summary (${plan.minParas}–${plan.maxParas} paragraphs). Each paragraph ${plan.sentences} sentences. Length should scale with the text (longer text = more detail).`;

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

  const formatBlock = `
Follow EXACT format:

[${headerSummary}]
Paragraph 1...

Paragraph 2...

[${headerMCQ}]
1) ...
A) ...
B) ...
C) ...
D) ...
${ansCorrectLabel}: A

[${headerTF}]
1) ... (${headerTF})
${ansLabel}: T
`.trim();

  const promptFull = `
You are an educational assistant.
${baseRules}

Requirements:
${summaryInstruction}
${mcqInstruction}
${tfInstruction}

${formatBlock}

Text:
${text}
`.trim();

  // ✅ Localized "more" requirements (no English leaking into AR/HE)
  const moreReq = isAr
    ? `المطلوب (أسئلة فقط بدون ملخص):
1) [${headerMCQ}] أنشئ ${safeCount} سؤال جديد تمامًا (A/B/C/D) وحدد ${ansCorrectLabel}: A
2) [${headerTF}] أنشئ ${safeCount} سؤال ${headerTF}. في سطر الإجابة اكتب ${ansLabel}: T أو F فقط.`
    : isHe
      ? `דרישות (שאלות בלבד ללא סיכום):
1) [${headerMCQ}] צור ${safeCount} שאלות חדשות לחלוטין (A/B/C/D) וציין ${ansCorrectLabel}: A
2) [${headerTF}] צור ${safeCount} שאלות ${headerTF}. בשורת התשובה כתוב ${ansLabel}: T או F בלבד.`
      : `Requirements (questions only, no summary):
1) [${headerMCQ}] Create ${safeCount} brand-new MCQ (A/B/C/D) and specify ${ansCorrectLabel}: A
2) [${headerTF}] Create ${safeCount} brand-new ${headerTF}. In the answer line write ${ansLabel}: T or F only.`;

  const noRepeatLine = isAr
    ? "✋ ممنوع التكرار أو إعادة الصياغة لنفس الفكرة."
    : isHe
      ? "✋ אסור לחזור על אותו רעיון או לנסח אותו מחדש."
      : "✋ No repeats or paraphrases.";

  const promptMore = `
You are an educational assistant.
${baseRules}

${forbidRepeat}

${moreReq}

${noRepeatLine}

Follow EXACT format:

[${headerMCQ}]
1) ...
A) ...
B) ...
C) ...
D) ...
${ansCorrectLabel}: A

[${headerTF}]
1) ... (${headerTF})
${ansLabel}: T

Text:
${text}
`.trim();

  return { prompt: mode === "more" ? promptMore : promptFull, lang: L };
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

/* =====================================================
   ✅ PayPal: Server-side verification + Webhook storage
   ENV required:
   - PAYPAL_CLIENT_ID=...
   - PAYPAL_CLIENT_SECRET=...
   - PAYPAL_WEBHOOK_ID=...   (Webhook ID from PayPal dashboard)
   Optional:
   - PAYPAL_MODE=live|sandbox  (default: live)
   - PAYPAL_API_BASE=https://api-m.paypal.com (live) OR https://api-m.sandbox.paypal.com
===================================================== */

const PAYPAL_MODE = (process.env.PAYPAL_MODE || "").toLowerCase().trim();
const PAYPAL_API_BASE =
  process.env.PAYPAL_API_BASE ||
  (PAYPAL_MODE === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com");

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || "";

// Simple local storage (safe for MVP). Replace with DB later.
const DATA_DIR = path.join(__dirname, "data");
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");

async function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SUBS_FILE)) {
    await fsp.writeFile(SUBS_FILE, JSON.stringify({ subscriptions: {} }, null, 2), "utf8");
  }
}

async function readSubs() {
  await ensureDataFile();
  const raw = await fsp.readFile(SUBS_FILE, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return { subscriptions: {} };
  }
}

async function writeSubs(db) {
  await ensureDataFile();
  const tmp = SUBS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fsp.rename(tmp, SUBS_FILE);
}

function isActiveStatus(status) {
  // PayPal subscription statuses can include: APPROVAL_PENDING, APPROVED, ACTIVE, SUSPENDED, CANCELLED, EXPIRED
  // We treat ACTIVE as active. You can also treat APPROVED as active depending on your flow.
  return String(status || "").toUpperCase() === "ACTIVE";
}

async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET");
  }

  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await r.json();
  if (!r.ok || !data?.access_token) {
    throw new Error(`PayPal token error: ${r.status} ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function fetchSubscriptionFromPayPal(subscriptionId) {
  const token = await getPayPalAccessToken();
  const r = await fetch(`${PAYPAL_API_BASE}/v1/billing/subscriptions/${subscriptionId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`PayPal subscription fetch failed: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

async function verifyPayPalWebhook(req) {
  // PayPal recommends verifying webhook signature using /v1/notifications/verify-webhook-signature
  if (!PAYPAL_WEBHOOK_ID) throw new Error("Missing PAYPAL_WEBHOOK_ID");

  const token = await getPayPalAccessToken();

  const transmissionId = req.header("paypal-transmission-id");
  const transmissionTime = req.header("paypal-transmission-time");
  const certUrl = req.header("paypal-cert-url");
  const authAlgo = req.header("paypal-auth-algo");
  const transmissionSig = req.header("paypal-transmission-sig");

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    throw new Error("Missing PayPal webhook headers");
  }

  const webhookEvent = req.body; // parsed JSON
  const raw = req.rawBody; // exact bytes captured by express.json verify

  // PayPal expects the exact webhook event object and the exact raw body string for some implementations.
  // In practice, sending the parsed body works, while the "webhook_event" is the JSON object.
  // We'll send webhook_event parsed + required headers.
  const payload = {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: PAYPAL_WEBHOOK_ID,
    webhook_event: webhookEvent,
  };

  const r = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`Verify webhook failed: ${r.status} ${JSON.stringify(data)}`);

  const status = String(data?.verification_status || "");
  if (status !== "SUCCESS") {
    throw new Error(`Webhook signature not verified: ${status}`);
  }

  return true;
}

async function upsertSubscriptionStatus(subscriptionId, patch) {
  const db = await readSubs();
  db.subscriptions = db.subscriptions || {};
  const current = db.subscriptions[subscriptionId] || {};
  db.subscriptions[subscriptionId] = {
    ...current,
    ...patch,
    subscriptionId,
    updatedAt: new Date().toISOString(),
  };
  await writeSubs(db);
  return db.subscriptions[subscriptionId];
}

/* ===========================
   ✅ PayPal Webhook endpoint
   Add this URL to PayPal dashboard:
   https://YOUR_DOMAIN/api/paypal/webhook
=========================== */
app.post("/api/paypal/webhook", async (req, res) => {
  try {
    // 1) verify signature
    await verifyPayPalWebhook(req);

    // 2) handle event
    const eventType = String(req.body?.event_type || "");
    const resource = req.body?.resource || {};

    // For subscription events, resource.id is usually the subscription ID
    const subscriptionId = resource?.id || resource?.billing_agreement_id || null;

    // If you pass custom_id in create subscription (recommended), it arrives here:
    // resource.custom_id (depends on integration)
    const customId = resource?.custom_id || resource?.custom || null;

    if (subscriptionId) {
      // Map PayPal events to status updates
      // Common subscription events:
      // BILLING.SUBSCRIPTION.ACTIVATED
      // BILLING.SUBSCRIPTION.CANCELLED
      // BILLING.SUBSCRIPTION.SUSPENDED
      // BILLING.SUBSCRIPTION.EXPIRED
      // BILLING.SUBSCRIPTION.UPDATED
      // BILLING.SUBSCRIPTION.CREATED / APPROVED (depending)
      let nextStatus = null;

      if (eventType.includes("BILLING.SUBSCRIPTION.")) {
        // If resource has status, trust it
        if (resource?.status) nextStatus = resource.status;
        else {
          // fallback mapping
          if (eventType.endsWith(".ACTIVATED")) nextStatus = "ACTIVE";
          if (eventType.endsWith(".CANCELLED")) nextStatus = "CANCELLED";
          if (eventType.endsWith(".SUSPENDED")) nextStatus = "SUSPENDED";
          if (eventType.endsWith(".EXPIRED")) nextStatus = "EXPIRED";
          if (eventType.endsWith(".APPROVED")) nextStatus = "APPROVED";
        }
      }

      const saved = await upsertSubscriptionStatus(subscriptionId, {
        status: nextStatus || resource?.status || "UNKNOWN",
        eventType,
        customId,
        lastEventId: req.body?.id || null,
      });

      return res.json({ ok: true, saved });
    }

    // If event not related to subscription or missing id, still ACK it.
    res.json({ ok: true, note: "Webhook received (no subscription id found)", eventType });
  } catch (err) {
    // Important: PayPal expects 2xx if you want to avoid retries.
    // But if verification fails, better return 400/401 so it retries (and you can debug).
    res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

/* ==========================================
   ✅ Server-side subscription check endpoints
   - Use these instead of trusting frontend
========================================== */

// Fetch latest from PayPal + update local storage
app.get("/api/subscription/status", async (req, res) => {
  try {
    const subscriptionId = String(req.query?.subId || "").trim();
    if (!subscriptionId) return res.status(400).json({ ok: false, error: "Missing subId" });

    const paypalData = await fetchSubscriptionFromPayPal(subscriptionId);
    const status = paypalData?.status || "UNKNOWN";

    const saved = await upsertSubscriptionStatus(subscriptionId, {
      status,
      lastCheckedAt: new Date().toISOString(),
      source: "paypal_api",
    });

    res.json({
      ok: true,
      subscriptionId,
      status,
      active: isActiveStatus(status),
      saved,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Lightweight verify endpoint (client can call after onApprove, but server decides)
app.post("/api/subscription/verify", async (req, res) => {
  try {
    const subscriptionId = String(req.body?.subscriptionId || "").trim();
    if (!subscriptionId) return res.status(400).json({ ok: false, error: "Missing subscriptionId" });

    const paypalData = await fetchSubscriptionFromPayPal(subscriptionId);
    const status = paypalData?.status || "UNKNOWN";

    const saved = await upsertSubscriptionStatus(subscriptionId, {
      status,
      lastVerifiedAt: new Date().toISOString(),
      source: "paypal_api",
    });

    res.json({ ok: true, subscriptionId, status, active: isActiveStatus(status), saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* ==========================================
   ✅ (Optional) Protect routes with active subscription
   - Example usage: add requireActiveSubscription middleware to paid endpoints
   - Client should send header: x-subscription-id: <id>
========================================== */
async function requireActiveSubscription(req, res, next) {
  try {
    const subId =
      String(req.header("x-subscription-id") || "").trim() ||
      String(req.query?.subId || "").trim();

    if (!subId) return res.status(401).json({ ok: false, error: "Missing subscription id" });

    // Prefer stored status first (fast), but you can force PayPal API check if you want.
    const db = await readSubs();
    const saved = db?.subscriptions?.[subId];
    const status = saved?.status || "";

    if (isActiveStatus(status)) return next();

    // Fallback to PayPal API verification (prevents stale local status)
    const paypalData = await fetchSubscriptionFromPayPal(subId);
    const liveStatus = paypalData?.status || "UNKNOWN";

    await upsertSubscriptionStatus(subId, {
      status: liveStatus,
      lastCheckedAt: new Date().toISOString(),
      source: "paypal_api_fallback",
    });

    if (!isActiveStatus(liveStatus)) {
      return res.status(403).json({ ok: false, error: "Subscription not active", status: liveStatus });
    }

    next();
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

/* =======================
   JSON: /api/generate
   (unchanged)
======================= */
app.post("/api/generate", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const mode = String(req.body?.mode || "full");
    const count = Number(req.body?.count || 5);
    const lang = normalizeLang(req.body?.lang || "ar");
    const previous = Array.isArray(req.body?.previous) ? req.body.previous : [];

    if (!text) return res.status(400).json({ error: errMsg(lang, "empty") });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: errMsg(lang, "noKey") });

    const { prompt } = buildPrompts({ text, count, mode, lang, previous });
    const { response, data } = await callGemini(prompt, apiKey);

    if (!response.ok) {
      if (response.status === 429) return res.status(429).json({ error: errMsg(lang, "rate") });
      return res.status(500).json({ error: errMsg(lang, "genErr") });
    }

    const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!result) return res.status(500).json({ error: errMsg(lang, "noText") });

    res.json({ text: result, sourceText: text });
  } catch (err) {
    res.status(500).json({ error: "Server error", details: String(err) });
  }
});

/* =======================
   FILE: /api/generate-file
   (unchanged)
======================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

app.post("/api/generate-file", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const mode = String(req.body?.mode || "full");
    const count = Number(req.body?.count || 5);
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

    const { prompt } = buildPrompts({ text, count, mode, lang, previous });
    const { response, data } = await callGemini(prompt, apiKey);

    if (!response.ok) {
      if (response.status === 429) return res.status(429).json({ error: errMsg(lang, "rate") });
      return res.status(500).json({ error: errMsg(lang, "genErr") });
    }

    const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!result) return res.status(500).json({ error: errMsg(lang, "noText") });

    res.json({ text: result, sourceText: text });
  } catch (err) {
    res.status(500).json({ error: "Server error", details: String(err) });
  }
});

/* ==========================================
   ✅ Example: Protect paid endpoints (optional)
   If you want /api/generate to be paid-only:
   - uncomment the middleware below (and same for generate-file)
========================================== */
// app.post("/api/generate", requireActiveSubscription, ...)
// app.post("/api/generate-file", requireActiveSubscription, ...)

app.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
  console.log(`💳 PayPal API base: ${PAYPAL_API_BASE}`);
});
