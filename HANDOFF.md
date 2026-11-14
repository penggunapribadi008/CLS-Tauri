# HANDOFF — ChatStream Labs (migrasi Electron → Tauri)

> **Untuk Claude yang membaca ini di chat baru:** file ini adalah ingatan proyek. Baca seluruhnya sebelum menjawab. Pengguna tidak perlu
> menjelaskan ulang. Aturan kerja ada di bagian **"Protokol Claude"**, dan itu wajib diikuti, termasuk memperbarui file ini di akhir kerja.
>
> **Untuk pengguna:** di chat baru, unggah **zip proyek terbaru** (di dalamnya ada file ini) lalu ketik: *"Lanjutkan dari HANDOFF.md"*.
> Kalau cuma mau tanya-tanya, mengunggah file ini saja sudah cukup.

Terakhir diperbarui: 2026-11-14 · Versi aplikasi: 1.1.6

---

## 1. Apa proyek ini
ChatStream Labs: aplikasi Windows untuk streamer (bahasa Indonesia) yang menampilkan chat live **YouTube, TikTok, Twitch, Kick** sebagai
jendela chat (dock) dan overlay OBS, plus **Browser Dock** (widget donasi: alert / media share, mis. Saweria), laporan penonton, ekstensi Chrome.

**Tujuan pengguna:** app yang jauh lebih ringan (RAM) daripada versi Electron, dengan **fitur sama persis**, tanpa Electron. Pengguna sendiri
yang build lewat GitHub Actions dan menguji di Windows. Pengguna bukan programmer; penjelasan harus sederhana, jujur, dan tidak bertele-tele.

**Repo:** `penggunapribadi008/CLS-Tauri` (GitHub, **Private**). Cabang `main`.

## 2. Sejarah keputusan (singkat)
1. Pengguna awalnya minta "Win32 murni C++". Dibuat fondasi kecil **ChatStream Lite** (C++), tapi fiturnya jauh lebih sedikit (tanpa dashboard, TikTok, dll).
   Pengguna kecewa karena harapannya fitur penuh. **Lite ditinggalkan** (hanya eksperimen, tidak ada di repo ini).
2. Pengguna bilang "ke manapun asal bukan Electron, Rust boleh". Dipilih **Tauri 2 (Rust)** karena Dashboard, pengaturan, gaya overlay, laporan,
   server, dan konektor adalah web biasa dan bisa **dipakai ulang tanpa ditulis ulang**. Yang diganti hanya `src/main.js` (cangkang Electron) menjadi Rust.
3. Pelajaran: **jangan menjanjikan lebih dari yang bisa dibuktikan**; pengguna pernah menganggap yang terpasang itu Tauri padahal masih Electron
   (nama installer berbeda, lihat bagian 9).

## 3. Arsitektur
```
Tauri (Rust) = shell/src-tauri/src/main.rs
   │  jendela, tray, hotkey, kunci/pin, Browser Dock, alert, update
   ├─ WebView2 bawaan Windows ─► http://localhost:PORT/?view=...   (halaman web LAMA: src/ui/*)
   └─ node.exe (sidecar, v22.11.0 dikunci) menjalankan src/sidecar.js = server.js LAMA + konektor YouTube/TikTok/Twitch/Kick
        protokol: JSON per baris lewat stdin/stdout (dokumentasi di kepala src/sidecar.js)
```
- Server lama memanggil "hooks" (hal yang butuh OS/jendela). `sidecar.js` mengalihkan hooks itu ke Rust. Server TIDAK diubah.
- Folder data **sama dengan Electron**: `%APPDATA%\ChatStream Labs` (pengaturan lama otomatis terbawa). Berkas milik cangkang: `shell-state.json`
  (posisi jendela, status pin dock), `shell-log.txt` (log server + cangkang, otomatis dipangkas >1 MB).
