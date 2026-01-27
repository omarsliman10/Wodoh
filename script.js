/* =======================
   Settings
======================= */
const FULL_COUNT = 5;
const MORE_COUNT = 3;

let currentLang = "ar"; // UI language only (ar/en)
let previousQuestions = [];
let lastSourceText = "";

// ✅ store output language (ar/en/he) used for last generation
let lastOutputLang = ""; // "ar" | "en" | "he" | ""

/* timing (Free has delay; Pro minimal delay) */
let lastRequestTime = 0;
const MIN_DELAY_FREE = 2500;
const MIN_DELAY_PRO  = 250; // "بدون انتظار" عمليًا، لكن نحمي السيرفر من spam

/* Free cooldown for "More"; Pro no cooldown */
const COOLDOWN_SECONDS_FREE = 30;
let nextMoreAllowedAt = 0;
let moreCountdownTimer = null;

let currentFile = null;

const DEV_FORCE_PRO = false;

/* =======================
   Free vs Pro limits
======================= */
const FREE_MAX_QUESTIONS = 5;
const PRO_MAX_QUESTIONS = 20;

/* =======================
   Auth + Subscription (SERVER state via HttpOnly cookie)
======================= */

// Session cache in memory
let sessionUser = null; // {id,firstName,lastName,subActive,subscriptionId}

// Helpers
function isLoggedIn(){ return !!sessionUser; }
function isSubscribed(){
  // ✅ Pro فقط لرقمك أنت
  if (sessionUser?.phone === "+972537118999") return true;

  // باقي المستخدمين حسب الاشتراك الحقيقي
  return !!(sessionUser && sessionUser.subActive === true);
}

function getUser(){
  if (!sessionUser){
    return { loggedIn:false, subscribed:false, subscriptionId:"", firstName:"", lastName:"" };
  }
  return {
    loggedIn:true,
    subscribed: isSubscribed(),
    subscriptionId: sessionUser.subscriptionId || "",
    firstName: sessionUser.firstName || "",
    lastName: sessionUser.lastName || ""
  };
}

// ✅ Always include credentials so cookies are sent
async function apiJSON(url, body){
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    credentials: "include",
    body: JSON.stringify(body || {})
  });
  const data = await r.json().catch(()=> ({}));
  return { r, data };
}

async function apiGET(url){
  const r = await fetch(url, { method:"GET", credentials:"include" });
  const data = await r.json().catch(()=> ({}));
  return { r, data };
}

async function syncSession(){
  try{
    const { data } = await apiGET("/api/auth/me");
    sessionUser = data?.user || null;
  }catch{
    sessionUser = null;
  }
  refreshHeaderButtons();
  return sessionUser;
}



/* =======================
   DOM Elements
======================= */
const textInput = document.getElementById("textInput");
const output = document.getElementById("output");
const generateBtn = document.getElementById("generateBtn");
const langBtn = document.getElementById("langBtn");
const toast = document.getElementById("toast");

// ✅ if user clicks Subscribe while logged out, we remember the action
let pendingAction = ""; // "" | "subscribe"


/* NEW controls */
const questionTypeEl = document.getElementById("questionType");
const questionCountEl = document.getElementById("questionCount");
const proLockHint1 = document.getElementById("proLockHint1");
const proLockHint2 = document.getElementById("proLockHint2");

/* NEW: Pro controls container (from updated index) */
const proControlsWrap = document.getElementById("proControls");
const proLockBox = document.getElementById("proLockBox");
const openSubscribeFromControls = document.getElementById("openSubscribeFromControls");
const controlsPlanBadge = document.getElementById("controlsPlanBadge");



/* NEW: header plan pill (from updated index) */
const planPill = document.getElementById("planStatus");
const planPillText = document.getElementById("planStatusText");

/* Landing */
const landing = document.getElementById("landing");
const app = document.getElementById("app");
const startBtn = document.getElementById("startBtn");
const skipBtn = document.getElementById("skipBtn");

function openApp(){
  if (landing) landing.style.display = "none";
  if (app) app.style.display = "block";

  // افتح الرئيسية أول ما يدخل
  if (typeof showView === "function") showView("home");

  window.scrollTo({ top: 0, behavior: "smooth" });
}

startBtn?.addEventListener("click", (e)=>{
  e.preventDefault();
  openApp();
});

skipBtn?.addEventListener("click", (e)=>{
  e.preventDefault();
  openApp();
});


/* Uploader */
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const chooseFileBtn = document.getElementById("chooseFileBtn");
const clearFileBtn = document.getElementById("clearFileBtn");
const filePreview = document.getElementById("filePreview");
const fileNameEl = document.getElementById("fileName");
const fileMetaEl = document.getElementById("fileMeta");

/* Summaries */
const mySummariesWrap = document.getElementById("mySummaries");
const panel = document.querySelector(".panel");
const mySummariesBtn = document.getElementById("mySummariesBtn");

/* Header buttons */
const headerAccountBtn = document.getElementById("headerAccountBtn");
const headerSubscribeBtn = document.getElementById("headerSubscribeBtn");

/* Paywall */
const paywallModal = document.getElementById("paywallModal");
const paywallTitle = document.getElementById("paywallTitle");
const paywallText = document.getElementById("paywallText");
const paywallAccountBtn = document.getElementById("paywallAccountBtn");
const paywallSubscribeBtn = document.getElementById("paywallSubscribeBtn");
const closePaywall = document.getElementById("closePaywall");

/* Subscribe modal */
const subscribeModal = document.getElementById("subscribeModal");
const subClose = document.getElementById("subClose");

// ✅ Paddle price IDs (غيّرهم من Paddle Dashboard)
const PADDLE_PRICE_MONTHLY = "pri_01kfk186aqa8k9rdgc8bed3ymb";
const PADDLE_PRICE_YEARLY  = "pri_01kfk1atxx6ymveaj4gg3w13j5";

function getSelectedPlan(){
  const active = document.querySelector(".sub-plans .plan.active");
  return active?.dataset?.plan || "monthly";
}

document.getElementById("paddlePayBtn")?.addEventListener("click", async ()=>{
  await syncSession();

  if (!isLoggedIn()){
    pendingAction = "subscribe";
    openAccount();
    return;
  }

  const plan = getSelectedPlan();
  const priceId = (plan === "yearly") ? PADDLE_PRICE_YEARLY : PADDLE_PRICE_MONTHLY;

  if (!window.Paddle){
    showToast("❌ Paddle لم يتم تحميله", "err", 2500);
    return;
  }

  // ✅ افتح Checkout
Paddle.Checkout.open({
  items: [{ priceId, quantity: 1 }],

  customData: {
    userId: sessionUser?.id,
    phone: sessionUser?.phone || ""
  },

  settings: {
    successUrl: `${location.origin}/?app=1&thanks=1`
  }
});
});

document.querySelectorAll(".sub-plans .plan").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".sub-plans .plan").forEach(x=>x.classList.remove("active"));
    btn.classList.add("active");
  });
});


// ✅ Fallback IDs if HTML uses different ids
const _fallback = (el, id) => el || document.getElementById(id);

// إذا بالـ HTML عندك id مختلف (جرّب هذه الأكثر شيوعًا)
window.generateBtn = _fallback(generateBtn, "btnGenerate");
window.mySummariesBtn = _fallback(mySummariesBtn, "historyBtn");
window.headerAccountBtn = _fallback(headerAccountBtn, "accountBtn");
window.headerSubscribeBtn = _fallback(headerSubscribeBtn, "subscribeBtn");

// ✅ FIX: use fallback elements everywhere
const GEN_BTN = window.generateBtn;
const HIST_BTN = window.mySummariesBtn;
const ACC_BTN  = window.headerAccountBtn;
const SUB_BTN  = window.headerSubscribeBtn;

// =======================
// Views nav (Home / Solve / Generate) — ROBUST
// =======================
const VIEWS = {
  home: document.getElementById("homeView") || document.querySelector('[data-view="home"]'),
  solve: document.getElementById("solveView") || document.querySelector('[data-view="solve"]'),
  generate: document.getElementById("generateView") || document.querySelector('[data-view="generate"]'),
  summaries: document.getElementById("mySummariesView") || document.getElementById("mySummaries") // ✅ NEW
};
const topBack = document.getElementById("topBack");

