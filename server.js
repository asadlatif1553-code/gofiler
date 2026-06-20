/**
 * server.js — Express backend for GoFiler Web App
 * Run: node server.js  (default port 3000)
 */

const express  = require("express");
const cors     = require("cors");
const fs       = require("fs");
const path     = require("path");
const https    = require("https");
const http     = require("http");
const { compute, defaultReturnData } = require("./taxEngine");

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data", "returns.json");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Ensure data directory exists (no-op on read-only filesystems like Vercel)
try {
  if (!fs.existsSync(path.join(__dirname, "data"))) {
    fs.mkdirSync(path.join(__dirname, "data"));
  }
} catch (_) {}

// ── Helpers ────────────────────────────────────────────────────────────────

function loadReturns() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveReturns(returns) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(returns, null, 2), "utf8"); } catch (_) {}
}

// ── Routes ─────────────────────────────────────────────────────────────────

// POST /api/compute — compute tax from submitted ReturnData, do NOT persist
app.post("/api/compute", (req, res) => {
  try {
    const data = { ...defaultReturnData(), ...req.body };
    const result = compute(data);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /api/return/:cnic — load saved return for a CNIC
app.get("/api/return/:cnic", (req, res) => {
  const returns = loadReturns();
  const key = req.params.cnic.replace(/[^0-9]/g, "");
  const entry = returns[key] || null;
  res.json({ ok: true, data: entry ? entry.returnData : defaultReturnData() });
});

// POST /api/return/:cnic — save return for a CNIC
app.post("/api/return/:cnic", (req, res) => {
  const returns = loadReturns();
  const key = req.params.cnic.replace(/[^0-9]/g, "");
  returns[key] = {
    cnic: key,
    name: req.body.name || "",
    savedAt: new Date().toISOString(),
    returnData: { ...defaultReturnData(), ...req.body }
  };
  saveReturns(returns);
  res.json({ ok: true, message: "Return saved." });
});

// GET /api/returns — list all saved returns (summary only)
app.get("/api/returns", (req, res) => {
  const returns = loadReturns();
  const list = Object.values(returns).map(r => ({
    cnic: r.cnic, name: r.name, savedAt: r.savedAt
  }));
  res.json({ ok: true, list });
});

// DELETE /api/return/:cnic — delete a saved return
app.delete("/api/return/:cnic", (req, res) => {
  const returns = loadReturns();
  const key = req.params.cnic.replace(/[^0-9]/g, "");
  delete returns[key];
  saveReturns(returns);
  res.json({ ok: true });
});

// ── FBR Active Filer Checker ───────────────────────────────────────────────

/**
 * Simple HTTP GET returning the response body as a string.
 */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, { headers: { "User-Agent": "Mozilla/5.0", ...headers } }, (res) => {
      // Follow a single redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ body: data, headers: res.headers, status: res.statusCode }));
    }).on("error", reject);
  });
}

/**
 * HTTP POST with form-encoded body, returning response body as a string.
 */
function httpPost(url, formBody, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(formBody),
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml",
        ...extraHeaders
      }
    };
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ body: data, headers: res.headers, status: res.statusCode }));
    });
    req.on("error", reject);
    req.write(formBody);
    req.end();
  });
}

