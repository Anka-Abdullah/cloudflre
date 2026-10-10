# Cloudflare Queue per nomor untuk wuzapi

Layanan webhook/callback untuk **satu nomor WhatsApp = satu folder Cloudflare**.
Event dari wuzapi masuk ke **Cloudflare Queue**, lalu diproses oleh Worker yang
sama. Tanpa RabbitMQ, tanpa PostgreSQL, dan **tanpa mengubah satu baris pun kode
wuzapi**.

Sejak FASE 1–2, Worker yang sama juga bisa menjalankan **bot automation**
(`BOT_MODE=shadow|on`): filter pesan 1:1, patuhi `no_ai`, kunci per chat, susun
balasan, dan kirim lewat REST API wuzapi. `BOT_MODE=off` mengembalikannya menjadi
relay Queue biasa — itulah tombol rollback-nya.

```
wuzapi (dashboard per nomor)                    Cloudflare (folder <nomor>/)
┌──────────────────────────┐                   ┌──────────────────────────────────────┐
│ Webhook URL  ────────────┼──POST + HMAC─────▶│ Worker  /ingest/<INGEST_TOKEN>       │
│ Webhook Events (All/…)   │  x-hmac-signature │  1. token + HMAC atas raw body       │
│ HMAC Key (32+ char)      │                   │  2. ≤ 90 KB → pesan inline           │
└──────────────────────────┘                   │     > 90 KB → stream ke R2 + pointer │
                                               │  3. env.EVENTS.send() → 202          │
                                               └───────────────┬──────────────────────┘
                                                               │ Queue <nomor>-events
                                                               ▼
                       ┌───────────────────────────────────────────────────────────────┐
                       │ Consumer (Worker yang sama), dipilih oleh BOT_MODE            │
                       │                                                               │
                       │ off    → relay ke DOWNSTREAM_URL (perilaku lama)              │
                       │ shadow → pipeline bot penuh, TIDAK mengirim ke customer       │
                       │ on     → pipeline bot + kirim balasan via wuzapi REST         │
                       │                                                               │
                       │ pipeline: filter → no_ai → lock (DO) → idempotensi (D1)       │
                       │           → history (D1) → AI → outbound (token bucket)       │
                       └───────────────┬───────────────────────────────────────────────┘
                                       │ POST /chat/send/text|image|document
                                       │ header Token: <WUZAPI_TOKEN>
                                       ▼
                                 REST API wuzapi → WhatsApp
```

Dokumen pendamping (teks biasa, enak dibaca di terminal):

| File | Isi |
|---|---|
| `docs/wuzip-bot-flow.txt` | alur bisnis end-to-end, keputusan ack/retry/DLQ, nasib tiap jenis pesan |
| `docs/wuzip-bot-architecture.txt` | kontrak Queue & payload wuzapi yang dibekukan, skema D1/Turso, env & secret, invariants |
| `docs/wuzip-bot-runbook.txt` | prosedur operasional: provision → secret → migrate → shadow → on, plus troubleshooting |

## 1. Bisakah tanpa mengubah kode wuzapi? Bisa

Fakta dari kode wuzapi (bukan asumsi):

| Fakta | Bukti | Konsekuensi |
|---|---|---|
| wuzapi hanya punya 3 jalur keluar event: webhook per-user, webhook global, RabbitMQ | `wuzapi/wmiau.go` (`sendToUserWebHook*`, `sendToGlobalWebHook`, `sendToGlobalRabbit`) | Jalur webhook sudah cukup; RabbitMQ tidak dipakai |
| URL webhook **per nomor** bisa diubah dari dashboard | `wuzapi/static/dashboard/index.html` (modal *Webhook*), `wuzapi/routes.go` (`/webhook`) | Tiap nomor cukup diberi URL worker-nya masing-masing |
| HMAC key per nomor juga dari dashboard, minimal 32 karakter | `wuzapi/handlers.go` (`ConfigureHmac`), modal *HMAC Key* | Autentikasi kuat tanpa ubah kode |
| Signed data = **badan request apa adanya** untuk JSON, form, dan media | `wuzapi/helpers.go` (`generateHmacSignature`), `wuzapi/media_delivery.go` (`mediaSignature`); resty menulis body dari `r.FormData.Encode()` | Worker cukup menghitung HMAC atas byte mentah, tidak perlu meniru encoder Go |
| wuzapi tidak mengirim header kustom (hanya `x-hmac-signature`) | `wuzapi/helpers.go` | wuzapi **tidak bisa** push langsung ke REST API Cloudflare Queues (butuh `Authorization: Bearer`), jadi worker penerima memang diperlukan |
| Tanpa `RABBITMQ_*` publish menjadi no-op; tanpa `DB_*` lengkap otomatis SQLite | `wuzapi/rabbitmq.go`, `wuzapi/db.go` | Syarat "tanpa RabbitMQ & PostgreSQL" murni konfigurasi |

Kredensial yang Anda berikan per nomor = **URL worker + HMAC key**, keduanya
ditempel di dashboard wuzapi. Tidak ada polling/API wuzapi: satu-satunya
permukaan HTTP adalah penerimaan webhook, setelah itu semuanya queue.

## 2. Struktur folder

```
cloudflare/
├── shared/                 # @wuzip/wuzapi-queue-core — semua logika (worker, HMAC, R2, relay, bot)
│   ├── src/ingest/         # handler /ingest, auth token+HMAC, parser json/form
│   ├── src/consumer/       # relay ke bot (ack/retry), arsip DLQ
│   ├── src/lib/            # hmac (streaming), jsonScan (lewati base64), backoff, logger
│   ├── src/bot/            # pipeline automation (lihat daftar di bawah)
│   └── test/               # vitest di runtime Workers, termasuk fixture HMAC buatan Go
├── docs/                   # flow, arsitektur, runbook (teks biasa)
├── _template/              # bahan scaffold (placeholder __SLUG__ dsb.)
├── scripts/                # new-instance, provision, instance, simulate-webhook, smoke-ai
├── tools/hmac-fixture/     # generator fixture Go (pembuktian kompatibilitas tanda tangan)
├── wuzapi-local/           # docker compose wuzapi SQLite tanpa postgres & rabbitmq (uji lokal)
└── <nomor>/                # satu folder per nomor, mis. 6281234567890/
    ├── wrangler.jsonc      # worker/queue/DLQ/bucket/D1/KV/DO + vars milik nomor ini
    ├── src/index.ts        # `export default createWorker()` + `export { ChatCoordinator }`
    ├── .dev.vars.example   # contoh secret untuk dev lokal
    └── README.md           # langkah dashboard untuk nomor ini
```