function showView(name){
  Object.entries(VIEWS).forEach(([k, el])=>{
    if (!el) return;
    el.style.display = (k === name) ? "block" : "none";
  });

  document.body.classList.toggle("view-home", name === "home");

  // ✅ زر الرجوع (يظهر بكل الصفحات غير home)
  const backBtn = document.getElementById("backHomeBtn");
  if (backBtn) backBtn.style.display = (name === "home") ? "none" : "inline-flex";

  closeHeaderMenu?.();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
// ✅ expose globally (حتى أي مكان يقدر يناديها)
window.showView = showView;

// ✅ bind زر الرجوع مباشرة (مش بالـ delegation)
const BACK_BTN = document.getElementById("backHomeBtn");
BACK_BTN?.addEventListener("click", (e)=>{
  e.preventDefault();
  e.stopPropagation();
  window.showView("home");
});


// أزرار الانتقال (بـ id أو data-action)
document.addEventListener("click", (e)=>{
  const toSolve = e.target.closest("#goSolve, [data-action='goSolve']");
  const toGen   = e.target.closest("#goGenerate, [data-action='goGenerate']");
  const back    = e.target.closest("#backHomeBtn, [data-action='backHome']");

if (toSolve){
  e.preventDefault();

  if (!isSubscribed()){
    showToast(
      currentLang === "ar"
        ? "🔒 حل الأسئلة متاح لمشتركي Wodoh Pro فقط"
        : "🔒 Solving questions is available for Pro users only",
      "err",
      3200
    );
    openSubscribe();
    return;
  }

  showView("solve");
}
  if (toGen){ e.preventDefault(); showView("generate"); }
  if (back){ e.preventDefault(); showView("home"); }
});

document.addEventListener("click", (e)=>{
  const btn = e.target.closest("#mySummariesBtn, #historyBtn, [data-action='mySummaries']");
  if (!btn) return;

  e.preventDefault();
  e.stopPropagation();

  if (!isLoggedIn()){
    pendingAction = ""; // ما بدنا نعلّق اشتراك هنا
    openAccount();
    showToast(
      currentLang==="ar" ? "🔐 سجّل دخول أولًا" : "🔐 Please log in first",
      "err",
      2500
    );
    return;
  }

  if (!isSubscribed()){
    showToast(t("toastNeedProHistory"), "err", 2800);
    openSubscribe();
    return;
  }

  showSummariesView();
});



/* =======================
   Header Menu (Dropdown)
======================= */
const headerMenuBtn = document.getElementById("headerMenuBtn");
const headerMenuDropdown = document.getElementById("headerMenuDropdown");

mySummariesBtn?.addEventListener("click", closeHeaderMenu);
headerAccountBtn?.addEventListener("click", closeHeaderMenu);
headerSubscribeBtn?.addEventListener("click", closeHeaderMenu);

function closeHeaderMenu(){
  if (!headerMenuDropdown) return;
  headerMenuDropdown.hidden = true;
  headerMenuBtn?.setAttribute("aria-expanded", "false");
    // ✅ اخفي logout لما تسكر القائمة
  toggleLogoutRow(false);
}

function openHeaderMenu(){
  if (!headerMenuDropdown) return;
  headerMenuDropdown.hidden = false;
  headerMenuBtn?.setAttribute("aria-expanded", "true");
}

headerMenuBtn?.addEventListener("click", (e)=>{
  e.preventDefault();
  e.stopPropagation();
  if (!headerMenuDropdown) return;

  const isOpen = headerMenuDropdown.hidden === false;
  if (isOpen) closeHeaderMenu();
  else openHeaderMenu();
});

// اقفل القائمة عند الضغط خارجها
document.addEventListener("click", (e)=>{
  if (!headerMenuDropdown || headerMenuDropdown.hidden) return;
  const wrap = e.target.closest(".header-menu-wrap");
  if (!wrap) closeHeaderMenu();
});

// اقفلها بزر ESC
document.addEventListener("keydown", (e)=>{
  if (e.key === "Escape") closeHeaderMenu();
});

document.addEventListener("DOMContentLoaded", async () => {
  const p = document.getElementById("phoneLocalInput");
  const c = document.getElementById("codeInput");
  const s = document.getElementById("sendCodeBtn");
  const firstNameInput = document.getElementById("firstNameInput"); // ✅ جديد

  if (p) p.value = "";
  if (c) c.value = "";
  if (s) s.disabled = true;

  await syncSession();
});


/* =======================
   i18n
======================= */
const I18N = {
  ar: {
    brandAr: "وضوح",
    brandEn: "Wodoh",
    brandDescAr: "حوّل المحتوى إلى فهم — ملخصات وأسئلة تفاعلية",
    brandDescEn: "Turn content into understanding — summaries & interactive questions",

    landingTitle: "تعلّم أوضح، أسرع، وبشكل تفاعلي",
    landingSubtitle: "توليد أسئلة وملخصات • حل أسئلة مباشرة — الصق نصًا أو ارفع ملفًا وابدأ فورًا",
    landingNoteAr: "منصّة ذكية لتحويل المحتوى إلى فهم حقيقي",
    landingNoteEn: "A smart platform that turns content into real understanding",

    featFast: "⚡ سريع",
    featInteractive: "🧠 تفاعلي",
    featFiles: "📄 يدعم ملفات",
    featLangs: "🌐 لغات",

    langBtn: "🌐 English",
    mySummariesBtn: "📚 ملخصاتي",
    accountBtnTop: "👤 الحساب",
    subscribeBtnTop: "⭐ اشترك",
    generateBtn: "تلخيص + أسئلة",

    inputLabel: "النص",
    uploadTitle: "📎 رفع ملف",
    chooseFileBtn: "اختيار ملف",
    clearFileBtn: "مسح الملف ✖",
    fileHint: "اسحب الملف هنا أو اضغط “اختيار ملف” (TXT / PDF / DOCX)",
    textPlaceholder: "الصق النص هنا...",

    qTypeLabel: "نوع الأسئلة",
    qTypeBoth: "اختيار من متعدد + صح/خطأ",
    qTypeMcq: "اختيار من متعدد فقط",
    qTypeTf: "صح/خطأ فقط",
    qCountLabel: "عدد الأسئلة",
    proLockHint: "🔒 التحكم الكامل متاح للمشترك",
    freeLimitHint: "🆓 المجاني: مرة واحدة يوميًا",
    startBtn: "ابدأ الآن",
    skipBtn: "تخطي",

    generatingBtn: "⏳ جاري التلخيص...",
    toastWait: "⏳ انتظر قليلًا",
    toastEnterText: "⚠️ أدخل نصًا",
    toastGenerated: "✅ تم التوليد",
    toastAdded: "✅ تم الحفظ في ملخصاتي",
    toastConnErr: "❌ خطأ اتصال",
    toastErr: "❌ حدث خطأ",
    toastTimer: "⏳ انتظر المؤقت",
    toastTextFirst: "⚠️ اكتب نصًا أولًا",
    toastReading: "📄 جاري قراءة الملف...",
    toastBadType: "⚠️ نوع ملف غير مدعوم",
    toastNeedLibs: "⚠️ لتشغيل PDF/DOCX أضف pdf.js و mammoth في index.html",
    toastNeedSub: "🔒 انتهت المحاولات المجانية. اشترك للاستخدام بلا حدود.",
    toastNeedProHistory: "🔒 الحفظ (ملخصاتي) للمشترك فقط.",
    toastSubOn: "⭐ تم تفعيل الاشتراك — بلا حدود!",
    toastSubAlready: "⭐ أنت مشترك بالفعل",
    toastPayPalNotReady: "⚠️ PayPal لم يتم تحميله بعد. حدّث الصفحة وحاول.",
    toastSubVerifyFail: "⚠️ تم الدفع لكن لم يتم تأكيد الاشتراك من السيرفر. تواصل معي.",

    firstNameLabel: "الاسم الأول",
    lastNameLabel: "اسم العائلة",
    firstNamePh: "اسمك الشخصي",
    lastNamePh: "اسم العائلة",
    toastNeedName: "⚠️ أدخل الاسم الأول واسم العائلة",

    paywallTitle: "🔒 انتهت المحاولات المجانية اليوم",
    paywallText: "انتهت المحاولات المجانية. اشترك للمتابعة بلا حدود.",
    planMonthly: "شهري",
    planYearly: "سنوي",
    planUnlimited: "استخدام بلا حدود",
    planBest: "أفضل قيمة",
    subText: "اختر الخطة. عند الاشتراك يصبح الاستخدام بلا حدود.",
    paypalNote: "ادفع عبر PayPal أو البطاقة لتفعيل الاشتراك.",
    subHint: "عند تفعيل الاشتراك سيتم إزالة حد الاستخدام اليومي.",

    footerBrand: "Wodoh – وضوح",
    lockedTitle: "🔒 Pro فقط",
    freeLimitTitle: "🆓 المجاني",
    proControlsTitle: "تحكم بالأسئلة",
    proControlsDesc: "اختر النوع والعدد (تحكم كامل لمشتركي Pro).",

    privacyLink: "سياسة الخصوصية",
    termsLink: "الشروط والأحكام",
    closeBtn: "إغلاق",

    tierFreeName: "Free",
    tierFreeBadge: "أساسي",
    tagLimit: "Limit",
    tagPro: "Pro",

    tierFreeItem1: "مرة واحدة يوميًا",
    tierFreeItem2: "أسئلة محدودة",
    tierFreeItem3: "بدون حفظ",
    tierFreeItem4: "مع انتظار",

    tierProName: "Wodoh Pro",
    tierProBadge: "غير محدود",
    tierProItem1: "غير محدود",
    tierProItem2: "حفظ النتائج",
    tierProItem3: "تحكم بالنوع والعدد",
    tierProItem4: "بدون انتظار",
    tierProItem5: "دعم كامل للغات",

    backBtn: "↩ رجوع للموقع",

    // ✅ NEW
    planFree: "Free",
    planPro: "Wodoh Pro",
    planProDesc: "يعطيك تحكم بالنوع والعدد + بدون انتظار + حفظ النتائج.",
    upgradeBtn: "ترقية ⭐",
    // ✅ Feedback
    fbTitle: "💬 رأيك يهمنا",
    fbDesc: "ساعدنا نطوّر وضوح — دقيقة واحدة فقط.",
    fbRatingLabel: "التقييم",
    fbRatingHint: "اختر من 1 إلى 5",
    fbTypeLabel: "نوع الملاحظة",
    fbTypeIdea: "اقتراح ميزة",
    fbTypeBug: "مشكلة / خطأ",
    fbTypeUx: "تحسين تجربة الاستخدام",
    fbTypePayment: "الدفع / الاشتراك",
    fbTypeOther: "أخرى",
    fbMsgLabel: "رسالتك",
    fbMsgPh: "اكتب ملاحظتك باختصار...",
    fbSend: "إرسال",
    fbNote: "بدون حساب",
    fbSuccess: "✅ شكرًا لك! تم إرسال الملاحظة.",
    toastPickRating: "⚠️ اختر تقييمًا",
    toastWriteMsgMin: "⚠️ اكتب رسالة قصيرة (على الأقل 8 أحرف)",
    toastFeedbackSent: "🙏 شكرًا! وصلتنا ملاحظتك",
    toastFeedbackErr: "❌ خطأ، جرّب مرة أخرى",

    homeSolveTitle: "✅ حل الأسئلة",
    homeSolveDesc: "ارفع ملف أسئلة أو الصق الأسئلة، وخلي وضوح يعطيك الإجابات بشكل مرتب.",
    homeGenerateTitle: "⚡ تلخيص + إنشاء أسئلة",
    homeGenerateDesc: "ارفع نص/ملف → ملخص + أسئلة اختيار من متعدد وصح/خطأ (حسب الخطة).",

    mySummariesBtn: "ملخصاتي",
    accountBtn: "الحساب",
    logoutBtn: "تسجيل خروج",
    menuBtn: "القائمة",

    headerDescAr: "حوّل المحتوى إلى فهم",
    headerDescEn: "Turn content into understanding",

    langBtn: "🌐 English",


    menuBtn: "القائمة",

    accountTitle: "الحساب",
    phonePlaceholder: "رقم الهاتف",
    sendCodeBtn: "إرسال الكود",
    closeBtn: "إغلاق",

    loginNote: "تسجيل الدخول لا يفعّل النسخة الاحترافية (Pro). الاشتراك مطلوب.",

    backHomeBtn: "⬅ الرجوع للرئيسية",

      homeGenerateTitle: "تلخيص + إنشاء أسئلة",
    homeGenerateDesc: "ارفع نصًا أو ملفًا لتحصل على ملخص واضح مع أسئلة اختيار من متعدد وصح/خطأ (حسب الخطة).",

    homeSolveTitle: "حل الأسئلة",
    homeSolveDesc: "ارفع ملف أسئلة أو الصق الأسئلة، وسيعطيك وضوح الإجابات بشكل مرتب وواضح.",

        solveLabel: "حل الأسئلة",
    solveTextPlaceholder: "الصق أسئلة الاختبار هنا... (MCQ / صح-خطأ)",
    solveUploadTitle: "📎 رفع ملف أسئلة",
    solveClearFileBtn: "مسح الملف ✖",
    solveChooseFileBtn: "اختيار ملف",
    solveFileHint: 'اسحب الملف هنا أو اضغط "اختيار ملف" (TXT / PDF / DOCX)',
    solveNowBtn: "✅ حلّ الآن",
    clearTextTitle: "مسح النص",

    advancedTitle: "إعدادات متقدمة",

  },

  en: {
    brandAr: "وضوح",
    brandEn: "Wodoh",
    brandDescAr: "حوّل المحتوى إلى فهم — ملخصات وأسئلة تفاعلية",
    brandDescEn: "Turn content into understanding — summaries & interactive questions",

    landingTitle: "Learn clearer, faster, and interactively",
    landingSubtitle: "Generate summaries & questions • Solve questions instantly — paste text or upload a file and start now",
    landingNoteEn: "A smart platform that turns content into real understanding",

    featFast: "⚡ Fast",
    featInteractive: "🧠 Interactive",
    featFiles: "📄 File support",
    featLangs: "🌐 Languages",

    langBtn: "🌐 العربية",
    mySummariesBtn: "📚 My Summaries",
    accountBtnTop: "👤 Account",
    subscribeBtnTop: "⭐ Subscribe",
    generateBtn: "Summary + Questions",

    inputLabel: "Text",
    uploadTitle: "📎 Upload file",
    chooseFileBtn: "Choose file",
    clearFileBtn: "Clear file ✖",
    fileHint: "Drag & drop a file here or click “Choose file” (TXT / PDF / DOCX)",
    textPlaceholder: "Paste the text here...",

    qTypeLabel: "Question type",
    qTypeBoth: "MCQ + True/False",
    qTypeMcq: "MCQ only",
    qTypeTf: "True/False only",
    qCountLabel: "Questions count",
    proLockHint: "🔒 Full control is for Pro",
    freeLimitHint: "🆓 Free: once per day",
    toastNeedSub: "🔒 Free daily limit reached. Subscribe for unlimited access.",

    startBtn: "Start now",
    skipBtn: "Skip",

    generatingBtn: "⏳ Generating...",
    toastWait: "⏳ Please wait",
    toastEnterText: "⚠️ Enter text",
    toastGenerated: "✅ Generated",
    toastAdded: "✅ Saved to My Summaries",
    toastConnErr: "❌ Connection error",
    toastErr: "❌ Error",
    toastTimer: "⏳ Wait for timer",
    toastTextFirst: "⚠️ Add text first",
    toastReading: "📄 Reading file...",
    toastBadType: "⚠️ Unsupported file type",
    toastNeedLibs: "⚠️ To use PDF/DOCX add pdf.js and mammoth to index.html",
    toastNeedSub: "🔒 Free limit reached. Subscribe for unlimited.",
    toastNeedProHistory: "🔒 Saving (My Summaries) is for Pro only.",
    toastSubOn: "⭐ Subscription enabled — Unlimited!",
    toastSubAlready: "⭐ You are already subscribed",
    toastPayPalNotReady: "⚠️ PayPal not loaded yet. Refresh and try again.",
    toastSubVerifyFail: "⚠️ Paid but server did not confirm. Contact support.",

    firstNameLabel: "First name",
    lastNameLabel: "Last name",
    firstNamePh: "e.g., Omar",
    lastNamePh: "e.g., Sliman",
    toastNeedName: "⚠️ Enter first & last name",

    paywallTitle: "🔒 Free limit reached today",
    paywallText: "Free limit reached. Subscribe for unlimited.",

    tabLogin: "Log in",
    tabSignup: "Sign up",
    authSubtitle: "Log in or create an account in seconds.",
    cancelBtn: "Close",

    planMonthly: "Monthly",
    planYearly: "Yearly",
    planUnlimited: "Unlimited",
    planBest: "Best value",
    subText: "Choose a plan. Subscription gives you unlimited usage.",
    paypalNote: "Pay via PayPal or card to activate your subscription.",
    subHint: "Subscription removes the daily free limit.",
    footerBrand: "Wodoh – وضوح",

    faqTitle: "❓ Frequently Asked Questions",
    faqQ1: "Is my data or file saved?",
    faqA1: "No. We do not store texts or files for free users.",
    faqQ2: "Which languages are supported?",
    faqA2: "Supports all languages, with automatic detection for Arabic and English.",
    faqQ3: "What is the free limit?",
    faqA3: "Once per day. Subscription unlocks unlimited usage.",

    faqToggleBtn: "❓ FAQ",
    faqCloseBtn: "✖ Close FAQ",

    privacyLink: "Privacy Policy",
    termsLink: "Terms of Service",
    closeBtn: "Close",

    tierFreeName: "Free",
    tierFreeBadge: "Basic",
    tagLimit: "Limit",
    tagPro: "Pro",

    tierFreeItem1: "Once per day",
    tierFreeItem2: "Limited questions",
    tierFreeItem3: "No saving",
    tierFreeItem4: "With waiting",

    tierProName: "Wodoh Pro",
    tierProBadge: "Unlimited",
    tierProItem1: "Unlimited",
    tierProItem2: "Save results",
    tierProItem3: "Full control (type & count)",
    tierProItem4: "No waiting",
    tierProItem5: "Full language support",
    
    backBtn: "↩ Back to site",
    menuBtn: "Menu",

    accountTitle: "Account",
    phonePlaceholder: "Phone number",
    sendCodeBtn: "Send code",
    closeBtn: "Close",

    loginNote: "Logging in does not activate Pro. A subscription is required.",

   backHomeBtn: "← Back to Home",

    homeSolveTitle: "Solve Questions",
    homeSolveDesc: "Upload a questions file or paste your questions, and Wodoh will provide clear, well-organized answers.",

   homeSolveTitle: " Solve Questions",
    homeSolveDesc: "Upload a questions file or paste your questions, and Wodoh will give you clean, organized answers.",
    homeGenerateTitle: " Summary + Question Generation",
    homeGenerateDesc: "Upload text/file → a summary + MCQ and True/False questions (based on your plan).",

    mySummariesBtn: "My Summaries",
    accountBtn: "Account",
    logoutBtn: "Log out",
    menuBtn: "Menu",

    headerDescAr: "حوّل المحتوى إلى فهم",
    headerDescEn: "Turn content into understanding",

    langBtn: "🌐 العربية",

    solveLabel: "Solve Questions",
    solveTextPlaceholder: "Paste your exam questions here... (MCQ / True-False)",
    solveUploadTitle: "📎 Upload Questions File",
    solveClearFileBtn: "Clear file ✖",
    solveChooseFileBtn: "Choose file",
    solveFileHint: "Drag the file here or click “Choose file” (TXT / PDF / DOCX)",
    solveNowBtn: "✅ Solve now",
    clearTextTitle: "Clear text",

     advancedTitle: "Advanced Settings",

  // ✅ Feedback
  fbTitle: "💬 Your feedback matters",
  fbDesc: "Help us improve Wodoh — just one minute.",
  fbRatingLabel: "Rating",
  fbRatingHint: "Choose from 1 to 5",
  fbTypeLabel: "Feedback type",
  fbTypeIdea: "Feature suggestion",
  fbTypeBug: "Bug / issue",
  fbTypeUx: "UX improvement",
  fbTypePayment: "Payment / subscription",
  fbTypeOther: "Other",
  fbMsgLabel: "Your message",
  fbMsgPh: "Write your feedback briefly...",
  fbSend: "Send",
  fbNote: "No account • No email required",
  fbSuccess: "✅ Thanks! Your feedback has been sent.",
  toastPickRating: "⚠️ Please choose a rating",
  toastWriteMsgMin: "⚠️ Write a short message (min 8 chars)",
  toastFeedbackSent: "🙏 Thanks! Feedback received",
  toastFeedbackErr: "❌ Error, try again",
  // ✅ Pro controls block (missing keys)
  proControlsTitle: "Question controls",
  proControlsDesc: "Choose type and count (Full control for Pro).",

  // ✅ Hints titles (missing keys)
  lockedTitle: "🔒 Pro only",
  freeLimitTitle: "🆓 Free",
  planProDesc: "Gives you full control over type & count + no wait + saving results.",
    // ✅ NEW
    planFree: "Free",
    planPro: "Wodoh Pro",
    upgradeBtn: "Upgrade ⭐"
  },

  he: {
    summaryTitle: "סיכום",
    mcqTitle: "רב־ברירה",
    tfTitle: "נכון / לא נכון",
    moreBtn: "➕ עוד שאלות",
    extraTitle: "שאלות נוספות",
    waitLabel: (s) => `⏳ המתן ${s}s`,
  },

  out_en: {
    summaryTitle: "Summary",
    mcqTitle: "Multiple Choice",
    tfTitle: "True / False",
    moreBtn: "➕ More questions",
    extraTitle: "Extra questions",
    waitLabel: (s) => `⏳ Wait ${s}s`,
  },

  out_ar: {
    summaryTitle: "ملخص",
    mcqTitle: "اختيار من متعدد",
    tfTitle: "صح / خطأ",
    moreBtn: "➕ المزيد من الأسئلة",
    extraTitle: "أسئلة إضافية",
    waitLabel: (s) => `⏳ انتظر ${s}s`,
  }
};

function t(key){
  const dict = I18N[currentLang] || I18N.ar;
  return dict[key] ?? key;
}

/* =======================
   Language detect
======================= */
function detectLangFromText(text){
  let s = String(text || "");
  s = s.replace(/https?:\/\/\S+/g, " ");
  s = s.replace(/%[0-9A-Fa-f]{2}/g, " ");
  s = s.replace(/[0-9_]/g, " ");
  s = s.replace(/\s+/g, " ");

  const arCount = (s.match(/[\u0600-\u06FF]/g) || []).length;
  const heCount = (s.match(/[\u0590-\u05FF]/g) || []).length;
  const enCount = (s.match(/[A-Za-z]/g) || []).length;

  if (heCount >= 10 && heCount >= arCount && heCount >= enCount) return "he";
  if (arCount >= 10 && arCount >= heCount && arCount >= enCount) return "ar";

  if (heCount >= arCount && heCount >= enCount && heCount > 0) return "he";
  if (arCount >= heCount && arCount >= enCount && arCount > 0) return "ar";
  return "en";
}

function outLang(){
  if (lastOutputLang) return lastOutputLang;
  const src = lastSourceText || (textInput?.value || "");
  return detectLangFromText(src);
}
function outDict(){
  const L = outLang();
  if (L === "ar") return I18N.out_ar;
  if (L === "he") return I18N.he;
  return I18N.out_en;
}
function outT(key){
  const d = outDict();
  return (d && d[key] != null) ? d[key] : key;
}

/* =======================
   Busy button
======================= */
let btnBusyTimer = null;
let originalGenerateLabel = "";

function setGenerateBusy(isBusy){
  const btn = GEN_BTN || generateBtn;
  if (!btn) return;

  if (btnBusyTimer) clearTimeout(btnBusyTimer);

  if (isBusy){
    if (!originalGenerateLabel) originalGenerateLabel = btn.textContent || t("generateBtn");
    btn.disabled = true;
    btn.style.filter = "brightness(0.72)";
    btn.style.transform = "translateY(1px)";
    btn.style.opacity = "0.95";
    btn.textContent = t("generatingBtn");
  } else {
    btnBusyTimer = setTimeout(()=>{
      btn.disabled = false;
      btn.style.filter = "";
      btn.style.transform = "";
      btn.style.opacity = "";
      btn.textContent = t("generateBtn"); // هادي لحالها رح ترجع النص
      originalGenerateLabel = "";
    }, 200);
  }
}

/* =======================
   UI helpers
======================= */
let toastTimer = null;
function showToast(msg, type="ok", ms=3000){
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.className = `toast ${type==="err" ? "err" : "ok"}`;
  toast.textContent = msg;
  toast.style.display = "block";
  toastTimer = setTimeout(()=>{
    toast.style.display = "none";
    toast.textContent = "";
  }, ms);
}
function hideToast(){
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.style.display = "none";
  toast.textContent = "";
}
function openModal(el){ if (el) el.style.display = "flex"; }
function closeModal(el){ if (el) el.style.display = "none"; }

/* =======================
   File helpers
======================= */
function clearFile(){
  currentFile = null;
  if (filePreview) filePreview.style.display = "none";
  if (fileNameEl) fileNameEl.textContent = "—";
  if (fileMetaEl) fileMetaEl.textContent = "—";
  if (clearFileBtn) clearFileBtn.disabled = true;
}
function updateFileUI(file){
  if (!filePreview || !fileNameEl || !fileMetaEl) return;
  filePreview.style.display = "block";
  fileNameEl.textContent = file.name;
  fileMetaEl.textContent = `${formatBytes(file.size)} • ${file.type || file.name.split(".").pop()?.toUpperCase()}`;
}
function readTxt(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onerror = ()=> reject(reader.error);
    reader.onload = ()=> resolve(reader.result || "");
    reader.readAsText(file, "utf-8");
  });
}
async function readDocx(file){
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return result?.value || "";
}
async function readPdf(file){
  const buf = await file.arrayBuffer();
  try{
    if (window.pdfjsLib?.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc){
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
  }catch(e){}
  const loadingTask = window.pdfjsLib.getDocument({ data: buf });
  const pdf = await loadingTask.promise;
  let fullText = "";
  for (let i=1; i<=pdf.numPages; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(it=> it.str);
    fullText += strings.join(" ") + "\n";
  }
  return fullText;
}
function formatBytes(bytes){
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B","KB","MB","GB"];
  let i=0, n=bytes;
  while (n >= 1024 && i < units.length - 1){ n/=1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* =======================
   Header buttons + Plan pill
======================= */
function setPlanPillUI(){
  const pro = isSubscribed();
  const dict = I18N[currentLang] || I18N.ar;

  if (planPill){
    planPill.classList.toggle("pro", pro);
    planPill.classList.toggle("free", !pro);
  }
  if (planPillText){
    planPillText.textContent = pro ? (dict.planPro || "Wodoh Pro") : (dict.planFree || "Free");
  }

  if (controlsPlanBadge){
    controlsPlanBadge.classList.toggle("pro", pro);
    controlsPlanBadge.classList.toggle("free", !pro);
    controlsPlanBadge.textContent = pro ? (dict.planPro || "Wodoh Pro") : (dict.planFree || "Free");
  }
}

function refreshHeaderButtons(){
  const u = getUser();

  // ✅ Show name not email
    if (headerAccountBtn){
      const name = String(u.firstName || "").trim();
      if (u.loggedIn){
        headerAccountBtn.textContent = name ? `👤 ${name}` : "👤 User";
      } else {
        headerAccountBtn.textContent = t("accountBtnTop");
      }
    }

  if (headerSubscribeBtn){
    if (u.subscribed){
      headerSubscribeBtn.textContent = currentLang==="ar" ? "⭐ مشترك" : "⭐ Subscribed";
      headerSubscribeBtn.disabled = true;
    } else {
      headerSubscribeBtn.textContent = t("subscribeBtnTop");
      headerSubscribeBtn.disabled = false;
    }
  }

  setPlanPillUI();
  updateProLocks();
}

function updateProLocks(){
  const pro = isSubscribed();

  // hints
  if (proLockHint1) proLockHint1.style.display = pro ? "none" : "block";
  if (proLockHint2) proLockHint2.style.display = pro ? "none" : "block";

  // ✅ Pro controls box (upgrade) from updated index
  if (proControlsWrap){
    proControlsWrap.classList.toggle("locked", !pro);
  }
  if (proLockBox){
    proLockBox.style.display = pro ? "none" : "flex";
  }

  // ✅ FREE: force question type to BOTH + lock control
  if (questionTypeEl){
    if (!pro){
      questionTypeEl.value = "both";
      questionTypeEl.disabled = true;
    } else {
      questionTypeEl.disabled = false;
    }
  }

  // ✅ Count limits
  if (questionCountEl){
    const max = pro ? PRO_MAX_QUESTIONS : FREE_MAX_QUESTIONS;
    questionCountEl.max = String(max);

    let n = Number(questionCountEl.value || 5);
    if (!Number.isFinite(n) || n < 1) n = 5;
    if (n > max) n = max;

    questionCountEl.value = String(n);

    // optional: lock count input for Free? (keep it editable but capped)
    questionCountEl.disabled = false;
  }

  setPlanPillUI();
}

/* ✅ upgrade button inside controls => open subscribe */
openSubscribeFromControls?.addEventListener("click", ()=> SUB_BTN?.click?.());

/* ✅ Server-verified subscription check helper */
async function serverVerifySubscription(subscriptionId){
  try{
    if (!subscriptionId) {
      return { ok:false, active:false, status:"" };
    }

    const r = await fetch("/api/subscription/verify",{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      credentials: "include",
      body: JSON.stringify({ subscriptionId })
    });

    const data = await r.json().catch(()=> ({}));

    return {
      ok: data?.ok === true,
      active: data?.active === true,
      status: data?.status || ""
    };
  }catch{
    return { ok:false, active:false, status:"" };
  }
}

/* =======================
   Paywall
======================= */
function showPaywall(){
  if (paywallTitle) paywallTitle.textContent = t("paywallTitle");
  if (paywallText) paywallText.textContent =
    currentLang==="ar"
      ? "انتهت المحاولة المجانية اليوم. اشترك للمتابعة بلا حدود."
      : "Free daily limit reached. Subscribe for unlimited access.";
  openModal(paywallModal);
}

closePaywall?.addEventListener("click", ()=> closeModal(paywallModal));
paywallModal?.addEventListener("click", (e)=>{ if (e.target === paywallModal) closeModal(paywallModal); });

paywallAccountBtn?.addEventListener("click", ()=>{
  closeModal(paywallModal);
  openAccount();
});
paywallSubscribeBtn?.addEventListener("click", ()=>{
  closeModal(paywallModal);
  openSubscribe();

});

/* =======================
   Subscribe modal (NO PayPal)
======================= */
function closeSubscribe(){
  closeModal(subscribeModal);
}

async function openSubscribe(){
  await syncSession(); // ✅ ensure session

  if (!isLoggedIn()){
    pendingAction = "subscribe";
    openAccount();
    return;
  }

  if (isSubscribed()){
    showToast(t("toastSubAlready"), "ok", 1800);
    return;
  }

  // ✅ افتح المودال بس بدون أي بوابات دفع
  openModal(subscribeModal);
}

SUB_BTN?.addEventListener("click", ()=> openSubscribe());
subClose?.addEventListener("click", closeSubscribe);
subscribeModal?.addEventListener("click",(e)=>{ if (e.target === subscribeModal) closeSubscribe(); });

/* =======================
   Account (Phone OTP) Modal
======================= */
const accountModal = document.getElementById("accountModal");
const accountClose = document.getElementById("accountClose");
const cancelAccountBtn = document.getElementById("cancelAccountBtn");

let sendCodeCooldown = false;
let resendTimer = null;
const resendSeconds = 30;


// ✅ OTP inputs (NEW)
const codeInput = document.getElementById("codeInput"); // لازم يكون id موجود بالـ HTML
// بدل phoneInput القديم استخدم phoneLocalInput

// const phoneInput = document.getElementById("phoneInput"); // ❌ قديم

const countrySelect = document.getElementById("countryCode");
const phoneLocalInput = document.getElementById("phoneLocalInput"); // ✅ جديد
// 🔒 phone: digits only + min length
phoneLocalInput?.addEventListener("input", () => {
  // أرقام فقط
  phoneLocalInput.value = phoneLocalInput.value.replace(/\D/g, "");

  // أقل من 7 أرقام => عطّل زر الإرسال
  if (phoneLocalInput.value.length < 7) {
    sendCodeBtn.disabled = true;
  } else {
    sendCodeBtn.disabled = false;
  }
});

function getFullPhoneNumber(){
  if (!countrySelect || !phoneLocalInput) return "";

  const code = String(countrySelect.value || "").trim(); // مثل: +972
  const number = String(phoneLocalInput.value || "")
    .replace(/\D/g, "")   // يشيل أي شيء غير أرقام
    .replace(/^0+/, "");  // يشيل صفر بالبداية

  return code + number;   // مثال: +972537118999
}


const sendCodeBtn   = document.getElementById("sendCodeBtn");
const verifyCodeBtn = document.getElementById("verifyCodeBtn");
const resendCodeBtn = document.getElementById("resendCodeBtn");
const backToPhoneBtn= document.getElementById("backToPhoneBtn");
if (sendCodeBtn) sendCodeBtn.disabled = true;
sendCodeBtn?.addEventListener("click", handleSendCode);
resendCodeBtn?.addEventListener("click", ()=>{
  if (resendCodeBtn.disabled) return;
  handleSendCode();
});

verifyCodeBtn?.addEventListener("click", async ()=>{
  const code = String(codeInput?.value || "").trim();
  const phone = _lastPhone || getFullPhoneNumber();

  if (!code){
    authSetMsg(currentLang==="ar" ? "⚠️ أدخل الكود" : "⚠️ Enter the code", false);
    return;
  }

  verifyCodeBtn.disabled = true;
  verifyCodeBtn.textContent = currentLang==="ar" ? "⏳ جاري التحقق..." : "⏳ Verifying...";

  try{
    const firstName = String(document.getElementById("firstNameInput")?.value || "").trim();
    if (firstName.length < 2){
      authSetMsg(currentLang==="ar" ? "⚠️ أدخل الاسم" : "⚠️ Enter your name", false);
      return;
    }
    const { r, data } = await verifyPhoneOTP(phone, code, firstName);

    if (!r.ok || data?.ok !== true){
      // ✅ رسائل خطأ حسب رد السيرفر (إذا بتبعت code / error)
      const msg =
        data?.error ||
        (data?.code === "INVALID_CODE" ? (currentLang==="ar" ? "❌ الكود غير صحيح" : "❌ Invalid code") :
         data?.code === "EXPIRED_CODE" ? (currentLang==="ar" ? "⏳ الكود منتهي" : "⏳ Code expired") :
         (currentLang==="ar" ? "❌ فشل التحقق" : "❌ Verification failed"));

      authSetMsg(msg, false);
      return;
    }

    showToast(currentLang==="ar" ? "✅ تم تسجيل الدخول" : "✅ Logged in", "ok", 2200);
   
    // ✅ نجاح: حدّث الجلسة (cookie) واغلق مودال الحساب
await syncSession();
closeAccount({ clearPending:false }); // لا تمسح pendingAction
closeHeaderMenu?.();

// ✅ لو المستخدم كان ضاغط "اشترك"
if (pendingAction === "subscribe"){
  pendingAction = "";
  openSubscribe(); // 🔓 افتح الاشتراك مباشرة
  return;
}

showToast(
  currentLang==="ar" ? "✅ تم تسجيل الدخول" : "✅ Logged in",
  "ok",
  2200
);

    
  }catch(e){
    console.error(e);
    authSetMsg(currentLang==="ar" ? "❌ خطأ اتصال" : "❌ Connection error", false);
  }finally{
    verifyCodeBtn.disabled = false;
    verifyCodeBtn.textContent = currentLang==="ar" ? "تحقق" : "Verify";
  }
});


const authMsg = document.getElementById("authMsg");

let _lastPhone = "";

function authSetMsg(msg, ok=true){
  if (!authMsg) return;
  authMsg.textContent = msg || "";
  authMsg.style.color = ok ? "" : "rgba(239,68,68,0.95)";
}
const phoneStep = document.getElementById("phoneStep");
const codeStep  = document.getElementById("codeStep");


function setAuthStep(step){
  if (!phoneStep || !codeStep) return;

  if (step === "code"){
    phoneStep.style.display = "none";
    codeStep.style.display = "block";
    setTimeout(()=> codeInput?.focus?.(), 30);
  } else {
    codeStep.style.display = "none";
    phoneStep.style.display = "block";
    setTimeout(()=> phoneLocalInput?.focus?.(), 30); // ✅ بدل phoneInput
  }
}

function openAccount(){
  if (!accountModal){
    showToast("⚠️ accountModal غير موجود", "err", 2500);
    return;
  }
  closeHeaderMenu?.();
  authSetMsg("");
  setAuthStep("phone");
  openModal(accountModal);
  // ✅ امسح أي قيمة (حتى لو المتصفح عبّاها)
if (phoneLocalInput) phoneLocalInput.value = "";
if (codeInput) codeInput.value = "";
if (sendCodeBtn) sendCodeBtn.disabled = true;

}

function closeAccount({ clearPending = false } = {}){
  if (clearPending) pendingAction = "";

  // ✅ امسح رقم الهاتف والكود والرسالة
  if (phoneLocalInput) phoneLocalInput.value = "";
  if (codeInput) codeInput.value = "";
  if (authMsg) authMsg.textContent = "";
  if (sendCodeBtn) sendCodeBtn.disabled = true;

  closeModal(accountModal);
}


// ✅ Robust binding for Account button (works with different IDs)
(function bindAccountButton(){
  const acc =
    document.getElementById("headerAccountBtn") ||
    document.getElementById("accountBtn") ||
    document.getElementById("accountBtnTop") ||
    document.querySelector('[data-action="account"]');

  acc?.addEventListener("click", (e)=>{
    e.preventDefault();
    openAccount();
  });
})();

function toggleLogoutRow(force){
  const row = document.getElementById("logoutRow");
  if (!row) return;

  // force: true/false أو toggle لو مش موجود
  if (typeof force === "boolean"){
    row.style.display = force ? "block" : "none";
  } else {
    row.style.display = (row.style.display === "block") ? "none" : "block";
  }
}

// ✅ لما تضغط على الاسم
ACC_BTN?.addEventListener("click", (e)=>{
  e.preventDefault();
  e.stopPropagation();

  // لو مش مسجل دخول: افتح مودال الحساب
  if (!isLoggedIn()){
    openAccount();
    return;
  }

  // لو مسجل دخول: افتح/سكر زر تسجيل الخروج
  toggleLogoutRow();
});
accountClose?.addEventListener("click", ()=> closeAccount({ clearPending:true }));
cancelAccountBtn?.addEventListener("click", ()=> closeAccount({ clearPending:true }));

accountModal?.addEventListener("click", (e)=>{
  if (e.target === accountModal) closeAccount({ clearPending:true });
});

document.addEventListener("keydown", (e)=>{
  if (e.key === "Escape" && accountModal?.style.display === "flex") closeAccount({ clearPending:true });
});

/* =======================
   OTP: Start + Verify
   ✅ عدّل الروابط إذا عندك endpoints مختلفة
======================= */
async function startPhoneOTP(phone){
  return apiJSON("/api/auth/phone/send", { phone });
}

async function verifyPhoneOTP(phone, code, firstName){
  return apiJSON("/api/auth/phone/verify", { phone, code, firstName });
}

function normalizePhone(p){
  return String(p||"").trim();
}

async function handleSendCode(){
  if (sendCodeCooldown) return;

  const phone = getFullPhoneNumber();
  const localDigits = phoneLocalInput.value.replace(/\D/g, "");

  if (localDigits.length < 7 || localDigits.length > 12){
    authSetMsg(
      currentLang === "ar"
        ? "⚠️ رقم الهاتف يجب أن يكون بين 7 و 12 رقم"
        : "⚠️ Phone number must be 7–12 digits",
      false
    );
    return;
  }

  // 🔒 قفل الزر + Loading
  sendCodeCooldown = true;
if (sendCodeBtn) sendCodeBtn.disabled = true;
  sendCodeBtn.textContent = currentLang === "ar" ? "⏳ جاري الإرسال..." : "⏳ Sending...";

  authSetMsg("");

  try{
    const { r, data } = await startPhoneOTP(phone);

    if (!r.ok || data?.ok !== true){
      authSetMsg(
        data?.error || (currentLang === "ar" ? "❌ فشل إرسال الكود" : "❌ Failed to send code"),
        false
      );
      return;
    }

    _lastPhone = phone;
    setAuthStep("code");

    authSetMsg(
      currentLang === "ar"
        ? "✅ تم إرسال الكود"
        : "✅ Code sent",
      true
    );

    // ▶️ عداد إعادة الإرسال
    startResendTimer();

  }catch(e){
    console.error(e);
    authSetMsg(
      currentLang === "ar" ? "❌ خطأ اتصال" : "❌ Connection error",
      false
    );
  }finally{
    // افتح الزر بعد 4 ثواني (anti-spam)
    setTimeout(()=>{
      sendCodeCooldown = false;
      sendCodeBtn.disabled = false;
      sendCodeBtn.textContent = currentLang === "ar" ? "إرسال الكود" : "Send code";
    }, 4000);
  }
}
function startResendTimer(){
  if (!resendCodeBtn) return;

  let sec = resendSeconds;
  resendCodeBtn.disabled = true;
  resendCodeBtn.textContent =
    currentLang === "ar"
      ? `إعادة الإرسال (${sec})`
      : `Resend (${sec})`;

  if (resendTimer) clearInterval(resendTimer);

  resendTimer = setInterval(()=>{
    sec--;

    if (sec <= 0){
      clearInterval(resendTimer);
      resendTimer = null;
      resendCodeBtn.disabled = false;
      resendCodeBtn.textContent =
        currentLang === "ar" ? "إعادة الإرسال" : "Resend";
    } else {
      resendCodeBtn.textContent =
        currentLang === "ar"
          ? `إعادة الإرسال (${sec})`
          : `Resend (${sec})`;
    }
  }, 1000);
}

/* =======================
   applyLang (UI only)
======================= */
function applyLang(){
  const ar = currentLang === "ar";
  const dict = I18N[currentLang] || I18N.ar;

  document.documentElement.lang = ar ? "ar" : "en";

  document.documentElement.dir = "rtl";
  document.body.dir = "rtl";

  document.body.classList.toggle("lang-en", !ar);
  document.body.classList.toggle("lang-ar", ar);

  const header = document.getElementById("appHeader");
  if (header) header.setAttribute("dir", "ltr");

  document.querySelectorAll("[data-i18n]").forEach((el)=>{
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    if (dict[key] == null) return;

    const icon = (el.getAttribute("data-i18n-icon") || "").trim();
    el.textContent = icon ? `${icon} ${dict[key]}` : dict[key];
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el)=>{
    const key = el.getAttribute("data-i18n-placeholder");
    if (!key) return;
    if (dict[key] != null) el.setAttribute("placeholder", dict[key]);
  });

  // ✅ هذا كان سبب الكراش — لازم يكون هنا داخل applyLang
  document.querySelectorAll("[data-i18n-title]").forEach((el)=>{
    const key = el.getAttribute("data-i18n-title");
    if (!key) return;
    if (dict[key] != null) el.setAttribute("title", dict[key]);
  });

  if (langBtn) langBtn.textContent = dict.langBtn;

  const btn = GEN_BTN || generateBtn;
  if (btn && !btn.disabled){
    const icon = (btn.getAttribute("data-i18n-icon") || "").trim();
    btn.textContent = icon ? `${icon} ${dict.generateBtn}` : dict.generateBtn;
  }

  if (paywallTitle && dict.paywallTitle) paywallTitle.textContent = dict.paywallTitle;
  if (paywallText && dict.paywallText) paywallText.textContent = dict.paywallText;

  refreshHeaderButtons();
}

/* =======================
   Session Save/Restore
======================= */
const LS_SESSION_KEY = "wodoh_last_session_v6";

function saveSession(){
  try{
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify({
      lang: currentLang
    }));
  }catch{}
}

function restoreSession(){
  if (textInput) textInput.value = "";
  if (output) output.innerHTML = "";
  previousQuestions = [];
  lastSourceText = "";
  lastOutputLang = "";
  clearFile();

  try{
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s?.lang === "ar" || s?.lang === "en") currentLang = s.lang;
    else currentLang = "ar";
  }catch{}
}


function resetWorkState(){
  if (textInput) textInput.value = "";
  if (output) output.innerHTML = "";
  previousQuestions = [];
  lastSourceText = "";
  lastOutputLang = "";
  clearFile();
}


document.addEventListener("DOMContentLoaded", async ()=>{
  restoreSession();   // يرجّع اللغة فقط
  applyLang();

  await syncSession();  // يعرف إذا فيه user ولا لا

  // ✅ إذا مش مسجل دخول: رجّع كل شيء من الصفر بعد الريفرش
  if (!isLoggedIn()){
    resetWorkState();
  }

  refreshHeaderButtons();
  textInput?.addEventListener("input", saveSession);
});

/* =======================
   Uploader Logic (TXT / PDF / DOCX)
======================= */
chooseFileBtn?.addEventListener("click", ()=> fileInput?.click());

fileInput?.addEventListener("change", async ()=>{
  const file = fileInput.files?.[0];
  if (!file) return;
  await handleFile(file);
  fileInput.value = "";
});

clearFileBtn?.addEventListener("click", ()=>{
  clearFile();
  saveSession();
});

dropZone?.addEventListener("dragover", (e)=>{ e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone?.addEventListener("dragleave", ()=> dropZone.classList.remove("dragover"));
dropZone?.addEventListener("drop", async (e)=>{
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  await handleFile(file);
});

async function handleFile(file){
  hideToast();
  showToast(t("toastReading"), "ok", 1200);

  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!["txt","pdf","docx"].includes(ext)){
    showToast(t("toastBadType"), "err");
    return;
  }

  currentFile = file;
  updateFileUI(file);
  if (clearFileBtn) clearFileBtn.disabled = false;

  try{
    let extracted = "";

    if (ext === "txt"){
      extracted = await readTxt(file);
    } else if (ext === "pdf"){
      if (typeof window.pdfjsLib === "undefined"){
        showToast(t("toastNeedLibs"), "err", 4500);
        return;
      }
      extracted = await readPdf(file);
    } else if (ext === "docx"){
      if (typeof window.mammoth === "undefined"){
        showToast(t("toastNeedLibs"), "err", 4500);
        return;
      }
      extracted = await readDocx(file);
    }

    extracted = String(extracted || "").trim();
    if (!extracted){
      showToast(t("toastErr"), "err");
      return;
    }

    if (textInput) textInput.value = extracted;
    lastSourceText = extracted;
    lastOutputLang = detectLangFromText(extracted);

    saveSession();
  }catch(e){
    console.error(e);
    showToast(t("toastErr"), "err");
  }
}

/* =======================
   Helpers
======================= */
function canRequest(){
  const now = Date.now();
  const minDelay = isSubscribed() ? MIN_DELAY_PRO : MIN_DELAY_FREE;
  if (now - lastRequestTime < minDelay) return false;
  lastRequestTime = now;
  return true;
}

function startMoreCooldown(){
  if (isSubscribed()) return; // ✅ Pro: no cooldown

  const seconds = COOLDOWN_SECONDS_FREE;
  nextMoreAllowedAt = Date.now() + seconds * 1000;
  if (moreCountdownTimer) clearInterval(moreCountdownTimer);

  const tick = ()=>{
    const remain = Math.max(0, Math.ceil((nextMoreAllowedAt - Date.now()) / 1000));
    document.querySelectorAll("[data-more]").forEach(moreBtn=>{
      if (remain > 0){
        moreBtn.disabled = true;
        const wl = outT("waitLabel");
        moreBtn.textContent = (typeof wl === "function") ? wl(remain) : `⏳ Wait ${remain}s`;
      } else {
        moreBtn.disabled = false;
        moreBtn.textContent = outT("moreBtn");
      }
    });

    if (remain <= 0){
      clearInterval(moreCountdownTimer);
      moreCountdownTimer = null;
    }
  };

  tick();
  moreCountdownTimer = setInterval(tick, 1000);
}

/* =======================
   Skeleton
======================= */
function renderSkeleton(){
  return `
    <div class="skeleton-card">
      <div class="skeleton-line skeleton-title"></div>
      <div class="skeleton-line skeleton-long"></div>
      <div class="skeleton-line skeleton-mid"></div>
      <div class="skeleton-line skeleton-long"></div>
      <div class="skeleton-line skeleton-short"></div>
    </div>
    <div class="skeleton-card">
      <div class="skeleton-line skeleton-title"></div>
      <div class="skeleton-line skeleton-long"></div>
      <div class="skeleton-line skeleton-long"></div>
      <div class="skeleton-line skeleton-mid"></div>
    </div>
  `;
}

/* =======================
   Strict Summary (Send to server)
======================= */
const SUMMARY_STYLE = "mixed";
const SUMMARY_BULLETS = 4;
const SUMMARY_WORDS_PER_BULLET = 10;

/* =======================
   Read question controls (Free vs Pro)
======================= */
function getQuestionPrefs(){
  const pro = isSubscribed();

  // Free forced:
  let mode = pro ? (questionTypeEl?.value || "both") : "both";
  if (!["both","mcq","tf"].includes(mode)) mode = "both";

  let n = Number(questionCountEl?.value || 5);
  if (!Number.isFinite(n) || n < 1) n = 5;

  const max = pro ? PRO_MAX_QUESTIONS : FREE_MAX_QUESTIONS;
  if (n > max) n = max;

  return { questionMode: mode, questionCount: n };
}

/* =======================
   API
======================= */
async function callAPI({text,mode,count,questionMode,questionCount}){
  const detected = detectLangFromText(text);

  const r = await fetch("/api/generate",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    credentials: "include",
    body: JSON.stringify({
      text,
      mode,
      count,
      previous: previousQuestions,
      lang: detected,

      // ✅ new
      questionMode,
      questionCount,

      summaryStyle: SUMMARY_STYLE,
      summaryBullets: SUMMARY_BULLETS,
      summaryWordsPerBullet: SUMMARY_WORDS_PER_BULLET
    })
  });

  const data = await r.json().catch(()=> ({}));
  return { r, data, detected };
}

// ✅ Generate click
(GEN_BTN || generateBtn)?.addEventListener("click", onGenerate);

async function onGenerate(e){
  e?.preventDefault?.();

  hideToast();

  if (!canRequest()){
    showToast(t("toastWait"), "err");
    return;
  }

  const text = (textInput?.value || "").trim();
  if (!text){
    showToast(t("toastEnterText"), "err");
    return;
  }

  const prefs = getQuestionPrefs();

  previousQuestions = [];
  lastSourceText = text;

  if (output) output.innerHTML = renderSkeleton();

  setGenerateBusy(true);

  try{
    const { r, data, detected } = await callAPI({
      text,
      mode:"full",
      count: FULL_COUNT,
      questionMode: prefs.questionMode,
      questionCount: prefs.questionCount
    });

    lastOutputLang = detected;
    if (!r.ok){
  if (r.status === 429 || r.status === 402 || data?.code === "FREE_LIMIT"){
    showPaywall();
    return;
  }
  showToast((data?.error || t("toastErr")), "err", 3500);
  return;
}

const parsed = parseGeminiText(data.text || "");

// خزّن أسئلة لمنع التكرار
previousQuestions = [
  ...parsed.mcq.map(q=>q.question),
  ...parsed.tf.map(q=>q.statement)
];

// اعرض النتيجة
if (output) output.innerHTML = renderUI(parsed);

// حفظ “ملخصاتي” فقط للمشترك (اختياري)
if (isSubscribed()){
  const summaryText = (parsed.summaryParas || []).join("\n\n") || (parsed.summary || []).join("\n\n");
  addSummaryItem({
    title: currentLang==="ar" ? "ملخص جديد" : "New Summary",
    summaryText,
    questions: [...(parsed.mcq||[]), ...(parsed.tf||[])]
  });
}

saveSession();
showToast(t("toastGenerated"), "ok", 2000);


    // ✅ الصق هنا نفس الكود الموجود عندك بعد if(!r.ok) إلى قبل الـ catch
    // يعني: if(!r.ok){...} ثم parseGeminiText/renderUI/addSummaryItem/saveSession/showToast ...

  }catch(e){
    console.error(e);
    showToast(t("toastConnErr"), "err");
  }finally{
    setGenerateBusy(false);
  }
}


/* =======================
   More button
======================= */
document.addEventListener("click", async (e)=>{
  const btn = e.target.closest("[data-more]");
  if (!btn) return;

  hideToast();

  // ✅ Free: لا تسمح بـ "المزيد من الأسئلة"
  if (!isSubscribed()){
    showToast(currentLang==="ar"
      ? "🔒 يجب الاشتراك في Wodoh Pro للحصول على المزيد من الأسئلة"
      : "🔒 Subscribe to Wodoh Pro to get more questions",
      "err",
      3200
    );
    openSubscribe();
    return;
  }

  if (!lastSourceText){
    showToast(t("toastTextFirst"), "err");
    return;
  }

  if (!canRequest()){
    showToast(t("toastWait"), "err");
    return;
  }

  startMoreCooldown();

  const prefs = getQuestionPrefs();

  const skeletonHolder = document.createElement("div");
  skeletonHolder.innerHTML = renderSkeleton();
  skeletonHolder.style.marginTop = "14px";

  const anchor = btn.closest(".card") || btn.closest(".more-inline") || output;
  anchor.insertAdjacentElement("afterend", skeletonHolder);

  try{
    const { r, data, detected } = await callAPI({
      text:lastSourceText,
      mode:"more",
      count: MORE_COUNT,
      questionMode: prefs.questionMode,
      questionCount: prefs.questionCount
    });
    lastOutputLang = detected;

    skeletonHolder.remove();

  if (!r.ok){
  // Free limit reached (server)
  if (r.status === 429 || r.status === 402 || data?.code === "FREE_LIMIT"){
    showPaywall();
    return;
  }
  showToast((data?.error || t("toastErr")), "err", 3500);
  return;
}


    const parsed = parseGeminiText(data.text || "");
    previousQuestions.push(
      ...parsed.mcq.map(q=>q.question),
      ...parsed.tf.map(q=>q.statement)
    );

    const html = `
      <div class="card">
        <h3>➕ ${outT("extraTitle")}</h3>
        ${renderQuestionsOnly(parsed)}
        <div class="more-inline">
          <button class="more-btn" data-more>${outT("moreBtn")}</button>
        </div>
      </div>
    `;
    anchor.insertAdjacentHTML("afterend", html);

    saveSession();
    startMoreCooldown();
  }catch(e){
    console.error(e);
    skeletonHolder.remove();
    showToast(t("toastConnErr"), "err");
  }
});

/* =======================
   Answer selection
======================= */
document.addEventListener("click", (e) => {
  const opt = e.target.closest("button[data-opt]");
  if (!opt) return;

  const q = opt.closest(".q");
  if (!q) return;

  if (q.dataset.locked === "1") return;

  const chosen = String(opt.dataset.opt || "");
  const correct = String(q.dataset.correct || "");

  q.querySelectorAll("button[data-opt]").forEach((b) => {
    b.classList.remove("correct", "wrong", "selected");
  });

  opt.classList.add("selected");

  if (chosen === correct) {
    q.dataset.locked = "1";
    q.querySelectorAll("button[data-opt]").forEach((b) => {
      b.disabled = true;
      b.classList.add("disabled");
      if (String(b.dataset.opt || "") === correct) b.classList.add("correct");
    });
  } else {
    opt.classList.add("wrong");
    opt.disabled = true;
  }

  saveSession?.();
});

/* =======================
   Render
======================= */
function renderUI(p){
  const L = outLang();
  const rtl = (L === "ar" || L === "he");

  const paras = (p.summaryParas || p.summary || []);
  const bullets = (p.summaryBullets || []);

  const showParas = paras; // عرض الفقرات دائمًا

  return `
    ${showParas.length || bullets.length ? `
      <div class="card" dir="${rtl ? "rtl" : "ltr"}">
        <h3>📌 ${outT("summaryTitle")}</h3>
        <div class="sum-paras">
          ${showParas.map(x=>`<p style="margin:0 0 10px;line-height:1.75;opacity:.95">${escapeHtml(x)}</p>`).join("")}
          ${bullets.length ? `
            <ul style="margin:8px 0 0;padding-${rtl ? "right" : "left"}:18px;line-height:1.7;opacity:.95">
              ${bullets.map(b=> `<li>${escapeHtml(b)}</li>`).join("")}
            </ul>
          ` : ""}
        </div>
      </div>` : ""
    }
    ${renderQuestionsOnly(p)}
  `;
}

function renderQuestionsOnly(p){
  const L = outLang();
  const rtl = (L === "ar" || L === "he");

  let h = "";
  if (p.mcq.length){
    h += `<div class="card" dir="${rtl ? "rtl" : "ltr"}"><h3>📝 ${outT("mcqTitle")}</h3>${p.mcq.map(renderMCQ).join("")}</div>`;
  }
  if (p.tf.length){
    h += `<div class="card" dir="${rtl ? "rtl" : "ltr"}"><h3>✅ ${outT("tfTitle")}</h3>${p.tf.map(renderTF).join("")}</div>`;
  }
  return h;
}

function renderMCQ(q){
  return `
    <div class="q" data-correct="${q.correct}">
      <div class="q-title">${escapeHtml(q.question)}</div>
      <div class="options">
        ${Object.entries(q.options).map(([k,v])=>`
          <button class="opt" data-opt="${k}">
            <span class="badge">${k}</span>
            <span>${escapeHtml(v)}</span>
          </button>
        `).join("")}
      </div>
    </div>`;
}

function renderTF(q){
  const clean = String(q.statement).replace(/\(.*?\)$/,"").trim();
  const srcLang = outLang();
  const rtl = (srcLang === "ar" || srcLang === "he");

  const trueLabel = srcLang === "ar" ? "صح" : (srcLang === "he" ? "נכון" : "True");
  const falseLabel = srcLang === "ar" ? "خطأ" : (srcLang === "he" ? "לא נכון" : "False");

  const trueBadge = srcLang === "ar" ? "صح" : (srcLang === "he" ? "נכון" : "T");
  const falseBadge = srcLang === "ar" ? "خطأ" : (srcLang === "he" ? "לא נכון" : "F");

  return `
    <div class="q" data-correct="${q.correct}">
      <div class="q-title">${escapeHtml(clean)}</div>
      <div class="options" dir="${rtl ? "rtl" : "ltr"}">
        <button class="opt" data-opt="T"><span class="badge">${trueBadge}</span><span>${trueLabel}</span></button>
        <button class="opt" data-opt="F"><span class="badge">${falseBadge}</span><span>${falseLabel}</span></button>
      </div>
    </div>`;
}

// =======================
// Solve rendering: show answers directly (NO user interaction)
// =======================
function renderSingleAnswerOnly(p){
  const L = detectLangFromText(lastSourceText || "");
  const rtl = (L === "ar" || L === "he");

  // ✅ لو في MCQ: رجّع نص الإجابة الصحيحة فقط
  if (p.mcq && p.mcq.length){
    const q = p.mcq[0];
    const key = String(q.correct || "").toUpperCase();
    const ans = (q.options && q.options[key]) ? q.options[key] : key;
    return `<div class="card" dir="${rtl ? "rtl" : "ltr"}">${escapeHtml(ans || "")}</div>`;
  }

  // ✅ لو في صح/خطأ: رجّع صح/خطأ حسب لغة السؤال
  if (p.tf && p.tf.length){
    const q = p.tf[0];
    const c = String(q.correct || "T").toUpperCase();
    const ans =
      (L==="ar") ? (c==="T" ? "صح" : "خطأ") :
      (L==="he") ? (c==="T" ? "נכון" : "לא נכון") :
                   (c==="T" ? "True" : "False");

    return `<div class="card" dir="${rtl ? "rtl" : "ltr"}">${escapeHtml(ans)}</div>`;
  }

  return `<div class="card" dir="${rtl ? "rtl" : "ltr"}"></div>`;
}


/* =======================
   Parser
======================= */
function parseGeminiText(text){
  const raw = String(text || "").replace(/\r/g, "");
  const lines = raw.split("\n");

  const summaryParas = [];
  const summaryBullets = [];
  const mcq = [];
  const tf = [];

  const isHeader = (l) => /^\[(.+)\]\s*$/.test(l.trim());
  const headerName = (l) => {
    const m = l.trim().match(/^\[(.+)\]\s*$/);
    return m ? m[1].trim().toLowerCase() : "";
  };

  let section = "";
  let buffer = [];

  const isBulletLine = (s) => /^(\-|\*|•)\s+/.test(String(s||"").trim());

  function flushSummaryBuffer(){
    const joined = buffer.join("\n").trim();
    buffer = [];
    if (!joined) return;

    const blocks = joined.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);

    for (const block of blocks){
      const blines = block.split("\n").map(x=>x.trim()).filter(Boolean);

      if (blines.length && blines.every(isBulletLine)){
        blines.forEach(line=>{
          summaryBullets.push(line.replace(/^(\-|\*|•)\s+/, "").trim());
        });
        continue;
      }

      const paraLines = [];
      blines.forEach(line=>{
        if (isBulletLine(line)){
          summaryBullets.push(line.replace(/^(\-|\*|•)\s+/, "").trim());
        } else {
          paraLines.push(line);
        }
      });
      const para = paraLines.join(" ").trim();
      if (para) summaryParas.push(para);
    }
  }

  let cur = null;

  for (let i=0; i<lines.length; i++){
    const line = lines[i];
    const l = line.trim();

    if (!l) {
      if (section === "summary") buffer.push("");
      continue;
    }

    if (isHeader(l)){
      if (section === "summary") flushSummaryBuffer();

      const h = headerName(l);
      if (h.includes("ملخص") || h.includes("summary") || h.includes("סיכום")) section = "summary";
      else if (h.includes("اختيار") || h.includes("multiple") || h.includes("רב")) section = "mcq";
      else if (h.includes("صح") || h.includes("true") || h.includes("נכון")) section = "tf";
      else section = "";
      continue;
    }

    if (section === "summary"){
      buffer.push(line);
      continue;
    }

    if (/^\d+\)/.test(l)){
      cur = { question: l.replace(/^\d+\)\s*/, ""), options: {}, correct: "" };
      continue;
    }
    if (/^[A-D]\)/.test(l) && cur){
      const k = l[0];
      cur.options[k] = l.slice(2).trim();
      continue;
    }

    if (cur && /(الإجابة|Answer|תשובה)/i.test(l)){
      const m = l.match(/\b([A-DTF])\b/i);
      if (m) cur.correct = m[1].toUpperCase();

      const hasOptions = cur.options && cur.options.A;
      if (hasOptions) mcq.push(cur);
      else tf.push({ statement: cur.question, correct: cur.correct || "T" });

      cur = null;
      continue;
    }
  }

  if (section === "summary") flushSummaryBuffer();

  const summary = [...summaryParas];
  return { summary, summaryParas, summaryBullets, mcq, tf, raw };
}