- `src/main.js` (Electron) **sengaja tetap ada** sebagai acuan perilaku asli untuk di-port. Jangan dihapus.
- Label jendela Tauri: `splash`, `dash`, `chat`, `ctl-chat`, `ctl-<idDock>`, `dock-<idDock>`, `galert`, `win-<view>`.

## 4. Peta berkas penting
| Berkas | Isi |
|---|---|
| `shell/src-tauri/src/main.rs` (~2200 baris) | seluruh cangkang Rust. Bagian: state, util, posisi jendela, Dashboard, jendela chat, geser & resize buatan sendiri, kotak tombol (ctl), Browser Dock, klik di jendela ter-pin (hover_loop), alert hadiah, simpan CSS, auto-update, jendela lain, keluar, hotkey, hook dari server, sidecar, start-up, tray |
| `shell/src-tauri/tauri.conf.json`, `Cargo.toml` | konfigurasi (versi harus sama, lihat `scripts/version.js`) |
| `src/sidecar.js` | jembatan server ↔ cangkang |
| `src/updater.js` | cek/unduh pembaruan dari GitHub Releases (node terpisah, SHA-256 wajib cocok) |
| `scripts/build-tauri.js` | menyiapkan `shell/app` (resource) dan `shell/splash` (frontendDist) |
| `scripts/version.js` | `check` / `set <x.y.z>`: menyamakan versi di 6 tempat (package.json, lock ×2, manifest ekstensi, tauri.conf.json, Cargo.toml) |
| `.github/workflows/build-tauri.yml` | build installer NSIS; tag `v*` → GitHub Release |
| ~~`.github/workflows/build.yml`~~ | workflow Electron lama: **DIHAPUS di v1.1.4** (satu push = satu workflow saja) |
| `test/sidecar-test.js`, `updater-test.js`, `dock-measure-test.js` | tes Node tanpa internet (jalan di CI dan di sandbox Claude) |
| `shell/README.md` | status singkat cangkang |

## 5. Status fitur (Tauri)
Legenda: ✅ dikonfirmasi pengguna jalan · 🟡 ditulis & lolos build, belum ada konfirmasi perilaku · ❌ belum ada

| Fitur | Status |
|---|---|
| Build GitHub Actions (Rust + NSIS) | ✅ berhasil (sampai versi terakhir) |
| Splash, Dashboard, tray, satu instance, keluar dengan konfirmasi | ✅ |
| Jendela chat (transparan, di atas, pin = klik tembus) | ✅ |
| Kotak tombol: mata, pin, pindah, tutup (jendela `ctl-*`) | ✅ |
| Browser Dock: banyak dock, buka/tutup/muat ulang, pin, skala otomatis, tray + hotkey | ✅ |
| Geser tanpa "snap layar penuh" + resize dari sudut (buatan sendiri, `start_move` / `grip_loop`) | 🟡 |
| Browser Dock "Ukuran otomatis" (isi widget memenuhi jendela) | 🟡 |
| Alert hadiah TikTok (`galert`) | 🟡 |
| Klik "bulatan" chat/filter dan kolom ketik di jendela ter-pin (`hover_loop`, `chatFocus`) | 🟡 |
| Simpan CSS (dialog Simpan sebagai) | 🟡 |
| Auto-update (dialog Update Now / Later, progres di splash, tombol Cek Update) | 🟡, **butuh repo Public** dan versi kedua untuk diuji |
| Hotkey global, sembunyikan dari OBS/tangkapan layar | ✅/🟡 (hotkey belum dikonfirmasi satu per satu) |
| **Hemat RAM v1.1.3**: argumen WebView2 hemat (`WV_LEAN`, lewat `wb()`), Dashboard DIHANCURKAN saat disembunyikan >30 dtk, flag heap node | 🟡 (ukur ulang di Task Manager: sebelumnya 342.7 MB) |
| Tombol **Bisu** di Browser Dock (`MUTE_JS`, suara dibisukan dari dalam halaman; bukan SetIsMuted WebView2) | 🟡 |
| **Muat ulang otomatis** dock yang gagal (Tauri tidak memberi tahu halaman gagal) | ❌ |
| **Kunci scroll** chat saat ter-pin (`lockScroll`): hook roda mouse global `WH_MOUSE_LL` (`wheel_hook` + `wheel_loop`), aktif bila pengaturan "Chat bisa di-scroll saat terkunci" nyala | 🟡 |
| **Cadangan Kick** lewat jaringan Chromium (`netFetch` menjawab status 0). Hasilnya bergantung Cloudflare, anggap eksperimen | ❌ |
| Opsi "Abaikan versi ini" (dialog kedua setelah Later; disimpan di `shell-state.json` kunci `skipUpdate`) | 🟡 |
| Menu tray dinamis (label Pin/Lepas pin berganti) | ❌ (kecil) |
| Warna latar dock saat tidak di-pin mengikuti tema (sekarang gelap tetap `rgba(14,18,20,…)`) | ❌ (kecil) |
| **Tahap 3:** buang `node.exe`, tulis ulang server + konektor ke Rust | ❌ (besar; putuskan setelah RAM total diukur) |

