# n8n — Kokpit rozbieżności kursowych (multi-Azure, multi-platforma)

Rozbudowany przepływ n8n, który:

1. **pobiera pliki transakcyjne z wielu maszyn Azure** (VM przez SSH/SFTP lub Azure Blob),
2. **porównuje kursy z kilku platform** (NBP, ECB, broker/FIX, dostawca premium),
3. **generuje wielostronicowy raport rozbieżności** (HTML → PDF), archiwizuje i rozsyła,
4. ma **obsługę błędów, alerty krytyczne i retry**.

Plik do importu: [`workflow.json`](workflow.json) (n8n → *Import from File*).

---

## Założenia (do dostosowania)

| Obszar | Założenie domyślne | Alternatywa |
|--------|--------------------|-------------|
| Źródło plików | przełącznik `fileSource` w „Set Config”: **`ssh`** (VM Azure) lub **`blob`** (Azure Blob, SAS per maszyna) | obie ścieżki są w workflow — wybór bez zmian struktury |
| Format transakcji | CSV: `txId,timestamp,pair,amount,rate,counterparty` | JSON / Parquet (zmiana w „Parse & Normalize”) |
| Platformy kursowe | **NBP (tab. A)** + **ECB/Frankfurter** — obie publiczne, działają od razu | dowolne REST/SOAP — dopisz do `platforms` w „Set Config” |
| Pary walutowe | `X/PLN` dla `trackCurrencies` (EUR/USD/GBP/CHF), z **kursami krzyżowymi** | dodaj waluty w `trackCurrencies` |
| Silnik PDF | **Gotenberg** (`/forms/chromium/convert/html`); HTML pakowany do binarnego `index.html` osobnym węzłem | API typu PDFShift / węzeł społecznościowy / Puppeteer |
| Wyzwalacz | **Schedule** (codziennie 06:00) | Webhook / ręcznie |
| Próg rozbieżności | `tolerancePct = 0.5%`, CRITICAL > `4×` progu | konfigurowalne w „Set Config” |

---

## Architektura — fazy

```
[Schedule] → [Set Config] ─┬─► [Machines List] → [Fetch Files (SSH)] → [Parse & Normalize TX] ─┐
                           │                                                                   ├─► [Sync ⨝ Merge] → [Reconcile] ─┬─► [Build HTML Report] → [HTML→PDF] → [Upload Blob] → [Email]
                           └─► [Platforms List] → [Fetch Rates (HTTP)] → [Normalize Rates] ─────┘                                └─► [Filter CRITICAL] → [If >0] → [Alert Teams]

[Error Trigger] → [Notify Failure]            (osobny przepływ obsługi błędów)
```

### Faza 1 — Wyzwolenie i konfiguracja
- **Schedule Trigger** — cron (np. `0 6 * * *`).
- **Set Config** (Code) — jedno źródło prawdy: lista maszyn, lista platform, progi, adresy Gotenberg/Blob, odbiorcy. Reszta węzłów czyta z `$('Set Config')`.

### Faza 2 — Pobranie plików z wielu maszyn Azure (równolegle, per item)
- **Machines List** (Code) — zwraca po jednym itemie na maszynę: `{machine,host,user,path,blob}`.
- **Source = SSH?** (IF) — przełącza ingest wg `fileSource`: `true` → SSH, `false` → Azure Blob.
- **Fetch Files (SSH)** — `cat`/`sftp` na VM (raz na maszynę). **Fetch Files (Azure Blob)** — `GET` po SAS z `machines[].blob`. Obie ścieżki schodzą się w „Parse”.
- **Parse & Normalize TX** (Code) — CSV→JSON; obsługuje wyjście SSH (`stdout`) i Blob (`data`/`body`); jednolity schemat + znacznik `machine`.

### Faza 3 — Kursy z wielu platform (równolegle)
- **Platforms List** (Code) — po jednym itemie na platformę: `{name,url}`.
- **Fetch Rates** (HTTP Request) — URL z `={{ $json.url }}` (per platforma).
- **Normalize Rates** (Code) — wykrywa format po kształcie odpowiedzi (NBP / Frankfurter) i liczy **kursy krzyżowe do PLN**, więc NBP i ECB pokrywają te same pary `X/PLN`. Wspólny format `{platform,pair,rate,ts}`.