/* =======================
   utils
======================= */
function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

/* =======================
   My Summaries (PRO ONLY usage)
======================= */
const LS_SUMMARIES_KEY = "wodoh_summaries_v1";

function loadSummaries(){
  try { return JSON.parse(localStorage.getItem(LS_SUMMARIES_KEY) || "[]"); }
  catch { return []; }
}
function saveSummaries(list){
  localStorage.setItem(LS_SUMMARIES_KEY, JSON.stringify(list));
}
function addSummaryItem({ title, summaryText, questions }){
  const list = loadSummaries();

  const id = (window.crypto?.randomUUID)
    ? window.crypto.randomUUID()
    : String(Date.now()) + "-" + Math.random().toString(16).slice(2);

  list.unshift({
    id,
    title: title || (currentLang==="ar" ? "ملخص جديد" : "New Summary"),
    createdAt: new Date().toISOString(),
    summaryText: summaryText || "",
    questions: Array.isArray(questions) ? questions : []
  });

  saveSummaries(list);
}
function deleteSummaryItem(id){
  saveSummaries(loadSummaries().filter(x => x.id !== id));
}

/* Views */
let lastMainView = "home";

function showSummariesView(){
  // احفظ وين كنت قبل
  lastMainView = getCurrentViewName() || lastMainView || "home";

  // افتح صفحة الملخصات
  if (typeof showView === "function") showView("summaries");

  // render
  renderMySummaries();
}

