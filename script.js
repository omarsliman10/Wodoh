/* =======================
   Settings
======================= */
const FULL_COUNT = 5;
const MORE_COUNT = 3;

/* ✅ PayPal Plan IDs (LIVE) */
const PAYPAL_PLAN_IDS = {
  monthly: "P-42A822454X567163XNFIV7MY",
  yearly:  "P-02486823H7988883MNFIV6LY",
};

let currentLang = "ar"; // UI language only (ar/en)
let previousQuestions = [];
let lastSourceText = "";

// ✅ store output language (ar/en/he) used for last generation
let lastOutputLang = ""; // "ar" | "en" | "he" | ""

/* timing */
let lastRequestTime = 0;
const MIN_DELAY = 2500;

const COOLDOWN_SECONDS = 30;
let nextMoreAllowedAt = 0;
let moreCountdownTimer = null;

let currentFile = null;

/* =======================
   Daily limit
======================= */
const FREE_DAILY_LIMIT = 3;
const LS_USAGE_KEY = "wodoh_daily_usage_v1";

function todayKey(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function getDailyUsage(){
  try{
    const raw = localStorage.getItem(LS_USAGE_KEY);
    if (!raw) return { date: todayKey(), used: 0 };
    const obj = JSON.parse(raw);
    if (!obj || obj.date !== todayKey()) return { date: todayKey(), used: 0 };
    return { date: obj.date, used: Number(obj.used)||0 };
  }catch{
    return { date: todayKey(), used: 0 };
  }
}
function setDailyUsage(used){
  localStorage.setItem(LS_USAGE_KEY, JSON.stringify({ date: todayKey(), used }));
}
function remainingFreeUses(){
  const u = getDailyUsage().used;
  return Math.max(0, FREE_DAILY_LIMIT - u);
}
function consumeOneUse(){
  const u = getDailyUsage().used;
  setDailyUsage(u + 1);
}

/* =======================
   Auth + Subscription (Local state)
======================= */
const LS_USER_KEY = "wodoh_user_v1";

function getUser(){
  try{
    const raw = localStorage.getItem(LS_USER_KEY);
    if (!raw) return { loggedIn:false, subscribed:false, email:"", firstName:"", lastName:"" };
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object"
      ? {
          loggedIn: !!obj.loggedIn,
          subscribed: !!obj.subscribed,
          email: obj.email || "",
          firstName: obj.firstName || "",
          lastName: obj.lastName || ""
        }
      : { loggedIn:false, subscribed:false, email:"", firstName:"", lastName:"" };
  }catch{
    return { loggedIn:false, subscribed:false, email:"", firstName:"", lastName:"" };
  }
}
function setUser(obj){
  const safe = obj && typeof obj === "object" ? obj : {};
  localStorage.setItem(LS_USER_KEY, JSON.stringify({
    loggedIn: !!safe.loggedIn,
    subscribed: !!safe.subscribed,
    email: safe.email || "",
    firstName: safe.firstName || "",
    lastName: safe.lastName || ""
  }));
}
function isLoggedIn(){ return !!getUser().loggedIn; }
function isSubscribed(){ return !!getUser().subscribed; }

/* =======================
   DOM Elements
======================= */
const textInput = document.getElementById("textInput");
const output = document.getElementById("output");
const generateBtn = document.getElementById("generateBtn");
const langBtn = document.getElementById("langBtn");
const toast = document.getElementById("toast");

/* Landing */
const landing = document.getElementById("landing");
const app = document.getElementById("app");
const startBtn = document.getElementById("startBtn");
const skipBtn = document.getElementById("skipBtn");

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

/* Account modal */
const accountModal = document.getElementById("accountModal");
const accountClose = document.getElementById("accountClose");
const tabLogin = document.getElementById("tabLogin");
const tabSignup = document.getElementById("tabSignup");

/* name fields */
const authFirstName = document.getElementById("authFirstName");
const authLastName  = document.getElementById("authLastName");

const authEmail = document.getElementById("authEmail");
const authPass = document.getElementById("authPass");
const authSubmit = document.getElementById("authSubmit");
const logoutBtn = document.getElementById("logoutBtn");

/* Subscribe modal */
const subscribeModal = document.getElementById("subscribeModal");
const subClose = document.getElementById("subClose");
const paypalButtonsEl = document.getElementById("paypalButtons");

/* =======================
   i18n
======================= */
const I18N = {
  ar: {
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
    toastLoggedIn: "✅ تم تسجيل الدخول",
    toastSignedUp: "✅ تم إنشاء الحساب",
    toastLoggedOut: "✅ تم تسجيل الخروج",
    toastSubOn: "⭐ تم تفعيل الاشتراك — بلا حدود!",
    toastSubAlready: "⭐ أنت مشترك بالفعل",
    toastPayPalNotReady: "⚠️ PayPal لم يتم تحميله بعد. حدّث الصفحة وحاول.",

    firstNameLabel: "الاسم الأول",
    lastNameLabel: "اسم العائلة",
    firstNamePh: "اسمك الشخصي",
    lastNamePh: "اسم العائلة",
    toastNeedName: "⚠️ أدخل الاسم الأول واسم العائلة",

    paywallTitle: "🔒 انتهت المحاولات المجانية اليوم",
    paywallText: "لديك 3 مرات يوميًا مجانًا. اشترك للمتابعة بلا حدود.",

    emailLabel: "الإيميل",
    passLabel: "كلمة المرور",
  },

  en: {
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
    toastLoggedIn: "✅ Logged in",
    toastSignedUp: "✅ Account created",
    toastLoggedOut: "✅ Logged out",
    toastSubOn: "⭐ Subscription enabled — Unlimited!",
    toastSubAlready: "⭐ You are already subscribed",
    toastPayPalNotReady: "⚠️ PayPal not loaded yet. Refresh and try again.",

    firstNameLabel: "First name",
    lastNameLabel: "Last name",
    firstNamePh: "e.g., Omar",
    lastNamePh: "e.g., Sliman",
    toastNeedName: "⚠️ Enter first & last name",

    paywallTitle: "🔒 Free limit reached today",
    paywallText: "You have 3 free tries per day. Subscribe for unlimited.",

    emailLabel: "Email",
    passLabel: "Password",
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
  if (!generateBtn) return;

  if (btnBusyTimer) clearTimeout(btnBusyTimer);

  if (isBusy){
    if (!originalGenerateLabel) originalGenerateLabel = generateBtn.textContent || t("generateBtn");
    generateBtn.disabled = true;
    generateBtn.style.filter = "brightness(0.72)";
    generateBtn.style.transform = "translateY(1px)";
    generateBtn.style.opacity = "0.95";
    generateBtn.textContent = t("generatingBtn");
  } else {
    btnBusyTimer = setTimeout(()=>{
      generateBtn.disabled = false;
      generateBtn.style.filter = "";
      generateBtn.style.transform = "";
      generateBtn.style.opacity = "";
      generateBtn.textContent = t("generateBtn");
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

function refreshHeaderButtons(){
  const u = getUser();

  if (headerAccountBtn){
    const fullName = `${u.firstName || ""} ${u.lastName || ""}`.trim();
    if (u.loggedIn){
      headerAccountBtn.textContent = fullName ? `👤 ${fullName}` : (u.email ? `👤 ${u.email}` : t("accountBtnTop"));
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
}

function canUseNow(){
  if (isSubscribed()) return true;
  return remainingFreeUses() > 0;
}

/* =======================
   Paywall
======================= */
function showPaywall(){
  const left = remainingFreeUses();
  if (paywallTitle) paywallTitle.textContent = t("paywallTitle");
  if (paywallText) paywallText.textContent = currentLang==="ar"
    ? `المجاني: ${FREE_DAILY_LIMIT} مرات/يوم. المتبقي اليوم: ${left}. اشترك للاستخدام بلا حدود.`
    : `Free: ${FREE_DAILY_LIMIT}/day. Remaining today: ${left}. Subscribe for unlimited.`;
  openModal(paywallModal);
}

closePaywall?.addEventListener("click", ()=> closeModal(paywallModal));
paywallModal?.addEventListener("click", (e)=>{ if (e.target === paywallModal) closeModal(paywallModal); });

paywallAccountBtn?.addEventListener("click", ()=>{
  closeModal(paywallModal);
  openAccount("login");
});
paywallSubscribeBtn?.addEventListener("click", ()=>{
  closeModal(paywallModal);
  openSubscribe();
});

/* =======================
   Account modal
======================= */
let accountMode = "login";

function setAccountTab(mode){
  accountMode = mode;
  tabLogin?.classList.toggle("active", mode==="login");
  tabSignup?.classList.toggle("active", mode==="signup");

  document.querySelectorAll("[data-auth-name]").forEach(el=>{
    el.style.display = (mode === "signup") ? "" : "none";
  });

  const emailLabelEl = document.getElementById("emailLabel");
  const passLabelEl = document.getElementById("passLabel");
  const firstLabelEl = document.getElementById("firstNameLabel");
  const lastLabelEl  = document.getElementById("lastNameLabel");
  if (emailLabelEl) emailLabelEl.textContent = t("emailLabel");
  if (passLabelEl) passLabelEl.textContent = t("passLabel");
  if (firstLabelEl) firstLabelEl.textContent = t("firstNameLabel");
  if (lastLabelEl) lastLabelEl.textContent = t("lastNameLabel");

  if (authFirstName) authFirstName.placeholder = t("firstNamePh");
  if (authLastName) authLastName.placeholder = t("lastNamePh");

  if (authSubmit){
    authSubmit.textContent = mode==="login"
      ? (currentLang==="ar" ? "دخول" : "Log in")
      : (currentLang==="ar" ? "إنشاء حساب" : "Create account");
  }
  if (authPass){
    authPass.setAttribute("autocomplete", mode==="login" ? "current-password" : "new-password");
  }
}

function openAccount(mode="login"){
  setAccountTab(mode);
  const u = getUser();
  if (logoutBtn){
    logoutBtn.style.display = u.loggedIn ? "block" : "none";
    logoutBtn.textContent = currentLang==="ar" ? "تسجيل خروج" : "Log out";
  }
  openModal(accountModal);
}
function closeAccount(){ closeModal(accountModal); }

headerAccountBtn?.addEventListener("click", ()=> openAccount("login"));
accountClose?.addEventListener("click", closeAccount);
accountModal?.addEventListener("click", (e)=>{ if (e.target === accountModal) closeAccount(); });

tabLogin?.addEventListener("click", ()=> setAccountTab("login"));
tabSignup?.addEventListener("click", ()=> setAccountTab("signup"));

authSubmit?.addEventListener("click", ()=>{
  const email = (authEmail?.value || "").trim();
  const pass = (authPass?.value || "").trim();

  const firstName = (authFirstName?.value || "").trim();
  const lastName  = (authLastName?.value || "").trim();

  if (accountMode === "signup"){
    if (!firstName || !lastName){
      showToast(t("toastNeedName"), "err");
      return;
    }
  }

  if (!email || !pass){
    showToast(currentLang==="ar" ? "⚠️ أدخل الإيميل وكلمة المرور" : "⚠️ Enter email & password", "err");
    return;
  }

  const u = getUser();
  setUser({
    loggedIn: true,
    subscribed: u.subscribed,
    email,
    firstName: (accountMode === "signup") ? firstName : (u.firstName || ""),
    lastName:  (accountMode === "signup") ? lastName  : (u.lastName  || "")
  });

  closeAccount();
  refreshHeaderButtons();
  showToast(accountMode==="login" ? t("toastLoggedIn") : t("toastSignedUp"));
});

logoutBtn?.addEventListener("click", ()=>{
  const u = getUser();
  setUser({ loggedIn:false, subscribed: u.subscribed, email:"", firstName:"", lastName:"" });
  closeAccount();
  refreshHeaderButtons();
  showToast(t("toastLoggedOut"));
});

/* =======================
   Subscribe modal (PayPal REAL) ✅ FIXED
   - Fix: if modal opens before PayPal SDK loads, we auto-wait and render once ready
======================= */
let selectedPlan = "monthly";
let paypalRendered = false;

// ✅ NEW: wait timer so we can render once SDK is ready (no need to reopen modal)
let paypalWaitTimer = null;

function getSelectedPlanId(){
  return PAYPAL_PLAN_IDS[selectedPlan] || PAYPAL_PLAN_IDS.monthly;
}

function openSubscribe(){
  if (isSubscribed()){
    showToast(t("toastSubAlready"), "ok", 1800);
    return;
  }
  openModal(subscribeModal);
  ensurePayPalButtons(); // ✅ will now auto-wait for SDK
}

// ✅ updated: stop waiting if user closes modal
function closeSubscribe(){
  if (paypalWaitTimer){
    clearInterval(paypalWaitTimer);
    paypalWaitTimer = null;
  }
  closeModal(subscribeModal);
}

headerSubscribeBtn?.addEventListener("click", openSubscribe);
subClose?.addEventListener("click", closeSubscribe);
subscribeModal?.addEventListener("click",(e)=>{ if (e.target === subscribeModal) closeSubscribe(); });

document.querySelectorAll(".plan").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".plan").forEach(x=> x.classList.remove("active"));
    btn.classList.add("active");
    selectedPlan = btn.getAttribute("data-plan") || "monthly";
    // لا نحتاج إعادة Render للأزرار لأن createSubscription يقرأ selectedPlan وقت الضغط
  });
});

function ensurePayPalButtons(){
  if (paypalRendered) return;
  if (!paypalButtonsEl) return;

  // reset container
  paypalButtonsEl.innerHTML = "";

  const isReady = () => !!(window.paypal && window.paypal.Buttons);

  // ✅ If PayPal SDK not ready yet, wait and render automatically when ready
  if (!isReady()){
    // show a friendly loading toast once
    showToast(
      currentLang === "ar"
        ? "⏳ جاري تحميل PayPal... انتظر ثوانٍ"
        : "⏳ Loading PayPal... please wait",
      "ok",
      2200
    );

    // avoid multiple timers
    if (paypalWaitTimer) return;

    // poll for readiness
    paypalWaitTimer = setInterval(()=>{
      // if user closed modal, stop
      if (!subscribeModal || subscribeModal.style.display !== "flex"){
        clearInterval(paypalWaitTimer);
        paypalWaitTimer = null;
        return;
      }

      if (isReady()){
        clearInterval(paypalWaitTimer);
        paypalWaitTimer = null;
        // try render now
        ensurePayPalButtons();
      }
    }, 250);

    return;
  }

  // ready -> render
  try{
    window.paypal.Buttons({
      style: {
        layout: "vertical",
        shape: "rect",
        label: "subscribe",
      },

      createSubscription: function(data, actions) {
        const planId = getSelectedPlanId();
        return actions.subscription.create({
          plan_id: planId
        });
      },

      onApprove: function(data, actions) {
        // ✅ تم الاشتراك — فعّل اللا محدود محليًا (لاحقًا نربطه بسيرفر + Webhook)
        const u = getUser();
        setUser({
          loggedIn: u.loggedIn,
          subscribed: true,
          email: u.email || "",
          firstName: u.firstName || "",
          lastName: u.lastName || ""
        });

        closeSubscribe();
        refreshHeaderButtons();
        showToast(t("toastSubOn"), "ok", 2600);

        // optional: حفظ subscription id للعرض
        // console.log("Subscription ID:", data.subscriptionID);
      },

      onError: function(err){
        console.error("PayPal error:", err);
        showToast(t("toastErr"), "err", 3500);
      },

      onCancel: function(){
        // المستخدم ألغى الدفع
        showToast(currentLang==="ar" ? "تم إلغاء العملية." : "Checkout canceled.", "err", 2000);
      }

    }).render("#paypalButtons");

    paypalRendered = true;
  }catch(e){
    console.error(e);
    showToast(t("toastErr"), "err", 3500);
  }
}

/* =======================
   applyLang (UI only)
======================= */
function applyLang(){
  const ar = currentLang === "ar";
  const dict = I18N[currentLang] || I18N.ar;

  document.documentElement.lang = ar ? "ar" : "en";
  document.documentElement.dir = ar ? "rtl" : "ltr";
  document.body.dir = ar ? "rtl" : "ltr";

  document.querySelectorAll("[data-i18n]").forEach((el)=>{
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    if (dict[key] != null) el.textContent = dict[key];
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el)=>{
    const key = el.getAttribute("data-i18n-placeholder");
    if (!key) return;
    if (dict[key] != null) el.setAttribute("placeholder", dict[key]);
  });

  if (langBtn) langBtn.textContent = dict.langBtn;
  if (generateBtn && !generateBtn.disabled) generateBtn.textContent = dict.generateBtn;

  if (paywallTitle && dict.paywallTitle) paywallTitle.textContent = dict.paywallTitle;
  if (paywallText && dict.paywallText) paywallText.textContent = dict.paywallText;

  if (authFirstName) authFirstName.placeholder = t("firstNamePh");
  if (authLastName) authLastName.placeholder = t("lastNamePh");

  refreshHeaderButtons();
}

/* =======================
   Session Save/Restore
======================= */
const LS_SESSION_KEY = "wodoh_last_session_v5";

function saveSession(){
  try{
    const payload = {
      lang: currentLang,
      text: (textInput?.value || ""),
      lastSourceText: lastSourceText || "",
      lastOutputLang: lastOutputLang || "",
      previousQuestions,
      outputHTML: output?.innerHTML || "",
      fileName: currentFile?.name || "",
      fileSize: currentFile?.size || 0,
      ts: Date.now()
    };
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(payload));
  }catch(e){}
}
function restoreSession(){
  try{
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);

    if (s.lang) currentLang = s.lang;
    if (textInput && typeof s.text === "string") textInput.value = s.text;
    if (typeof s.lastSourceText === "string") lastSourceText = s.lastSourceText;
    if (typeof s.lastOutputLang === "string") lastOutputLang = s.lastOutputLang;
    if (Array.isArray(s.previousQuestions)) previousQuestions = s.previousQuestions;

    if (output && typeof s.outputHTML === "string" && s.outputHTML.trim()){
      output.innerHTML = s.outputHTML;
    }

    if (s.fileName && filePreview && fileNameEl && fileMetaEl){
      filePreview.style.display = "block";
      fileNameEl.textContent = s.fileName;
      fileMetaEl.textContent = s.fileSize ? formatBytes(s.fileSize) : "—";
      if (clearFileBtn) clearFileBtn.disabled = false;
    }
  }catch(e){}
}

/* =======================
   Landing
======================= */
function openApp(){
  if (landing) landing.style.display = "none";
  if (app){
    app.style.display = "block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}
startBtn?.addEventListener("click", openApp);
skipBtn?.addEventListener("click", openApp);

/* =======================
   Init
======================= */
restoreSession();
applyLang();
refreshHeaderButtons();
setAccountTab("login");
textInput?.addEventListener("input", saveSession);

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

clearFileBtn?.addEventListener("click", clearFile);

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
  }catch(err){
    console.error(err);
    showToast(t("toastErr"), "err", 3500);
  }
}

function clearFile(){
  currentFile = null;
  if (filePreview) filePreview.style.display = "none";
  if (fileNameEl) fileNameEl.textContent = "—";
  if (fileMetaEl) fileMetaEl.textContent = "—";
  if (clearFileBtn) clearFileBtn.disabled = true;
  saveSession();
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
   Helpers
======================= */
function canRequest(){
  const now = Date.now();
  if (now - lastRequestTime < MIN_DELAY) return false;
  lastRequestTime = now;
  return true;
}

function startMoreCooldown(){
  nextMoreAllowedAt = Date.now() + COOLDOWN_SECONDS * 1000;
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
   API
======================= */
async function callAPI({text,mode,count}){
  const detected = detectLangFromText(text);

  const r = await fetch("/api/generate",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      text,
      mode,
      count,
      previous: previousQuestions,
      lang: detected,
    })
  });

  const data = await r.json().catch(()=> ({}));
  return { r, data, detected };
}