Isi `shared/src/bot/` dan sekitarnya (FASE 1-8, semua teruji):

| File | Isi |
|---|---|
| `types.ts` | tipe payload wuzapi + tipe normalisasi (`InboundMessage`, `OutboundMessage`) |
| `filter.ts` | memutuskan event mana yang boleh diproses (grup, self, status, newsletter, kosong) |
| `text.ts` | ekstraksi teks: conversation, extendedText, caption, button, list, unwrap view-once |
| `history.ts` | repository D1: history, `chat_state`, ledger idempotensi `processed_events` |
| `contacts/policy.ts` | aturan `no_ai` + `suppressed_chats` + saklar per chat |
| `coordinator/chat-lock.ts` | Durable Object `ChatCoordinator`: lock per chat, seen-set, token bucket |
| `wuzapi/client.ts` | klien REST wuzapi: sendText/sendImage/sendDocument/presence/getContacts + retry 1s/2s/4s |
| `outbound.ts` | satu-satunya jalur kirim: hormati shadow mode, token bucket, jeda manusiawi 1-3 detik |
| `agent/run.ts` | loop AI: prompt + katalog + riwayat, native tool calling dengan fallback JSON |
| `agent/tools.ts` | tool yang boleh dipanggil model (cart, gambar, `create_payment_link`) |
| `knowledge/` | loader KV/R2, chunker, pencarian (in-memory + FTS5 bm25), parser katalog, sync index |
| `sales/cart.service.ts` | keranjang D1; harga selalu dari katalog, bukan dari model |
| `contacts/policy.ts`, `contacts/sync.ts` | aturan `no_ai` + sinkronisasi kontak dari wuzapi |
| `payment/` | Turso (schema + repository idempoten), provider (dry-run/mock/Sumopod), checkout, settle, events, routes |
| `telegram/` | klien Bot API, kartu approval, webhook admin, pending reply (`Ubah Biaya`) |
| `outbox/store.ts`, `outbox/flush.ts` | antrean kirim: dedupe key, klaim lease, backoff, msgid deterministik |
| `nota/pdf.ts` | nota PDF (`pdf-lib`) + fallback teks yang tidak mungkin gagal |
| `queue/router.ts` | router batch: `wuzapi.event` / `payment.event` / `outbox.tick`, ack vs retry vs DLQ |
| `queue/handlers.ts` | pipeline: filter → policy → lock → idempotensi → history → AI → typing → kirim → settle |
| `admin/routes.ts`, `cron.ts` | `/admin/*` dan semua job terjadwal (`scheduled()`) |
| `migrations/0001_init.sql`, `0002_payment_outbox.sql` | skema D1: history, idempotensi, kontak, keranjang, outbox (+ dedupe/lease), `cron_state`, `telegram_pending` |

Logika ada di `shared/` supaya satu perbaikan bug berlaku untuk semua nomor,
sementara resource, secret, dan konfigurasi tetap terpisah per nomor.

Folder `6281234567890/` sudah ada sebagai **contoh hasil scaffold** (dipakai juga
oleh uji end-to-end di bagian 9). Aman dihapus, atau dipakai sebagai nomor
pertama Anda — tinggal ganti `INSTANCE_SLUG` dan nama resource di
`wrangler.jsonc`, atau buat folder baru dengan `pnpm run new`.

## 3. Menambah nomor baru

Sekali per akun Cloudflare, siapkan akses wrangler — pilih salah satu:

- `npx wrangler login`, atau
- `export CLOUDFLARE_API_TOKEN=...` dengan izin **Workers Scripts:Edit**,
  **Queues:Edit**, **R2:Edit**, **D1:Edit**, **KV:Edit** (tambahkan **Account
  Settings:Read** bila perlu membaca subdomain `workers.dev`).

```sh
cd cloudflare
pnpm install
pnpm run new       -- --number 6281234567890    # membuat folder <nomor>/
pnpm run provision -- --number 6281234567890    # queue + DLQ + bucket R2 + D1 + KV
pnpm run secrets   -- --number 6281234567890 --hmac-key "<32+ karakter>"
pnpm run migrate   -- --number 6281234567890    # skema D1
pnpm run deploy    -- --number 6281234567890
```

Resource yang dibuat per nomor:

| Resource | Nama | Binding | Fungsi |
|---|---|---|---|
| Worker | `wuzapi-<nomor>` | — | penerima webhook + consumer queue + bot |
| Queue | `wuzapi-<nomor>-events` | `EVENTS` | antrean event (retensi default 4 hari) |
| DLQ | `wuzapi-<nomor>-dlq` | `DLQ` | kegagalan permanen, diarsipkan ke R2 |
| Bucket R2 | `wuzipbot-media-<nomor>` | `MEDIA` | payload besar (media base64), arsip DLQ, nota PDF (FASE 6) |
| D1 | `wuzipbot-bot-<nomor>` | `BOT_DB` | state bot: history, idempotensi, kontak, cart, outbox |
| KV | `WUZIPBOT_KNOWLEDGE_<nomor>` | `KNOWLEDGE_KV` | prompt + knowledge kecil (FASE 3) |
| Durable Object | `ChatCoordinator` | `CHAT_COORDINATOR` | lock per chat, idempotensi cepat, token bucket per nomor |

`provision` menulis `database_id` dan id KV yang asli ke `wrangler.jsonc` nomor
tersebut, jadi file itu tidak perlu diedit tangan. `--worker-prefix`,
`--bucket-prefix`, `--d1-prefix` dan `--kv-prefix` bisa diubah saat
`pnpm run new`; nama bucket R2 unik secara global, jadi pakai prefix yang khas
milik Anda.

Durable Object tidak perlu di-provision: ia dideklarasikan di `wrangler.jsonc`
dan dibuat oleh deploy pertama (`migrations.new_sqlite_classes`).

`provision` mencetak rencana resource (queue, DLQ, bucket, D1, KV) **sebelum**
membuat apa pun, jadi salah prefix/salah nomor langsung terlihat di terminal.
Satu detail yang mudah salah: binding KV di `wrangler.jsonc` hanya menyimpan
`id`, bukan nama namespace. Nama untuk dibuat dicatat saat scaffold di
`<nomor>/package.json` (`wuzip.kvNamespaceTitle`, diabaikan npm dan wrangler),
dan bisa ditimpa dengan `--kv-name`. Sebelum membuat, script selalu mencari
namespace yang **id**-nya sudah cocok, sehingga menjalankan ulang `provision`
tidak pernah menghasilkan namespace kedua.