### Faza 4 — Uzgodnienie (rdzeń logiki)
- **Sync (Merge, append)** — bariera: gwarantuje, że obie gałęzie skończyły.
- **Reconcile** (Code) — dla każdej transakcji liczy odchylenie użytego kursu od **każdej** platformy (najbliższy czasowo kurs), wyznacza `maxDeviationPct` i `severity` (OK/WARNING/CRITICAL).

### Faza 5 — Raport wielostronicowy
- **Build HTML Report** (Code) — buduje HTML z `@media print { .page { page-break-after: always } }`:
  1. **Strona tytułowa** + podsumowanie (liczby, % rozbieżności, top platformy).
  2. **Strona per maszyna** — tabela transakcji z odchyleniami.
  3. **Macierz platforma×para** — średnie/maks. odchylenia.
  4. **Załącznik CRITICAL** — pełna lista przekroczeń progu.
- **HTML → binary (index.html)** (Code) — pakuje pole `html` w plik binarny `index.html` (`this.helpers.prepareBinaryData`), gotowy dla Gotenberga.
- **HTML→PDF (Gotenberg)** — POST multipart (`files`=`index.html`), zwraca PDF w polu binarnym `data`.

### Faza 6 — Dystrybucja i alerty
- **Upload Blob** — archiwizacja PDF (`PUT` z nagłówkiem `x-ms-blob-type: BlockBlob`).
- **Email Report** — PDF w załączniku do odbiorców.
- **Filter CRITICAL → If >0 → Alert Teams** — natychmiastowy alert tylko gdy są przekroczenia.

### Faza 7 — Obsługa błędów (osobny workflow)
- **Error Trigger → Notify Failure** — Teams/e-mail z nazwą węzła, błędem i `executionId`.
- Per węzeł: **Retry On Fail** (3×, 5 s) na SSH/HTTP; **Continue On Fail** na pobieraniu plików, aby jedna padnięta maszyna nie zatrzymała całości (braki raportowane jako luki).

---

## Rdzeń: węzeł „Reconcile” (Code, *Run Once for All Items*)

```js
// Uzgodnienie transakcji z kursami wielu platform.
const txs   = $('Parse & Normalize TX').all().map(i => i.json);
const rates = $('Normalize Rates').all().map(i => i.json);
const cfg   = $('Set Config').first().json;
const tol   = cfg.tolerancePct ?? 0.5;          // próg WARNING w %
const critX = cfg.criticalMultiplier ?? 4;      // CRITICAL = tol * critX

const platforms = [...new Set(rates.map(r => r.platform))];

// Najbliższy czasowo kurs danej pary z danej platformy.
function refRate(pair, platform, ts) {
  const c = rates.filter(r => r.pair === pair && r.platform === platform);
  if (!c.length) return null;
  c.sort((a, b) =>
    Math.abs(new Date(a.ts) - new Date(ts)) - Math.abs(new Date(b.ts) - new Date(ts)));
  return c[0].rate;
}

const out = [];
for (const t of txs) {
  const row = {
    machine: t.machine, txId: t.txId, pair: t.pair, ts: t.ts,
    usedRate: t.rate, refs: {}, maxDeviationPct: 0, worstPlatform: null, severity: 'OK',
  };
  for (const p of platforms) {
    const rr = refRate(t.pair, p, t.ts);
    if (rr == null) { row.refs[p] = null; continue; }
    const dev = ((t.rate - rr) / rr) * 100;
    row.refs[p] = { rate: rr, deviationPct: Math.round(dev * 1e4) / 1e4 };
    if (Math.abs(dev) > Math.abs(row.maxDeviationPct)) {
      row.maxDeviationPct = Math.round(dev * 1e4) / 1e4;
      row.worstPlatform = p;
    }
  }
  const ad = Math.abs(row.maxDeviationPct);
  row.severity = ad > tol * critX ? 'CRITICAL' : ad > tol ? 'WARNING' : 'OK';
  out.push({ json: row });
}
return out;
```

## Rdzeń: węzeł „Build HTML Report” (Code)