/* =======================
   Generate button
======================= */
generateBtn?.addEventListener("click", async ()=>{
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

  if (!canUseNow()){
    showPaywall();
    return;
  }

  previousQuestions = [];
  lastSourceText = text;

  if (output) output.innerHTML = renderSkeleton();

  setGenerateBusy(true);

  try{
    const { r, data, detected } = await callAPI({ text, mode:"full", count: FULL_COUNT });
    lastOutputLang = detected;

    if (!r.ok){
      showToast((data?.error || t("toastErr")), "err", 3500);
      return;
    }

    if (!isSubscribed()) consumeOneUse();

    const parsed = parseGeminiText(data.text || "");
    previousQuestions.push(
      ...parsed.mcq.map(q=>q.question),
      ...parsed.tf.map(q=>q.statement)
    );

    if (output){
      output.innerHTML = renderUI(parsed);
      output.insertAdjacentHTML("beforeend", `
        <div class="more-inline">
          <button class="more-btn" data-more>${outT("moreBtn")}</button>
        </div>
      `);
    }

    const summaryText = (parsed.summary || []).join("\n\n");
    const questions = [
      ...parsed.mcq.map(q => ({ type:"mcq", question:q.question, options:q.options, answer:q.correct })),
      ...parsed.tf.map(q => ({ type:"tf", statement:q.statement, answer:q.correct }))
    ];

    const L = outLang();
    const titlePrefix = (L==="ar") ? "ملخص" : (L==="he" ? "סיכום" : "Summary");

    addSummaryItem({
      title: `${titlePrefix} • ${new Date().toLocaleDateString()}`,
      summaryText,
      questions
    });

    saveSession();
    showToast(t("toastGenerated"));
    showToast(t("toastAdded"), "ok", 2200);
  }catch(e){
    console.error(e);
    showToast(t("toastConnErr"), "err");
  }finally{
    setGenerateBusy(false);
  }
});

