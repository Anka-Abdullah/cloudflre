# wuzapi lokal untuk uji end-to-end

Harness kecil untuk membuktikan pipeline Cloudflare bekerja dengan wuzapi
sungguhan — **tanpa PostgreSQL** dan **tanpa RabbitMQ**.

```sh
cd cloudflare
pnpm run dev -- --number 6281234567890        # worker + queue + R2 lokal di :8790

cd wuzapi-local
cp .env.example .env                          # sudah berisi token & HMAC dev
docker compose up -d --build                  # wuzapi di :8081, SQLite + volume
```

Dashboard: <http://localhost:8081/dashboard> (token dari `WUZAPI_ADMIN_TOKEN`).

## Kenapa ini berjalan tanpa PostgreSQL dan RabbitMQ

| Kebutuhan | Cara dihindari |
|---|---|
| PostgreSQL | `wuzapi/db.go` memakai SQLite otomatis jika `DB_USER`/`DB_PASSWORD`/`DB_NAME`/`DB_HOST`/`DB_PORT` tidak lengkap. Compose ini tidak mengisi satu pun, jadi database ada di volume pada `/data` (`--datadir=/data`). |
| RabbitMQ | Tanpa `RABBITMQ_URL`, publish ke queue menjadi no-op (`wuzapi/rabbitmq.go`). Semua event keluar lewat webhook. |

Compose juga menambahkan `extra_hosts: host.docker.internal:host-gateway`
supaya container bisa memanggil worker di host, dan `WUZAPI_MEDIA_TMPDIR=/data/media`
agar berkas media sementara berada di volume (bukan tmpfs/RAM).

## Alur uji yang sudah diverifikasi

1. `WUZAPI_GLOBAL_WEBHOOK` di `.env` menunjuk ke
   `http://host.docker.internal:8790/ingest/<INGEST_TOKEN>`, dan
   `WUZAPI_GLOBAL_HMAC_KEY` sama dengan secret `WUZAPI_HMAC_KEYS` worker.
2. Buat instance (sekali):
   ```sh
   curl -X POST http://127.0.0.1:8081/admin/users \
     -H "Authorization: $WUZAPI_ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"name":"e2e","token":"e2e-token-1234"}'
   ```
3. Berlangganan event — **wajib**. Webhook global tetap melewati pemeriksaan
   subscription milik user (`wuzapi/wmiau.go`: `checkIfSubscribedToEvent` dipanggil
   sebelum `sendToUserWebHook*` maupun `sendToGlobalWebHook`). Jadi user dengan
   `events` kosong tidak mengirim apa pun. Di dashboard, ini setara dengan
   mencentang event pada kartu *Webhook Events*.
   ```sh
   curl -X POST http://127.0.0.1:8081/webhook -H "token: e2e-token-1234" \
     -H 'content-type: application/json' -d '{"webhookurl":"","events":["All"]}'
   ```
4. Sambungkan sesi (menghasilkan event `QR` walau belum dipindai):
   ```sh
   curl -X POST http://127.0.0.1:8081/session/connect -H "token: e2e-token-1234" \
     -H 'content-type: application/json' -d '{"immediate":true}'
   ```

Hasil yang teramati di log worker (`pnpm run dev`):

```json
{"event":"ingest_queued","kind":"event","eventType":"QR","userID":"20b45e…","size":1957}
{"event":"relay_delivered","status":200,"attempt":1,"eventType":"QR"}
```

Artinya signature HMAC yang dibuat wuzapi sungguhan lolos verifikasi worker,
event masuk queue, dan diteruskan ke bot.

Catatan kecil saat menguji lewat API: wuzapi membaca token user dari header
`token:` (bukan `Authorization:`), sedangkan endpoint `/admin/*` memakai header
`Authorization:` berisi admin token.

## Membersihkan

```sh
docker compose down          # hentikan
docker compose down -v       # hentikan dan hapus volume (SQLite + media)
```