## 4. Yang ditempel ke dashboard wuzapi (per nomor)

| Field dashboard | Nilai |
|---|---|
| **Webhook URL** | `https://wuzapi-<nomor>.<subdomain-akun>.workers.dev/ingest/<INGEST_TOKEN>` |
| **Webhook Events** | `All`, atau subset (mis. `Message,Connected,Disconnected`) untuk menekan biaya |
| **HMAC Key** | 32+ karakter; nilainya sama dengan secret Worker `WUZAPI_HMAC_KEYS` |

Catatan:

- `WEBHOOK_FORMAT` adalah variabel **global** wuzapi (env), bukan per nomor.
  Pakai `json`: metadata media ikut terbaca worker. Di mode `form`, payload besar
  hanya bisa disimpan sebagai pointer tanpa metadata (lihat bagian 6).
- Jangan mengisi `WUZAPI_GLOBAL_WEBHOOK` bersamaan dengan webhook per nomor bila
  Anda tidak ingin event yang sama dikirim dua kali (bentuk payload global pun
  berbeda: `jsonData` berupa string).
- Menyalakan S3 delivery per nomor (`Media delivery: s3`) membuat event media
  berisi tautan, bukan base64 — payload tetap kecil dan R2 tidak terpakai.

## 5. Skema pesan queue (v1)

```jsonc
{
  "v": 1,
  "kind": "event",                    // lihat daftar kind di bawah
  "receivedAt": "2026-10-10T08:00:01.450Z",
  "deliveryId": "7f4d…4d44",          // sha256(raw body) — kunci idempotensi
  "contentType": "application/json",
  "hmac": { "verified": true, "algorithm": "hmac-sha256" },
  "event": {
    "type": "Message",                // "Connected", "QR", "Receipt", …
    "userID": "1",
    "instanceName": "nomor-1",
    "payload": { "type": "Message", "event": { "Info": {}, "Message": {} } }
  },
  "source": { "worker": "6281234567890", "slug": "6281234567890", "ua": "go-resty/2.16.5", "ip": "…", "rawSize": 292 }
}
```

`kind` yang sah (dibekukan di FASE 0):

| `kind` | Arti |
|---|---|
| `event` | satu webhook wuzapi, payload inline |
| `media-pointer` | webhook yang sama tetapi payload terlalu besar; `event.payload` = `null` dan metadata pindah ke `media` |
| `wuzapi.event` | alias eksplisit untuk dua di atas, supaya produsen luar bisa menyebut sumbernya |
| `payment.event` | callback gateway / halaman dry-run / keputusan admin (satu-satunya penulis status order) |
| `outbox.tick` | perintah "flush outbox sekarang" |

`event` dan `media-pointer` dipertahankan sebagai nama kanonik karena itulah yang
sudah dikirim `/ingest` dan dipakai semua deployment yang ada; router bot menerima
ketiganya sebagai event wuzapi.

Untuk payload besar, `kind` menjadi `media-pointer` dan `event.payload` bernilai
`null`; sebagai gantinya ada:

```jsonc
"media": {
  "r2Key": "events/6281234567890/2026/10/10/<uuid>.json",
  "size": 200461,
  "sha256": "1baa…9979d",
  "skippedFields": { "base64": 200002 },   // ukuran field yang dilewati scanner
  "fields": { "type": "Message", "userID": "1", "instanceName": "nomor-1", "event": { … } },
  "fieldsOmitted": false,                  // true bila metadata pun tak muat
  "mediaUrl": null                         // terisi bila R2_PUBLIC_BASE_URL diset
}
```

Relay ke bot mengirim envelope ini apa adanya (`application/json`) dengan header:

| Header | Isi |
|---|---|
| `x-wuzip-signature` | `sha256=<hex HMAC-SHA256>` atas body relay, key = `DOWNSTREAM_HMAC_KEY` |
| `x-wuzip-delivery-id` | `deliveryId` — pakai untuk idempotensi di bot |
| `x-wuzip-attempt` | percobaan ke berapa |
| `x-wuzip-queue-message-id` | id pesan queue |
| `x-wuzip-slug`, `x-wuzip-kind`, `x-wuzip-event-type`, `x-wuzip-user-id` | metadata routing |

Verifikasi di bot (Node):

```js
const expected = "sha256=" + createHmac("sha256", process.env.DOWNSTREAM_HMAC_KEY)
  .update(rawBody).digest("hex");
if (expected !== req.headers["x-wuzip-signature"]) return res.status(401).end();
```

## 6. Perilaku ingress

`POST /ingest/<INGEST_TOKEN>` — satu-satunya route publik. `GET /healthz`
melaporkan konfigurasi efektif.

| Kondisi | Jawaban | Alasan |
|---|---|---|
| Diterima dan masuk queue | `202` | wuzapi berhenti (tidak retry) |
| Token salah | `401` | salah konfigurasi URL |
| HMAC tidak ada (mode `strict`) atau tidak cocok | `403` | melindungi dari pengirim palsu |
| Content-Type bukan `application/json`/`x-www-form-urlencoded` | `415` | bentuk yang tidak dikenal |
| Body tidak bisa di-parse | `400` | payload rusak |
| Payload > ambang **dan** `MEDIA_MODE=reject` | `413` | sekaligus dicatat ke DLQ |
| `queue.send()` gagal | `503` | wuzapi mengulang (jaring pengaman) |
| `R2.put()` gagal | `500` | wuzapi mengulang |
| Panjang body tidak sesuai `Content-Length` | `400` | body terpotong, tidak ada objek parsial yang disimpan |

Ambang ukuran: `INLINE_MAX_BYTES` (default 90 000) — di atas itu payload
di-stream ke R2. R2 hanya menerima stream yang panjangnya diketahui, jadi:

| Body | Perlakuan |
|---|---|
| ≤ 90 KB | pesan inline (satu pesan queue, < 128 KB) |
| > 90 KB dengan `Content-Length` (selalu dikirim wuzapi) | satu kali baca: stream ke R2 (`FixedLengthStream`) sambil menghitung HMAC streaming, sha256, dan scan JSON — tanpa buffering |
| > 90 KB tanpa `Content-Length` | di-buffer sampai `MEDIA_BUFFER_MAX_BYTES` (default 25 MB), lalu disimpan sebagai objek |

Scanner JSON (`shared/src/lib/jsonScan.ts`) menyalin field top-level kecuali
`base64` (diukur ukurannya, tidak ditampung). Di mode `form`, `jsonData` yang
ter-escape tidak bisa dipindai tanpa buffering, sehingga pointer hanya membawa
`instanceName`/`userID` dari byte awal body.

