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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =======================
   Body + static
   ✅ Keep rawBody for PayPal webhooks verification
======================= */
app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      // Keep exact raw bytes (useful for PayPal verification/debug)
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

/* =======================
   JSON: /api/generate
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

/* =======================
   PayPal (Webhook + Verify)
======================= */
function paypalBase() {
  const mode = String(process.env.PAYPAL_MODE || "live").toLowerCase();
  return mode === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
}

// ✅ Quick env check
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
const DATA_DIR = path.join(__dirname, "data");
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
    // Support both variants (seen differences in some docs/tools)
    case "BILLING.SUBSCRIPTION.RE-ACTIVATED":
    case "BILLING.SUBSCRIPTION.REACTIVATED":
      return "ACTIVE";
    default:
      return "UNKNOWN";
  }
}

// PayPal webhook receiver
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

// Verify subscription by calling PayPal directly
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

// Local status check
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
