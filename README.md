# ChatStream Labs

Satu aplikasi untuk streamer YouTube + TikTok + Twitch + Kick: gabungkan chat dua platform, tampilkan sebagai overlay di OBS dengan banyak gaya
(bisa tambah CSS sendiri), lihat jumlah penonton, dan balas chat dari satu kolom.

## Fitur
- Chat YouTube + TikTok + Twitch + Kick dalam satu jendela, filter platform, label BOT/MOD, notifikasi penonton bergabung, riwayat bisa di-scroll
- Overlay OBS: gaya Default, Kartu, Persona 5, Neon, Retro, dan CSS buatan sendiri (tambah/edit/hapus, pratinjau langsung)
- Pengaturan ukuran nama/chat, jarak, kiri/kanan, arah muncul, animasi masuk, latar chat
- Tambah overlay ke OBS satu klik (lewat obs-websocket)
- Mode kunci (tanpa bingkai, transparan, tembus-klik) + hotkey global yang bisa diatur
- Sembunyikan jendela dari tangkapan layar OBS
- Super Chat YouTube tampil menonjol (nominal + warna) di dock dan overlay
- Kirim chat lewat ekstensi Chrome (**eksperimental**, bawaannya mati; nyalakan di Dashboard → Koneksi → Kirim Chat). Semua pengiriman memakai ekstensi, tidak ada login di dalam aplikasi
- Enam tema tampilan aplikasi
- Pengaturan per platform (Pribadi dan Overlay): TikTok (bergabung, hadiah, suka, ikuti, bagikan, langganan; masing-masing bisa diberi latar dan warna font) dan YouTube (Super Chat, Super Sticker, Member)
- Twitch dan Kick (**eksperimental**): Bits/Kicks, subscribe, gift sub, raid, pengumuman, follow, hadiah poin, chatter baru, emote; masing-masing punya halaman pengaturan di Pribadi dan Overlay (belum diuji dengan live sungguhan)
- Pratinjau overlay menampilkan pesan acak terus-menerus dari semua platform dan jenis aktivitas
- Kotak Total penonton (penonton yang sedang menonton, bukan puncak) dan tombol Laporan penonton: grafik, puncak, rata-rata, chat, hadiah, Super Chat, riwayat sesi
- Browser Dock (dulu Donate Dock): tempel URL widget donasi (alert dan media share, misalnya Saweria), lalu widget tampil di jendela sendiri di atas game. Ikut mode gembok (transparan, tembus klik, tidak mencuri fokus), posisi dan ukuran tersimpan, ada saklar bisu, hotkey (Ctrl+Alt+D) dan menu tray. Chrome tidak perlu dibuka. Belum diuji dengan widget asli
- Dock chat = satu jendela transparan. Tombol mata, pin, pindah, dan tutup ada di kotak kecil DI LUAR jendela chat; bulatan chat (buka kotak kirim) + bulatan filter (pilihan muncul ke atas) ada di dalam jendela, kanan bawah. Pin: nyala = terkunci (klik tembus ke game), mati = bisa digeser dan di-resize lewat pegangan di tepi atas/samping (sisi bawah tidak bisa di-resize), tanpa pindah jendela
- Kolom kirim chat bawaannya mati (kotak isi chat dan tombol Kirim tersembunyi; bulatan chat ikut tersembunyi, bulatan filter tetap ada). Nyalakan lewat saklar Kirim Chat di Koneksi

## Catatan penting
- Cara mengambil chat YouTube/TikTok **tidak resmi** dan bisa berhenti bekerja kapan saja; memakainya bisa melanggar ketentuan layanan
  platform. Pakai dengan risiko sendiri.
- `tiktok-live-proto` (dipakai oleh `tiktok-live-connector`) berlisensi **AGPL-3.0**. Kalau kamu membagikan aplikasi hasil build,
  baca ketentuannya dan sediakan kode sumbernya.
- Belum ada lisensi untuk kode proyek ini sendiri. Pemiliknya perlu memilih lisensi sebelum dipublikasikan.
- Aplikasi belum bertanda tangan digital, jadi Windows SmartScreen akan memberi peringatan saat instal.