## 7. Perilaku consumer

| Hasil dari bot | Aksi |
|---|---|
| `2xx` | `ack` |
| `408`, `425`, `429`, `5xx`, error jaringan/timeout | `retry` dengan backoff `min(RETRY_BASE_SECONDS × 2^(attempt-1), RETRY_MAX_SECONDS) + jitter` |
| 4xx lainnya (mis. `404`, `422`) | `ack` + kirim ke DLQ (kegagalan permanen, tidak diulang selamanya) |
| Pesan bukan envelope v1 | `ack` + DLQ (poison message) |
| `DOWNSTREAM_URL` kosong saat `RELAY_MODE=relay` | `ack` + DLQ + log error |
| `attempts` mencapai `max_retries` (default 5) | Cloudflare memindahkan pesan ke `wuzapi-<nomor>-dlq` |

DLQ dikonsumsi worker yang sama: setiap record diarsipkan ke
`_dlq/<nomor>/<tanggal>/<messageId>.json` di bucket R2 nomor tersebut, lalu
notifikasi dikirim ke `ALERT_WEBHOOK_URL` **dan/atau** ke chat admin lewat
Telegram (`TELEGRAM_ENABLED=true`), baru kemudian di-`ack`. Jika arsip gagal,
pesan tetap di queue.

Dua kind envelope lain punya consumer sendiri (FASE 5-7):

| Kind | Yang terjadi |
|---|---|
| `payment.event` | Satu-satunya penulis status order: nominal dicocokkan, transisi kondisional (`pending → paid`) dijalankan sekali, nota diantre ke outbox, konfirmasi dikirim ke customer. Callback ganda menjadi no-op. |
| `outbox.tick` | Flush outbox sekarang (dipakai tes dan operator yang tidak mau menunggu cron). |

### Outbox: satu-satunya jalur kirim yang boleh menunggu

Pesan yang tidak boleh hilang (link pembayaran, nota, pemberitahuan penolakan)
masuk ke tabel `outbox` D1 sebelum dikirim. Tiga mekanisme menjaga "sekali saja":

| Mekanisme | Yang dicegah |
|---|---|
| `dedupe_key` UNIQUE | baris kedua untuk peristiwa bisnis yang sama (mis. `order:PAY-…:nota`) |
| lease (`lease_id` + `claimed_until`, klaim lewat UPDATE kondisional) | dua flusher mengirim baris yang sama |
| msgid deterministik `ob-<id>` | kiriman ulang setelah crash tampil dua kali di WhatsApp |

Baris yang gagal sementara di-backoff (`RETRY_BASE_SECONDS`…`RETRY_MAX_SECONDS`)
sampai `OUTBOX_MAX_ATTEMPTS`; 4xx dari wuzapi langsung ditandai `failed` dan
alasannya tersimpan di kolom `last_error`. Flush dipicu tiga cara: cron tiap
menit, envelope `outbox.tick`, dan `POST /admin/outbox/flush`.

Sebelum bot siap: set `RELAY_MODE=observe` supaya event hanya dicatat dan di-ack.

## 8. Bot automation (BOT_MODE)

`BOT_MODE` menentukan apa yang dilakukan consumer terhadap queue yang sama:

| Nilai | Perilaku |
|---|---|
| `off` (default) | relay ke `DOWNSTREAM_URL` seperti sebelumnya. **Tombol rollback.** |
| `shadow` | pipeline bot berjalan penuh — filter, `no_ai`, lock, history, AI — tetapi tidak ada satu pun pesan yang dikirim ke customer. Balasan yang seharusnya dikirim tercatat di log sebagai `outbound_suppressed_shadow` beserta preview-nya. |
| `on` | balasan benar-benar dikirim lewat REST wuzapi. |

Urutan pipeline untuk satu pesan masuk (lihat `shared/src/bot/queue/handlers.ts`):

```
1. filter     tolak grup, @newsletter, status, broadcast, 0@, pesan sendiri, body kosong
2. policy     tolak chat ber-no_ai (dari D1 contacts ATAU Info.PushName), suppressed_chats,
              dan chat yang saklarnya dimatikan admin
3. lock       Durable Object per chat: satu AI turn per chat pada satu waktu
4. idempotensi INSERT OR IGNORE ke processed_events; hanya status `done` yang memblokir
              pemrosesan ulang, sehingga retry setelah gagal tetap bisa jalan
5. history    baca N pesan terakhir dari D1, lalu simpan pesan masuk
6. AI         loop prompt + tool calling (agent/run.ts): katalog, keranjang, tool
7. typing     presence "composing" sebelum balasan, "paused" sesudahnya
8. outbound   deliverOutbound: shadow mode berhenti di sini; kalau tidak, ambil token
              dari bucket per nomor, jeda 1-3 detik antar pesan, lalu POST ke /chat/send/*
9. settle     tandai `done`/`failed` dan lepaskan lock
```

Mengapa urutannya begitu:

- **filter dan policy paling murah dan menolak sebagian besar trafik** sebelum ada
  biaya AI atau tulis D1.
- **lock diambil sebelum panggilan AI**, supaya dua kiriman ulang webhook yang sama
  tidak memulai dua turn untuk chat yang sama.
- **idempotensi D1 adalah penentu yang tahan lama**: sukses bersifat permanen,
  gagal boleh diulang. Lock DO hanya mencegah tumpang tindih, bukan pengganti ledger.
- **token bucket** (`CHAT_COORDINATOR` singleton per nomor, 30 pesan burst, 0,5
  token/detik ≈ 30 pesan/menit) melindungi nomor dari pembatasan WhatsApp.

`GET /healthz` melaporkan `botMode`, `bindings` (EVENTS, DLQ, MEDIA, BOT_DB,
KNOWLEDGE_KV, CHAT_COORDINATOR — boolean saja), `bot.ready` beserta
`bot.missing` / `bot.missingBindings`, plus ringkasan `payment`, `telegram`,
`outbox`, dan `cron` (semuanya boolean/angka: `tursoConfigured`, `dryRun`,
`webhookSecretSet`, `batch`, interval). Tidak ada nilai secret yang pernah
dikembalikan endpoint publik ini; `GET /admin/status` (Bearer `ADMIN_API_KEY`)
memberi versi yang lebih lengkap, termasuk tabel Turso yang terlihat.

### Mengunggah prompt & knowledge

Satu perintah, dari folder `cloudflare/`:

