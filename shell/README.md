# Cangkang Tauri (pengganti Electron)

Tujuan: menghilangkan Electron/Chromium bawaan, tanpa menulis ulang UI. Dashboard, pengaturan, gaya overlay, laporan,
server, dan konektor TETAP kode lama. Yang diganti hanya `src/main.js` (urusan jendela) menjadi `src-tauri/src/main.rs`.

```
Tauri (Rust)  ──jendela, tray, hotkey──►  WebView2 bawaan Windows  ──►  http://localhost:PORT  (halaman lama)
     │  stdin/stdout (JSON per baris, lihat src/sidecar.js)
     ▼
node.exe + sidecar.js  =  server.js lama + konektor YouTube/TikTok/Twitch/Kick
```
Folder data SAMA dengan versi Electron (`%APPDATA%\ChatStream Labs`), jadi pengaturan lama langsung terbawa.

## Status tahap 1
| | |
|---|---|
| Splash lama, Dashboard, tray, satu instance, keluar dengan konfirmasi | ada |
| Jendela chat (transparan, selalu di atas, pin = klik tembus, geser/resize), posisi diingat | ada |
| Hotkey global (bawaan + yang diubah di pengaturan), sembunyikan dari OBS/tangkapan layar | ada |
| Jendela laporan/gaya/pratinjau, tombol min/max/tutup Dashboard, hemat RAM Dashboard | ada |
| Server + 4 konektor + overlay OBS + ekstensi Chrome (folder tetap) | ada (kode lama) |
| Installer "next-next" (NSIS, per pengguna) | ada |
| Jendela tombol (mata, pin, pindah, tutup) di luar jendela chat, posisinya mengikuti pengaturan "Posisi tombol" | ada (tahap 2a) |
| Browser Dock (banyak dock, buka/tutup/muat ulang, pin, geser, ubah ukuran, skala otomatis, posisi diingat, tray + hotkey) | ada (tahap 2a) |
| **Belum:** alert hadiah TikTok (jendela terpisah) | tahap 2b |
| **Belum di Browser Dock:** tombol Bisu, "Ukuran otomatis", muat-ulang otomatis saat halaman gagal | tahap 2b |
| **Belum:** area klik di dalam jendela ter-pin (bulatan chat/filter; sekarang pin = seluruh jendela tembus klik; pakai hotkey/tray) | tahap 2 |
| **Belum:** auto-update, simpan CSS (.css), cadangan Kick lewat jaringan Chromium | tahap 2 |

## Build
Push ke cabang `tauri` -> Actions > "Build Tauri" -> Artifacts: installer `.exe`.
Lokal (butuh Rust, Node 22): `node scripts/build-tauri.js`, taruh `node.exe` di
`src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`, lalu `cd shell && npx @tauri-apps/cli@2 build`.

## Kalau build merah
Kode ini ditulis tanpa compiler Rust. Titik yang paling mungkin perlu disesuaikan dengan versi Tauri terbaru:
`event.state()` pada hotkey, `show_menu_on_left_click`, bentuk `resources` di `tauri.conf.json`, nama-nama kecil di API dialog.
Kirim log error-nya, biasanya perbaikannya satu baris.