/* =======================
   More button
======================= */
document.addEventListener("click", async (e)=>{
  const btn = e.target.closest("[data-more]");
  if (!btn) return;

  hideToast();

  if (!lastSourceText){
    showToast(t("toastTextFirst"), "err");
    return;
  }

  if (!canUseNow()){
    showPaywall();
    return;
  }

  if (Date.now() < nextMoreAllowedAt){
    showToast(t("toastTimer"), "err");
    return;
  }

  if (!canRequest()){
    showToast(t("toastWait"), "err");
    return;
  }

  startMoreCooldown();

  const skeletonHolder = document.createElement("div");
  skeletonHolder.innerHTML = renderSkeleton();
  skeletonHolder.style.marginTop = "14px";

  const anchor = btn.closest(".card") || btn.closest(".more-inline") || output;
  anchor.insertAdjacentElement("afterend", skeletonHolder);

  try{
    const { r, data, detected } = await callAPI({ text:lastSourceText, mode:"more", count: MORE_COUNT });
    lastOutputLang = detected;

    skeletonHolder.remove();

    if (!r.ok){
      showToast((data?.error || t("toastErr")), "err", 3500);
      return;
    }

    if (!isSubscribed()) consumeOneUse();

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
    showToast(t("toastAdded"));
  }catch(e){
    console.error(e);
    skeletonHolder.remove();
    showToast(t("toastConnErr"), "err");
  }
});