RAM TERUKUR (screenshot Task Manager, 2026-11-14): total **342.7 MB** (13 proses): Rust 7.5, node 16.7, Console Window Host 5.7, WebView2 ±313 (GPU 114, Manager 64, 4 renderer ±52, 2 widget saweria 24+52).
Angka "30 MB" yang dulu tercatat HANYA proses Rust. Node cuma ±22 MB (+console), jadi **tahap 3 hampir tidak menghemat RAM**; sarankan ditunda/dibatalkan. Penghemat nyata ada di WebView2 (jumlah jendela/widget, opsi GPU).

## 6. Status hooks server → cangkang
`protect` ✅ · `open` ✅ · `window` ✅ · `lock`(+id dock) ✅ · `drag`/`resize` (buatan sendiri) 🟡 · `openSettings/Report/Chat` ✅ · `winCtl` ✅ ·
`relaunch` ✅ · `setHotkeys` ✅ · `global` (ctrlPos + sinkron dock) ✅ · `donate` ✅ · `shape` (disimpan di `handle_line`, dipakai `hover_loop`) 🟡 ·
`chatFocus` 🟡 · `galert` 🟡 · `saveCss` 🟡 · `checkUpdate` 🟡 · `appVersion`, `dashState` ✅ · `netFetch` ❌ (stub).

## 7. Catatan teknis yang mahal ditemukan (jangan diulang)
- **Sandbox Claude tidak punya Rust/cargo dan tidak ada internet.** Kode Rust ditulis tanpa compiler; verifikasi = GitHub Actions. Yang bisa diuji di sandbox: semua JS (`node test/*.js`).
- Tauri yang dipakai CI: **2.12.x**. Di versi ini **tidak ada** `tauri::ResizeDirection` dan `WebviewWindow::start_resize_dragging` (itu error build sebelumnya).
  Karena itu geser/resize dibuat sendiri lewat FFI user32 (`SetWindowPos` + polling kursor `GetCursorPos`/`GetAsyncKeyState`), `resizable(false)` di chat dan dock.
- Geser bawaan Windows memicu **Aero Snap** (tarik ke tepi atas = layar penuh); itu alasan geser dibuat sendiri. Area sudut resize bawaan Tauri hanya ±5 px.
- Membuat jendela dari event handler thread utama bisa **deadlock** di Windows → semua aksi UI dijalankan di `std::thread::spawn`.
- `Mutex` guard dari `sh(app).x.lock()`: jangan simpan ke `let` kalau `sh(app)` hanya sementara (error "temporary dropped"). Pakai `let s = sh(app); let m = s.x.lock()...`.
- Browser Dock lama memakai dua `WebContentsView` dalam satu jendela (latar + widget). Di Tauri dibuat **satu jendela per dock** (multi-webview butuh fitur tidak stabil).
  Latar dock saat tidak di-pin = CSS `rgba(14,18,20,dockOp)` yang disuntik; saat di-pin transparan + `pointer-events:none`.