```sh
# dev lokal: tulis ke .wrangler/state yang dibaca `pnpm run dev`
pnpm run knowledge -- --number <nomor> --local \
  --prompt <nomor>/knowledge/prompt.txt --knowledge <nomor>/knowledge/knowledge.txt

# produksi (remote)
export ADMIN_API_KEY=...            # untuk rebuild indeks D1 di worker
pnpm run knowledge -- --number <nomor> \
  --prompt <nomor>/knowledge/prompt.txt --knowledge <nomor>/knowledge/knowledge.txt
```

Perilaku `scripts/sync-knowledge.mjs`:

| Hal | Detail |
|---|---|
| Target simpan | `KNOWLEDGE_MODE=auto` → KV selama ≤ `KNOWLEDGE_INLINE_MAX_BYTES`, di atas itu R2 (sama dengan aturan loader) |
| Gambar | Folder `--images <dir>` (default `<nomor>/knowledge/images/`) selalu ke R2 dengan kunci `knowledge/images/<nama>` |
| Ongkir | `<nomor>/knowledge/ongkir-policy.json` ikut diunggah bila ada |
| Verifikasi | Setiap objek dibaca ulang dan dibandingkan sha256-nya; `--no-verify` untuk melewati |
| Indeks D1 | `POST /admin/knowledge/sync` (butuh worker berjalan + `ADMIN_API_KEY`) mengisi `knowledge_chunks`, FTS5, dan `catalog_products` |
| Tanpa worker | `--skip-index` (atau `--url` kosong) mengunggah berkas saja; indeks bisa disusun nanti |

`--dry-run` mencetak rencana tanpa mengunggah apa pun, dan `--help` mencetak
seluruh flag. **`--config <nomor>/wrangler.jsonc` dipakai otomatis oleh wrapper
`pnpm run knowledge`** — memanggil `wrangler` langsung tanpa flag itu akan gagal
dengan pesan menyesatkan "No KV namespaces are configured".

Ukuran nyata: `prompt.txt` 16 KB + `knowledge.txt` 57 KB = ~73 KB, aman di KV;
gambar (70 berkas, 4,7 MB) ke R2.

### Order, pembayaran, dan nota (FASE 4-6)

Alur lengkapnya, semua tanpa nomor WA:

```
keranjang (D1)  ->  create_payment_link (tool)
                      |
                      |  harga SELALU dibaca ulang dari katalog, client_ref =
                      |  hash(chat + isi keranjang + nama + alamat)  -> idempoten
                      v
                  order di Turso (status creating)
                      |
      ongkir termasuk? +--> ya  -> approved -> tautan pembayaran -> pending
                      |                        (PAYMENT_DRY_RUN=true:
                      |                         {PUBLIC_BASE_URL}/dry-run/<kode_bayar>)
                      +--> tidak -> awaiting_approval -> kartu Telegram ke admin
                                     (Terima / Tolak / Ubah Biaya)
                      |
   customer bayar ---+-> payment.event -> consumer: nominal dicek, pending -> paid,
                          nota PDF dirender, masuk outbox, konfirmasi dikirim
```

Yang bisa dijalankan sekarang, tanpa Sumopod dan tanpa WhatsApp:

| Perintah | Kegunaan |
|---|---|
| `pnpm run smoke:turso -- --number <nomor>` | schema + CRUD + idempotensi ke Turso asli; tanpa kredensial ia menguji SQLite lokal |
| `GET /dry-run/<kode_bayar>` | halaman simulasi pembayaran (hanya saat `PAYMENT_DRY_RUN=true`); tombolnya mengirim `payment.event` yang sama seperti callback gateway |
| `POST /admin/orders/<kode>/approve` | jalur approval tanpa Telegram: `{"additionalFee": 25000, "reason": "…"}` |
| `POST /admin/orders/<kode>/reject` | tolak + alasan yang dikirim ke customer lewat outbox |
| `POST /admin/outbox/flush` | kirim isi outbox sekarang |
| `GET /admin/status` | ringkasan Turso/Telegram/outbox untuk operator |

Nominal tidak pernah datang dari teks customer maupun dari model: `order_items.harga`
disalin dari katalog D1 (`catalog_products`), dan callback dengan nominal berbeda
tidak mengubah status apa pun (hanya dicatat + dieskalasi ke log admin).

### Cron (FASE 7)

Setiap nomor punya trigger `*/1 * * * *` (`triggers.crons` di `wrangler.jsonc`).
`shared/src/cron.ts` menjalankan:

| Job | Kapan | Isi |
|---|---|---|
| `outbox_flush` | tiap menit | klaim lease + kirim + tandai (`sent`/`failed`, backoff) |
| `expire_orders` | tiap menit | order lewat `expires_at` → `expired` + satu pesan ke customer |
| `reconcile_payments` | tiap menit | tanya status ke gateway (`PAYMENT_DRY_RUN=false`) lalu **antre** `payment.event` — bukan mengubah order langsung |
| `contact_sync` | `CONTACT_SYNC_INTERVAL_MINUTES` | `GET /user/contacts` → `contacts` + saklar `no_ai` |
| `retry_unreplied` | `RETRY_UNREPLIED_MINUTES` (0 = mati) | chat yang belum dibalas → satu pesan menahan (dedupe per pesan masuk) |
| `prune_history` | harian | history 90 hari + kartu Telegram 72 jam |

Job interval diklaim lewat tabel `cron_state` (UPDATE kondisional), jadi dua
invokasi cron yang tumpang tindih tidak menjalankan job yang sama dua kali, dan
satu job yang gagal tidak membatalkan job lain.

### E2E tanpa nomor WA (FASE 8)

```sh
pnpm run e2e -- --number <nomor>      # 33 pemeriksaan, ~1 menit
E2E_VERBOSE=1 pnpm run e2e -- --number <nomor>
```

Yang dijalankan: `wrangler dev` asli (queue, D1, KV, R2, DO nyata) + tiga tiruan
(`pnpm run mock:services`: wuzapi, Telegram, AI) + `pnpm run mock:turso` (server
libSQL/hrana di atas SQLite lokal). Yang dibuktikan: balasan 1:1 terkirim sekali,
duplikat tidak menggandakan balasan, `no_ai` tidak dibalas, checkout otomatis,
checkout lewat kartu admin (termasuk tombol Terima + kartu yang diedit), halaman
dry-run, nota PDF terkirim sebagai dokumen, dan order berakhir `paid`.

### Catatan katalog (dari referensi `automation_chat`)

