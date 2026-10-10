# Nomor 6281234567890

Worker Cloudflare untuk satu nomor wuzapi: menerima webhook dari dashboard
wuzapi, menaruhnya di Cloudflare Queue, lalu — tergantung `BOT_MODE` — merelay
isinya ke bot lama, menjalankan pipeline bot tanpa mengirim apa pun (shadow),
atau menjawab customer langsung.

- Worker: `wuzapi-6281234567890`
- Queue: `wuzapi-6281234567890-events` (DLQ: `wuzapi-6281234567890-dlq`)
- Bucket R2: `wuzipbot-media-6281234567890` (binding `MEDIA`)
- D1: `wuzipbot-bot-6281234567890` (binding `BOT_DB`)
- KV: `WUZIPBOT_KNOWLEDGE_6281234567890` (binding `KNOWLEDGE_KV`)
- Durable Object: `ChatCoordinator` (binding `CHAT_COORDINATOR`)
- URL yang ditempel ke dashboard wuzapi:
  `https://wuzapi-6281234567890.<subdomain-akun>.workers.dev/ingest/<INGEST_TOKEN>`

Folder ini adalah **contoh hasil scaffold** yang dipakai uji lokal; aman dihapus
atau dipakai sebagai nomor pertama Anda.

## 1. Provision resource

```sh
cd cloudflare
pnpm install
pnpm run provision -- --number 6281234567890
```

Perintah ini membuat queue, DLQ, bucket R2, database D1 dan KV namespace, lalu
menulis `database_id` dan id KV yang asli ke `wrangler.jsonc` folder ini. Jalankan
sekali lagi kapan saja — idnya selalu dibaca ulang dari akun, jadi aman.

## 2. Set secret (dari folder `cloudflare/`)

```sh
pnpm run secrets -- --number 6281234567890 --hmac-key "<32+ karakter>"
pnpm run secrets -- --number 6281234567890 --set WUZAPI_TOKEN=<token API wuzapi>
export AI_API_KEY=…
pnpm run secrets -- --number 6281234567890 --from-env
```

Yang wajib untuk bot: `INGEST_TOKEN`, `WUZAPI_HMAC_KEYS`, `WUZAPI_TOKEN`,
`AI_API_KEY`. **Nilai HMAC key harus sama** dengan yang nanti diketik di dashboard
wuzapi. `pnpm run secrets -- --number 6281234567890 --list` menunjukkan nama
secret yang sudah ada (nilainya tidak pernah bisa dibaca kembali).

## 3. Terapkan skema D1

```sh
pnpm run migrate -- --number 6281234567890
```

## 4. Deploy

```sh
pnpm run deploy -- --number 6281234567890
```

Cron `*/1 * * * *` ikut terpasang saat deploy (flush outbox, expire order,
rekonsiliasi pembayaran, sync kontak, prune). Tidak ada langkah tambahan.

```
https://wuzapi-6281234567890.<subdomain-akun>.workers.dev/ingest/<INGEST_TOKEN>
```

## 5. Daftarkan di dashboard wuzapi (per nomor)

1. Buka dashboard wuzapi, pilih instance nomor 6281234567890.
2. Kartu **Webhook Events** → isi **Webhook URL** dengan URL pada langkah 4 →
   pilih event (mis. `All`, atau subset seperti `Message`, `Connected`) → simpan.
3. Kartu **HMAC Key** → isi key yang sama dengan secret `WUZAPI_HMAC_KEYS` →
   simpan. Dashboard menyembunyikannya setelah disimpan.
4. Set `WUZAPI_API_BASE` di `wrangler.jsonc` ke domain publik wuzapi nomor ini
   (HTTPS, tanpa trailing slash) dan deploy ulang. Worker memanggil
   `/chat/send/*` dan `/user/contacts` ke sana.

## 5b. Turso, Telegram, dan pembayaran

Ketiganya opsional untuk menjalankan bot, tetapi dibutuhkan begitu pelanggan
boleh checkout:

```sh
export TURSO_DATABASE_URL=libsql://<host-anda>
export TURSO_AUTH_TOKEN=<token>
export TELEGRAM_BOT_TOKEN=<token BotFather>
export TELEGRAM_WEBHOOK_SECRET=<secret acak>
export ADMIN_API_KEY=<secret acak>
pnpm run secrets -- --number 6281234567890 --from-env
pnpm run smoke:turso -- --number 6281234567890 --local-secrets   # verifikasi schema + CRUD
```