- "Ukuran otomatis": skrip `MEAS_JS` (di dalam `main.rs`) berjalan di halaman widget, mengukur kotak isi terlihat tiap 1 dtk, menulis hasil ke URL `#__csl=W,H`
  lewat `history.replaceState`; Rust membaca `url()` tiap 1 dtk (`dock_measure_loop`). Ukuran hanya naik. **URL dock bisa memuat kunci stream: jangan pernah dicatat ke log.**
- Nama repo untuk auto-update diambil **saat build** dari env `GITHUB_REPOSITORY` (`option_env!`). Repo Private → API GitHub menjawab 404 → "tidak ada pembaruan".
- Update: v1.1.5 ke bawah menjalankan installer dengan `/P /R /UPDATE` (dari ingatan) dan TERBUKTI GAGAL: wizard installer tetap muncul (pengguna harus memilih uninstall/reinstall manual). v1.1.6 memakai cmd: tunggu app keluar → `start /wait installer /S /UPDATE /D=<folder lama>` → buka app lagi (app dibuka lagi walau pemasangan gagal). BELUM TERBUKTI. Perbaikan hanya berlaku untuk update DARI v1.1.6 ke atas (yang menjalankan update adalah app lama, jadi update 1.1.5→1.1.6 masih lewat wizard).
- RAM v1.1.3: SEMUA jendela dibuat lewat `wb()` (argumen WebView2 harus identik di semua jendela, kalau tidak error 0x8007139F). `WV_LEAN` = bawaan Tauri + `--in-process-gpu` + `--renderer-process-limit=2` + `--enable-low-end-device-mode` + fitur tidak perlu dimatikan. Argumen buatan sendiri MENGGANTI bawaan Tauri, makanya bawaan disertakan ulang. Cadangan tanpa build ulang: berkas `%APPDATA%\ChatStream Labs\webview-args.txt` (isi `default` = hanya bawaan Tauri; kosong/tidak ada = set hemat). `--in-process-gpu` pada jendela transparan BELUM terbukti; kalau jendela chat/dock jadi hitam/berkedip, pakai `default`.
- v1.1.5: (a) `lockScroll` = hook `WH_MOUSE_LL` di thread sendiri (`wheel_install`), isi callback cuma atomik; roda DITELAN kalau kursor di dalam rect chat (`chat_geom`) + chat ter-pin + pengaturan nyala; delta dikirim ke `#list` lewat `eval` (`wheel_loop`, 16 ms). Batasan: kalau jendela lain menutupi chat, roda di situ ikut tertelan (sama dengan Electron). `LOCK_SCROLL` diisi dari hook `global` dan `settings.json` saat start. (b) Scrollbar Browser Dock disembunyikan lewat CSS (`scrollbar-width:none` + `::-webkit-scrollbar`), tetap bisa di-scroll. (c) Kursor resize Browser Dock = 8 elemen `<b>` bercursor `*-resize` di dalam bingkai putih `__cs_fr` (hanya saat tidak di-pin), ukurannya sama dengan zona `grip_loop` (tepi 8 px, sudut 18 px); resize-nya sendiri tetap dari `grip_loop`. Chat TIDAK diubah (halaman chat sudah punya pegangan `rz` sendiri).
- Dashboard dihancurkan (bukan about:blank) saat hidden >30 dtk; `show_dash` membuatnya lagi dan menunggu `dash_loaded`. Kalau tidak ada jendela web lain, proses WebView2 berhenti total (RAM diam ≈ Rust + node). `RunEvent::ExitRequested` sudah mencegah aplikasi keluar saat jendela terakhir hilang.
- Bisu: `MUTE_JS` disuntik lewat `initialization_script` (saat dokumen mulai) + `window.__cslSetMute` dari `dock_apply`. Menutup `<video>/<audio>` dan Web Audio (GainNode). TIDAK menjangkau suara di iframe lintas-situs. Kalau Saweria masih bersuara, penyebab paling mungkin iframe; solusi lanjutan = `with_webview` + `ICoreWebView2_8::SetIsMuted` (butuh crate `webview2-com`, versi harus cocok dengan Tauri).
- Dialog Tauri hanya punya 2 tombol (`OkCancelCustom`); "Abaikan" dibuat sebagai dialog kedua setelah "Later". `YesNoCancelCustom` ada di plugin versi baru tapi belum diverifikasi.
- Shell sandbox: `mkdir -p {a,b}` (brace expansion) **gagal** (sh/dash). Buat folder satu per satu.
- Kuota artifact GitHub (repo Private) cepat penuh (workflow Electron mengunggah ±100 MB tiap push). Workflow Tauri: `retention-days: 1` + `continue-on-error`.
  Installer diambil lewat **Release** (tag), yang tidak memakai kuota artifact.