Rencana kerja menyebut referensi `automation_chat`, dan proyek itu ada di mesin
ini. Alur bisnis, format katalog, dan isi nota sudah dibaca dari sana dan
dibekukan di `docs/wuzip-bot-architecture.txt` bagian 6c. Tiga hal yang perlu
Anda ketahui sebelum FASE 3:

1. **Aturan ongkir** — `ongkir_included = true` hanya jika keranjang tidak
   kosong, semua item ada di katalog, dan **semua** item punya baris
   `Ongkir: termasuk`. Selain itu masuk jalur admin (default aman).
2. **Katalog saat ini tidak punya baris `Ongkir:`** — `knowledge.txt` (70
   produk, 56.965 byte) tidak memuat satu pun kata `Ongkir`. Artinya seluruh
   pesanan akan selalu masuk jalur admin: tidak akan ada link otomatis tanpa
   review admin sampai baris itu ditambahkan per produk.
3. **Format katalog berbeda dari ringkasan rencana** — tidak ada label
   `Produk:` maupun `Harga coret:`; bentuk nyatanya header `#NN  <nama>` diikuti
   baris `  Harga          : Rp 1.400.000,00`. `SKU/Code` sering kosong, jadi
   `catalog_products.kode` akan memakai `Template ID` sebagai kode stabil
   (mis. `T116964`).

Ukuran nyata: `prompt.txt` 16.046 byte + `knowledge.txt` 56.965 byte = 73 KB,
jauh di bawah `KNOWLEDGE_INLINE_MAX_BYTES` (1 MB) — sehingga
`KNOWLEDGE_MODE=auto` akan memilih **`kv_inline`**, bukan `r2_d1_fts`. Gambar
(70 file, 4,7 MB) tetap ke R2 dan dikirim lewat penanda `[GAMBAR: nama - caption]`.

## 9. Env dan secret per nomor

Semua pengaturan non-rahasia ada di `wrangler.jsonc` (`vars`); semua rahasia
diset dengan `wrangler secret put` (lewat `pnpm run secrets`). **Tidak ada API key
di dalam repo.**

| Secret | Dipakai untuk | Wajib saat |
|---|---|---|
| `INGEST_TOKEN` | token di URL `/ingest/<token>` | selalu |
| `WUZAPI_HMAC_KEYS` | verifikasi `x-hmac-signature` (boleh beberapa, dipisah koma) | selalu |
| `DOWNSTREAM_HMAC_KEY` | menandatangani payload relay | `BOT_MODE=off` |
| `ALERT_WEBHOOK_URL` | notifikasi DLQ | opsional |
| `WUZAPI_TOKEN` | header `Token` untuk `/chat/send/*` dan `/user/contacts` | `shadow`/`on` |
| `AI_API_KEY` | endpoint AI OpenAI-compatible | `shadow`/`on` |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | order/payment (Turso, HTTP libsql) | checkout (`create_payment_link`) |
| `PAYMENT_API_KEY`, `PAYMENT_CALLBACK_SECRET` | gateway Sumopod | sebelum `PAYMENT_DRY_RUN=false`; callback ditolak bila secret kosong |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | kartu approval admin | saat `TELEGRAM_ENABLED=true` |
| `ADMIN_API_KEY` | `/admin/*` | selalu (tanpa itu endpoint admin menjawab 503) |

`vars` yang paling sering diubah: `BOT_MODE`, `WUZAPI_API_BASE`, `AI_BASE_URL`,
`AI_MODEL`, `KNOWLEDGE_MODE`, `KNOWLEDGE_TOP_K`, `KNOWLEDGE_HISTORY_LIMIT`,
`CONTACT_SYNC_INTERVAL_MINUTES`, `PAYMENT_DRY_RUN`, `VOICE_ENABLED`. Daftar
lengkap beserta artinya ada di `docs/wuzip-bot-architecture.txt`.

Cara aman mengisi rahasia (tanpa masuk shell history):

```sh
export AI_API_KEY=...            # atau tempel di file .dev.vars yang git-ignored
pnpm run secrets -- --number 6281234567890 --from-env
pnpm run secrets -- --number 6281234567890 --generate ADMIN_API_KEY,TELEGRAM_WEBHOOK_SECRET
pnpm run secrets -- --number 6281234567890 --list        # nama saja, bukan nilai
```

Rotasi HMAC tanpa downtime: isi `WUZAPI_HMAC_KEYS` dengan dua key dipisah koma
(`key-lama,key-baru`), ganti key di dashboard, lalu hapus key lama.

## 10. Alternatif: bot menarik sendiri dari queue (pull consumer)

Bila bot berjalan di luar Cloudflare dan ingin menarik sendiri tanpa worker
consumer:

```sh
wrangler queues consumer worker remove wuzapi-<nomor>-events wuzapi-<nomor>   # lepas push consumer
wrangler queues consumer http add wuzapi-<nomor>-events
```

Lalu bot memanggil:

```
POST https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/queues/<QUEUE_ID>/messages/pull
Authorization: Bearer <API TOKEN dengan Queues:Read + Queues:Write>
{ "visibility_timeout_ms": 60000, "batch_size": 20 }
```

`lease_id` dari respons dipakai untuk `POST .../messages/ack`
(`{ "acks": [...], "retries": [...] }`). Pesan bertipe `json` datang
base64-encoded, jadi harus di-decode.

Penting: satu queue **tidak bisa** punya push consumer dan HTTP pull sekaligus —
pilih salah satu. Kredensial pull (Account ID, Queue ID, API token) inilah yang
bisa disimpan per nomor di sisi bot.

## 11. Uji lokal

