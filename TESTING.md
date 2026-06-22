# Uruchomienie i testy

Trzy warianty — od najszybszego (sama logika) do pełnego przepływu w n8n.

---

## Wariant A — szybki test logiki (bez n8n) ✅ zalecany na start

Odtwarza węzły Parse → Normalize Rates → Reconcile → Build HTML Report na
przykładowym CSV i **żywych** kursach NBP + Frankfurter (ECB). Wymaga tylko Node 18+.

```bash
node test/run-local.mjs
```

Wynik (przykład — kursy z dnia uruchomienia):

```
Wynik uzgodnienia: OK=5 WARNING=2 CRITICAL=3
txId     para     kurs     NBP        ECB        maks.odchyl  status
TX-1005  USD/PLN  3.821    3.7282     3.7256     2.5618%      CRITICAL
TX-1007  EUR/PLN  4.148    4.2693     4.2680     -2.8412%     CRITICAL
...
Raport HTML zapisany: test/report.html
```

Otwórz `test/report.html` w przeglądarce (lub wydrukuj do PDF — page-breaki działają).
To dowód, że pobieranie kursów, kursy krzyżowe do PLN, uzgodnienie i raport działają.

---

## Wariant B — pełny przepływ w n8n + Gotenberg (Docker)

### 1. Postaw n8n i Gotenberg

```yaml
# docker-compose.yml
services:
  n8n:
    image: n8nio/n8n:latest
    ports: ["5678:5678"]
    environment:
      - N8N_SECURE_COOKIE=false
    volumes:
      - n8n_data:/home/node/.n8n
  gotenberg:
    image: gotenberg/gotenberg:8
    ports: ["3000:3000"]
volumes:
  n8n_data:
```

```bash
docker compose up -d
```

n8n: <http://localhost:5678> (załóż konto). Gotenberg widoczny dla n8n pod
`http://gotenberg:3000` — zgodnie z `gotenbergUrl` w „Set Config".

### 2. Zaimportuj workflow

n8n → menu → **Import from File** → `workflow.json`.

### 3. Poświadczenia (Credentials)

| Węzeł | Credential | Na test |
|-------|-----------|---------|
| Fetch Rates | brak | działa od razu (NBP + Frankfurter publiczne) |
| Fetch Files (SSH) | SSH Private Key | patrz pkt 4 |
| HTML → PDF (Gotenberg) | brak | działa po `docker compose up` |
| Upload Report to Blob / Email / Alert Teams | SAS / SMTP / webhook | na test możesz **dezaktywować** te węzły (prawy klik → Deactivate) |

### 4. Podanie transakcji bez maszyn Azure

Najprościej: tymczasowo podmień ingest na dane przykładowe.
Wstaw węzeł **Code** zamiast pary „Machines List → Source = SSH? → Fetch Files":

```js
// Zwraca surowy CSV jak ze stdout SSH — Parse & Normalize TX to obsłuży.
const csv = `txId,timestamp,pair,amount,rate,counterparty
TX-1005,2026-06-22T10:05:00Z,USD/PLN,32000,3.8210,GLOBEX-US
TX-1007,2026-06-22T11:12:00Z,EUR/PLN,76000,4.1480,ACME-FRA`;
return [{ json: { machine: 'sample', stdout: csv } }];
```

Połącz go do „Parse & Normalize TX". (Alternatywnie zostaw tryb `ssh`/`blob`
i wgraj `samples/transactions-sample.csv` na maszynę / do kontenera.)

### 5. Uruchom

Kliknij **Execute Workflow**. Sprawdź:
- „Reconcile" → itemy ze `severity`,
- „HTML → PDF" → pole binarne `data` z PDF-em (Download),
- gałąź „Filter CRITICAL → Alert Teams" odpala się tylko dla CRITICAL.

---

## Wariant C — tryb Azure Blob

W „Set Config" ustaw `fileSource: 'blob'` i uzupełnij `machines[].blob`
poprawnymi URL-ami z SAS. Reszta przepływu bez zmian — IF „Source = SSH?"
przełączy ingest na „Fetch Files (Azure Blob)".

---

## Co działa bez żadnej konfiguracji
- Pobieranie i normalizacja kursów (NBP + Frankfurter), kursy krzyżowe do PLN.
- Uzgodnienie i klasyfikacja severity (Wariant A udowadnia to na żywych danych).
- Generacja HTML; PDF po dołożeniu Gotenberga (Wariant B).

## Co wymaga środowiska (nie kodu)
- Realne pliki transakcji: SSH do VM Azure **albo** Azure Blob (SAS).
- Wysyłka: SMTP (e-mail), SAS (Blob), webhook (Teams).