/** Extract a hidden form field value from ASP.NET HTML */
function extractHiddenField(html, name) {
  const re = new RegExp(`id="${name}"[^>]*value="([^"]*)"`, "i");
  const m = html.match(re) || html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

// GET /api/filer/:cnic — check FBR Active Taxpayer List status
app.get("/api/filer/:cnic", async (req, res) => {
  const cnic = req.params.cnic.replace(/[^0-9]/g, "");
  if (cnic.length !== 13) {
    return res.status(400).json({ ok: false, error: "CNIC must be exactly 13 digits." });
  }

  const ATL_URL = "https://e.fbr.gov.pk/ATLSearchUtilityIT.aspx";

  try {
    // Step 1 — load the page to obtain ASP.NET state tokens
    const { body: pageHtml, headers: pageHeaders } = await httpGet(ATL_URL);

    const viewState    = extractHiddenField(pageHtml, "__VIEWSTATE");
    const eventVal     = extractHiddenField(pageHtml, "__EVENTVALIDATION");
    const viewStateGen = extractHiddenField(pageHtml, "__VIEWSTATEGENERATOR");

    // Extract cookie(s) for session continuity
    const setCookie = pageHeaders["set-cookie"] || [];
    const cookie = setCookie.map(c => c.split(";")[0]).join("; ");

    // Step 2 — POST the CNIC
    const formBody = new URLSearchParams({
      "__VIEWSTATE":          viewState,
      "__VIEWSTATEGENERATOR": viewStateGen,
      "__EVENTVALIDATION":    eventVal,
      "txtCnic":              cnic,
      "Button1":              "Search"
    }).toString();

    const { body: resultHtml } = await httpPost(ATL_URL, formBody, {
      "Referer": ATL_URL,
      "Cookie":  cookie
    });

    const lower = resultHtml.toLowerCase();

    // Log a snippet so we can see what FBR is returning
    const snippet = resultHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
    console.log("[FBR ATL] Response snippet:", snippet);

    // Parse result text — cast a wide net over common FBR response phrases
    if (
      lower.includes("active taxpayer") || lower.includes("is active") ||
      lower.includes("atl status: active") || lower.includes("status: active") ||
      lower.includes("in atl") || lower.includes("is filer") ||
      lower.includes("is an active")
    ) {
      return res.json({ ok: true, status: "filer", label: "Active Filer ✅",
        message: "This CNIC is on the FBR Active Taxpayer List (ATL). Filer WHT rates apply." });
    }
    if (
      lower.includes("not an active") || lower.includes("not active") ||
      lower.includes("non active") || lower.includes("non-active") ||
      lower.includes("inactive") || lower.includes("not in atl") ||
      lower.includes("not a filer") || lower.includes("not filer") ||
      lower.includes("not found") || lower.includes("no record")
    ) {
      return res.json({ ok: true, status: "non-filer", label: "Non-Filer ❌",
        message: "This CNIC is NOT on the Active Taxpayer List. Higher non-filer WHT rates apply." });
    }

    // Could not parse — FBR portal has CAPTCHA, automation is not possible
    return res.json({ ok: false, fallback: true,
      error: "FBR requires a CAPTCHA — automated checks are not possible. Use the button below to verify on the IRIS portal." });

  } catch (e) {
    console.error("FBR ATL lookup failed:", e.message);
    return res.json({ ok: false, fallback: true,
      error: "FBR blocks automated checks. Use the button below to open the portal — your CNIC will be copied to clipboard automatically." });
  }
});

// ── Lead Capture ──────────────────────────────────────────────────────────

const LEADS_FILE = path.join(__dirname, "data", "leads.json");

function loadLeads() {
  try {
    if (fs.existsSync(LEADS_FILE)) return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
  } catch (_) {}
  return [];
}

// POST /api/lead — save a lead (email + phone) collected from the app
app.post("/api/lead", (req, res) => {
  try {
    const { email, phone, name, cnic, ts, source } = req.body;
    if (!email && !phone) return res.status(400).json({ ok: false, error: "email or phone required" });

    const leads = loadLeads();
    // Avoid duplicates by email
    const exists = leads.find(l => l.email && l.email.toLowerCase() === (email||"").toLowerCase());
    if (!exists) {
      leads.push({ email: email||"", phone: phone||"", name: name||"", cnic: cnic||"", ts: ts||new Date().toISOString(), source: source||"gofiler" });
      fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), "utf8");
      console.log(`[Lead] New: ${email} / ${phone} (${name})`);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[Lead] Save error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/leads — list all leads (for admin use)
app.get("/api/leads", (req, res) => {
  const leads = loadLeads();
  res.json({ ok: true, count: leads.length, leads });
});

// ── Tax Advisor Chatbot (Ollama proxy) ────────────────────────────────────

const TAX_SYSTEM_PROMPT = `You are GoFiler Tax Advisor, an expert on Pakistan income tax law for Tax Year 2026. You help Pakistani taxpayers with practical, accurate tax advice. Always answer in clear simple language. Give amounts in Pakistani Rupees (Rs).

=== TAX YEAR 2026 (1 Jul 2025 – 30 Jun 2026) — Finance Act 2025 ===

SALARIED INDIVIDUAL SLABS (Division I, Part I, First Schedule):
• Up to Rs 600,000 → Nil
• Rs 600,001–1,200,000 → 1% of excess over 600,000
• Rs 1,200,001–2,200,000 → Rs 6,000 + 11% of excess over 1,200,000
• Rs 2,200,001–3,200,000 → Rs 116,000 + 23% of excess over 2,200,000
• Rs 3,200,001–4,100,000 → Rs 346,000 + 30% of excess over 3,200,000
• Above Rs 4,100,000 → Rs 616,000 + 35% of excess over 4,100,000

NON-SALARIED / BUSINESS INDIVIDUAL SLABS (Division II):
• Up to Rs 600,000 → Nil
• Rs 600,001–1,200,000 → 15% of excess over 600,000
• Rs 1,200,001–2,400,000 → Rs 90,000 + 20% of excess over 1,200,000
• Rs 2,400,001–3,600,000 → Rs 330,000 + 25% of excess over 2,400,000
• Rs 3,600,001–6,000,000 → Rs 630,000 + 30% of excess over 3,600,000
• Above Rs 6,000,000 → Rs 1,350,000 + 35% of excess over 6,000,000

SALARIED vs NON-SALARIED: Salaried rates apply only when salary income > 75% of total taxable income. Otherwise non-salaried (higher) rates apply.

SURCHARGE (Section 4AB): 9% of income tax payable where taxable income exceeds Rs 10,000,000.

DEDUCTIONS AND TAX CREDITS:
• Zakat (Sec 60): Deducted directly from taxable income
• Workers Welfare Fund (Sec 60): Deducted from taxable income
• Pension Fund Contribution (Sec 63): Tax credit at average effective rate, max eligible = 20% of taxable income
• Charitable Donations (Sec 61): Tax credit at average effective rate, max eligible = 30% of taxable income
• Teacher/Researcher Reduction: 25% reduction on salary tax (2nd Schedule, Part III, Clause 1(1A))

FINAL/SEPARATE TAX REGIMES:
• Bank profit on savings/term deposits up to Rs 5M (Sec 7B): 15% filers, 30% non-filers (final tax)
• NSS / prize bond profit (Sec 151): 15% filers, 30% non-filers (final tax)
• Dividends (Sec 150): 15% filers, 30% non-filers (final tax)
• Profit on debt > Rs 5M: Falls outside Sec 7B final regime — taxable at normal rates
• Securities gains (Sec 37A): held < 1 yr = 15%, 1–2 yr = 12.5%, > 2 yr = exempt
• Property capital gains (Sec 37): Open Plot — <1yr=15%, 1-2yr=12.5%, 2-3yr=10%, 3-4yr=7.5%, 4-5yr=5%, 5-6yr=2.5%, >6yr=exempt. Constructed/Flat — <1yr=15%, 1-2yr=12.5%, 2-3yr=10%, 3-4yr=7.5%, 4-5yr=5%, >5yr=exempt.

WITHHOLDING TAX — FILER vs NON-FILER:
• Bank profit / NSS (Sec 7B/151): 15% filer, 30% non-filer
• Dividends (Sec 150): 15% filer, 30% non-filer
• Cash withdrawal > Rs 50,000/transaction (Sec 231A): 0% filer, 0.6% non-filer
• Immovable property purchase (Sec 236K): 3% filer, 6% non-filer
• Immovable property sale (Sec 236C): 3% filer, 6% non-filer
• Services/contracts (Sec 153): 10% filer, 20% non-filer
• Commission (Sec 233): 12% filer, 20% non-filer
• Vehicle registration 1001–1800cc (Sec 231B): Rs 10,000 filer, Rs 25,000 non-filer
• Vehicle registration 1801–2500cc: Rs 25,000 filer, Rs 75,000 non-filer
• Vehicle registration >2500cc: Rs 50,000 filer, Rs 150,000 non-filer

ACTIVE TAXPAYER LIST (ATL):
• Updated weekly by FBR every Sunday
• Check via SMS: send "ATL [space] 13-digit-CNIC" to 9966
• Check online: iris.fbr.gov.pk → Online Verifications → Active Taxpayer List (Income Tax)
• Being on ATL = Active Filer = lower WHT rates on all financial transactions

FILING REQUIREMENTS (Income Tax Ordinance 2001, Sec 114):
• Deadline: 30 September each year (for tax year ending 30 June)
• Extension: Commissioner can grant extension on application
• Portal: IRIS at iris.fbr.gov.pk
• Who must file: taxable income > Rs 600,000 OR owns property/vehicle abroad OR is a company director OR has foreign assets/income OR is a withholding agent OR runs a business
• NTN (National Tax Number): Required to file. Register free on iris.fbr.gov.pk

WEALTH STATEMENT (Sec 116):
• Required if taxable income > Rs 1,000,000 or if required to file under Sec 114
• Shows opening net assets, inflows (income + gifts + remittances), outflows (expenses + tax), and closing net assets
• Must balance: Increase in net assets = Inflows − Outflows

PROPERTY INCOME (Sec 15):
• Net rental income = rent received − property tax − insurance − maintenance − interest on loan − other deductions
• Taxed at normal slab rates as part of total income

BUSINESS INCOME (Sec 18/22):
• Net = Revenue − Cost of Sales − Admin Expenses − Finance Charges − Depreciation − Initial Allowance − Other Deductions
• Depreciation: Building 10%, Plant & Machinery 15%, Vehicles 15%, Computers 30%
• Initial Allowance: 25% on new plant & machinery in year of installation

SALARY INCOME (Sec 12):
• Includes: basic salary, HRA, medical allowance, conveyance, bonuses, perquisites
• Exempt: medical allowance up to 10% of basic salary (Clause 139, 2nd Schedule)
• Tax deducted by employer u/s 149 is adjustable against liability

FOREIGN INCOME / REMITTANCES:
• Foreign remittances received in Pakistan (Sec 111(4)): exempt if routed through banking channel
• Foreign income of resident: taxable in Pakistan

COMMON QUESTIONS:
• Last date to file return: 30 September (TY2026 = 30 Sep 2026)
• Penalty for late filing (Sec 182): Rs 40,000 or 0.1% of tax per week, whichever is higher
• How to become filer: Register NTN on IRIS → file income tax return → you appear on ATL next Sunday

Always be helpful, accurate, and practical. For complex matters recommend consulting a registered tax consultant or FBR helpline 051-111-772-772.`;

// POST /api/chat — proxy to Ollama for tax advisor chatbot
app.post("/api/chat", async (req, res) => {
  const { messages, model = "llama3.2:3b" } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ ok: false, error: "messages array required" });
  }

  const ollamaBody = JSON.stringify({
    model,
    messages: [
      { role: "system", content: TAX_SYSTEM_PROMPT },
      ...messages
    ],
    stream: true
  });

  const options = {
    hostname: "localhost",
    port: 11434,
    path: "/api/chat",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(ollamaBody)
    }
  };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const ollamaReq = http.request(options, (ollamaRes) => {
    ollamaRes.on("data", chunk => {
      try {
        const lines = chunk.toString().split("\n").filter(l => l.trim());
        lines.forEach(line => {
          const obj = JSON.parse(line);
          const token = obj?.message?.content || "";
          if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
          if (obj.done) res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        });
      } catch (_) {}
    });
    ollamaRes.on("end", () => res.end());
  });

  ollamaReq.on("error", (e) => {
    res.write(`data: ${JSON.stringify({ error: "Ollama not running. Please install Ollama and run: ollama run llama3.2:3b" })}\n\n`);
    res.end();
  });

  ollamaReq.write(ollamaBody);
  ollamaReq.end();
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nGoFiler running at http://localhost:${PORT}\n`);
});