```sh
cd cloudflare
pnpm install
pnpm test                     # 471 uji di runtime Workers: HMAC vs fixture Go, scanner,
                              # ingest (R2 asli), consumer, skema+constraint D1 & FTS5,
                              # filter/ekstraksi teks, idempotensi, policy no_ai,
                              # Durable Object lock + token bucket, pipeline bot end-to-end,
                              # Turso (DDL + repository idempoten lewat SQLite asli),
                              # checkout/approval/payment/outbox, nota PDF, Telegram, cron, DLQ
pnpm typecheck

# 0) smoke test endpoint AI (butuh AI_API_KEY; tidak menulis apa pun ke disk)
pnpm run smoke:ai -- --number 6281234567890

# 1) worker lokal (queue, R2, D1, KV, DO disimulasikan; state di cloudflare/.wrangler/state)
pnpm run dev -- --number 6281234567890          # http://127.0.0.1:8790

# 2) kirim webhook bertanda tangan (tanpa WhatsApp)
pnpm run simulate -- \
  --url http://127.0.0.1:8790/ingest/dev-ingest-token-0123456789 \
  --key dev-hmac-key-0123456789abcdef --format json
#   --format form | media --media-bytes 150000

# 3) E2E lengkap tanpa nomor WA (mock wuzapi + Telegram + AI + Turso)
pnpm run e2e -- --number 6281234567890
E2E_VERBOSE=1 pnpm run e2e -- --number 6281234567890   # lihat log worker & mock

# 4) tiruan pihak ketiga, bila ingin dipakai manual (wrangler dev terpisah)
pnpm run mock:services -- --port 8898     # wuzapi + Telegram + AI
pnpm run mock:turso    -- --port 8899     # libSQL/hrana di atas SQLite lokal
#    lalu di .dev.vars: WUZAPI_API_BASE=http://127.0.0.1:8898/wuzapi,
#    AI_BASE_URL=http://127.0.0.1:8898/ai/v1, TELEGRAM_API_BASE=http://127.0.0.1:8898/telegram,
#    TURSO_DATABASE_URL=http://127.0.0.1:8899

# 5) opsional: wuzapi sungguhan (SQLite, tanpa postgres/rabbitmq)
cd wuzapi-local && cp .env.example .env && docker compose up -d --build
#   dashboard: http://localhost:8081/dashboard (token dari .env)
#   lalu langganan event + connect; detail langkahnya di wuzapi-local/README.md
```

Uji bot dijalankan langsung terhadap binding asli: `MessageBatch` sungguhan,
database D1 dengan migration yang sama seperti produksi, dan Durable Object
sungguhan — hanya HTTP keluar (wuzapi) dan responder AI yang di-inject. Jadi
"shadow tidak mengirim apa pun" dan "on mengirim tepat satu balasan" diuji pada
jalur kode yang sama dengan produksi, bukan pada tiruannya.

Uji ini sudah dijalankan: event `QR` dari container wuzapi sungguhan (Go, SQLite,
tanpa RabbitMQ) lolos verifikasi HMAC di worker, masuk queue, dan ter-relay ke
bot dengan status 200. Temuan penting: webhook **global** pun melewati
pemeriksaan subscription milik user, jadi `events` per nomor harus diisi
(walaupun webhook per-nomor tidak dipakai).

Fixture HMAC di `shared/test/fixtures/wuzapi-hmac.json` dihasilkan oleh Go
(`cloudflare/tools/hmac-fixture`), jadi uji membuktikan signature buatan wuzapi
benar-benar diterima — bukan hanya payload buatan sendiri. Regenerasi:

```sh
cd cloudflare/tools/hmac-fixture && go run . ../../shared/test/fixtures/wuzapi-hmac.json
```

## 12. Operasi harian

| Perintah | Fungsi |
|---|---|
| `pnpm run new -- --number <nomor>` | buat folder nomor dari `_template/` |
| `pnpm run provision -- --number <nomor>` | buat queue/DLQ/bucket/D1/KV + tulis id ke `wrangler.jsonc` (idempoten) |
| `pnpm run migrate -- --number <nomor> [--local]` | terapkan skema D1 |
| `pnpm run secrets -- --number <nomor> [opsi]` | set rahasia (`--from-env`, `--set`, `--generate`, `--list`) |
| `pnpm run dev -- --number <nomor> [--port 8790]` | worker lokal, semua interface (untuk container) |
| `pnpm run deploy -- --number <nomor>` | deploy worker nomor itu |
| `pnpm run tail -- --number <nomor>` | stream log produksi |
| `pnpm run smoke:ai [-- --number <nomor>]` | uji endpoint AI: teks, native tool calling, JSON mode |
| `pnpm run knowledge -- --number <nomor> --prompt <file> --knowledge <file>` | unggah prompt/knowledge (+ gambar, + indeks D1); lihat bagian 8 |
| `pnpm run simulate -- --url … --key …` | kirim satu webhook bertanda tangan |

Rotasi HMAC tanpa downtime: `WUZAPI_HMAC_KEYS` menerima beberapa key dipisah
koma (`key-lama,key-baru`). Set keduanya di worker, ganti key di dashboard, lalu
hapus key lama.

Observability: `observability` aktif di `wrangler.jsonc`; semua log berupa satu
JSON per baris dengan field `event`. Yang penting untuk bot: `event_received`,
`event_filtered`, `event_suppressed`, `event_duplicate`, `event_locked`,
`event_processing`, `event_done`, `event_failed`, `outbound_sent`,
`outbound_failed`, `outbound_incomplete`, `outbound_permanent`,
`outbound_suppressed_shadow`, `wuzapi_retry`, `rate_limited`,
`bot_misconfigured`, `bot_retry`, `bot_poison_message`. Metrik queue (backlog,
retry, DLQ) tersedia di dashboard Cloudflare.

## 13. Batas & biaya (angka dari dokumentasi Cloudflare)

- Pesan queue maksimum **128 KB**; `sendBatch` ≤ 100 pesan / 256 KB; batch consumer ≤ 100 pesan; retry maksimum 100; retensi default 4 hari (**Free plan 24 jam**).
- Pesan > 64 KB dihitung sebagai beberapa chunk operasi. Pointer R2 berukuran beberapa ratus byte, jadi payload besar tetap 1 chunk.
- Harga: 10.000 operasi/hari (Free) atau 1 juta operasi/bulan + $0.40/juta operasi (Paid).
- Body request Worker maksimum **100 MB** (Free/Pro); memori Worker 128 MB; CPU default 30 detik (Paid).
- Event `Presence`/`Receipt` sangat deras. Pilih subset event di dashboard per nomor (`Message,Connected,Disconnected` misalnya) untuk menekan jumlah operasi.
- Untuk media sangat besar, aktifkan S3 delivery per nomor di dashboard: event berisi tautan, bukan base64, sehingga tidak menyentuh R2 sama sekali.

## 14. Pemecahan masalah

