# Panduan Deploy DITZ MARKET ke VPS

Total waktu sekitar 30 menit. Kamu butuh: **VPS**, **domain**, dan file `ditz-market.zip` ini.

## 1. Beli VPS
- OS: **Ubuntu 22.04 atau 24.04**. Spesifikasi kecil sudah cukup (1 vCPU, 1 GB RAM, 20 GB disk).
- Pilih penyedia yang kamu percaya, misalnya DigitalOcean, Vultr, Hetzner, Contabo, atau penyedia lokal seperti
  Biznet Gio / IDCloudHost. Cek harga dan lokasi server terbaru di situsnya (untuk pembeli Indonesia, server di Singapura/Indonesia lebih cepat).
- Catat **alamat IP** VPS dan password/SSH key root-nya.

## 2. Beli domain
- Di registrar mana saja (Niagahoster, Rumahweb, Namecheap, Cloudflare Registrar, dll.).
- Di pengaturan DNS domain, buat dua **A record** yang mengarah ke IP VPS:
  - `@` → IP VPS
  - `www` → IP VPS
- Tunggu 5–30 menit sampai aktif.

## 3. Pasang di VPS
Di komputermu (ganti `IP_VPS`):
```bash
scp ditz-market.zip root@IP_VPS:/root/
ssh root@IP_VPS
```
Di dalam VPS:
```bash
apt-get update && apt-get install -y unzip
unzip ditz-market.zip && cd ditz-market
sudo bash deploy/setup-vps.sh namadomain.com emailkamu@gmail.com
```
Mau menentukan sendiri akun adminnya? Tambahkan variabelnya di depan (hanya berlaku pada pemasangan pertama):
```bash
sudo ADMIN_USER=adit ADMIN_PASS='PasswordKuat123' bash deploy/setup-vps.sh namadomain.com emailkamu@gmail.com
```
Skrip akan memasang Node.js, Nginx, HTTPS gratis (Let's Encrypt), firewall, dan menyalakan toko otomatis
(hidup lagi sendiri bila server restart). Di akhir, **username dan password admin tampil di layar** — simpan.

## 4. Setelah online
- Buka `https://namadomain.com/admin`, login, lalu **ganti password** di Pengaturan.
- Cek `https://namadomain.com` lalu coba daftar dan buat satu pesanan uji.
- Update aplikasi: upload zip baru, `unzip -o`, jalankan skrip lagi (data tetap aman di `/var/lib/ditz-market`).
- Backup: otomatis tiap hari di `/var/lib/ditz-market/backups` (14 hari). Sesekali salin ke komputermu:
  `scp -r root@IP_VPS:/var/lib/ditz-market/backups ./backup-toko`
- Log: `journalctl -u ditz-market -f`

## Mengaktifkan integrasi (opsional)
Lihat bagian **Integrasi opsional** di README.md (Midtrans, Xendit, Digiflazz, Telegram). Singkatnya: tambahkan variabelnya ke `/etc/ditz-market.env`, isi URL webhook di dashboard penyedia, lalu `systemctl restart ditz-market`. Mulai dari sandbox.

## Alternatif tanpa mengurus server
Layanan seperti Railway atau Render bisa menjalankan folder ini langsung (perintah start: `node server.js`).
Wajib pasang *persistent volume*, set `DATA_DIR` ke volume itu, dan `COOKIE_SECURE=true`, `TRUST_PROXY=true`.
Domain tinggal diarahkan lewat menu *Custom Domain* mereka.

## Keamanan dasar VPS (sangat disarankan)
- Pakai login SSH dengan key, matikan login password root.
- Aktifkan update keamanan otomatis: `apt-get install -y unattended-upgrades`.
- Jangan bagikan file `/etc/ditz-market.env` (berisi password admin awal).