## 8. Cara build & uji
- Build: push ke `main` → Actions → **Build Tauri**. Installer: buat **Release** dengan tag **persis** `v<versi>` (mis. `v1.1.1`) → aset `ChatStream-Labs_<versi>_x64-setup.exe` + `.sha256`.
- Naikkan versi: `node scripts/version.js set 1.1.2` (menyamakan 6 tempat), commit, lalu tag `v1.1.2`.
- Tes lokal (Node 22): `node test/sidecar-test.js && node test/updater-test.js && node test/dock-measure-test.js && node scripts/version.js check`.
- Ikon file installer = `installerIcon` di tauri.conf.json; ikon aplikasi/jendela/tray datang dari `icons/`. Kalau ikon installer tampil "NSIS" polos, `installerIcon` hilang.
- Nama installer yang BENAR untuk Tauri: `ChatStream Labs_x.y.z_x64-setup.exe` / `ChatStream-Labs_x.y.z_x64-setup.exe`.
  `chatstreamlab-vX.exe` = installer **Electron lama** (jangan tertukar). Menu tray Electron punya "Buka Browser Dock"; Tauri hanya punya "Browser Dock (buka / tutup)".
- Jangan jalankan Electron dan Tauri bersamaan (folder data dan port sama).

## 9. Pertanyaan terbuka untuk pengguna (tagih saat chat baru dimulai)
1. Apakah build terbaru sudah dipasang dan fitur 🟡 di bagian 5 sudah dicoba? Mana yang gagal?
2. Total RAM sebenarnya (jumlah semua proses, lihat bagian 5)?
3. Repo mau dijadikan Public (agar auto-update jalan)?

## 10. Backlog (urutan saran)
~~1. Abaikan versi ini~~ (selesai 1.1.2, 🟡) → ~~2. Tombol Bisu~~ (selesai 1.1.2, 🟡, lewat JS) → ~~3. `lockScroll`~~ (selesai 1.1.5, 🟡) → 4. Muat ulang otomatis dock →
5. Hal kecil (tray dinamis, warna latar dock mengikuti tema) → 6. **Hemat RAM lanjutan** (kalau v1.1.3 belum cukup): gabungkan jendela `ctl-*` dan `galert` ke jendela yang ada; widget dimuat hanya saat perlu; ganti Dashboard ke UI native (besar, mengulang jalur Lite).
7. **Tahap 3** (buang node): RAM sudah terukur, hasilnya tidak sepadan, sarankan dibatalkan. Gantinya: hemat WebView2 (widget dimuat hanya saat perlu, uji `--disable-gpu` lewat `additionalBrowserArgs`, kurangi jendela).

## 11. Protokol Claude (WAJIB)
1. **Awal chat:** baca file ini, lalu tagih bagian 9 (hasil build/uji) sebelum menambah fitur baru. Menambah fitur di atas build yang belum terbukti hanya menumpuk error.
2. **Bahasa:** Indonesia santai, singkat, jujur. Tegaskan mana yang **sudah teruji** dan mana yang **belum** (terutama kode Rust). Jangan mengklaim fitur ada kalau tidak.
3. **Cara kirim hasil:** **satu file zip** berisi struktur folder lengkap (pengguna tidak mau menimpa file satu per satu) dan jangan membuild semuanya satu per satu.
   Nama zip: `CLS-Tauri.zip`, folder akar `CLS-Tauri/`. Sertakan HANDOFF.md terbaru di dalamnya.