| Gejala | Penyebab & tindakan |
|---|---|
| wuzapi melaporkan webhook gagal `403` | `WUZAPI_HMAC_KEYS` di worker ≠ HMAC key di dashboard, atau `HMAC_MODE=strict` sementara dashboard belum diisi. Samakan keduanya; `HMAC_MODE=optional` hanya untuk diagnosis. |
| `401` di log worker | Token di URL dashboard salah/berubah. Ambil nilai terbaru: `pnpm run secrets -- --number <nomor>` (token lama dipertahankan kecuali `--rotate-ingest-token`). |
| `413` dan ada record di DLQ | `MEDIA_MODE=reject` aktif, atau body tanpa `Content-Length` melebihi `MEDIA_BUFFER_MAX_BYTES`. Naikkan batas, pakai `MEDIA_MODE=r2`, atau nyalakan S3 delivery. |
| `500 media storage failed` | Bucket R2 belum dibuat / nama tidak cocok. Jalankan `pnpm run provision -- --number <nomor>`. |
| `503 queue write failed` | Queue belum ada atau salah nama. `wrangler.jsonc` dan `pnpm run provision` harus sinkron. |
| Bot tidak menerima apa pun | Cek `RELAY_MODE` (harus `relay`), `DOWNSTREAM_URL` terisi, dan `relay_delivered`/`relay_retry` di `pnpm run tail`. |
| Pesan menumpuk di DLQ | Lihat `_dlq/…` di bucket dan log `relay_rejected`; biasanya bot membalas 4xx (payload tidak dikenal) atau `DOWNSTREAM_URL` kosong. |
| Event media hanya pointer tanpa metadata | `WEBHOOK_FORMAT` wuzapi masih `form`. Set `WEBHOOK_FORMAT=json` dan restart wuzapi. |
| Event dobel | Webhook global dan webhook per nomor aktif bersamaan, atau bot tidak memakai `x-wuzip-delivery-id` untuk idempotensi. |
| Bot tidak membalas padahal event masuk | Lihat alasan di log: `event_filtered` (grup/self/status/body kosong), `event_suppressed` (`no_ai`, `suppressed_chats`, saklar admin), `event_locked` (retry, normal saat chat sibuk), `bot_misconfigured` (secret/binding belum lengkap — cek `GET /healthz`). |
| `BOT_MODE=on` tetapi balasan tidak sampai | Pastikan `WUZAPI_API_BASE` dan `WUZAPI_TOKEN` benar. `outbound_failed` berisi status HTTP dan pesan wuzapi; `outbound_suppressed_shadow` berarti mode masih `shadow`. |
| `wuzapi 401`/`403` di log | `WUZAPI_TOKEN` salah atau tidak punya sesi aktif di wuzapi. Token dikirim sebagai header `Token`, bukan `Authorization`. |
| Balasan dobel | Seharusnya tidak terjadi: `processed_events` memblokir delivery yang sudah `done`. Kalau tetap terjadi, cek apakah dua event berbeda (bukan redelivery) — mis. webhook global dan per nomor aktif bersamaan. |
| `wrangler dev` gagal dengan `EPERM … ~/.wrangler/registry` | `$HOME` tidak bisa ditulis (sandbox/CI). `pnpm run dev` sudah menanganinya (`scripts/lib.mjs` menyetel `WRANGLER_REGISTRY_PATH`, `WRANGLER_CACHE_DIR`, `WRANGLER_LOG_PATH`); kalau memanggil `wrangler` langsung, set ketiganya ke dalam `cloudflare/.wrangler/`. |
| `D1_ERROR: no such table` | `pnpm run migrate -- --number <nomor>` belum dijalankan, atau `database_id` di `wrangler.jsonc` masih placeholder (jalankan `pnpm run provision`). |
| `event_locked` berulang terus | Ada pemrosesan yang tidak pernah selesai (biasanya AI menggantung). Kurangi `AI_TIMEOUT_MS`, pastikan `AI_MAX_TURNS` kecil; lock kedaluwarsa sendiri setelah 120 detik. |
| `rate_limited` sering | Nomor mengirim terlalu cepat. Bucket sengaja dibatasi 30 pesan burst dan 30/menit; kalau perlu, turunkan volume balasan per pesan. |
| `ai_unavailable` + balasan generik | `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL` kosong (atau `AI_MAX_TOKENS` 0). Ini fallback yang disengaja supaya customer tetap dapat jawaban. |
| `create_payment_link` menjawab "gagal (turso_not_configured)" | `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` belum diisi. Set keduanya, lalu `pnpm run smoke:turso -- --number <nomor> --local-secrets`. |
| Kartu approval tidak muncul di Telegram | `TELEGRAM_ENABLED=false`, token/chat kosong, atau admin belum menekan `/start`. Balasan `/start` memuat `TELEGRAM_CHAT_ID=<id>`. Alternatif tanpa Telegram: `POST /admin/orders/<kode>/approve`. |
| Webhook Telegram menjawab `401` | `X-Telegram-Bot-Api-Secret-Token` ≠ `TELEGRAM_WEBHOOK_SECRET`, atau secret kosong (worker sengaja menolak semuanya). Daftarkan ulang webhook dengan `secret_token` yang sama. |
| Order tidak pernah jadi `paid` | Cek `GET /admin/status` (`payment.tursoConfigured`, `payment.dryRun`, tabel Turso), lalu `payment_event`/`payment_settle_failed` di log. Saat `PAYMENT_DRY_RUN=true` hanya halaman `/dry-run/<kode_bayar>` yang bisa membayar. |
| Nota tidak terkirim | Nota lewat outbox: `POST /admin/outbox/flush`, lalu periksa kolom `last_error`/`attempts`/`status` di tabel `outbox`. `wuzapi` yang menolak 4xx membuat baris ditandai `failed` (tidak diulang selamanya). |
| `reconcile_query_failed` tiap menit | `PAYMENT_API_BASE`/`PAYMENT_STATUS_PATH` belum cocok dengan API gateway. Rekonsiliasi dilewati saat `PAYMENT_DRY_RUN=true`. |
| Link pembayaran menunjuk URL relatif | `PUBLIC_BASE_URL` kosong. Isi dengan URL worker nomor ini, mis. `https://wuzapi-<nomor>.<subdomain>.workers.dev`. |
| `bot_degraded_shadow` | `BOT_MODE=on` tetapi konfigurasi belum lengkap (lihat `missing`/`missingBindings` di log). Worker sengaja diam, bukan mengirim balasan generik ke customer. Lengkapi secret lalu periksa `GET /healthz`. |
| Biaya AI membengkak | Turunkan `KNOWLEDGE_TOP_K` dan `KNOWLEDGE_HISTORY_LIMIT`; pastikan filter grup/status tetap aktif (mereka menolak sebelum panggilan AI). |

## 15. Catatan kompatibilitas

Folder `cloudflare/` tidak mengubah apa pun di `wuzapi/`. Uji `pnpm test`
menjalankan verifikasi HMAC terhadap fixture yang dihasilkan kode Go wuzapi
(`url.Values.Encode`, `json.Marshal`, streaming media body), sehingga perubahan
wuzapi di masa depan yang menyentuh format tanda tangan akan langsung terdeteksi
saat fixture diregenerasi.