```js
const rows = $input.all().map(i => i.json);
const cfg  = $('Set Config').first().json;
const ts   = $now.toISO();

const byMachine = {};
for (const r of rows) (byMachine[r.machine] ??= []).push(r);
const crit = rows.filter(r => r.severity === 'CRITICAL');
const warn = rows.filter(r => r.severity === 'WARNING');
const fmt  = n => (n > 0 ? '+' : '') + n.toFixed(4) + '%';

const css = `<style>
  body{font-family:system-ui,Arial;color:#0f172a;margin:0}
  .page{padding:32px;min-height:100vh;box-sizing:border-box}
  @media print{.page{page-break-after:always}}
  h1{margin:0 0 4px} table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left}
  .crit{color:#b91c1c;font-weight:700}.warn{color:#b45309}.ok{color:#15803d}
  .kpi{display:inline-block;margin-right:24px;font-size:20px;font-weight:700}
</style>`;

const row = r => `<tr>
  <td>${r.txId}</td><td>${r.pair}</td><td>${r.usedRate}</td>
  <td>${r.worstPlatform ?? '—'}</td>
  <td class="${r.severity.toLowerCase()}">${fmt(r.maxDeviationPct)}</td>
  <td class="${r.severity.toLowerCase()}">${r.severity}</td></tr>`;

// 1) Strona tytułowa + KPI
let html = `${css}<div class="page">
  <h1>Raport rozbieżności kursowych</h1>
  <div>Wygenerowano: ${ts} · próg ${cfg.tolerancePct}%</div><hr/>
  <div class="kpi">Transakcje: ${rows.length}</div>
  <div class="kpi warn">WARNING: ${warn.length}</div>
  <div class="kpi crit">CRITICAL: ${crit.length}</div>
  <p>Maszyny: ${Object.keys(byMachine).join(', ')}</p></div>`;

// 2) Strona per maszyna
for (const [m, list] of Object.entries(byMachine)) {
  html += `<div class="page"><h1>Maszyna: ${m}</h1>
    <table><thead><tr><th>txId</th><th>Para</th><th>Kurs użyty</th>
    <th>Najgorsza platforma</th><th>Maks. odchylenie</th><th>Status</th></tr></thead>
    <tbody>${list.map(row).join('')}</tbody></table></div>`;
}

// 3) Załącznik CRITICAL
html += `<div class="page"><h1>Załącznik — przekroczenia CRITICAL</h1>
  <table><thead><tr><th>Maszyna</th><th>txId</th><th>Para</th>
  <th>Platforma</th><th>Odchylenie</th></tr></thead><tbody>
  ${crit.map(r => `<tr><td>${r.machine}</td><td>${r.txId}</td><td>${r.pair}</td>
   <td>${r.worstPlatform}</td><td class="crit">${fmt(r.maxDeviationPct)}</td></tr>`).join('')}
  </tbody></table></div>`;

return [{ json: { generatedAt: ts, critical: crit.length, warning: warn.length }, html }];
```

> Węzeł **HTML→PDF** wysyła pole `html` do Gotenberga jako plik `index.html` (multipart)
> i zwraca PDF w `binary`. Page-breaki z CSS dają stronicowanie.

---

## Poświadczenia (Credentials w n8n)

| Węzeł | Credential |
|-------|-----------|
| Fetch Files (SSH) | **SSH** (Private Key) — klucz do VM Azure |
| Fetch Files (Blob, alt.) | **Header Auth** / SAS w URL / Azure AD (OAuth2) |
| Fetch Rates | per platforma: **Header Auth** / **OAuth2** / brak (NBP publiczne) |
| Upload Blob / Alert Teams | **Header Auth** (SAS), **Microsoft Teams** webhook |
| Email Report | **SMTP** |

---

## Skalowanie i niezawodność
- **Równoległość per item** — SSH i HTTP Rates wykonują się raz na maszynę/platformę bez ręcznej pętli.
- **Retry On Fail** (3×) na węzłach sieciowych; **Continue On Fail** na pobieraniu plików (luki raportowane, nie zatrzymują całości).
- **Idempotencja** — nazwa pliku raportu zawiera datę (`report-YYYY-MM-DD.pdf`); ponowny bieg nadpisuje ten sam blob.
- **Duże wolumeny** — przetwarzanie wsadowe (Loop Over Items / *Split In Batches*) gdy transakcji są setki tysięcy; rozważ sub-workflow na maszynę.
- **Bezpieczeństwo** — żadnych sekretów w węzłach; wszystko w Credentials; SAS krótkożyjące / Managed Identity.
```
```