function showMainView(){
  if (typeof showView === "function") showView(lastMainView || "home");
}

// helper to detect current view
function getCurrentViewName(){
  for (const [k, el] of Object.entries(VIEWS)){
    if (!el) continue;
    if (el.style.display !== "none") return k;
  }
  return "home";
}

function renderMySummaries(){
  const wrap = document.getElementById("mySummaries");
  if (!wrap) return;

  const list = loadSummaries();
  const title = currentLang==="ar" ? "📚 ملخصاتي" : "📚 My Summaries";
  const empty = currentLang==="ar" ? "لا يوجد ملخصات محفوظة بعد." : "No saved summaries yet.";

  wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;">
      <h2 style="margin:0">${title}</h2>
    </div>

    ${list.length === 0 ? `<div style="opacity:.8">${empty}</div>` : ""}

    <div class="sum-list">
      ${list.map(item => {
        const dt = new Date(item.createdAt);
        const dateStr = dt.toLocaleString(currentLang==="ar"?"ar":"en", {
          year:"numeric", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"
        });
        return `
          <div class="sum-item">
            <div class="sum-meta">
              <div class="sum-title">${escapeHtml(item.title)}</div>
              <div class="sum-date">${escapeHtml(dateStr)}</div>
            </div>
            <div class="sum-actions">
              <button class="btn btn-soft" data-open="${item.id}">${currentLang==="ar"?"فتح":"Open"}</button>
              <button class="btn btn-danger" data-del="${item.id}">${currentLang==="ar"?"حذف":"Delete"}</button>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;


  wrap.querySelectorAll("[data-open]").forEach(btn=>{
    btn.addEventListener("click", ()=> openSummary(btn.getAttribute("data-open")));
  });
  wrap.querySelectorAll("[data-del]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      deleteSummaryItem(btn.getAttribute("data-del"));
      renderMySummaries();
    });
  });
}

function openSummary(id){
  const item = loadSummaries().find(x=> x.id === id);
  if (!item) return;

  const wrap = document.getElementById("mySummaries");
  if (!wrap) return;

  const backLabel = currentLang==="ar" ? "⬅ رجوع" : "⬅ Back";
  const sumTitle = currentLang==="ar" ? "الملخص" : "Summary";
  const qTitle = currentLang==="ar" ? "الأسئلة" : "Questions";
  const ansLabel = currentLang==="ar" ? "الإجابة" : "Answer";

  wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;">
      <div style="font-weight:800;font-size:18px;">${escapeHtml(item.title)}</div>
      <button id="backToList" class="btn btn-soft" type="button">${backLabel}</button>
    </div>

    <div style="opacity:.85;margin-bottom:10px;">
      ${escapeHtml(new Date(item.createdAt).toLocaleString(currentLang==="ar"?"ar":"en"))}
    </div>

    <div style="font-weight:700;margin:10px 0 6px;">${sumTitle}</div>
    <div style="white-space:pre-wrap;line-height:1.7;">${escapeHtml(item.summaryText || "")}</div>

    <div style="font-weight:700;margin:14px 0 6px;">${qTitle}</div>
    <div>
      ${(item.questions || []).map((q, idx)=>`
        <div style="margin:10px 0;padding:10px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">
          <div style="font-weight:700;margin-bottom:6px;">${idx+1}) ${escapeHtml(q.question || q.statement || "")}</div>
          ${q.options && typeof q.options==="object" ? `
            <div style="opacity:.9">
              ${Object.entries(q.options).map(([k,v])=> `<div>${escapeHtml(k)}. ${escapeHtml(v)}</div>`).join("")}
            </div>` : ""
          }
          ${(q.answer || q.correct) ? `<div style="margin-top:6px;opacity:.85">${ansLabel}: ${escapeHtml(String(q.answer || q.correct))}</div>` : ""}
        </div>
      `).join("")}
    </div>
  `;

  wrap.scrollIntoView({ behavior:"smooth", block:"start" });
}

HIST_BTN?.addEventListener("click", ()=>{
  if (!isLoggedIn()){
    openAccount();
    showToast(
      currentLang==="ar"
        ? "🔐 سجّل دخول أولًا (الميزة Pro فقط)"
        : "🔐 Please log in first (Pro feature)",
      "err",
      3000
    );
    return;
  }

  if (!isSubscribed()){
    showToast(t("toastNeedProHistory"), "err", 2800);
    openSubscribe();
    return;
  }

  showSummariesView();
  renderMySummaries();
});

document.addEventListener("keydown",(e)=>{
  if (e.key==="Escape" && mySummariesWrap?.style.display==="block") showMainView();
});


/* =======================
   Language toggle (UI only)
======================= */
langBtn?.addEventListener("click", ()=>{
  currentLang = currentLang === "ar" ? "en" : "ar";
  applyLang();
  saveSession();
});

/* keep locks synced */
questionCountEl?.addEventListener("input", ()=> updateProLocks());
questionTypeEl?.addEventListener("change", ()=> updateProLocks());
updateProLocks();

// =======================
// Feedback (Formspree) — NO browser alert, show inline success + clear fields
// =======================
const FORMSPREE_URL = "https://formspree.io/f/mvzgvjwz";

const fbStars = document.getElementById("fbStars");
const fbType  = document.getElementById("fbType");
const fbMsg   = document.getElementById("fbMsg");
const fbSend  = document.getElementById("fbSend");
const fbCount = document.getElementById("fbCount");
const fbWebsite = document.getElementById("fbWebsite");
const fbRatingInput = document.getElementById("fbRating");
let feedbackSuccess = document.getElementById("feedbackSuccess");

let fbRating = 0;

function setStarsUI(v){
  fbRating = v;
  if (fbRatingInput) fbRatingInput.value = String(v);

  fbStars?.querySelectorAll(".star").forEach(b=>{
    const n = Number(b.dataset.v || 0);
    b.classList.toggle("active", n <= v);
  });
}

fbStars?.addEventListener("click", (e)=>{
  const b = e.target.closest(".star");
  if (!b) return;
  setStarsUI(Number(b.dataset.v || 0));
});

fbMsg?.addEventListener("input", ()=>{
  if (fbCount) fbCount.textContent = String((fbMsg.value || "").length);
});

function showFeedbackSuccess(text){
  if (!feedbackSuccess) return;
  feedbackSuccess.textContent = text;
  feedbackSuccess.style.display = "block";
  setTimeout(()=> feedbackSuccess && (feedbackSuccess.style.display="none"), 3500);
}

async function sendFeedbackFormspree(){
  // honeypot
  if (fbWebsite && String(fbWebsite.value || "").trim()) return;

  const type = String(fbType?.value || "other");
  const msg  = String(fbMsg?.value || "").trim();

  // ✅ بدل alert: استخدم showToast (إذا عندك) أو رجّع رسالة بسيطة
  if (!fbRating){
    showToast?.(t?.("toastPickRating") || "⚠️ اختر تقييمًا", "err", 2400);
    return;
  }
  if (msg.length < 8){
    showToast?.(t?.("toastWriteMsgMin") || "⚠️ اكتب رسالة قصيرة (على الأقل 8 أحرف)", "err", 2400);
    return;
  }

  if (!fbSend) return;
  fbSend.disabled = true;
  fbSend.textContent = (currentLang === "ar") ? "⏳ جاري الإرسال..." : "⏳ Sending...";

  try{
    const fd = new FormData();
    fd.append("rating", String(fbRating));
    fd.append("type", type);
    fd.append("message", msg);
    fd.append("page", "Wodoh");
    fd.append("date", new Date().toLocaleString());

    const res = await fetch(FORMSPREE_URL, {
      method: "POST",
      body: fd,
      headers: { Accept: "application/json" },
    });

    if (!res.ok){
      showToast?.(t?.("toastFeedbackErr") || "❌ خطأ، جرّب مرة أخرى", "err", 2600);
      return;
    }

    // ✅ reset UI
    setStarsUI(0);
    if (fbMsg) fbMsg.value = "";
    if (fbCount) fbCount.textContent = "0";

    // ✅ نجاح تحت الزر
    showFeedbackSuccess(
      currentLang === "ar"
        ? "✅ شكرًا لك! تم إرسال الملاحظة."
        : "✅ Thanks! Your feedback has been sent."
    );

    showToast?.(t?.("toastFeedbackSent") || "🙏 شكرًا! وصلتنا ملاحظتك", "ok", 2200);

  }catch(e){
    console.error(e);
    showToast?.(t?.("toastConnErr") || "❌ خطأ اتصال", "err", 2600);
  }finally{
    fbSend.disabled = false;
    fbSend.textContent = (currentLang === "ar") ? "إرسال" : "Send";
  }
}

fbSend?.addEventListener("click", sendFeedbackFormspree);
/* =======================
   Open App directly if ?app=1
======================= */
(function(){
  const params = new URLSearchParams(window.location.search);
  if (params.get("app") === "1") {
    // افتح صفحة التلخيص مباشرة
    const landing = document.getElementById("landing");
    const app = document.getElementById("app");

    if (landing) landing.style.display = "none";
    if (app) app.style.display = "block";

    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  (function bindCore(){
  const g = document.getElementById("generateBtn");
  if (g && g !== generateBtn) g.addEventListener("click", ()=> generateBtn?.click?.());

  const h = document.getElementById("mySummariesBtn");
  if (h && h !== mySummariesBtn) h.addEventListener("click", ()=> mySummariesBtn?.click?.());

  const a = document.getElementById("headerAccountBtn");
  if (a && a !== headerAccountBtn) a.addEventListener("click", ()=> headerAccountBtn?.click?.());

  const s = document.getElementById("headerSubscribeBtn");
  if (s && s !== headerSubscribeBtn) s.addEventListener("click", ()=> headerSubscribeBtn?.click?.());

})();

})();
// 🔹 تركيب رقم الهاتف الكامل من الدولة + الرقم المحلي
window.testPhone = function(){
  alert(getFullPhoneNumber());
};

async function logout(){
  try{
    await fetch("/api/auth/logout", { method:"POST", credentials:"include" });
  }catch(e){}

  // ✅ session
  sessionUser = null;

  // ✅ امسح كل حالة الشغل (لكن لا تمسح ملخصاتي)
  try{
    localStorage.removeItem(LS_SESSION_KEY); // wodoh_last_session_v6
  }catch{}

  // امسح المدخلات والنتائج والملفات
  resetWorkState(); // عندك موجودة

  // ✅ لو عندك solve inputs
  const solveTa = document.getElementById("solveTextInput");
  if (solveTa) solveTa.value = "";
  const solveOut = document.getElementById("solveOutput");
  if (solveOut) solveOut.innerHTML = "";
  const solveFi = document.getElementById("solveFileInput");
  if (solveFi) solveFi.value = "";

  refreshHeaderButtons();
  closeHeaderMenu?.();

  // رجّع للصفحة الرئيسية
  showView?.("home");
}
document.getElementById("logoutBtn")?.addEventListener("click", logout);


document.getElementById("logoutBtn")?.addEventListener("click", logout);
(function () {
  const select = document.getElementById("countryCode");
  if (!select) return;

  select.addEventListener("change", () => {
    // سكّر الدروب داون فورًا بعد الاختيار
    select.blur();

    // رجّع الفوكس لحقل الهاتف (يعطي إحساس احترافي)
    setTimeout(() => {
      document.getElementById("phoneLocalInput")?.focus?.();
    }, 0);
  });
})();
(function initNiceCountrySelect(){
  const real = document.getElementById("countryCode");
  const wrap = document.getElementById("countryNice");
  const btn  = document.getElementById("countryNiceBtn");
  const drop = document.getElementById("countryNiceDrop");
  const list = document.getElementById("countryNiceList");
  const val  = document.getElementById("countryNiceValue");
  const search = document.getElementById("countryNiceSearch");
  const phone = document.getElementById("phoneLocalInput");

  if (!real || !wrap || !btn || !drop || !list || !val || !search) return;

  // build options from real select
  const options = Array.from(real.options).map(o => ({
    value: o.value,
    label: o.textContent.trim()
  }));

  function render(filter=""){
    const f = filter.trim().toLowerCase();
    list.innerHTML = "";
    options
      .filter(x => !f || x.label.toLowerCase().includes(f))
      .forEach(x => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "nice-select__opt" + (real.value === x.value ? " active" : "");
        b.textContent = x.label;

        b.addEventListener("click", ()=>{
          real.value = x.value;
          val.textContent = x.label;

          // close
          closeDrop();

          // focus next input
          setTimeout(()=> phone?.focus?.(), 0);

          // if you rely on change event anywhere:
          real.dispatchEvent(new Event("change", { bubbles:true }));
        });

        list.appendChild(b);
      });
  }

  function openDrop(){
    wrap.classList.add("open");
    drop.hidden = false;
    btn.setAttribute("aria-expanded","true");
    search.value = "";
    render("");
    setTimeout(()=> search.focus(), 0);
  }
  function closeDrop(){
    wrap.classList.remove("open");
    drop.hidden = true;
    btn.setAttribute("aria-expanded","false");
  }
  function toggle(){
    if (drop.hidden) openDrop();
    else closeDrop();
  }

  // initial label
  val.textContent = real.options[real.selectedIndex]?.textContent?.trim() || "اختر الدولة";

  btn.addEventListener("click", (e)=>{ e.preventDefault(); toggle(); });

  search.addEventListener("input", ()=> render(search.value));

  // click outside to close
  document.addEventListener("click", (e)=>{
    if (!wrap.contains(e.target)) closeDrop();
  });

  // esc
  document.addEventListener("keydown", (e)=>{
    if (e.key === "Escape") closeDrop();
  });
})();
const clearTextBtn = document.getElementById("clearTextBtn");

clearTextBtn?.addEventListener("click", ()=>{
  if (!textInput) return;

  textInput.value = "";
  textInput.focus();

  lastSourceText = "";
  lastOutputLang = "";
  previousQuestions = [];

  showToast(
    currentLang === "ar" ? "🧹 تم مسح النص" : "🧹 Text cleared",
    "ok",
    1600
  );
});
document.addEventListener("click", (e)=>{
  const back = e.target.closest("#backHomeBtn, [data-action='backHome']");
  if (!back) return;
  e.preventDefault();
  showView("home");
});
const backHomeBtn = document.getElementById("backHomeBtn");

function showBackBtn(){
  if (backHomeBtn) backHomeBtn.style.display = "inline-flex";
}
function hideBackBtn(){
  if (backHomeBtn) backHomeBtn.style.display = "none";
}

backHomeBtn?.addEventListener("click", ()=>{
  showView("home");
  hideBackBtn();
});
// ✅ HARD FIX: Solve clear text (works regardless of load order)
document.addEventListener("click", (e) => {
  const btn = e.target.closest("#clearSolveTextBtn");
  if (!btn) return;

  e.preventDefault();
  e.stopPropagation();

  const ta = document.getElementById("solveTextInput");
  if (!ta) return;

  ta.value = "";
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
});
const qc = document.getElementById("questionCount");
const qv = document.getElementById("qCountValue");
if (qc && qv) {
  qv.textContent = qc.value;
  qc.addEventListener("input", () => (qv.textContent = qc.value));
}
// ✅ Solve: Clear text button
document.addEventListener("DOMContentLoaded", () => {
  const solveTxt = document.getElementById("solveTextInput");
  const clearBtn = document.getElementById("clearSolveTextBtn");
  if (!solveTxt || !clearBtn) return;

  const sync = () => {
    clearBtn.style.display = solveTxt.value.trim() ? "flex" : "none";
  };

  clearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    solveTxt.value = "";
    solveTxt.focus();
    sync();
  });

  solveTxt.addEventListener("input", sync);
  sync();
});
// =======================
// Solve (RUN) — minimal working handler
// =======================
function showSolveToast(msg, type="ok", ms=2600){
  const t = document.getElementById("solveToast");
  if (!t) return;
  t.className = `toast ${type==="err" ? "err" : "ok"}`;
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(()=>{ t.style.display="none"; t.textContent=""; }, ms);
}