/* =======================
   Answer selection
======================= */
document.addEventListener("click",(e)=>{
  const opt = e.target.closest("[data-opt]");
  if (!opt) return;

  const q = opt.closest(".q");
  if (!q || q.dataset.answered) return;
  q.dataset.answered = "1";

  const chosen = opt.dataset.opt;
  const correct = q.dataset.correct;

  q.querySelectorAll("[data-opt]").forEach(b=>{
    b.disabled = true;
    b.classList.add("disabled");
    if (b.dataset.opt === correct) b.classList.add("correct");
    if (b.dataset.opt === chosen && chosen !== correct) b.classList.add("wrong");
  });

  saveSession();
});

/* =======================
   Render
======================= */
function renderUI(p){
  const L = outLang();
  const rtl = (L === "ar" || L === "he");

  return `
    ${p.summary.length ? `
      <div class="card" dir="${rtl ? "rtl" : "ltr"}">
        <h3>📌 ${outT("summaryTitle")}</h3>
        <div class="sum-paras">
          ${p.summary.map(x=>`<p style="margin:0 0 10px;line-height:1.75;opacity:.95">${escapeHtml(x)}</p>`).join("")}
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

/* =======================
   Parser
======================= */
function parseGeminiText(text){
  const raw = String(text || "").replace(/\r/g, "");
  const lines = raw.split("\n");

  const summary = [];
  const mcq = [];
  const tf = [];

  const isHeader = (l) => /^\[(.+)\]\s*$/.test(l.trim());
  const headerName = (l) => {
    const m = l.trim().match(/^\[(.+)\]\s*$/);
    return m ? m[1].trim().toLowerCase() : "";
  };

  let section = "";
  let buffer = [];

  function flushSummaryBuffer(){
    const joined = buffer.join("\n").trim();
    buffer = [];
    if (!joined) return;
    const paras = joined.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
    summary.push(...paras);
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

  return { summary, mcq, tf, raw };
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
   My Summaries
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
    ? crypto.randomUUID()
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
function showSummariesView(){
  if (panel) panel.style.display = "none";
  if (output) output.style.display = "none";
  if (mySummariesWrap) mySummariesWrap.style.display = "block";
}
function showMainView(){
  if (mySummariesWrap) mySummariesWrap.style.display = "none";
  if (panel) panel.style.display = "";
  if (output) output.style.display = "";
}

function renderMySummaries(){
  const wrap = document.getElementById("mySummaries");
  if (!wrap) return;

  const list = loadSummaries();
  const title = currentLang==="ar" ? "📚 ملخصاتي" : "📚 My Summaries";
  const empty = currentLang==="ar" ? "لا يوجد ملخصات محفوظة بعد." : "No saved summaries yet.";
  const backLabel = currentLang==="ar" ? "⬅ رجوع" : "⬅ Back";

  wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;">
      <h2 style="margin:0">${title}</h2>
      <button id="backFromSummaries" class="btn btn-soft" type="button">${backLabel}</button>
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

  document.getElementById("backFromSummaries")?.addEventListener("click", showMainView);

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

  document.getElementById("backToList")?.addEventListener("click", renderMySummaries);
  wrap.scrollIntoView({ behavior:"smooth", block:"start" });
}

mySummariesBtn?.addEventListener("click", ()=>{
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