- `TELEGRAM_CHAT_ID` diambil dari balasan bot saat admin menekan `/start`.
- Daftarkan webhook Telegram ke `https://<worker>/webhooks/telegram` dengan
  `secret_token` = `TELEGRAM_WEBHOOK_SECRET`.
- Biarkan `PAYMENT_DRY_RUN=true` (default) sampai kunci Sumopod siap: tautan
  pembayaran menunjuk `{PUBLIC_BASE_URL}/dry-run/<kode_bayar>` dan tidak ada
  gateway yang dipanggil. Isi `PUBLIC_BASE_URL` dengan URL worker ini.
- Tanpa Telegram, approval dikerjakan lewat
  `POST /admin/orders/<kode>/approve|reject`.

Langkah lengkapnya ada di `../docs/wuzip-bot-runbook.txt` bagian 10-14.

## 6. Nyalakan bot (shadow dulu, jangan langsung on)

| `BOT_MODE` | Perilaku |
|---|---|
| `off` | hanya relay ke `DOWNSTREAM_URL` — perilaku lama, sekaligus tombol rollback |
| `shadow` | pipeline bot berjalan penuh (filter, no_ai, lock, AI) tetapi **tidak ada pesan yang dikirim** ke customer; balasan yang seharusnya dikirim muncul di log sebagai `outbound_suppressed_shadow` |
| `on` | bot menjawab customer |

Urutannya: set `BOT_MODE=shadow`, deploy, amati `pnpm run tail` selama 1×24 jam →
kalau balasan yang muncul di log sudah benar, ganti ke `on`.

```sh
curl -s https://wuzapi-6281234567890.<subdomain-akun>.workers.dev/healthz | jq
```

`bot.ready=false` disertai `bot.missing`/`bot.missingBindings` menunjukkan apa
yang belum diisi. Rollback = set `BOT_MODE=off` lalu deploy.

## Perintah harian

| Perintah | Fungsi |
|---|---|
| `pnpm run dev -- --number 6281234567890` | jalankan worker lokal (port 8790, queue/R2/D1/KV/DO disimulasikan) |
| `pnpm run deploy -- --number 6281234567890` | deploy worker nomor ini |
| `pnpm run tail -- --number 6281234567890` | stream log produksi |
| `pnpm run migrate -- --number 6281234567890` | terapkan skema D1 (`--local` untuk database lokal) |
| `pnpm run secrets -- --number 6281234567890` | perbarui secret (`--list`, `--from-env`, `--set`, `--generate`) |
| `pnpm run provision -- --number 6281234567890` | buat queue/DLQ/bucket/D1/KV (idempoten) |
| `pnpm run knowledge -- --number 6281234567890 --prompt <file> --knowledge <file>` | unggah prompt/knowledge (+ `--images <dir>`, + rebuild indeks D1 lewat `--url`) |
| `pnpm run smoke:turso -- --number 6281234567890 --local-secrets` | uji schema + CRUD Turso (tanpa kredensial: SQLite lokal) |
| `pnpm run smoke:ai -- --number 6281234567890` | uji endpoint AI |
| `pnpm run e2e -- --number 6281234567890` | E2E penuh tanpa nomor WA (mock wuzapi/Telegram/AI/Turso) |
| `curl -H "Authorization: Bearer $ADMIN_API_KEY" https://<worker>/admin/status` | ringkasan Turso/Telegram/outbox |

## Uji cepat

```sh
# dari folder cloudflare/, setelah `pnpm run dev`
pnpm run simulate -- --url http://127.0.0.1:8790/ingest/dev-ingest-token-0123456789 \
  --key dev-hmac-key-0123456789abcdef --format json
```

`.dev.vars` di folder ini sudah berisi nilai dev untuk `INGEST_TOKEN`,
`WUZAPI_HMAC_KEYS`, dan `DOWNSTREAM_URL` ke `http://127.0.0.1:8799/echo`.

E2E satu perintah (mock wuzapi + Telegram + AI + Turso, tanpa pairing):

```sh
pnpm run e2e -- --number 6281234567890
```

Lihat `../README.md` untuk arsitektur, skema pesan, dan pemecahan masalah, serta
`../docs/wuzip-bot-runbook.txt` untuk prosedur operasional lengkap.
