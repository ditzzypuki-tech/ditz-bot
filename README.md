# DITZ MARKET — Toko Top Up (dengan Backend)

Backend Node.js **tanpa dependensi** (cukup Node 18+, tanpa `npm install`).

## Menjalankan
```bash
node server.js
```
- Toko: http://localhost:3000
- Admin: http://localhost:3000/admin
- Saat **pertama kali** jalan, akun admin dibuat otomatis dan password-nya **tampil sekali di terminal**.
  Mau pilih sendiri? `ADMIN_USER=adit ADMIN_PASS='PasswordKuat123' node server.js` (hanya berlaku saat akun admin belum ada).
- Data tersimpan di `data/db.json` (backup file ini secara rutin).

## Variabel lingkungan
| Variabel | Fungsi |
|---|---|
| `PORT` | Port server (default 3000) |
| `COOKIE_SECURE=true` | **Wajib** saat memakai HTTPS |
| `TRUST_PROXY=true` | Aktifkan bila di belakang Nginx/Cloudflare (agar IP asli terbaca untuk pembatasan login) |
| `DATA_DIR` | Lokasi folder data (arahkan ke disk permanen di hosting) |
| `ADMIN_USER`, `ADMIN_PASS` | Akun admin awal |

## Deploy
Panduan lengkap langkah demi langkah ada di **DEPLOY.md** (satu skrip memasang semuanya di VPS Ubuntu).
1. **VPS** (disarankan): jalankan dengan `pm2`/systemd, pasang Nginx + HTTPS (Let's Encrypt), set `COOKIE_SECURE=true` dan `TRUST_PROXY=true`.
2. **Railway / Render / Fly.io**: deploy folder ini, pasang *persistent volume* lalu set `DATA_DIR` ke volume tersebut.
   Tanpa disk permanen, data hilang setiap redeploy.

## Yang dijaga server
- Password di-hash (scrypt), sesi lewat cookie `HttpOnly`, pembatasan percobaan login/daftar.
- **Harga dihitung di server** — pembeli tidak bisa mengubah nominal.
- Semua endpoint admin hanya untuk akun ber-role `admin`.

## Batasan
- Verifikasi pembayaran masih **manual** oleh admin. Untuk otomatis, sambungkan payment gateway (Midtrans/Xendit) ke `server.js`.
- Penyimpanan berupa file JSON — cukup untuk toko kecil. Bila pesanan sudah banyak, pindah ke SQLite/PostgreSQL.
- Belum ada fitur lupa password (admin bisa membuatkan akun baru).
- Nomor DANA/GoPay dan gambar QRIS ada di `public/index.html` (bagian `PAYMENT_METHODS`).

## Kelengkapan toko (v1.1)
- Validasi ID per game di server (`FIELDS` di `server.js`): Zone ID untuk Mobile Legends & Magic Chess, format Riot ID untuk Valorant, dst. Produk voucher (Steam/Google Play/PlayStation) mewajibkan nomor WhatsApp.
- Halaman Syarat & Ketentuan, Kebijakan Privasi, Kebijakan Refund + footer. **Teks ini draf umum, sesuaikan dengan praktik tokomu.**
- Checkbox persetujuan di checkout (juga dicek server), FAQ tambahan, panduan "Cara Top Up", meta SEO, favicon, `robots.txt`.

## Integrasi opsional (semua diatur lewat variabel lingkungan)
Tanpa variabelnya, fitur terkait otomatis nonaktif dan toko berjalan manual seperti biasa. Status tiap integrasi tampil di **Admin > Pengaturan**.
Di VPS, isi di `/etc/ditz-market.env` lalu `systemctl restart ditz-market`.

| Fitur | Variabel | Webhook yang diisi di dashboard penyedia |
|---|---|---|
| QRIS & GoPay otomatis (Midtrans) | `MIDTRANS_SERVER_KEY`, `MIDTRANS_ENV=production` (default sandbox) | `https://domain/api/payment/midtrans/notify` |
| DANA otomatis (Xendit) | `XENDIT_SECRET_KEY`, `XENDIT_CALLBACK_TOKEN`, `SITE_URL=https://domain` | `https://domain/api/payment/xendit/notify` (jenis eWallet) |
| Top up game otomatis (Digiflazz) | `DIGIFLAZZ_USERNAME`, `DIGIFLAZZ_KEY`, `DIGIFLAZZ_WEBHOOK_SECRET` | `https://domain/api/supplier/digiflazz/notify` |
| Notifikasi admin (Telegram) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | - |

**Alur pembayaran otomatis.** Pembeli bayar -> server mengecek status langsung ke penyedia (bukan hanya percaya webhook) -> status **Dibayar - Diproses**. Halaman checkout juga mengecek sendiri tiap beberapa detik. Pembayaran yang masuk setelah pesanan kedaluwarsa/dibatalkan tetap dicatat dengan catatan di panel admin.

**Top up otomatis (Digiflazz).** Isi **Kode SKU** per paket di Admin > Produk. Paket yang SKU-nya kosong tetap diproses manual oleh admin. Pesanan dikirim ke supplier dengan `ref_id` = ID pesanan (aman dikirim ulang). Hasil: Sukses -> status **Berhasil** (kode/SN voucher tampil ke pembeli); Gagal -> tetap **Dibayar - Diproses** dengan catatan, supaya admin memproses manual atau me-refund; Pending -> dicek ulang tiap 30 detik dan lewat webhook. IP server perlu didaftarkan (whitelist) di Digiflazz. Format `customer_no`: ID, untuk Mobile Legends/Magic Chess = ID + Zone ID digabung. Cek ke supplier format tiap produkmu, terutama voucher dan Valorant.

**Kode promo.** Admin > Promo: persen atau nominal, maks diskon, minimal paket, kuota, masa berlaku. Satu kode sekali per akun; kuota kembali bila pesanan dibatalkan/kedaluwarsa.

**Lupa password.** Pembeli minta kode ke admin (WhatsApp); admin menekan **Reset password** di Admin > Akun dan mengirim kodenya (berlaku 30 menit, sekali pakai). Akun admin tidak bisa direset lewat jalur ini.

**Bukti bayar.** Untuk pesanan manual, pembeli bisa unggah screenshot (dikompres di browser, maks 300 KB); admin melihatnya lewat tombol **Bukti** di Admin > Pesanan. Nginx harus mengizinkan body hingga 512 KB (sudah di `deploy/nginx.conf.template`; jalankan ulang setup atau salin manual).

Catatan: Xendit eWallet memakai endpoint `/ewallets/charges` (API lama yang sedang dimigrasikan Xendit ke `/v3/payment_requests`). Bila Xendit menonaktifkannya, bagian `createCharge` untuk DANA perlu disesuaikan.