4. **Sebelum mengirim:** jalankan semua tes Node (bagian 8) dan `node scripts/version.js check`. Cek kurung/kurawal Rust seimbang. Tidak ada compiler Rust, jadi terus terang soal itu.
5. **Setelah SETIAP sesi kerja yang mengubah sesuatu, perbarui HANDOFF.md** (tanpa menunggu diminta): tanggal, status bagian 5/6, catatan teknis baru (bagian 7),
   backlog (bagian 10), dan tambahkan baris di **Changelog** di bawah. Lalu **ingatkan pengguna**: *"HANDOFF.md ikut ada di zip; simpan zip ini dan unggah di chat baru."*
6. Kalau pengguna memberi aturan/preferensi baru yang bersifat tetap, catat di sini (bagian 11) supaya tidak hilang.
7. Kalau build merah: minta **screenshot/teks error** dari langkah yang gagal; biasanya perbaikannya satu baris.

## 12. Changelog
- **2026-11-14 (v1.1.6)** — Update otomatis dibuat senyap (`/S` lewat cmd + buka app lagi), karena cara lama memunculkan wizard. Belum diuji; hanya berlaku untuk update dari v1.1.6 ke versi berikutnya.
- **2026-11-14 (v1.1.5)** — Permintaan pengguna: chat ter-pin bisa di-scroll dengan roda mouse tanpa bilah scroll (hook roda global), scrollbar Browser Dock dihapus, kursor berubah saat di tepi/sudut Browser Dock yang tidak di-pin. Belum dicoba di Windows; Rust belum dikompilasi.
- **2026-11-14 (v1.1.4)** — Ikon file installer diperbaiki (`bundle.windows.nsis.installerIcon = icons/icon.ico`; tanpa ini Tauri memakai ikon bawaan NSIS). Workflow Electron `build.yml` dihapus. Argumen WebView2 yang dipakai kini dicatat di `shell-log.txt`. Hasil uji pengguna: argumen hemat aktif (GPU menyatu), total 342.7 → ±228 MB; `webview-args.txt` agresif terbaca tapi tidak menambah hemat (renderer tetap ±6), disarankan dihapus.
- **2026-11-14 (v1.1.3)** — Hemat RAM: `wb()` + `WV_LEAN` argumen WebView2 (dengan berkas cadangan `webview-args.txt`), Dashboard dihancurkan saat disembunyikan, node `--max-old-space-size=192`. Belum diuji; ukur Task Manager sebelum/sesudah.
- **2026-11-14 (v1.1.2)** — Tombol Bisu Browser Dock (`MUTE_JS`) dan "Abaikan versi ini" di dialog update. Hasil ukur RAM dicatat (342.7 MB), tahap 3 disarankan dibatalkan. Belum dicoba di Windows; kode Rust belum dikompilasi (cek lewat Actions).
- **2026-11-14** — Tahap 1 (cangkang Tauri + sidecar + installer) → 2a (kotak tombol ctl + Browser Dock) → 2b (alert hadiah, klik di jendela ter-pin, chatFocus,
  simpan CSS, auto-update) → perbaikan resize (error build `ResizeDirection`/`start_resize_dragging`) → geser & resize buatan sendiri (tanpa snap, sudut 18 px)
  → "Ukuran otomatis" Browser Dock (`MEAS_JS` + `dock_measure_loop`) → workflow: retensi artifact 1 hari, rilis lewat tag.
  Build Actions dikonfirmasi berhasil; tombol ctl dan Browser Dock dikonfirmasi jalan; sisanya menunggu uji pengguna.
  Pengguna meminta file serah-terima ini (HANDOFF.md) dan pengiriman hasil sebagai satu zip.
