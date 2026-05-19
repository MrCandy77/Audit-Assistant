/* Subscription Audit Assistant (standalone, offline-first)
   - Parses CSV locally
   - Auto-detects Date/Description/Amount columns (with safe mapping fallback)
   - Detects recurring merchants (subscription candidates)
   - Review -> Confirm -> Dashboard
*/
(function () {
  "use strict";

  const STORAGE_KEY = "saa:v1";
  const DAY_MS = 24 * 60 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const banner = $("banner");

  function showBanner(message, type = "ok") {
    banner.hidden = false;
    banner.className = "banner" + (type === "error" ? " error" : type === "warn" ? " warn" : "");
    banner.textContent = message;
  }
  function hideBanner() {
    banner.hidden = true;
    banner.textContent = "";
  }

  function safeJsonParse(text, fallback) {
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? safeJsonParse(raw, null) : null;
  }
  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  function clearState() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function toISODate(date) {
    // yyyy-mm-dd
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseDateMaybe(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;

    // Try ISO / yyyy-mm-dd or yyyy/mm/dd
    const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (iso) {
      const y = Number(iso[1]);
      const m = Number(iso[2]);
      const d = Number(iso[3]);
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (!Number.isNaN(dt.getTime())) return dt;
    }

    // Try dd/mm/yyyy or mm/dd/yyyy (ambiguous). We'll infer by >12.
    const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
    if (dmy) {
      let a = Number(dmy[1]);
      let b = Number(dmy[2]);
      let y = Number(dmy[3]);
      if (y < 100) y += 2000;
      let day = a;
      let month = b;
      if (a <= 12 && b <= 12) {
        // ambiguous; prefer day/month (common outside US)
        day = a;
        month = b;
      } else if (a > 12 && b <= 12) {
        day = a;
        month = b;
      } else if (b > 12 && a <= 12) {
        day = b;
        month = a;
      }
      const dt = new Date(Date.UTC(y, month - 1, day));
      if (!Number.isNaN(dt.getTime())) return dt;
    }

    // Last resort: Date.parse (can be locale-dependent)
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t);
    return null;
  }

  function parseAmountMaybe(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    // Remove currency symbols and spaces, keep digits, commas, dots, minus
    const cleaned = s
      .replace(/[^\d,.\-]/g, "")
      .replace(/,(?=\d{3}(\D|$))/g, ""); // remove thousands commas
    const n = Number(cleaned);
    if (Number.isNaN(n)) return null;
    return n;
  }

  function normalizeMerchant(desc) {
    if (!desc) return "";
    let s = String(desc).toLowerCase();
    s = s.replace(/\s+/g, " ").trim();
    // remove common noise tokens
    s = s.replace(/\b(pos|purchase|card|debit|credit|online|payment|paid|visa|mastercard|mc|auth|ref|reference)\b/g, "");
    s = s.replace(/[^\p{L}\p{N}\s.+/&-]/gu, ""); // keep unicode letters/numbers
    s = s.replace(/\s+/g, " ").trim();
    // collapse long IDs
    s = s.replace(/\b\d{4,}\b/g, "");
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  function formatMoney(amount, currency = "USD") {
    const abs = Math.abs(amount);
    const locale = undefined;
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: abs < 10 ? 2 : 2,
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${currency}`;
    }
  }

  function guessCurrencyFromText(text) {
    const t = (text || "").toUpperCase();
    if (t.includes("ZAR") || t.includes("R ")) return "ZAR";
    if (t.includes("GBP") || t.includes("£")) return "GBP";
    if (t.includes("EUR") || t.includes("€")) return "EUR";
    if (t.includes("USD") || t.includes("$")) return "USD";
    return "ZAR";
  }

  function detectCurrencyFromCsv(headers, dataRows, fullText) {
    // Prefer explicit currency markers in headers/cells; fallback to ZAR
    const headerText = (headers || []).join(" ");
    const candidatesText = [fullText, headerText].filter(Boolean).join("\n");
    let c = guessCurrencyFromText(candidatesText);
    if (c && c !== "ZAR") return c;

    // Scan a small sample of cells for currency codes/symbols
    const sampleRows = (dataRows || []).slice(0, 80);
    const sampleCells = [];
    for (const r of sampleRows) {
      for (let i = 0; i < Math.min(r.length, 12); i++) {
        const v = r[i];
        if (v == null) continue;
        const s = String(v).trim();
        if (!s) continue;
        sampleCells.push(s);
      }
      if (sampleCells.length > 600) break;
    }
    c = guessCurrencyFromText(sampleCells.join(" "));
    return c || "ZAR";
  }

  function parseCSV(text) {
    // Lightweight CSV parser: handles commas, quotes, newlines inside quotes.
    const rows = [];
    let row = [];
    let field = "";
    let i = 0;
    let inQuotes = false;

    function pushField() {
      row.push(field);
      field = "";
    }
    function pushRow() {
      // ignore trailing blank lines
      if (row.length === 1 && row[0] === "" && rows.length > 0) {
        row = [];
        return;
      }
      rows.push(row);
      row = [];
    }

    while (i < text.length) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          const next = text[i + 1];
          if (next === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += c;
        i += 1;
        continue;
      }

      if (c === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }

      if (c === ",") {
        pushField();
        i += 1;
        continue;
      }

      if (c === "\r") {
        // ignore CR; handle CRLF with LF case below
        i += 1;
        continue;
      }

      if (c === "\n") {
        pushField();
        pushRow();
        i += 1;
        continue;
      }

      field += c;
      i += 1;
    }

    pushField();
    pushRow();
    return rows;
  }

  function scoreColumnAsDate(values) {
    let ok = 0;
    let total = 0;
    for (const v of values) {
      if (v == null) continue;
      const s = String(v).trim();
      if (!s) continue;
      total += 1;
      if (parseDateMaybe(s)) ok += 1;
      if (total >= 25) break;
    }
    return total === 0 ? 0 : ok / total;
  }
  function scoreColumnAsAmount(values) {
    let ok = 0;
    let total = 0;
    for (const v of values) {
      if (v == null) continue;
      const s = String(v).trim();
      if (!s) continue;
      total += 1;
      const n = parseAmountMaybe(s);
      if (n != null && Number.isFinite(n)) ok += 1;
      if (total >= 25) break;
    }
    return total === 0 ? 0 : ok / total;
  }
  function scoreColumnAsDesc(values) {
    let total = 0;
    let avgLen = 0;
    let hasLetters = 0;
    for (const v of values) {
      if (v == null) continue;
      const s = String(v).trim();
      if (!s) continue;
      total += 1;
      avgLen += s.length;
      if (/[a-zA-Z]/.test(s)) hasLetters += 1;
      if (total >= 25) break;
    }
    if (total === 0) return 0;
    avgLen /= total;
    const letterRatio = hasLetters / total;
    return Math.min(1, (avgLen / 18) * 0.6 + letterRatio * 0.6);
  }

  function detectColumns(headers, sampleRows) {
    const cols = headers.map((h, idx) => {
      const values = sampleRows.map((r) => (r[idx] ?? "").trim());
      const hLower = (h || "").toLowerCase();
      const dateBoost = /(date|posted|posting|transaction date)/.test(hLower) ? 0.15 : 0;
      const amtBoost = /(amount|amt|debit|credit|value|paid|charge)/.test(hLower) ? 0.15 : 0;
      const descBoost = /(desc|description|details|merchant|narration|memo)/.test(hLower) ? 0.15 : 0;
      return {
        idx,
        header: h || `Column ${idx + 1}`,
        dateScore: Math.min(1, scoreColumnAsDate(values) + dateBoost),
        amtScore: Math.min(1, scoreColumnAsAmount(values) + amtBoost),
        descScore: Math.min(1, scoreColumnAsDesc(values) + descBoost),
      };
    });

    const bestDate = cols.slice().sort((a, b) => b.dateScore - a.dateScore)[0];
    const bestAmt = cols.slice().sort((a, b) => b.amtScore - a.amtScore)[0];
    const bestDesc = cols.slice().sort((a, b) => b.descScore - a.descScore)[0];

    const mapping = { date: bestDate?.idx ?? null, desc: bestDesc?.idx ?? null, amt: bestAmt?.idx ?? null };
    const confidence = Math.min(bestDate?.dateScore ?? 0, bestDesc?.descScore ?? 0, bestAmt?.amtScore ?? 0);
    return { mapping, confidence, cols };
  }

  function buildTransactions(rows, mapping) {
    const tx = [];
    for (const r of rows) {
      const dateRaw = r[mapping.date] ?? "";
      const descRaw = r[mapping.desc] ?? "";
      const amtRaw = r[mapping.amt] ?? "";
      const dt = parseDateMaybe(dateRaw);
      const amount = parseAmountMaybe(amtRaw);
      if (!dt || amount == null) continue;
      const desc = String(descRaw ?? "").trim();
      tx.push({
        date: toISODate(dt),
        ts: dt.getTime(),
        desc,
        merchant: normalizeMerchant(desc),
        amount,
        raw: r,
      });
    }
    tx.sort((a, b) => a.ts - b.ts);
    return tx;
  }

  function median(values) {
    if (values.length === 0) return 0;
    const arr = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  function detectSubscriptions(transactions, strictness) {
    // Returns array of candidates: { id, name, merchant, charges:[{date,amount}], avgMonthly, lastChargeTs }
    const byMerchant = new Map();
    for (const t of transactions) {
      if (!t.merchant) continue;
      // Ignore obvious transfers/fees where description is too generic
      if (t.merchant.length < 3) continue;
      const key = t.merchant;
      const entry = byMerchant.get(key) || [];
      entry.push(t);
      byMerchant.set(key, entry);
    }

    const nowTs = Date.now();
    const candidates = [];

    const cfg =
      strictness === "strict"
        ? { minCharges: 3, cadenceDays: [26, 35], amountVar: 0.12 }
        : strictness === "loose"
          ? { minCharges: 2, cadenceDays: [20, 40], amountVar: 0.25 }
          : { minCharges: 2, cadenceDays: [25, 36], amountVar: 0.2 };

    for (const [merchant, list] of byMerchant.entries()) {
      if (list.length < cfg.minCharges) continue;

      const charges = list
        .filter((x) => x.amount < 0 || x.amount > 0) // keep all, normalize later
        .map((x) => ({ date: x.date, ts: x.ts, amount: x.amount, desc: x.desc }));

      // Many banks store spend as negative. Treat subscription "cost" as positive spend magnitude.
      const spend = charges.map((c) => Math.abs(c.amount)).filter((a) => a > 0.001);
      if (spend.length < cfg.minCharges) continue;

      const med = median(spend);
      if (med <= 0) continue;

      const withinVar = spend.filter((a) => Math.abs(a - med) / (med || 1) <= cfg.amountVar).length / spend.length;
      if (withinVar < 0.55 && strictness !== "loose") continue;

      const sorted = charges.slice().sort((a, b) => a.ts - b.ts);
      const deltas = [];
      for (let i = 1; i < sorted.length; i++) {
        deltas.push((sorted[i].ts - sorted[i - 1].ts) / DAY_MS);
      }
      const medDelta = median(deltas);
      const inCadence = medDelta >= cfg.cadenceDays[0] && medDelta <= cfg.cadenceDays[1];
      if (!inCadence && strictness !== "loose") continue;

      const last = sorted[sorted.length - 1];
      const avgMonthly = med; // heuristic
      const dormant90 = nowTs - last.ts > 90 * DAY_MS;

      candidates.push({
        id: `m:${merchant}`,
        name: prettifyServiceName(merchant),
        merchant,
        avgMonthly,
        lastChargeTs: last.ts,
        lastChargeDate: last.date,
        dormant90,
        charges: sorted.map((c) => ({ date: c.date, ts: c.ts, amount: Math.abs(c.amount) })),
      });
    }

    candidates.sort((a, b) => b.avgMonthly - a.avgMonthly);
    return candidates;
  }

  function prettifyServiceName(merchant) {
    const s = String(merchant || "").trim();
    if (!s) return "Unknown";
    const words = s.split(" ").filter(Boolean);
    const capped = words
      .slice(0, 6)
      .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
      .join(" ");
    return capped;
  }

  function sparklineSvg(values) {
    const w = 300;
    const h = 34;
    if (!values || values.length < 2) {
      return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pad = 3;
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * (w - pad * 2) + pad;
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return [x, y];
    });
    const d = pts.map((p, i) => (i === 0 ? `M ${p[0].toFixed(2)} ${p[1].toFixed(2)}` : `L ${p[0].toFixed(2)} ${p[1].toFixed(2)}`)).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="rgba(94,234,212,.85)" stroke-width="2.2" stroke-linecap="round"/><path d="${d} L ${w - pad} ${h - pad} L ${pad} ${h - pad} Z" fill="rgba(94,234,212,.12)"/></svg>`;
  }

  function setSectionVisible(which) {
    $("onboarding").hidden = which !== "onboarding";
    $("review").hidden = which !== "review";
    $("dashboard").hidden = which !== "dashboard";
  }

  // UI wiring
  const dropzone = $("dropzone");
  const fileInput = $("fileInput");

  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  });

  $("btnReset").addEventListener("click", () => {
    if (!confirm("Clear all local data for this app?")) return;
    clearState();
    hideBanner();
    setSectionVisible("onboarding");
    showBanner("Cleared. Import a CSV to start again.");
  });

  $("btnExport").addEventListener("click", () => {
    const state = loadState();
    if (!state?.subscriptions?.length) {
      showBanner("Nothing to export yet. Import a CSV first.", "warn");
      return;
    }
    const rows = [
      ["Service", "AvgMonthly", "LastChargeDate", "Dormant90"],
      ...state.subscriptions.map((s) => [s.name, s.avgMonthly, s.lastChargeDate, s.dormant90 ? "yes" : "no"]),
    ];
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    downloadText(`subscription-audit-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
  });

  $("btnBackToImport").addEventListener("click", () => {
    setSectionVisible("onboarding");
  });
  $("btnBackToReview").addEventListener("click", () => {
    setSectionVisible("review");
  });

  $("strictness").addEventListener("change", () => {
    const state = loadState();
    if (!state?.transactions?.length) return;
    const subs = detectSubscriptions(state.transactions, $("strictness").value);
    state.subscriptions = subs;
    saveState(state);
    renderReview(state);
    showBanner("Detection updated. Review the list before confirming.", "warn");
  });

  $("btnConfirmAnalyze").addEventListener("click", () => {
    const state = loadState();
    if (!state?.subscriptions?.length) {
      showBanner("No subscriptions detected yet. Try loose mode, or import another CSV.", "warn");
      return;
    }
    // Save names from editable inputs
    for (const s of state.subscriptions) {
      const input = document.querySelector(`[data-name-for="${cssAttrEscape(s.id)}"]`);
      if (input) s.name = String(input.value || "").trim() || s.name;
    }
    saveState(state);
    setSectionVisible("dashboard");
    renderDashboard(state);
    hideBanner();
  });

  $("btnApplyMapping").addEventListener("click", () => {
    const state = loadState();
    if (!state?.rawCsv?.rows) return;
    const map = {
      date: Number($("mapDate").value),
      desc: Number($("mapDesc").value),
      amt: Number($("mapAmount").value),
    };
    const headers = state.rawCsv.headers;
    const dataRows = state.rawCsv.rows;
    const tx = buildTransactions(dataRows, map);
    state.mapping = map;
    state.transactions = tx;
    state.subscriptions = detectSubscriptions(tx, $("strictness").value);
    state.currency = state.currency || detectCurrencyFromCsv(headers, state.rawCsv.rows, "");
    saveState(state);
    $("mappingCard").hidden = true;
    renderReview(state);
    showBanner("Mapping applied. Review the detected subscriptions.", "warn");
  });

  function csvEscape(value) {
    const s = String(value ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  function downloadText(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function cssAttrEscape(s) {
    // minimal escaping for querySelector attribute value
    return String(s).replace(/"/g, '\\"');
  }

  function renderReview(state) {
    $("statTx").textContent = String(state.transactions?.length ?? 0);
    $("statSubs").textContent = String(state.subscriptions?.length ?? 0);
    const tbody = $("reviewBody");
    tbody.innerHTML = "";

    const currency = state.currency || "USD";
    for (const s of state.subscriptions || []) {
      const status = s.dormant90 ? `<span class="pill warn">No charge in 90 days</span>` : `<span class="pill good">Active billing</span>`;
      const row = document.createElement("tr");
      row.innerHTML = `
        <td style="min-width:240px">
          <input class="inline-input" value="${escapeHtml(s.name)}" data-name-for="${escapeHtml(s.id)}" aria-label="Service name" />
          <div class="small muted" title="${escapeHtml(s.merchant)}">${escapeHtml(shorten(s.merchant, 42))}</div>
        </td>
        <td><b>${escapeHtml(formatMoney(s.avgMonthly, currency))}</b></td>
        <td>${escapeHtml(s.lastChargeDate)}</td>
        <td>${status}</td>
        <td style="text-align:right">
          <button class="mini-btn" data-remove="${escapeHtml(s.id)}" type="button">Remove</button>
        </td>
      `;
      tbody.appendChild(row);
    }

    tbody.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-remove");
        const st = loadState();
        if (!st?.subscriptions) return;
        st.subscriptions = st.subscriptions.filter((x) => x.id !== id);
        saveState(st);
        renderReview(st);
      });
    });
  }

  function renderDashboard(state) {
    const currency = state.currency || "USD";
    const subs = state.subscriptions || [];
    const monthly = subs.reduce((sum, s) => sum + (Number(s.avgMonthly) || 0), 0);
    const dormant = subs.filter((s) => s.dormant90).length;

    $("kpiMonthly").textContent = formatMoney(monthly, currency);
    $("kpiDormant").textContent = String(dormant);

    const top = subs
      .slice()
      .sort((a, b) => {
        if (a.dormant90 !== b.dormant90) return a.dormant90 ? -1 : 1;
        return b.avgMonthly - a.avgMonthly;
      })
      .slice(0, 3)
      .map((s) => s.name);
    $("kpiTop").textContent = top.length ? top.join(", ") : "—";

    const candidates = $("candidates");
    candidates.innerHTML = "";
    const list = document.createElement("div");
    list.className = "list";

    const ordered = subs
      .slice()
      .sort((a, b) => {
        if (a.dormant90 !== b.dormant90) return a.dormant90 ? -1 : 1;
        return b.avgMonthly - a.avgMonthly;
      })
      .slice(0, 12);

    for (const s of ordered) {
      const item = document.createElement("div");
      item.className = "item";
      const pill = s.dormant90 ? `<span class="pill warn">No charge 90d</span>` : `<span class="pill good">Billing active</span>`;
      item.innerHTML = `
        <div class="item-title">
          <b>${escapeHtml(s.name)}</b>
          ${pill}
        </div>
        <div class="item-meta">Avg: <b>${escapeHtml(formatMoney(s.avgMonthly, currency))}</b> • Last: ${escapeHtml(s.lastChargeDate)}</div>
      `;
      list.appendChild(item);
    }
    candidates.appendChild(list);

    const trends = $("trends");
    trends.innerHTML = "";
    const trendList = document.createElement("div");
    trendList.className = "list";

    for (const s of subs.slice(0, 10)) {
      const amounts = (s.charges || []).slice(-12).map((c) => c.amount);
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `
        <div class="item-title">
          <b>${escapeHtml(s.name)}</b>
          <span class="pill">${escapeHtml(formatMoney(s.avgMonthly, currency))}/mo</span>
        </div>
        <div class="item-meta">${escapeHtml(amounts.length ? `Last ${amounts.length} charges` : "Not enough history")}</div>
        <div class="spark">${sparklineSvg(amounts)}</div>
      `;
      trendList.appendChild(item);
    }
    trends.appendChild(trendList);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  function shorten(s, n) {
    const str = String(s ?? "");
    if (str.length <= n) return str;
    return str.slice(0, n - 1) + "…";
  }

  async function handleFile(file) {
    hideBanner();
    if (!file || !/\.csv$/i.test(file.name)) {
      showBanner("Please choose a .csv file.", "error");
      return;
    }
    const text = await file.text();
    const rows = parseCSV(text);
    if (!rows || rows.length < 2) {
      showBanner("Couldn’t read rows from this CSV. Try exporting again.", "error");
      return;
    }
    const headers = rows[0].map((h, i) => (String(h || "").trim() ? String(h).trim() : `Column ${i + 1}`));
    const dataRows = rows.slice(1).filter((r) => r.some((x) => String(x ?? "").trim() !== ""));

    const sample = dataRows.slice(0, 40);
    const { mapping, confidence, cols } = detectColumns(headers, sample);

    const state = {
      importedAt: new Date().toISOString(),
      filename: file.name,
      rawCsv: { headers, rows: dataRows },
      mapping,
      currency: detectCurrencyFromCsv(headers, dataRows, text),
      transactions: [],
      subscriptions: [],
    };

    if (confidence < 0.62 || mapping.date == null || mapping.desc == null || mapping.amt == null) {
      // ask user to map
      saveState(state);
      setSectionVisible("review");
      renderMappingUI(headers, mapping);
      $("mappingCard").hidden = false;
      $("reviewBody").innerHTML = "";
      $("statTx").textContent = "—";
      $("statSubs").textContent = "—";
      showBanner("We couldn’t confidently map columns. Please select Date, Description, and Amount.", "warn");
      return;
    }

    const tx = buildTransactions(dataRows, mapping);
    state.transactions = tx;
    state.subscriptions = detectSubscriptions(tx, $("strictness").value);
    saveState(state);

    setSectionVisible("review");
    $("mappingCard").hidden = true;
    renderReview(state);
    showBanner("Imported. Review the detected subscriptions before confirming.", "warn");
  }

  function renderMappingUI(headers, mapping) {
    const opts = headers.map((h, idx) => ({ idx, label: h }));
    fillSelect($("mapDate"), opts, mapping.date);
    fillSelect($("mapDesc"), opts, mapping.desc);
    fillSelect($("mapAmount"), opts, mapping.amt);
  }

  function fillSelect(selectEl, options, selectedIdx) {
    selectEl.innerHTML = "";
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = String(o.idx);
      opt.textContent = o.label;
      selectEl.appendChild(opt);
    }
    if (selectedIdx != null) selectEl.value = String(selectedIdx);
  }

  // Service worker (offline)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    });
  }

  // Restore last session if present
  const state = loadState();
  if (state?.subscriptions?.length) {
    setSectionVisible("dashboard");
    renderDashboard(state);
    showBanner(`Restored your last session (${state.filename}).`, "ok");
  } else if (state?.rawCsv?.rows?.length) {
    setSectionVisible("review");
    renderReview({
      ...state,
      transactions: state.transactions || [],
      subscriptions: state.subscriptions || [],
    });
    showBanner("Restored import. Review and confirm to analyze.", "warn");
  } else {
    setSectionVisible("onboarding");
  }
})();
