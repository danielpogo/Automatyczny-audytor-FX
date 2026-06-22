// Lokalny test logiki przepływu BEZ n8n.
// Odtwarza węzły Parse → Normalize Rates → Reconcile → Build HTML Report,
// używając przykładowego CSV oraz ŻYWYCH kursów NBP + Frankfurter (ECB).
// Uruchom: node test/run-local.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const repo = join(__dir, "..");

const cfg = {
  tolerancePct: 0.5,
  criticalMultiplier: 4,
  trackCurrencies: ["EUR", "USD", "GBP", "CHF"],
  platforms: [
    { name: "NBP", url: "https://api.nbp.pl/api/exchangerates/tables/A?format=json" },
    { name: "ECB", url: "https://api.frankfurter.app/latest?from=EUR" },
  ],
};

// --- Parse & Normalize TX (z pliku) ---
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(",").map((h) => h.trim());
  return lines.filter((l) => l.trim()).map((ln) => {
    const c = ln.split(",");
    const r = {}; header.forEach((h, i) => (r[h] = (c[i] || "").trim()));
    return { machine: "sample", txId: r.txId, ts: r.timestamp, pair: r.pair.toUpperCase(),
      amount: parseFloat(r.amount), rate: parseFloat(r.rate), counterparty: r.counterparty };
  });
}

// --- Normalize Rates (z kursami krzyżowymi do PLN) ---
function normalizeRates(payloads, now) {
  const want = cfg.trackCurrencies;
  const out = [];
  for (const b of payloads) {
    const nbpTables = Array.isArray(b) ? b
      : (b.rates && Array.isArray(b.rates) && b.rates[0] && "code" in b.rates[0]) ? [b] : null;
    if (nbpTables) {
      for (const t of nbpTables) for (const r of t.rates)
        if (want.includes(r.code)) out.push({ platform: "NBP", pair: r.code + "/PLN", rate: r.mid, ts: t.effectiveDate || now });
      continue;
    }
    if (b.rates && b.base) {
      const pln = b.rates.PLN; const ts = b.date || now;
      if (pln != null) {
        if (want.includes("EUR")) out.push({ platform: "ECB", pair: "EUR/PLN", rate: pln, ts });
        for (const C of want) { if (C === "EUR") continue; const e = b.rates[C]; if (e) out.push({ platform: "ECB", pair: C + "/PLN", rate: pln / e, ts }); }
      }
    }
  }
  return out;
}

// --- Reconcile ---
function reconcile(txs, rates) {
  const tol = cfg.tolerancePct, critX = cfg.criticalMultiplier;
  const platforms = [...new Set(rates.map((r) => r.platform))];
  const refRate = (pair, p, ts) => {
    const c = rates.filter((r) => r.pair === pair && r.platform === p);
    if (!c.length) return null;
    c.sort((a, b) => Math.abs(new Date(a.ts) - new Date(ts)) - Math.abs(new Date(b.ts) - new Date(ts)));
    return c[0].rate;
  };
  return txs.map((t) => {
    const row = { machine: t.machine, txId: t.txId, pair: t.pair, ts: t.ts, usedRate: t.rate, refs: {}, maxDeviationPct: 0, worstPlatform: null, severity: "OK" };
    for (const p of platforms) {
      const rr = refRate(t.pair, p, t.ts);
      if (rr == null) { row.refs[p] = null; continue; }
      const dev = ((t.rate - rr) / rr) * 100;
      row.refs[p] = { rate: Math.round(rr * 1e6) / 1e6, deviationPct: Math.round(dev * 1e4) / 1e4 };
      if (Math.abs(dev) > Math.abs(row.maxDeviationPct)) { row.maxDeviationPct = Math.round(dev * 1e4) / 1e4; row.worstPlatform = p; }
    }
    const ad = Math.abs(row.maxDeviationPct);
    row.severity = ad > tol * critX ? "CRITICAL" : ad > tol ? "WARNING" : "OK";
    return row;
  });
}

function buildHtml(rows, now) {
  const byM = {}; for (const r of rows) (byM[r.machine] ??= []).push(r);
  const crit = rows.filter((r) => r.severity === "CRITICAL");
  const warn = rows.filter((r) => r.severity === "WARNING");
  const fmt = (n) => (n > 0 ? "+" : "") + Number(n).toFixed(4) + "%";
  const css = "<style>body{font-family:system-ui,Arial;margin:0}.page{padding:32px}@media print{.page{page-break-after:always}}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #cbd5e1;padding:6px 8px}.crit{color:#b91c1c;font-weight:700}.warn{color:#b45309}.ok{color:#15803d}</style>";
  const tr = (r) => `<tr><td>${r.txId}</td><td>${r.pair}</td><td>${r.usedRate}</td><td>${r.worstPlatform ?? "—"}</td><td class="${r.severity.toLowerCase()}">${fmt(r.maxDeviationPct)}</td><td class="${r.severity.toLowerCase()}">${r.severity}</td></tr>`;
  let html = css + `<div class="page"><h1>Raport rozbieżności kursowych</h1><div>Wygenerowano: ${now} · próg ${cfg.tolerancePct}%</div><p>Transakcje: ${rows.length} · WARNING: ${warn.length} · CRITICAL: ${crit.length}</p></div>`;
  for (const [m, list] of Object.entries(byM))
    html += `<div class="page"><h1>Maszyna: ${m}</h1><table><thead><tr><th>txId</th><th>Para</th><th>Kurs</th><th>Najgorsza platforma</th><th>Maks. odchylenie</th><th>Status</th></tr></thead><tbody>${list.map(tr).join("")}</tbody></table></div>`;
  return html;
}

// --- Bieg ---
const now = new Date().toISOString();
const txs = parseCsv(readFileSync(join(repo, "samples/transactions-sample.csv"), "utf8"));
console.log(`Wczytano transakcji: ${txs.length}`);

const payloads = [];
for (const p of cfg.platforms) {
  const r = await fetch(p.url);
  if (!r.ok) { console.error(`Błąd ${p.name}: HTTP ${r.status}`); continue; }
  payloads.push(await r.json());
  console.log(`Pobrano kursy: ${p.name}`);
}

const rates = normalizeRates(payloads, now);
console.log(`Znormalizowanych kursów (platforma×para): ${rates.length}`);

const rows = reconcile(txs, rates);
const c = (s) => rows.filter((r) => r.severity === s).length;
console.log(`\nWynik uzgodnienia: OK=${c("OK")} WARNING=${c("WARNING")} CRITICAL=${c("CRITICAL")}\n`);
console.log("txId     para     kurs     NBP        ECB        maks.odchyl  status");
for (const r of rows) {
  const nbp = r.refs.NBP ? r.refs.NBP.rate.toFixed(4) : "—";
  const ecb = r.refs.ECB ? r.refs.ECB.rate.toFixed(4) : "—";
  console.log(`${r.txId.padEnd(8)} ${r.pair.padEnd(8)} ${String(r.usedRate).padEnd(8)} ${nbp.padEnd(10)} ${ecb.padEnd(10)} ${(r.maxDeviationPct + "%").padEnd(11)} ${r.severity}`);
}

const out = join(repo, "test/report.html");
writeFileSync(out, buildHtml(rows, now));
console.log(`\nRaport HTML zapisany: ${out}`);