async function readSolveFileToText(file){
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "txt") return await readTxt(file);
  if (ext === "pdf") return await readPdf(file);
  if (ext === "docx") return await readDocx(file);
  return "";
}

document.getElementById("solveBtn")?.addEventListener("click", async ()=>{
  const out = document.getElementById("solveOutput");
  if (out) out.innerHTML = "";

  // Pro only (حسب منطقك الحالي)
  if (!isSubscribed()){
    showSolveToast(currentLang==="ar" ? "🔒 حل الأسئلة للمشترك فقط" : "🔒 Pro only", "err");
    openSubscribe();
    return;
  }

  const ta = document.getElementById("solveTextInput");
  const fi = document.getElementById("solveFileInput");
  const file = fi?.files?.[0] || null;

  let text = (ta?.value || "").trim();
  if (!text && file){
    showSolveToast(currentLang==="ar" ? "📄 جاري قراءة الملف..." : "📄 Reading file...", "ok", 1200);
    text = String(await readSolveFileToText(file)).trim();
  }

  if (!text){
    showSolveToast(currentLang==="ar" ? "⚠️ الصق أسئلة أو ارفع ملف" : "⚠️ Paste questions or upload a file", "err");
    return;
  }

  // ✅ هنا نستخدم نفس endpoint /api/generate لكن بنمط solve
  // لازم السيرفر يدعم mode: "solve" ويرجع data.text بنفس شكل parseGeminiText
  showSolveToast(currentLang==="ar" ? "⏳ جاري الحل..." : "⏳ Solving...", "ok", 1400);
  if (out) out.innerHTML = renderSkeleton();

  try{
    const { r, data, detected } = await callAPI({
      text,
      mode: "solve",
      count: 0,
      questionMode: "both",
      questionCount: 0
    });
    lastOutputLang = detected;

    if (!r.ok){
      out && (out.innerHTML = "");
      showSolveToast((data?.error || (currentLang==="ar"?"❌ خطأ":"❌ Error")), "err", 3200);
      return;
    }

    const parsed = parseGeminiText(data.text || "");
out && (out.innerHTML = renderSingleAnswerOnly(parsed));
  }catch(e){
    console.error(e);
    out && (out.innerHTML = "");
    showSolveToast(currentLang==="ar" ? "❌ خطأ اتصال" : "❌ Connection error", "err", 3200);
  }
});
document.addEventListener("DOMContentLoaded", () => {
  const fbSend = document.getElementById("fbSend");
  const fbMsg = document.getElementById("fbMsg");
  const fbType = document.getElementById("fbType");
  const fbStars = document.getElementById("fbStars");
  const fbRating = document.getElementById("fbRating");
  const fbCount = document.getElementById("fbCount");
  const feedbackSuccess = document.getElementById("feedbackSuccess");

  if (!fbSend) return;

  let ratingValue = 0;

  // ⭐ اختيار التقييم
  fbStars?.addEventListener("click", (e) => {
    const star = e.target.closest(".star");
    if (!star) return;

    ratingValue = Number(star.dataset.v);
    fbRating.value = ratingValue;

    fbStars.querySelectorAll(".star").forEach(s => {
      s.classList.toggle("active", Number(s.dataset.v) <= ratingValue);
    });
  });

  // 🔢 عداد الأحرف
  fbMsg?.addEventListener("input", () => {
    fbCount.textContent = fbMsg.value.length;
  });

  // 📩 إرسال
  fbSend.addEventListener("click", async () => {
    if (!ratingValue || fbMsg.value.trim().length < 3) {
      alert("اكتب رسالة واختر تقييم");
      return;
    }

    // (هنا ممكن يكون عندك إرسال Formspree — نخليه مثل ما هو)
    // await sendFeedbackFormspree();

    // ✅ نجاح الإرسال (UI فقط)
    fbMsg.value = "";
    fbCount.textContent = "0";
    fbRating.value = "0";
    ratingValue = 0;

    fbStars.querySelectorAll(".star").forEach(s => s.classList.remove("active"));

    feedbackSuccess.style.display = "block";
    setTimeout(() => {
      feedbackSuccess.style.display = "none";
    }, 3000);
  });
});
async function waitForProActivation(timeoutMs = 20000){
  const start = Date.now();

  while (Date.now() - start < timeoutMs){
    await syncSession();

    if (isSubscribed()){
      showToast(
        currentLang === "ar" ? "⭐ تم تفعيل الاشتراك!" : "⭐ Subscription activated!",
        "ok",
        2500
      );
      refreshHeaderButtons();
      closeSubscribe();
      return;
    }

    await new Promise(r => setTimeout(r, 1200));
  }

  showToast(
    currentLang === "ar"
      ? "✅ تم الدفع، وإذا ما تفعل الاشتراك خلال دقيقة تواصل معنا."
      : "✅ Payment completed. If Pro is not active yet, contact support.",
    "err",
    4000
  );
}

document.addEventListener("DOMContentLoaded", ()=>{
  const params = new URLSearchParams(location.search);
  if (params.get("thanks") === "1"){
    history.replaceState({}, "", "/?app=1");
    waitForProActivation();
  }
});
