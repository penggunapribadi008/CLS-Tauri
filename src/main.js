const {app,BrowserWindow,WebContentsView,View,session,dialog,Menu,shell,Tray,globalShortcut,nativeImage,screen}=require('electron');
const path=require('path'),fs=require('fs'),{spawn}=require('child_process');
const ICON=path.join(__dirname,'icon.png');
// v15.1.4 hemat RAM: batasi heap JavaScript tiap proses tampilan (halaman ini ringan; batas ini hanya mencegah memori membengkak)
try{app.commandLine.appendSwitch('js-flags','--max-old-space-size=256');}catch{}
// v15.6.3 (lag + cursor berat saat dock chat dibuka): matikan pelacak oklusi jendela native Chromium di Windows. Pelacak itu memasang hook WinEvent global dan menghitung ulang
//   jendela mana yang tertutup tiap ada jendela lain di sistem bergerak/berubah, di thread UI proses utama (yang juga menjalankan server). Jendela chat/kontrol selalu-di-atas dan transparan
//   (overlay game) justru yang paling sering memicunya. Efek samping: jendela yang tertutup jendela lain tetap menggambar (Dashboard saja, ringan).
try{app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');}catch{}
const gotLock=app.requestSingleInstanceLock();
if(!gotLock)app.exit(0);
try{
  const nu=app.getPath('userData');fs.mkdirSync(nu,{recursive:true});
  // Pindahan data dari nama aplikasi lama: SEKALI saja (ditandai berkas .migrasi-nama), dan yang dipakai adalah berkas TERBARU.
  // (Di Windows nama folder tidak peka huruf besar/kecil, jadi folder nama lama bisa saja sama dengan folder nama baru dan berisi data lebih lama.)
  const mark=path.join(nu,'.migrasi-nama');
  if(!fs.existsSync(mark)){
    let prevNames=[];try{prevNames=require('../package.json').previousNames||[];}catch{}
    const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
    const mt=f=>{try{return fs.statSync(f).mtimeMs;}catch{return -1;}};
    for(const f of['config.json','settings.json','window.json']){
      const dst=path.join(nu,f);let best=null,bt=mt(dst);
      for(const oldName of prevNames){
        const old=path.join(app.getPath('appData'),oldName);if(same(old,nu))continue;
        const t=mt(path.join(old,f));if(t>bt){bt=t;best=path.join(old,f);}
      }
      if(best)fs.copyFileSync(best,dst);
    }
    fs.writeFileSync(mark,'1');
  }
}catch{}
process.env.CG_DATA=app.getPath('userData');
process.on('uncaughtException',e=>{try{dialog.showErrorBox('ChatStream Labs - error',String(e&&e.message&&/^Port /.test(e.message)?e.message:(e&&e.stack)||e));}catch{}});
const BF=path.join(app.getPath('userData'),'window.json'),SFILE=path.join(app.getPath('userData'),'settings.json');
const readJ=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return{};}};
const saveB=b=>{try{fs.writeFileSync(BF,JSON.stringify({...readJ(BF),...b}));}catch{}};
const G=()=>readJ(SFILE).global||{};
let protect=G().protect!==false,ctrlPos=G().ctrlPos||'top-right',lockScroll=G().lockScroll===true; // lockScroll (v15.3.3): chat bisa di-scroll saat terkunci
// v15.1.6: PROTECT_PASSTHRU=true -> saat mode gembok + "Sembunyikan dari OBS" aktif, jendela TETAP tembus-klik penuh (setIgnoreMouseEvents(true), sama persis seperti saat OBS tidak disembunyikan).
//   Tidak ada lagi lubang/dot di ujung kursor. Dasarnya: Electron sendiri menambahkan WS_EX_LAYERED saat setContentProtection(true) dipasang (electron/electron#47856),
//   jadi jendela layered + proteksi seharusnya aman. BELUM DIUJI di Windows pengguna: setelah mengaktifkan, cek di OBS bahwa chat benar-benar tidak tertangkap.
//   Kalau ternyata chat masih tertangkap OBS, set false untuk kembali ke cara lama (setShape + lubang di kursor).
const PROTECT_PASSTHRU=true;
const useHole=()=>protect&&!PROTECT_PASSTHRU; // true = pakai cara lama (jendela tidak tembus-klik, area klik lewat setShape + lubang)
// v15.6.3: pengulangan 150/600/2000 ms cukup SEKALI per jendela (dulu tiap 'show' dan 'did-finish-load' menjadwalkan tiga kali lagi = puluhan SetWindowDisplayAffinity saat dock dibuka;
//   tiap panggilan membuat DWM menyusun ulang jendela layered). Panggilan berikutnya hanya satu kali langsung, dan dilewati kalau nilainya sudah sama dan pernah dipasang >2 dtk lalu.
// v15.6.4: tiap SetWindowDisplayAffinity menunggu DWM (lebih lama lagi kalau OBS sedang menangkap layar) dan dijalankan di thread UI = ikut menahan Dashboard. Sekarang: pasang sekali saat dibuat,
//   sekali lagi saat pertama tampil (kalau sudah lewat 300 ms), sekali lagi 900 ms kemudian; sesudah itu hanya kalau nilai "Sembunyikan dari OBS" berubah (force).
const protAt=new WeakMap();
function prot(w,force){const f=()=>{try{if(w&&!w.isDestroyed())w.setContentProtection(protect);}catch{}};
  const r=protAt.get(w),now=Date.now();
  if(!r){protAt.set(w,{v:protect,t:now});mark('prot');f();setTimeout(f,900);return;}
  if(r.v===protect&&(!force||now-r.t<300))return;
  r.v=protect;r.t=now;mark('prot');f();}
app.on('browser-window-created',(e,w)=>{prot(w);w.on('show',()=>prot(w,true));w.webContents.on('did-finish-load',()=>prot(w));}); // v15.6.3: 'show' = satu panggilan langsung (tanpa jadwal ulang); lihat prot()
let srv=null,main=null,dash=null,splashWin=null,locked=false,tray=null,dragT=null,rzT=null,quitting=false,asking=false; // locked = chat dock sedang di-PIN (klik tembus). v15.6.1: switching dihapus (jendela tidak pernah diganti lagi), rzT = timer resize
// false selama splash masih tampil (cek update + menyambungkan). Selama false, tidak ada jendela aplikasi (Dashboard, Chat, Donate Dock) yang boleh dibuka atau ditampilkan,
// baik lewat tray, hotkey, maupun membuka aplikasi kedua kalinya.
let appReady=false;
let lastRects=[],lastList=null;
let srvReady;const srvP=new Promise(r=>srvReady=r);
const base=()=>'http://localhost:'+(srv&&srv.port||3000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const THEME_BG={standar:'#0e1214',neo:'#e3e8ef',glass:'#08101d',clay:'#f4e6d8',liquid:'#071a2e',spatial:'#0d0e12'};
const themeBg=()=>THEME_BG[(readJ(SFILE).dock||{}).theme]||'#0e1214';
const LOGF=()=>path.join(app.getPath('userData'),'log.txt');
const log=t=>{try{fs.appendFileSync(LOGF(),new Date().toISOString()+' '+t+'\n');}catch{}};
// v15.6.4: kalau proses utama (yang juga menjalankan server dan semua jendela) terhenti > 400 ms, tulis ke log.txt berikut langkah terakhir yang tercatat lewat mark().
//   Dashboard "Not Responding" saat dock dibuka = proses utama tidak sempat memproses pesan jendela; baris ini menunjukkan di langkah mana.
const crumbs=[];const mark=s=>{crumbs.push((Date.now()%100000)+':'+s);if(crumbs.length>7)crumbs.shift();};
{let t0=Date.now();const t=setInterval(()=>{const n=Date.now(),d=n-t0-250;t0=n;if(d>400)log('proses utama terhenti ±'+d+' ms; jejak (jam%100000:langkah): '+(crumbs.join(' > ')||'-'));},250);if(t.unref)t.unref();}
app.on('second-instance',()=>{
  showDash();
});
// ===== kotak tombol (mata, gembok, pindah, tutup) = jendela kecil tanpa bingkai di LUAR jendela chat / Donate Dock =====
const CW=162,CH=36,CM=4;
// paksa jendela menggambar ulang isinya (dipakai setelah jendela tampil / dipulihkan dari minimize, supaya isinya tidak kosong)
const repaint=w=>{const f=()=>{try{if(w&&!w.isDestroyed()){const c=(w.__view||w).webContents;if(c&&!c.isDestroyed())c.invalidate();}}catch{}};f();setTimeout(f,120);};
// v15.5.4: selama chat dock digeser (dragOn) layar tempat jendela berada dicari paling sering tiap 250 ms. Dulu getDisplayMatching dipanggil 5-6 kali tiap 16 ms (kotak tombol + alert, masing-masing dua kali).
let waC=null,waT=0;
const workAreaOf=wb=>{const n=Date.now();if((dragT||rzT)&&waC&&n-waT<250)return waC;waC=screen.getDisplayMatching(wb).workArea;waT=n;return waC;};
function ctlBounds(wb,inside){ // Chat Dock: posisi kotak tombol di luar jendela: atas = tepat di atas jendela, bawah = tepat di bawah (mengikuti pengaturan "Posisi tombol"), dijaga tetap di dalam layar
  if(inside){ // Donate Dock: selalu di DALAM jendela, pojok kanan atas (tidak mengikuti pengaturan "Posisi tombol")
    let x=Math.max(wb.x,wb.x+wb.width-CW-CM),y=wb.y+CM;
    try{const wa=workAreaOf(wb);x=Math.min(Math.max(x,wa.x),wa.x+wa.width-CW);y=Math.min(Math.max(y,wa.y),wa.y+wa.height-CH);}catch{}
    return{x,y};
  }
  const P=ctrlPos||'top-right',top=P.startsWith('top');
  let x=P.endsWith('left')?wb.x:P.endsWith('right')?wb.x+wb.width-CW:Math.round(wb.x+(wb.width-CW)/2),y=top?wb.y-CH-CM:wb.y+wb.height+CM;
  try{const wa=workAreaOf(wb);x=Math.min(Math.max(x,wa.x),wa.x+wa.width-CW);y=Math.min(Math.max(y,wa.y),wa.y+wa.height-CH);}catch{}
  return{x,y};
}
// t = 'chat' atau id Donate Dock. Jendela tombol ikut bergerak, tampil, dan sembunyi bersama jendela induknya, dan ditutup saat induknya ditutup.
// v15.6.2: jendela chat KEMBALI memakai jendela tombol di luar (mata, pin, pindah, tutup); hanya bulatan chat + filter yang tinggal di dalam jendela chat.
//   Untuk chat, parameter lk = keadaan PIN (variabel `locked`, dibaca ulang tiap dimuat) dan berubah lewat pushPin() tanpa memuat ulang; untuk Donate Dock lk = terkunci (jendela dibuat ulang saat berganti).
// v15.5.0: halaman tombol (ctl.html) TIDAK lagi menembak /dash-state tiap 2 detik. Keadaan awal ikut di alamat (prot, lk); saat "Sembunyikan dari OBS" diganti, pushCtl() mendorongnya ke semua jendela tombol.
const ctlWins=new Set();
function pushCtl(){ctlWins.forEach(c=>{try{if(!c.isDestroyed())c.webContents.executeJavaScript('window.__st&&window.__st({prot:'+(protect?'true':'false')+'})').catch(()=>{});}catch{}});}
// v15.6.2: beri tahu kotak tombol chat bahwa pin berubah (ikon pin terisi = terpin)
function pushPin(){try{const c=main&&!main.isDestroyed()&&main.__ctl;if(c&&!c.isDestroyed())c.webContents.executeJavaScript('window.__st&&window.__st({lk:'+(locked?'true':'false')+'})').catch(()=>{});}catch{}}
function attachCtl(w,t,L){
  const c=new BrowserWindow({width:CW,height:CH,useContentSize:true,title:'ChatStream Labs - kontrol',icon:ICON,frame:false,transparent:true,backgroundColor:'#00000000',hasShadow:false,resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,focusable:false,thickFrame:false,show:false,parent:w,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false}});
  if(L)c.setAlwaysOnTop(true,'screen-saver');
  const pos=()=>{try{if(c.isDestroyed()||w.isDestroyed())return;const r=ctlBounds(w.getBounds(),t!=='chat'),b=c.getPosition();if(b[0]!==r.x||b[1]!==r.y)c.setPosition(r.x,r.y,false);}catch{}};
  w.__pos=pos;pos();
  ctlWins.add(c);c.on('closed',()=>ctlWins.delete(c));w.__ctl=c;
  const lkNow=()=>t==='chat'?(locked?1:0):((docks.get(t)||{}).locked?1:0); // v1.0.2: Browser Dock tidak dibuat ulang saat kunci berganti; keadaan dibaca ulang tiap dimuat dan berubah lewat pushDockLk()
  const go=()=>{if(!c.isDestroyed())c.loadURL(base()+'/?view=ctl&t='+encodeURIComponent(t)+'&prot='+(protect?1:0)+'&lk='+lkNow());};
  srvP.then(go);
  c.webContents.on('did-fail-load',(e,code,d,u)=>{if(code!==-3&&u&&u.startsWith('http://localhost'))setTimeout(go,1000);});
  w.on('move',()=>{if(!w.__dragging)pos();});w.on('resize',pos); // v15.5.4: saat digeser, dragOn sudah memanggil __pos sekali per tick; event 'move' tidak mengulanginya
  w.on('show',()=>{pos();try{if(!c.isDestroyed())c.showInactive();}catch{}});
  w.on('hide',()=>{try{if(!c.isDestroyed())c.hide();}catch{}});
  w.on('closed',()=>{try{if(!c.isDestroyed())c.destroy();}catch{}});
  return c;
}
const posAllCtl=()=>{[main,...[...docks.values()].map(D=>D.win)].forEach(x=>{try{if(x&&!x.isDestroyed()&&x.__pos)x.__pos();}catch{}});};
// ===== alert hadiah TikTok = jendela kecil transparan di LUAR jendela chat =====
// Muncul di sebelah KIRI jendela chat; kalau kiri tidak muat (mepet ujung layar) pindah ke sebelah KANAN. Ikut bergerak bersama jendela chat.
// Jendela ini hanya terlihat selama ada alert (beberapa detik), jadi tidak menghalangi klik / tangkapan layar di waktu lain.
const GAW=320,GAH=600,GAM=6; // v15.3.3: lebih tinggi supaya alert (atas) dan like (bawah) muat; jendela tembus-klik dan hanya tampil selama ada alert
function galertBounds(wb){
  let side='left',x=wb.x-GAW-GAM,y=wb.y;
  try{
    const wa=workAreaOf(wb);
    if(x<wa.x){
      side='right';x=wb.x+wb.width+GAM;
      if(x+GAW>wa.x+wa.width){ // kanan pun tidak muat: pakai sisi yang lebih lega dan tetap di dalam layar
        if(wb.x-wa.x>=wa.x+wa.width-(wb.x+wb.width)){side='left';x=wa.x;}else x=wa.x+wa.width-GAW;
      }
    }
    y=Math.min(Math.max(y,wa.y),wa.y+wa.height-GAH);
  }catch{}
  const off=Math.max(0,wb.y-y),h=Math.max(60,Math.min(wb.height,GAH-off)); // off/h: area di dalam jendela alert yang sejajar dengan jendela chat (like menempel di dasarnya)
  return{x,y,side,off,h};
}
function attachAlert(w,L){
  // v15.4.2: jendela alert TIDAK dibuat saat jendela chat dibuka / digembok (tiap jendela = satu proses tampilan).
  // v15.5.0: tidak ada lagi pemanasan otomatis. Halamannya sekarang mungil (galert.html, ±4 KB), jadi cukup dibuat saat alert pertama datang, lalu DILEPAS
  //   (destroy, proses tampilannya ikut hilang) ALERT_IDLE_MS sesudah alert terakhir selesai. Pengguna yang alert-nya mati tidak pernah membayar RAM jendela ini.
  let c=null;
  const st={ok:false,q:[],side:'left',off:0,h:GAH,hideT:null,poll:null,idleT:null};
  const alive=()=>!!c&&!c.isDestroyed()&&!w.isDestroyed();
  const run=js=>{try{return c.webContents.executeJavaScript(js);}catch{return Promise.resolve();}};
  const sendSide=()=>{if(st.ok&&alive())run('window.__gaside&&window.__gaside('+JSON.stringify(st.side)+','+st.off+','+st.h+')').catch(()=>{});};
  const pos=()=>{try{if(w.isDestroyed()||!c||c.isDestroyed())return;const r=galertBounds(w.getBounds()); // v15.5.4: tanpa jendela alert tidak ada yang perlu dihitung (jendelanya dibuat malas; make() dan push() memanggil pos sendiri)
    if(c&&!c.isDestroyed()){const b=c.getPosition();if(b[0]!==r.x||b[1]!==r.y)c.setPosition(r.x,r.y,false);}
    if(r.side!==st.side||r.off!==st.off||r.h!==st.h){st.side=r.side;st.off=r.off;st.h=r.h;sendSide();}}catch{}};
  // area yang menerima klik: "Sembunyikan dari OBS" aktif = hanya kotak alert (bentuk jendela); tidak aktif = tembus-klik penuh (lihat applyLockedInput)
  const input=()=>{
    if(!alive()||!c.isVisible())return;
    run('window.__garects?window.__garects():[]').then(rs=>{
      if(!alive())return;
      if(useHole()){c.setIgnoreMouseEvents(false);c.setShape(Array.isArray(rs)&&rs.length?rs:[{x:0,y:0,width:1,height:1}]);}
      else{c.setShape([{x:0,y:0,width:GAW,height:GAH}]);c.setIgnoreMouseEvents(true);}
    }).catch(()=>{});
  };
  const release=()=>{clearTimeout(st.idleT);const cc=c;c=null;st.ok=false;st.q.length=0;try{if(cc&&!cc.isDestroyed())cc.destroy();}catch{}};
  const stop=()=>{clearTimeout(st.hideT);clearInterval(st.poll);st.poll=null;try{if(c&&!c.isDestroyed())c.hide();}catch{}clearTimeout(st.idleT);if(c)st.idleT=setTimeout(release,ALERT_IDLE_MS);};
  const make=()=>{
    if(c||w.isDestroyed())return;
    clearTimeout(st.idleT);
    c=new BrowserWindow({width:GAW,height:GAH,useContentSize:true,title:'ChatStream Labs - alert',icon:ICON,frame:false,transparent:true,backgroundColor:'#00000000',hasShadow:false,resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,focusable:false,thickFrame:false,show:false,parent:w,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false}});
    if(L)c.setAlwaysOnTop(true,'screen-saver');
    const cc=c;cc.on('closed',()=>{if(c===cc){c=null;st.ok=false;}});
    const go=()=>{if(!cc.isDestroyed())cc.loadURL(base()+'/?view=galert');};
    srvP.then(go);
    cc.webContents.on('did-fail-load',(e,code,d,u)=>{if(code!==-3&&u&&u.startsWith('http://localhost'))setTimeout(go,1000);});
    cc.webContents.on('did-finish-load',()=>{st.ok=true;sendSide();st.q.splice(0).forEach(push);});
    pos();
  };
  const push=m=>{
    if(w.isDestroyed())return;
    clearTimeout(st.idleT);
    if(!c)make();
    if(!alive())return;
    if(!st.ok){st.q.push(m);if(st.q.length>5)st.q.shift();return;}
    pos();
    try{c.showInactive();}catch{}
    run('window.__ga&&window.__ga('+JSON.stringify(m)+')').catch(()=>{});
    clearTimeout(st.hideT);st.hideT=setTimeout(stop,(Number(m.dur)||6)*1000+1500); // lama alert dari pengaturan Dock (bawaan 6 dtk) + 0,45 dtk memudar
    if(!st.poll&&useHole())st.poll=setInterval(input,400); // v15.5.0: tanpa mode lubang bentuk jendela tidak berubah, cukup diatur sekali
    setTimeout(input,60);
  };
  const prevPos=w.__pos;w.__pos=()=>{if(prevPos)prevPos();pos();};
  w.__galert=push;pos();
  w.on('move',()=>{if(!w.__dragging)pos();});w.on('resize',pos); // v15.5.4: saat digeser, dragOn sudah memanggil __pos sekali per tick; event 'move' tidak mengulanginya
  w.on('hide',stop);w.on('minimize',stop);
  w.on('closed',()=>{clearTimeout(st.idleT);clearTimeout(st.hideT);clearInterval(st.poll);try{if(c&&!c.isDestroyed())c.destroy();}catch{}});
}
const ALERT_IDLE_MS=45000; // v15.5.0: jendela alert dilepas segini lama sesudah alert terakhir selesai (lihat attachAlert)
// dipanggil server (POST /galert) tiap ada hadiah TikTok yang lolos pengaturan dock; hanya tampil kalau jendela chat sedang terlihat
function galertPush(m){try{if(main&&!main.isDestroyed()&&main.__galert&&main.isVisible()&&!main.isMinimized())main.__galert(m);}catch{}}
// v15.5.5: selama jendela chat digeser halaman dock berhenti menggambar chat (window.__pause di app.js; chat tetap ditampung dan menyusul begitu dilepas). Saat live ramai, geser memaksa
//   jendela transparan digambar ulang di posisi baru TIAP tick 16 ms sementara halamannya juga membangun baris chat baru, dan keduanya berebut waktu.
const pausePage=(w,on)=>{try{const c=w&&!w.isDestroyed()&&(w.__view||w).webContents;if(c&&!c.isDestroyed())c.executeJavaScript('window.__pause&&window.__pause('+(on?'true':'false')+')').catch(()=>{});}catch{}}; // v15.5.6: halaman chat ada di WebContentsView (w.__view), BUKAN w.webContents; sebelumnya perintah ini jatuh ke halaman kosong jendela, jadi jeda saat geser (v15.5.5) tidak pernah bekerja
function dragOn(on){
  if(!on){if(dragT){clearInterval(dragT);dragT=null;try{if(main&&!main.isDestroyed())main.__dragging=false;}catch{}pausePage(main,false);if(main&&!main.isDestroyed())saveB({outer:main.getBounds()});}return;}
  if(dragT||!main||main.isDestroyed())return;
  const c0=screen.getCursorScreenPoint(),m0=main.getBounds(),t0=Date.now();main.__dragging=true;pausePage(main,true);
  dragT=setInterval(()=>{
    if(!main||main.isDestroyed()){clearInterval(dragT);dragT=null;return;}
    const c=screen.getCursorScreenPoint();
    main.setPosition(m0.x+c.x-c0.x,m0.y+c.y-c0.y);if(main.__pos)main.__pos();
    if(Date.now()-t0>25000)dragOn(false);
  },16);
}
// v15.6.1: ubah ukuran jendela chat yang TIDAK terpin. Jendela transparan tanpa bingkai tidak bisa di-resize lewat tepinya di Windows (jebakan 5), jadi halaman memasang pegangan di tepi dan sudut
// (#rz di app.js, hanya tampil saat tidak terpin) dan main.js mengikuti kursor lewat setBounds, sama seperti dragOn mengikuti kursor lewat setPosition. Jendela TIDAK dibuat ulang.
// edge = n|s|e|w|ne|nw|se|sw. Sisi yang berlawanan dengan yang ditarik tetap diam. Ukuran minimum RZ_MINW x RZ_MINH.
// v15.6.3: sisi BAWAH (s, se, sw) boleh lagi (permintaan pemilik: hanya sisi bawah yang tidak bisa ditarik). Bulatan chat + filter ada di dasar jendela halaman dan ikut bergeser bersama dasar.
const RZ_MINW=300,RZ_MINH=300;
function resizeOn(on,edge){
  if(!on){if(rzT){clearInterval(rzT);rzT=null;try{if(main&&!main.isDestroyed())main.__dragging=false;}catch{}pausePage(main,false);if(main&&!main.isDestroyed())saveB({outer:main.getBounds()});}return;}
  const E=String(edge||'');
  if(rzT||!main||main.isDestroyed()||locked||!/^(n|s|e|w|ne|nw|se|sw)$/.test(E))return;
  dragOn(false);
  const w=main,c0=screen.getCursorScreenPoint(),m0=w.getBounds(),t0=Date.now();w.__dragging=true;pausePage(w,true);
  rzT=setInterval(()=>{
    if(!main||main.isDestroyed()||main!==w||locked){resizeOn(false);return;}
    const c=screen.getCursorScreenPoint(),dx=c.x-c0.x,dy=c.y-c0.y;
    let wd=m0.width,ht=m0.height;
    if(E.includes('e'))wd=m0.width+dx;else if(E.includes('w'))wd=m0.width-dx;
    if(E.includes('n'))ht=m0.height-dy;else if(E.includes('s'))ht=m0.height+dy;
    wd=Math.max(RZ_MINW,Math.round(wd));ht=Math.max(RZ_MINH,Math.round(ht));
    const x=E.includes('w')?m0.x+m0.width-wd:m0.x,y=E.includes('n')?m0.y+m0.height-ht:m0.y,b=w.getBounds();
    if(b.x!==x||b.y!==y||b.width!==wd||b.height!==ht){
      w.setBounds({x,y,width:wd,height:ht});
      if(w.__fit)w.__fit();
      setShpIf(w,[{x:0,y:0,width:wd,height:ht}]); // bentuk jendela = seluruh area; kalau tidak ikut membesar, setShape memotong tampilan (lihat bagian 27)
    }
    if(Date.now()-t0>25000)resizeOn(false);
  },16);
}
// ===== jendela utama =====
// Jendela transparan yang tembus-klik (setIgnoreMouseEvents) tidak bisa disembunyikan Windows dari tangkapan layar.
// Jadi saat "Sembunyikan dari OBS" aktif, jendela tidak dibuat tembus-klik; hanya area gelembung chat yang menerima klik
// (setShape), sisanya diteruskan ke game. Saat tidak disembunyikan, jendela tembus-klik penuh.
// v15.1.2: setIgn / setShp hanya menyentuh jendela kalau nilainya benar-benar berubah. Di Windows, setIgnoreMouseEvents(false) mencabut gaya WS_EX_LAYERED jendela transparan;
// kalau dipanggil berulang (tiap ketukan timer) itu menjadi penyebab utama kedip. setShp(..., true) juga melewati setShape yang bentuknya sama dengan yang terakhir.
const ignC=new WeakMap(),shpC=new WeakMap();
const setIgn=(w,on,fwd)=>{try{if(!w||w.isDestroyed())return;on=!!on;if(ignC.get(w)===on)return;if(on&&fwd)w.setIgnoreMouseEvents(true,{forward:true});else w.setIgnoreMouseEvents(on);ignC.set(w,on);}catch{}};
const setShp=(w,rs,skipSame)=>{const k=JSON.stringify(rs);if(skipSame&&shpC.get(w)===k)return;w.setShape(rs);shpC.set(w,k);};
// v15.6.4: jendela chat tidak pernah diberi bentuk (hanya menyamai seluruh area, tidak ada yang dipotong). setShape = SetWindowRgn pada jendela transparan: DWM harus memotong tiap frame dan menggambar ulang jendelanya,
//   dan itu terjadi tepat saat dibuka / di-pin / ditarik ukurannya. Cukup perbarui bentuk kalau jendela itu memang pernah diberi bentuk.
const setShpIf=(w,rs)=>{if(shpC.has(w))setShp(w,rs,true);};
// ===== klik menembus gelembung chat (mode gembok + "Sembunyikan dari OBS") =====
// Saat disembunyikan dari OBS jendela TIDAK tembus-klik (lihat atas), jadi area gelembung / kotak penonton menangkap klik dan game di belakangnya tidak kena.
// Solusi: kalau kursor ada di atas salah satu area, dibuat lubang kecil (HOLE px) pada bentuk jendela (setShape), tepat di ujung kursor.
// Lubang itu tembus-klik dan tertutup gambar kursor, jadi klik jatuh ke jendela/game di belakangnya, sedangkan gelembung tetap terlihat dan tetap tersembunyi dari OBS.
// v15.1.1: lubang memanjang ke kanan-bawah dari titik kursor (bukan simetris), karena badan panah kursor ada di sisi itu, jadi titiknya tertutup.
// v15.1.2: lubang IKUT kursor terus (HOLE_WAIT=0), supaya klik tembus juga saat kursor sedang digerakkan. (v15.1.1 menunggu kursor diam dulu, dan itu terasa seperti fitur hilang.)
//   Kedip dikurangi dengan setIgn/setShp yang tidak menyentuh jendela kalau tidak ada perubahan, bukan dengan menunda lubang.
// Pengaturan: HOLE = ukuran lubang px (0 mematikan seluruh fitur; naikkan kalau klik kadang tidak tembus, turunkan kalau titiknya kelihatan),
//   HOLE_WAIT = jumlah tick kursor harus diam sebelum lubang dibuat (0 = ikut terus; 2 = gaya v15.1.1, tanpa kedip tapi tembus-klik hanya saat kursor diam), HOLE_MS = jeda tick.
// v15.1.3: HOLE_MS=0 = tanpa jeda buatan (setInterval 0 dibulatkan Node jadi ~1 ms, itu batas terkecilnya), supaya klik ke jendela di belakang dock langsung responsif.
// v15.1.4: lubang dibuat lebih besar (HOLE x HOLE) dengan kursor di dalamnya (HOLE_BACK px dari sisi kiri/atas), dan BARU dipindah kalau kursor mendekati tepi lubang (histeresis).
//   Sebelumnya lubang 3 px dipindah tiap kursor bergeser 1 px, jadi gerak pelan = setShape terus-menerus = kedip, dan kursor sering keluar dari lubang sedetik (ikon di belakang kehilangan hover = kedip).
//   Polling adaptif: HOLE_MS (cepat) hanya saat kursor di atas jendela; di luar jendela HOLE_IDLE_MS (lambat). Tidak ada lagi setInterval 0 ms.
// v15.1.5: lubang lebih besar dan lebih "sabar" supaya tidak tertinggal dari kursor: HOLE 10 px, kursor 4 px dari sisi kiri/atas (HOLE_BACK),
//   lubang dipindah LEBIH AWAL, yaitu saat kursor tinggal HOLE_EDGE (2) px dari tepi (dulu 1 px), jadi kursor tidak sempat keluar lubang waktu digerakkan cepat.
//   Lubang itu bukan elemen halaman, tetapi potongan pada bentuk jendela (setShape), jadi opacity tidak berlaku: yang terlihat adalah isi layar di belakang jendela.
const HOLE=10,HOLE_BACK=4,HOLE_EDGE=2,HOLE_WAIT=0,HOLE_MS=8,HOLE_IDLE_MS=60;
function carve(rects,hx1,hy1){
  const hx2=hx1+HOLE,hy2=hy1+HOLE,out=[];
  for(const q of rects){
    const x1=q.x,y1=q.y,x2=q.x+q.width,y2=q.y+q.height;
    if(hx2<=x1||hx1>=x2||hy2<=y1||hy1>=y2){out.push(q);continue;}
    if(hy1>y1)out.push({x:x1,y:y1,width:q.width,height:hy1-y1});
    if(hy2<y2)out.push({x:x1,y:hy2,width:q.width,height:y2-hy2});
    const my1=Math.max(y1,hy1),my2=Math.min(y2,hy2);
    if(hx1>x1)out.push({x:x1,y:my1,width:hx1-x1,height:my2-my1});
    if(hx2<x2)out.push({x:hx2,y:my1,width:x2-hx2,height:my2-my1});
  }
  return out;
}
// kursor relatif terhadap isi jendela, atau null kalau di luar
function curIn(w){
  try{const c=screen.getCursorScreenPoint(),b=w.getContentBounds(),x=c.x-b.x,y=c.y-b.y;return(x>=0&&y>=0&&x<b.width&&y<b.height)?{x,y}:null;}catch{return null;}
}
let holeT=null;
const holeAt=new WeakMap(); // jendela -> {x,y} pojok kiri-atas lubang yang sedang terpasang, atau tidak ada
const inAny=(rs,c)=>!!c&&(rs||[]).some(q=>c.x>=q.x&&c.x<q.x+q.width&&c.y>=q.y&&c.y<q.y+q.height);
// posisi lubang untuk kursor c: tetap di tempat selama kursor masih di zona aman di dalam lubang lama; pindah hanya kalau kursor mendekati tepi
function holeFor(w,c,on){
  const cur=holeAt.get(w);
  if(!on){if(cur){holeAt.delete(w);return true;}return false;} // keluar dari area: hapus lubang sekali
  if(cur&&c.x>=cur.x+HOLE_EDGE&&c.x<cur.x+HOLE-HOLE_EDGE&&c.y>=cur.y+HOLE_EDGE&&c.y<cur.y+HOLE-HOLE_EDGE)return false; // masih aman: jangan sentuh bentuk jendela
  holeAt.set(w,{x:c.x-HOLE_BACK,y:c.y-HOLE_BACK});return true;
}
function holeStop(){if(holeT){clearTimeout(holeT);holeT=null;}}
function holeTick(){
  holeT=null;
  const chatOn=false, // v15.6.0: chat terpin selalu memakai cara kursor-di-atas-tombol (lsApply); lubang di kursor hanya untuk Donate Dock
    dockOn=useHole()&&[...docks.values()].some(D=>D.locked&&donOpen(D));
  if(!HOLE||(!chatOn&&!dockOn))return; // tidak perlu polling sama sekali (dimulai lagi lewat holeStart)
  let changed=false,near=false;
  if(chatOn){const c=curIn(main);if(c)near=true;if(holeFor(main,c,inAny(lastRects,c)))changed=true;}
  docks.forEach(D=>{if(D.locked&&donOpen(D)){const c=curIn(D.win);if(c)near=true;if(holeFor(D.win,c,inAny(D.rects,c))){changed=true;applyDockInput(D,true);}}});
  
  holeT=setTimeout(holeTick,near?HOLE_MS:HOLE_IDLE_MS); // cepat hanya saat kursor di atas jendela; selain itu hemat CPU
}
function holeStart(){if(HOLE&&!holeT)holeT=setTimeout(holeTick,HOLE_MS);}
// v15.3.7: scroll saat gembok tanpa menghalangi klik. setShape memotong TAMPILAN jendela (bukan cuma area klik), jadi gelembung tidak boleh dikeluarkan dari bentuk.
// Gantinya: jendela tembus-klik (forward) dan baru menerima input selama kursor di atas kotak aktif (lastRects = strip scroll + kotak penonton).
// v15.3.8: roda mouse global (Windows) supaya chat bisa di-scroll di mana saja di atas chat TANPA menghalangi klik.
// Proses PowerShell kecil memasang hook mouse tingkat rendah (WH_MOUSE_LL). Kalau kursor ada di dalam area chat yang bisa di-scroll, roda mouse DITELAN
// (game di belakang tidak ikut ter-scroll) dan deltanya dikirim ke sini ("W <delta>"), lalu halaman menggeser #list. Area chat dikirim ke proses itu ("R x y w h", piksel layar fisik; "X" = nonaktif).
// Tanpa dependensi npm (workflow memakai npm ci). Gagal start/kompilasi -> tidak ada "READY" -> halaman tetap memakai strip scroll sebagai cadangan.
const HK_CS=`
using System;using System.Runtime.InteropServices;using System.Diagnostics;using System.Threading;
public class WH{
 delegate IntPtr P(int n,IntPtr w,IntPtr l);
 [StructLayout(LayoutKind.Sequential)]struct PT{public int x,y;}
 [StructLayout(LayoutKind.Sequential)]struct MS{public PT pt;public uint data,flags,time;public IntPtr extra;}
 [StructLayout(LayoutKind.Sequential)]struct MSG{public IntPtr h;public uint m;public IntPtr w,l;public uint t;public PT pt;}
 [DllImport("user32.dll")]static extern IntPtr SetWindowsHookEx(int id,P p,IntPtr m,uint t);
 [DllImport("user32.dll")]static extern IntPtr CallNextHookEx(IntPtr h,int n,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]static extern int GetMessage(out MSG m,IntPtr h,uint a,uint b);
 [DllImport("user32.dll")]static extern bool SetProcessDPIAware();
 [DllImport("kernel32.dll")]static extern IntPtr GetModuleHandle(string n);
 static volatile int rx,ry,rw,rh;static volatile bool on;
 static P proc=Hook;static IntPtr hh;
 static IntPtr Hook(int n,IntPtr w,IntPtr l){
  if(n>=0&&w.ToInt32()==0x020A&&on){
   MS s=(MS)Marshal.PtrToStructure(l,typeof(MS));
   if(s.pt.x>=rx&&s.pt.x<rx+rw&&s.pt.y>=ry&&s.pt.y<ry+rh){
    short d=unchecked((short)(s.data>>16));
    Console.Out.WriteLine("W "+d);Console.Out.Flush();
    return (IntPtr)1;
   }
  }
  return CallNextHookEx(hh,n,w,l);
 }
 public static void Run(){
  SetProcessDPIAware();
  Thread t=new Thread(delegate(){
   string ln;
   while((ln=Console.In.ReadLine())!=null){
    string[] a=ln.Trim().Split(' ');
    if(a[0]=="R"&&a.Length==5){rx=int.Parse(a[1]);ry=int.Parse(a[2]);rw=int.Parse(a[3]);rh=int.Parse(a[4]);on=true;}
    else if(a[0]=="X"||a[0]=="Q"){on=false;if(a[0]=="Q")break;}
   }
   Environment.Exit(0);
  });
  t.IsBackground=true;t.Start();
  hh=SetWindowsHookEx(14,proc,GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName),0);
  Console.Out.WriteLine(hh==IntPtr.Zero?"FAIL":"READY");Console.Out.Flush();
  MSG m;while(GetMessage(out m,IntPtr.Zero,0,0)>0){}
 }
}`;
const HK_PS="Add-Type -TypeDefinition @'\n"+HK_CS+"\n'@\n[WH]::Run()\n";
let hk=null,hkReady=false,hkSent='',hkPushed=new WeakMap();
let hkDelayT=null;const HK_DELAY=1200; // v15.5.1: hook roda baru dijalankan HK_DELAY ms sesudah menggembok (lihat lsStart)
const hkWC=()=>{const w=main;if(!w||w.isDestroyed())return null;const c=(w.__view||w).webContents;return c&&!c.isDestroyed()?c:null;}; // v15.4.1: halaman chat ada di WebContentsView (main.__view), bukan main.webContents
const hkPage=on=>{try{const c=hkWC();if(c)c.executeJavaScript('window.__lkHook&&window.__lkHook('+(on?'true':'false')+')').catch(()=>{});}catch{}};
function hkStart(){
  if(hk||process.platform!=='win32')return;
  try{
    const enc=Buffer.from(HK_PS,'utf16le').toString('base64');
    const c=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',enc],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    hk=c;let buf='';
    try{const os=require('os');os.setPriority(c.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{} // v15.4.2: kompilasi Add-Type (1-3 dtk, CPU penuh) tidak boleh merebut CPU dari chat/game saat baru menggembok
    c.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const ln=buf.slice(0,i).trim();buf=buf.slice(i+1);
      if(ln==='READY'){hkReady=true;log('hook roda: siap');try{const os=require('os');os.setPriority(c.pid,os.constants.priority.PRIORITY_NORMAL);}catch{}} // v15.6.3: hook mouse tingkat rendah di proses berprioritas rendah = SEMUA gerakan kursor menunggu proses itu mendapat CPU; prioritas rendah hanya untuk masa kompilasi
      else if(ln==='FAIL')log('hook roda: SetWindowsHookEx gagal');
      else if(ln.startsWith('W ')){const d2=parseInt(ln.slice(2),10)||0;try{const c=hkWC();if(c)c.executeJavaScript('window.__lkWheel&&window.__lkWheel('+d2+')').catch(()=>{});}catch{}}}});
    c.stderr.on('data',d=>log('hook roda: '+String(d).replace(/\s+/g,' ').slice(0,300)));
    c.stdin.on('error',()=>{});
    c.on('error',e=>{log('hook roda gagal: '+(e&&e.message||e));});
    c.on('exit',()=>{if(hk===c){hk=null;hkReady=false;hkSent='';hkPushed=new WeakMap();hkPage(false);}});
  }catch(e){log('hook roda gagal: '+(e&&e.message||e));hk=null;}
}
function hkStop(){
  clearTimeout(hkDelayT);hkDelayT=null;
  const c=hk;if(!c)return;hk=null;hkReady=false;hkSent='';hkPushed=new WeakMap();
  try{c.stdin.write('Q\n');}catch{}try{c.kill();}catch{}
  hkPage(false);
}
function hkSync(){ // dipanggil tiap lsTick: kirim area chat (piksel layar fisik) ke proses hook + beri tahu halaman bahwa hook aktif
  if(!hk||!hkReady||!main||main.isDestroyed())return;
  if(!hkPushed.get(main)){const w=main,c=hkWC();if(c){hkPushed.set(w,1);c.executeJavaScript('!!(window.__lkHook&&(window.__lkHook(true),1))').then(ok=>{if(!ok)hkPushed.delete(w);}).catch(()=>hkPushed.delete(w));}}
  let line='X';const L=lastList;
  try{
    if(L&&L.width>0&&L.height>0&&main.isVisible()){
      const cb=main.getContentBounds();let r={x:Math.round(cb.x+L.x),y:Math.round(cb.y+L.y),width:Math.round(L.width),height:Math.round(L.height)};
      try{r=screen.dipToScreenRect(main,r);}catch{}
      line='R '+r.x+' '+r.y+' '+r.width+' '+r.height;
    }
  }catch{}
  if(line!==hkSent){hkSent=line;try{hk.stdin.write(line+'\n');}catch{}}
}
let lsT=null;
// v15.6.3: TANPA {forward:true}. Di Windows forward:true membuat Electron memasang hook mouse global (WH_MOUSE_LL) yang dijalankan di thread UI proses utama; selama proses utama sibuk (server, SSE, konektor cadangan)
//   SEMUA gerakan kursor di sistem ikut tertahan = "cursor berat" begitu dock chat dibuka. Forward tidak diperlukan: lsTick sudah mengecek kursor sendiri dan membuka input begitu kursor masuk ke kotak aktif.
function lsApply(){try{if(!main||main.isDestroyed())return 0;const c=curIn(main);setIgn(main,!inAny(lastRects,c));return c?1:0;}catch{return 0;}}
function lsTick(){lsT=null;if(!locked||!main||main.isDestroyed()){hkStop();return;}const near=lsApply();if(lockScroll)hkSync();else hkStop();lsT=setTimeout(lsTick,near?33:70);} // v15.6.0: berjalan SELAMA chat terpin (bukan hanya saat lockScroll): tombol bilah kontrol ada di dalam jendela tembus-klik; hook roda hanya untuk lockScroll // v15.5.0: 16/80 ms -> 33/120 ms (dulu CPU tidak pernah sempat tidur saat chat digembok + scroll)
// v1.1.1: hook roda (PowerShell + kompilasi C#) TIDAK lagi dimulai pada timer tetap sejak digembok. Saat boot dingin, powershell.exe + csc.exe pertama kali jalan sangat lambat dan berebut CPU/disk
//   persis ketika jendela chat dan jendela tombol sedang dibuat. Sesudah HK_DELAY, hkWait menunggu jendela tombol selesai dibuat (w.__ctlMade, lihat makeMain), baru hook dimulai; cadangan 15 dtk.
function hkWait(t0){
  const w=main;
  if(w&&!w.isDestroyed()&&!w.__ctlMade&&Date.now()-t0<15000){hkDelayT=setTimeout(()=>{hkDelayT=null;if(locked&&lockScroll)hkWait(t0);},500);return;}
  hkStart();
}
function lsStart(){if(lockScroll&&!hk&&!hkDelayT)hkDelayT=setTimeout(()=>{hkDelayT=null;if(locked&&lockScroll)hkWait(Date.now());},HK_DELAY);if(!lsT)lsT=setTimeout(lsTick,16);}
function applyLockedInput(){
  if(!locked||!main||main.isDestroyed())return;
  try{
    // v15.6.0: jendela chat terpin TAMPIL penuh (bentuk jendela = seluruh area, supaya sudut membulat dan gelembung tidak terpotong) dan tembus-klik.
    // Hanya saat kursor ada di atas kotak aktif (tombol bilah kontrol + kolom ketik, dan kalau lockScroll: strip scroll + "Chat terbaru"; semuanya dari /shape) jendela menerima input. Diatur lsTick.
    // Cara lubang di kursor (PROTECT_PASSTHRU=false) tidak dipakai lagi untuk chat karena tombolnya sekarang ada di dalam jendela ini.
    const b=main.getBounds();
    setShpIf(main,[{x:0,y:0,width:b.width,height:b.height}]);
    lsApply();lsStart();
  }catch{}
}
// v15.6.0: kolom ketik di jendela chat terpin. Jendela terpin tidak bisa difokus (focusable:false) supaya keyboard tetap ke game;
// selama kolom ketik terbuka jendelanya dibuat bisa difokus (dan difokuskan), begitu kolom ditutup dikembalikan. Jendela tidak terpin (biasa) tidak perlu diubah.
function chatFocus(on){
  const w=main;if(!w||w.isDestroyed())return;
  try{
    if(on){if(locked)w.setFocusable(true);w.focus();try{w.__view.webContents.focus();}catch{}}
    else if(locked){try{w.blur();}catch{}w.setFocusable(false);}
  }catch{}
}
function applyLockedInputSoon(w){[0,300,1200].forEach(t=>setTimeout(()=>{if(main===w)applyLockedInput();},t));}
const showWin=(w,asLocked)=>{if(!w||w.isDestroyed())return;if(asLocked)w.showInactive();else w.show();};
// pengaman: kalau halaman belum siap (blank), muat ulang sampai 4 kali
function watchLoad(w,go,wc){ // wc = webContents yang dipantau (default: milik jendela itu sendiri)
  let tries=0;const t=setInterval(async()=>{
    if(w.isDestroyed()||(wc&&wc.isDestroyed())){clearInterval(t);return;}
    let ok=false;try{ok=await (wc||w.webContents).executeJavaScript('window.__ready===true');}catch{}
    if(ok){clearInterval(t);return;}
    try{if((wc||w.webContents).isLoading())return;}catch{} // v1.1.1: masih memuat (boot dingin lambat) = jangan diulang dari awal; itu menggandakan beban justru saat komputer paling sibuk
    if(++tries>4){clearInterval(t);log('halaman tidak siap setelah 4 kali percobaan');return;}
    log('halaman belum siap, muat ulang ('+tries+')');go();
  },6000);
}
function makeMain(bounds){
  const b=bounds||readJ(BF).outer||{};
  // v15.6.1: SATU jenis jendela saja: transparan, tanpa bingkai, selalu di atas (dulu ada juga jendela biasa berlatar untuk keadaan tidak terpin).
  //   Pin / lepas pin hanya mengubah perilaku jendela yang sama (setLock): klik tembus vs menerima klik + bisa di-resize. Jendela dibuat selalu dalam keadaan terpin (openChat), jadi tidak bisa difokus.
  const o={x:b.x,y:b.y,width:b.width||460,height:b.height||800,title:'ChatStream Labs',icon:ICON,minWidth:RZ_MINW,minHeight:RZ_MINH,show:false,skipTaskbar:true,webPreferences:{spellcheck:false},
    frame:false,transparent:true,backgroundColor:'#00000000',hasShadow:false,alwaysOnTop:true,resizable:false,focusable:false,thickFrame:false};
  mark('chat: buat jendela');const w=new BrowserWindow(o);mark('chat: jendela jadi');
  w.setAlwaysOnTop(true,'screen-saver');mark('chat: alwaysOnTop');
  // seperti Donate Dock: jendela hanya wadah, halaman chat ada di WebContentsView yang memenuhi isi jendela
  const v=new WebContentsView({webPreferences:{spellcheck:false}});
  v.setBackgroundColor('#00000000');
  w.contentView.addChildView(v);w.__view=v;
  const wc=v.webContents;
  const fit=()=>{if(w.isDestroyed())return;const [cw,ch]=w.getContentSize();v.setBounds({x:0,y:0,width:cw,height:ch});};
  fit();w.on('resize',fit);w.__fit=fit;
  // v15.6.2: mata, pin, pindah, tutup = jendela kecil di LUAR jendela chat (attachCtl, ?view=ctl&t=chat; posisinya mengikuti pengaturan "Posisi tombol Chat Dock").
  //   Hanya bulatan chat + bulatan filter yang ada DI DALAM jendela chat (#cbar di app.js, kanan bawah). (v15.6.0 sempat memasukkan semua tombol ke dalam jendela; pemilik minta dikeluarkan lagi.)
  //   attachCtl harus sebelum attachAlert (attachAlert membungkus w.__pos). (v15.6.4: keduanya dibuat 150 ms setelah showWin; lihat di bawah.)
  // v15.6.4: attachCtl/attachAlert TIDAK lagi dibuat serentak dengan jendela chat. Membuat dua jendela transparan selalu-di-atas beruntun di thread UI proses utama menahan Dashboard ("Not Responding");
  //   jendela tombol dibuat 150 ms sesudah jendela chat tampil. attachCtl harus tetap sebelum attachAlert (attachAlert membungkus w.__pos); karena 'show' sudah lewat, jendela tombol ditampilkan manual.
  // v1.1.1: Not Responding saat dock dibuka PERTAMA KALI sesudah PC menyala. Timer tetap 150 ms (v15.6.4) hanya menyebar beban di komputer yang sudah hangat; saat boot dingin (disk sibuk, antivirus memindai,
  //   aplikasi startup lain berebut CPU) pembuatan jendela chat, proses tampilannya, jendela tombol, dan jendela alert tetap tumpang tindih di thread UI yang sama. Sekarang berurutan berdasarkan KEJADIAN, bukan waktu:
  //   jendela tombol + alert baru dibuat setelah halaman chat selesai dimuat (cadangan 15 dtk kalau halaman tidak pernah selesai). Hook roda (lsStart) menunggu jendela tombol ini.
  let ctlMade=false;
  const mkCtl=()=>{if(ctlMade||w.isDestroyed())return;ctlMade=true;mark('ctl');attachCtl(w,'chat',true);attachAlert(w,true);w.__ctlMade=true;try{const c=w.__ctl;if(c&&!c.isDestroyed()&&w.isVisible()){if(w.__pos)w.__pos();c.showInactive();}}catch{}mark('ctl selesai');};
  wc.once('did-finish-load',()=>setTimeout(mkCtl,300));
  setTimeout(mkCtl,15000);
  mark('makeMain');
  const go=()=>{if(!w.isDestroyed()&&!wc.isDestroyed())wc.loadURL(base()+'/?view=dock&locked=1'+(locked?'&pin=1':'')).catch(()=>{});}; // locked=1: tampilan jendela chat; pin=1: keadaan pin saat dimuat (dibaca ulang tiap dimuat ulang)
  mark('chat: tampil');showWin(w,locked);mark('chat: tampil selesai');if(locked)applyLockedInputSoon(w);
  srvP.then(()=>{go();watchLoad(w,go,wc);});
  wc.on('did-finish-load',()=>prot(w));
  w.on('restore',()=>repaint(w));w.on('show',()=>repaint(w));
  wc.on('did-fail-load',(e,c,d,u)=>{if(c!==-3&&u&&u.startsWith('http://localhost'))setTimeout(go,1000);});
  wc.on('render-process-gone',()=>{log('proses tampilan berhenti, memuat ulang');setTimeout(go,500);});
  wc.on('console-message',(...a)=>{const e=a[0],lv=(e&&e.level!==undefined)?e.level:a[1],msg=(e&&e.message)||a[2];if(lv===3||lv==='error')log('tampilan: '+msg);});
  const keep=()=>{if(!w.isDestroyed()&&!w.isMinimized())saveB({outer:w.getBounds()});};
  w.on('moved',keep);w.on('resized',keep);
  // menutup jendela chat tidak menutup aplikasi (Dashboard tetap ada)
  w.on('closed',()=>{
    try{if(!wc.isDestroyed())wc.close();}catch{} // WebContentsView tidak ikut tertutup bersama jendelanya: tutup manual supaya prosesnya lepas
    if(main===w){main=null;locked=false;dragOn(false);resizeOn(false);if(tray)tray.setContextMenu(trayMenu());}});
  main=w;
  return w;
}
// v15.6.1: pin / lepas pin terjadi DI JENDELA YANG SAMA. Dulu setLock membuat jendela baru (jendela transparan tidak bisa di-resize / berubah mode, jebakan 5) lalu menukar dengan jendela lama
// (retireOld, HANDOVER_MAX, makeMain(bounds,quiet), setOpacity(0)); itu sumber freeze/layar kosong di bagian 33-38 dan kini dihapus. Sekarang:
//   pin       = tembus klik (hanya tombol bilah kontrol yang menerima klik, lihat applyLockedInput), tidak bisa difokus, tanpa pegangan resize;
//   lepas pin = jendela menerima klik di seluruh area, bisa difokus, halaman menampilkan bingkai tipis + pegangan di tepi/sudut (resizeOn) dan tombol pindah (dragOn).
const pageJS=(w,js)=>{try{const c=w&&!w.isDestroyed()&&(w.__view||w).webContents;if(c&&!c.isDestroyed())c.executeJavaScript(js).catch(()=>{});}catch{}}; // halaman chat ada di WebContentsView (w.__view), BUKAN w.webContents (lihat pausePage)
function setLock(on){
  on=!!on;mark('pin: '+(on?'nyala':'mati'));
  if(!appReady)return;
  if(!main||main.isDestroyed()){if(on)openChat();return;} // openChat membuka jendela dalam keadaan di-pin
  if(on===locked)return;
  const w=main;
  if(w.isMinimized())w.restore();
  dragOn(false);resizeOn(false);
  locked=on; // lastRects/lastList sengaja TIDAK dikosongkan: halaman terus melaporkan area tombol walau tidak terpin, dan hanya melapor ulang kalau berubah
  try{
    if(on){
      w.setFocusable(false);
      pageJS(w,'window.__pin&&window.__pin(true)');
      applyLockedInput();
    }else{
      hkStop();
      setIgn(w,false);
      const b=w.getBounds();setShpIf(w,[{x:0,y:0,width:b.width,height:b.height}]);
      w.setFocusable(true);
      pageJS(w,'window.__pin&&window.__pin(false)');
    }
  }catch(e){log('pin: '+(e&&e.message||e));}
  pushPin();
  saveB({outer:w.getBounds()});
  if(tray)tray.setContextMenu(trayMenu());
}
async function askQuit(){
  if(quitting||asking)return;asking=true;
  try{
    const parent=(dash&&!dash.isDestroyed()&&dash.isVisible())?dash:undefined;
    const r=await dialog.showMessageBox(parent,{type:'question',buttons:['Keluar','Batal'],defaultId:1,cancelId:1,noLink:true,title:'Keluar',message:'Keluar dari ChatStream Labs?'});
    if(r.response===0){quitting=true;app.quit();}
  }finally{asking=false;}
}
const trayMenu=()=>Menu.buildFromTemplate([
  {label:'Buka Dashboard',click:()=>showDash()},
  {label:'Buka Chat',click:()=>openChat()},
  {label:[...docks.values()].some(d=>donOpen(d)&&d.win.isVisible())?'Tutup Browser Dock':'Buka Browser Dock',click:()=>donateAct('toggle')},
  {label:locked?'Lepas pin jendela chat':'Pin jendela chat',click:()=>setLock(!locked)},
  {label:'Laporan penonton',click:()=>openReport()},
  {label:'Pengaturan',click:()=>openSettings()},
  {type:'separator'},{label:'Keluar',click:()=>askQuit()}]);
const wins={};
function openWin(url,opt){
  const isPrevWin=/preview=1/.test(url),vm=url.match(/view=(\w+)/),key=vm?vm[1]:'win';
  if(wins[key]&&!wins[key].isDestroyed()&&!isPrevWin)wins[key].destroy();
  const w=new BrowserWindow({width:520,height:820,autoHideMenuBar:true,backgroundColor:'#0e1214',icon:ICON,frame:isPrevWin,...opt});
  w.setMenuBarVisibility(false);w.loadURL(url.startsWith('http')?url:base()+url);
  if(!isPrevWin){wins[key]=w;w.on('closed',()=>{if(wins[key]===w)delete wins[key];});}
  return w;
}
function winCtl(which,act){
  const w=which==='main'?main:which==='dash'?dash:String(which).startsWith('donate:')?(docks.get(String(which).slice(7))||{}).win:wins[which];if(!w||w.isDestroyed())return;
  if(act==='min'){if(which==='dash'||which==='main')w.hide();else w.minimize();} // Dashboard/Chat: langsung sembunyi ke tray (tanpa status 'minimized', yang bikin jendela macet saat dibuka lagi)
  else if(act==='max'){if(w.isMaximized())w.unmaximize();else w.maximize();}
  else if(act==='close'){if(which==='dash')askQuit();else w.close();}
  else if(act==='reload'){try{(w.__view||w).webContents.reload();}catch{}}
}
// Laporan penonton = tab di dalam Dashboard (bukan jendela baru)
function openReport(){
  showDash();
  const w=dash,t0=Date.now();
  const tryGo=async()=>{
    if(!w||w.isDestroyed())return;
    let ok=false;try{ok=await w.webContents.executeJavaScript('window.__ready===true');}catch{}
    if(!ok){if(Date.now()-t0<10000)setTimeout(tryGo,250);return;}
    try{await w.webContents.executeJavaScript("window.__goTab&&window.__goTab('r')");}catch{}
  };
  tryGo();
}
// Pengaturan sekarang ada di Dashboard
function openSettings(){showDash();}
function showDash(){
  if(!appReady||!dash||dash.isDestroyed())return;
  if(dash.__susp){dash.__susp=false;if(dash.__go)dash.__go();} // halaman sempat dikosongkan untuk hemat RAM: muat lagi
  if(dash.isMinimized())dash.restore();
  if(!dash.isVisible())dash.show();
  dash.focus();dash.moveTop();
  try{dash.webContents.focus();}catch{}
}
// jendela chat (dulu jendela utama), dibuka dari tombol di Dashboard
function openChat(){
  if(!appReady)return;
  if(main&&!main.isDestroyed()){if(main.isMinimized())main.restore();if(!main.isVisible())showWin(main,locked);if(!locked){main.focus();try{main.__view.webContents.focus();}catch{}}return;}
  // v15.6.0: dock chat selalu dibuka dalam keadaan di-pin (terkunci); lepas pin lewat tombol pin / hotkey / tray untuk menggeser dan mengubah ukuran
  mark('buka chat');locked=true;makeMain();
}
// Dashboard = jendela pertama yang terbuka setelah splash
function makeDash(){
  const b=readJ(BF).dash||{};
  const w=new BrowserWindow({x:b.x,y:b.y,width:b.width||1100,height:b.height||700,minWidth:860,minHeight:540,title:'ChatStream Labs - Dashboard',icon:ICON,frame:false,autoHideMenuBar:true,backgroundColor:themeBg(),show:false,webPreferences:{spellcheck:false}});
  const go=()=>{if(!w.isDestroyed())w.loadURL(base()+'/?view=dashboard');};
  w.__go=go;go();watchLoad(w,go);
  w.webContents.on('did-fail-load',(e,c,d,u)=>{if(c!==-3&&u&&u.startsWith('http://localhost'))setTimeout(go,1000);});
  w.webContents.on('render-process-gone',()=>{log('proses tampilan Dashboard berhenti, memuat ulang');setTimeout(go,500);});
  const keep=()=>{if(!w.isDestroyed()&&!w.isMinimized()&&!w.isMaximized())saveB({dash:w.getBounds()});};
  w.on('moved',keep);w.on('resized',keep);
  // Hemat RAM: Dashboard yang disembunyikan ke tray > DASH_IDLE_MS dikosongkan halamannya (isi memori dilepas), lalu dimuat lagi saat dibuka.
  // Diperkecil lewat taskbar Windows = minimize biasa (tidak masuk tray, tidak dikosongkan).
  w.on('hide',()=>{clearTimeout(w.__idle);w.__idle=setTimeout(()=>suspendDash(w),DASH_IDLE_MS);});
  w.on('show',()=>{clearTimeout(w.__idle);repaint(w);});
  w.on('restore',()=>repaint(w));
  w.on('close',e=>{if(!quitting){e.preventDefault();askQuit();}});
  w.on('closed',()=>{clearTimeout(w.__idle);if(dash===w)dash=null;});
  dash=w;return w;
}
const DASH_IDLE_MS=30000;
function suspendDash(w){
  if(!w||w.isDestroyed()||w.isVisible()||w.isMinimized()||w.__susp||quitting)return;
  w.__susp=true;
  try{w.webContents.loadURL('about:blank').catch(()=>{});}catch{}
}
// ===== cek update (electron-updater + GitHub Releases) =====
// Hanya di aplikasi yang sudah terpasang (app.isPackaged); saat `npm start` dilewati. Alurnya:
//   cek latest.yml di Releases -> ada versi lebih baru? -> tanya pengguna: Ignore / Remind Me Later / Update Now
//   Update Now -> unduh (bar splash naik; kalau dari tombol Cek Update di sidebar, persennya tampil di tombol itu) -> pasang senyap -> aplikasi mulai ulang sendiri.
//   Ignore = versi itu tidak ditanyakan lagi saat aplikasi dibuka (tombol Cek Update tetap menanyakannya). Remind Me Later = ditanya lagi saat aplikasi dibuka berikutnya.
// Gagal apa pun (offline, Releases kosong, repositori private, timeout 10 dtk) hanya dicatat di log.txt dan aplikasi lanjut seperti biasa.
// manual=true: dipanggil dari tombol Cek Update. Mengembalikan 'installing' (pemasang berjalan, aplikasi akan keluar), 'none' (sudah terbaru),
// 'later' / 'ignored' (pilihan pengguna), 'error' (gagal cek), 'dev' (bukan aplikasi terpasang). Saat bukan manual, selain 'installing' semuanya setara 'lanjut'.
let updBusy=false;
const UPD_TIMEOUT=6000; // v15.4.2: dulu 10 dtk. Cek update menahan splash; GitHub yang lambat/offline tidak boleh membuat buka aplikasi terasa macet.
async function checkUpdates(spRun,manual){
  if(!app.isPackaged)return manual?'dev':'none';
  if(updBusy)return manual?'busy':'none';
  let au;try{au=require('electron-updater').autoUpdater;}catch(e){log('update: electron-updater tidak ditemukan ('+(e&&e.message||e)+')');return manual?'error':'none';}
  updBusy=true;
  try{
    au.autoDownload=false;au.autoInstallOnAppQuit=false;au.allowPrerelease=false;
    au.logger={info:m=>log('update: '+m),warn:m=>log('update: '+m),error:m=>log('update: '+m),debug(){}};
    const r=await Promise.race([au.checkForUpdates(),new Promise((_,no)=>setTimeout(()=>no(new Error('cek update lebih dari '+UPD_TIMEOUT/1000+' detik')),UPD_TIMEOUT))]);
    if(!r||!r.isUpdateAvailable){log('update: sudah versi terbaru ('+app.getVersion()+')');return 'none';}
    const nv=String((r.updateInfo&&r.updateInfo.version)||'');
    log('update: versi baru '+(nv||'?')+' ditemukan');
    if(!manual&&nv&&nv===String(readJ(BF).skipUpdate||'')){log('update: versi '+nv+' diabaikan pengguna, dilewati');return 'none';}
    const parent=manual?((dash&&!dash.isDestroyed())?dash:undefined):((splashWin&&!splashWin.isDestroyed())?splashWin:undefined);
    const ans=await dialog.showMessageBox(parent,{type:'question',buttons:['Ignore','Remind Me Later','Update Now'],defaultId:2,cancelId:1,noLink:true,title:'Update',message:'Versi baru '+(nv?'v'+nv+' ':'')+'tersedia',detail:'Kamu memakai v'+app.getVersion()+'.'});
    if(ans.response===0){if(nv)saveB({skipUpdate:nv});log('update: Ignore (versi '+(nv||'?')+')');return 'ignored';}
    if(ans.response!==2){log('update: Remind Me Later');return 'later';}
    log('update: Update Now, mengunduh');
    const onP=p=>spRun('window.updProgress&&window.updProgress('+Math.round(p.percent||0)+')');
    au.on('download-progress',onP);
    await spRun('window.updProgress&&window.updProgress(0)');
    try{await au.downloadUpdate();}finally{au.removeListener('download-progress',onP);}
    await spRun('window.updInstall&&window.updInstall()');
    await sleep(900);
    quitting=true;try{if(splashWin&&!splashWin.isDestroyed())splashWin.setClosable(true);}catch{}
    au.quitAndInstall(true,true); // senyap + jalankan lagi setelah terpasang
    return 'installing';
  }catch(e){log('update: gagal ('+(e&&e.message||e)+'), lanjut tanpa update');return manual?'error':'none';}
  finally{updBusy=false;}
}
// tombol Cek Update di sidebar Dashboard: hasil dikirim balik ke halaman Dashboard lewat server (/update-check)
const dashRun=async js=>{try{if(dash&&!dash.isDestroyed())return await dash.webContents.executeJavaScript(js);}catch{}};
// splash: cek update -> menyambungkan; ditutup setelah Dashboard siap. Dashboard (dan semua jendela lain) baru boleh tampil SETELAH splash ditutup (appReady).
function startUp(){
  const t0=Date.now();let finished=false;
  // Splash dikunci: tidak bisa digeser, diperkecil, atau ditutup sendiri (hanya aplikasi yang menutupnya lewat destroy()).
  const sp=new BrowserWindow({width:640,height:480,frame:false,resizable:false,movable:false,minimizable:false,maximizable:false,closable:false,fullscreenable:false,center:true,title:'ChatStream Labs',icon:ICON,backgroundColor:'#0a0a1c',show:false});
  splashWin=sp;
  const spLoaded=new Promise(r=>sp.webContents.once('did-finish-load',r));
  sp.loadFile(path.join(__dirname,'splash.html'));
  sp.once('ready-to-show',()=>{if(!sp.isDestroyed())sp.show();});
  sp.on('closed',()=>{splashWin=null;if(!finished&&!quitting)app.quit();});
  const spRun=async js=>{try{await spLoaded;if(!sp.isDestroyed())return await sp.webContents.executeJavaScript(js);}catch{}};
  (async()=>{
    // v15.4.2: Dashboard mulai dimuat (tersembunyi) begitu server siap, BERSAMAAN dengan cek update, bukan menunggu cek update selesai dulu.
    //   Pustaka konektor YouTube/TikTok juga dimuat sekarang (di balik splash) lewat srv.preload, bukan 2,5 dtk setelah Dashboard tampil.
    //   Memuat pustaka itu memblokir proses utama (server, jendela, dan tombol gembok ikut macet) dan dulu kejadiannya pas pengguna baru membuka chat dock.
    const dashP=srvP.then(()=>makeDash());
    const preP=srvP.then(()=>new Promise(r=>setTimeout(r,150))).then(()=>{try{return srv&&srv.preload?srv.preload():null;}catch{return null;}});
    // Tahap 1: cek update (teks "Checking for updates..." tampil minimal 1,9 dtk supaya terbaca)
    const [upd]=await Promise.all([checkUpdates(spRun),sleep(1900)]);
    if(upd==='installing')return; // pemasang jalan, aplikasi akan keluar
    // Tahap 2: menyambungkan (server lokal + Dashboard dimuat tersembunyi)
    await spRun('window.toConnect&&window.toConnect()');
    await srvP;
    const w=await dashP;
    const t=setInterval(async()=>{
      if(w.isDestroyed()){clearInterval(t);return;}
      let ok=false;try{ok=await w.webContents.executeJavaScript('window.__ready===true');}catch{}
      if(!ok&&Date.now()-t0<30000)return;
      if(Date.now()-t0<SPLASH_MIN)return; // beri waktu tampil kedua teks splash
      clearInterval(t);finished=true;
      await Promise.race([preP,sleep(4000)]); // pustaka konektor selesai dimuat (maks 4 dtk tambahan) sebelum splash ditutup
      await spRun('window.finish&&window.finish()');
      // beri waktu bar splash penuh, lalu tutup splash DULU; baru setelah itu aplikasi dianggap siap dan Dashboard tampil
      setTimeout(()=>{
        if(!sp.isDestroyed())sp.destroy();
        appReady=true;
        if(!w.isDestroyed())showDash();
        refreshTray();
      },700);
    },250);
  })();
}
const SPLASH_MIN=3000; // v15.4.2: lama minimal splash (dulu 3800 ms)
// ===== Donate Dock (bisa lebih dari satu) =====
// Tiap dock memuat satu URL widget donasi (alert / media share) di jendelanya sendiri. Tidak ada integrasi API: aplikasi hanya menampilkan halamannya.
// Jendela selalu tanpa bingkai dan tanpa bilah judul. Tombol (mata, gembok, pindah, tutup) = jendela kecil tanpa bingkai di LUAR jendela dock (?view=ctl&t=<id>, transparan rendah), lihat attachCtl.
// v1.0.2: SATU jendela per dock (sama seperti jendela chat): selalu transparan, tanpa bingkai, selalu di atas. Kunci / buka kunci hanya mengubah perilaku jendela yang SAMA (dockSetLock -> dockModeOn), halaman widget TIDAK dimuat ulang.
// Di-pin (terkunci): tidak bisa difokus, isi widget tidak bisa diklik, klik tembus, ukuran tetap. Tidak di-pin: menerima klik, bisa difokus, latar polos (Opacity Dock) di bawah widget, bingkai tipis + pegangan di tepi untuk resize (donFrame / dockResize).
// Isi widget otomatis diskalakan (zoom) supaya muat di jendela: skala = min(lebar jendela / lebar acuan, tinggi jendela / tinggi acuan).
const DON_MAX=5,docks=new Map(); // id -> D
const donCfg=()=>Array.isArray(G().donateDocks)?G().donateDocks:[];
const donFind=id=>donCfg().find(d=>d.id===id)||null;
const donOpen=D=>!!(D&&D.win&&!D.win.isDestroyed());
const donCheck=c=>{
  const raw=String((c&&c.url)||'').trim();
  if(!raw)return{error:'Isi URL dulu, lalu klik Simpan.'};
  const u=srv&&srv.cleanDonateUrl?srv.cleanDonateUrl(raw):null;
  return u?{url:u}:{error:'URL tidak valid. Awali dengan http:// atau https://.'};
};
const refreshTray=()=>{if(tray)tray.setContextMenu(trayMenu());};
const donLockSaved=id=>!!(readJ(BF).donLocked||{})[id];
const donSaveLock=(id,on)=>saveB({donLocked:{...(readJ(BF).donLocked||{}),[id]:!!on}});
const donSavedBounds=id=>(readJ(BF).donates||{})[id]||readJ(BF).donate||{};
const donSaveBounds=D=>{try{if(donOpen(D))saveB({donates:{...(readJ(BF).donates||{}),[D.id]:D.win.getBounds()}});}catch{}};
// Jendela tembus-klik penuh tidak bisa disembunyikan Windows dari tangkapan layar (lihat komentar applyLockedInput).
// Saat terkunci + "Sembunyikan dari OBS" aktif: jendela tidak tembus-klik, tetapi bentuknya (setShape) hanya sebesar isi widget yang sedang terlihat
// (dibaca dari halaman widget tiap 0,7 dtk). Selama belum ada donasi masuk, bentuknya hanya kotak tombol jadi tidak menghalangi game.
// Saat tidak disembunyikan dari OBS: tembus-klik penuh.
function applyDockInput(D,light){
  if(!D||!D.locked||!donOpen(D))return;
  try{
    const b=D.win.getBounds();
    if(useHole()){if(!light)setIgn(D.win,false);const hp=HOLE?holeAt.get(D.win):null,rr=hp?carve(D.rects||[],hp.x,hp.y):(D.rects||[]);setShp(D.win,rr.length?rr:[{x:0,y:0,width:1,height:1}],true);if(!light)holeStart();} // kotak tombol sudah jendela sendiri di luar, jadi tidak ikut di sini
    else{setShp(D.win,[{x:0,y:0,width:b.width,height:b.height}],true);setIgn(D.win,true);}
  }catch{}
}
function applyDonateInput(){docks.forEach(applyDockInput);}
// dijalankan DI DALAM halaman widget: daftar kotak [x,y,lebar,tinggi] (px CSS) dari bagian yang benar-benar terlihat
function scanFn(){
  const out=[],PAINT=/^(IMG|VIDEO|CANVAS|IFRAME|SVG|OBJECT|EMBED|PICTURE)$/i,SKIP=/^(SCRIPT|STYLE|NOSCRIPT|META|LINK|HEAD|TEMPLATE)$/;
  let n=0,k=0;
  const walk=(doc,ox,oy,W,H)=>{
    const win=doc.defaultView;if(!win)return;
    const vis=e=>{for(let x=e;x&&x.nodeType===1;x=x.parentElement||(x.getRootNode&&x.getRootNode().host)){const c=win.getComputedStyle(x);if(c.display==='none'||c.visibility==='hidden'||parseFloat(c.opacity)<0.02)return false;}return true;};
    const add=r=>{if(r.width>1&&r.height>1&&r.right>0&&r.bottom>0&&r.left<W&&r.top<H)out.push([r.left+ox,r.top+oy,r.width,r.height]);};
    const visit=root=>{
      for(const e of root.querySelectorAll('*')){
        if(++n>2500)return;
        if(SKIP.test(e.tagName))continue;
        if(e.shadowRoot)visit(e.shadowRoot);
        const c=win.getComputedStyle(e),bg=c.backgroundColor;
        const paint=PAINT.test(e.tagName)||c.backgroundImage!=='none'||(bg!=='transparent'&&!/,\s*0\)$/.test(bg))||(c.borderTopStyle!=='none'&&c.borderTopWidth!=='0px');
        if(paint&&vis(e)){const r=e.getBoundingClientRect();add(r);
          if(e.tagName==='IFRAME'){try{const d=e.contentDocument;if(d&&d.documentElement)walk(d,ox+r.left,oy+r.top,r.width,r.height);}catch{}}}
      }
    };
    const root=doc.body||doc.documentElement;visit(root);
    const tw=doc.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    for(let t;(t=tw.nextNode())&&k<600;k++){
      if(!t.nodeValue.trim())continue;const p=t.parentElement;
      if(!p||/^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)||!vis(p))continue;
      const g=doc.createRange();g.selectNodeContents(t);add(g.getBoundingClientRect());
    }
  };
  walk(document,0,0,innerWidth,innerHeight);
  return out.slice(0,400);
}
async function dockScan(D){
  if(!D.locked||!useHole()||!donOpen(D)||!D.view||D.view.webContents.isDestroyed())return;
  let a;try{a=await D.view.webContents.executeJavaScript('('+scanFn.toString()+')()');}catch{return;}
  if(!Array.isArray(a)||!donOpen(D))return;
  const z=D.zoom||1,[cw,ch]=D.win.getContentSize();
  const r=a.map(q=>{const x=Math.max(0,Math.floor(q[0]*z)-4),y=Math.max(0,Math.floor(q[1]*z)-4);
    return{x,y,width:Math.max(1,Math.min(cw-x,Math.ceil(q[2]*z)+8)),height:Math.max(1,Math.min(ch-y,Math.ceil(q[3]*z)+8))};}).filter(q=>q.x<cw&&q.y<ch);
  const sig=JSON.stringify(r);if(sig===D.sig)return;
  D.sig=sig;D.rects=r;applyDockInput(D);
}
// skala isi widget supaya muat di jendela
function dockFit(D){
  if(!donOpen(D)||!D.view||D.view.webContents.isDestroyed())return;
  const c=D.cfg||{},[cw,ch]=D.win.getContentSize();
  const rw=(c.auto&&D.cont)?D.cont.w:(c.refW||1280),rh=(c.auto&&D.cont)?D.cont.h:(c.refH||720); // v1.0.0: mode otomatis memakai ukuran isi halaman hasil pengukuran (D.cont), kalau belum terukur tetap ukuran acuan
  const z=c.fit===false?1:Math.min(10,Math.max(.1,Math.min(cw/rw,ch/rh)));
  D.zoom=z;try{D.view.webContents.setZoomFactor(z);}catch{}if(!D.locked&&D.frZ!==z)donFrame(D);
}
// CSS yang disuntik ke halaman widget: latar transparan + Opacity dari pengaturan dock (hanya isi widget; tombol tidak ikut pudar) + saat terkunci isi widget tidak bisa diklik
function donCss(D){
  const wc=D.view&&D.view.webContents;if(!wc||wc.isDestroyed())return;
  const op=Math.min(100,Math.max(10,Math.round(+((D.cfg||{}).opacity))||100));D.opAp=op;
  const css='html,body{background:transparent!important}'+(D.locked?'*{pointer-events:none!important}':'')+(op<100?'html{opacity:'+(op/100)+'!important}':'');
  const old=D.cssKey;D.cssKey=null;if(old)wc.removeInsertedCSS(old).catch(()=>{});
  wc.insertCSS(css).then(k=>{if(wc.isDestroyed())return;if(D.cssKey)wc.removeInsertedCSS(D.cssKey).catch(()=>{});D.cssKey=k;}).catch(()=>{});
  donFrame(D); // v1.0.2: bingkai + pegangan resize hanya saat tidak di-pin
}
// v1.0.2: latar Browser Dock = View polos DI BAWAH halaman widget (bukan latar jendela, supaya jendela tetap transparan dan tidak perlu dibuat ulang saat kunci berganti).
// Tampil hanya saat TIDAK terkunci, dengan Opacity Dock (cfg.dockOp, 0-100, bawaan 100); terkunci = transparan penuh. Opacity URL (cfg.opacity) hanya untuk isi widget (donCss).
function donBg(D){
  try{
    if(!D||!D.bg)return;
    const c=(D.cfg||{}).dockOp,n=Math.round(+c),op=(c==null||!isFinite(n))?100:Math.min(100,Math.max(0,n));
    const m=/^#?([0-9a-f]{6})$/i.exec(themeBg());
    D.bg.setBackgroundColor(D.locked||!m?'#00000000':'#'+('0'+Math.round(op*2.55).toString(16)).slice(-2)+m[1]);
  }catch{}
}
// v1.0.0: ukur ukuran isi halaman widget (px CSS): gabungan kotak semua gambar/video/canvas/svg/iframe dan teks yang tampak. Dijalankan di dalam halaman.
// Latar CSS dan elemen yang selebar layar tidak terhitung / tidak mengubah apa-apa (ukurannya mengikuti jendela), jadi tetap stabil. Widget kosong (menunggu donasi) = null.
const donMeasFn=()=>{try{
  let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;const seen=new Map();
  const ok=e=>{let v=seen.get(e);if(v===undefined){const s=getComputedStyle(e);v=s.display!=='none'&&+s.opacity!==0;seen.set(e,v);}return v;};
  const vis=el=>{if(getComputedStyle(el).visibility==='hidden')return false;for(let e=el;e&&e.nodeType===1;e=e.parentElement)if(!ok(e))return false;return true;};
  const add=r=>{if(r.width<2||r.height<2)return;x1=Math.min(x1,r.left);y1=Math.min(y1,r.top);x2=Math.max(x2,r.right);y2=Math.max(y2,r.bottom);};
  let n=0;for(const el of document.querySelectorAll('img,video,canvas,svg,iframe')){if(++n>600)break;if(vis(el))add(el.getBoundingClientRect());}
  const tw=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT),rg=document.createRange();
  for(let t,i=0;(t=tw.nextNode())&&i<1500;i++){if(!t.nodeValue.trim())continue;const p=t.parentElement;if(!p||/^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)||!vis(p))continue;rg.selectNodeContents(t);add(rg.getBoundingClientRect());}
  if(x2<x1)return null;return{w:x2-x1,h:y2-y1};
}catch{return null;}};
// Hanya jalan kalau opsi "Ukuran otomatis" nyala. Ukuran yang dipakai = yang TERBESAR yang pernah terlihat (naik saja, tidak turun saat widget kosong), jadi tidak bolak-balik mengecil-membesar.
function donMeasure(D){
  if(!donOpen(D)||!D.cfg||!D.cfg.auto||D.cfg.fit===false||D.measBusy)return;
  const wc=D.view&&D.view.webContents;if(!wc||wc.isDestroyed()||wc.isLoading())return;
  D.measBusy=true;
  wc.executeJavaScript('('+donMeasFn.toString()+')()',false).then(m=>{
    D.measBusy=false;
    if(!m||!(m.w>=20)||!(m.h>=20))return;
    const w=Math.min(7680,Math.ceil(m.w)),h=Math.min(4320,Math.ceil(m.h)),p=D.cont||{w:0,h:0};
    if(w>p.w*1.02||h>p.h*1.02){D.cont={w:Math.max(p.w,w),h:Math.max(p.h,h)};dockFit(D);}
  }).catch(()=>{D.measBusy=false;});
}
function donGo(D){
  if(!D.view||D.view.webContents.isDestroyed())return;
  D.cont=null; // URL baru = ukur ulang isinya
  const c=donCheck(D.cfg);if(!c.url)return;
  D.loaded=c.url;clearTimeout(D.T.hang);
  D.view.webContents.loadURL(c.url).catch(()=>{}); // kegagalan ditangani did-fail-load
  // pengaman halaman menggantung: kalau 25 detik masih memuat, hitung sebagai satu percobaan gagal
  D.T.hang=setTimeout(()=>{const wc=D.view&&!D.view.webContents.isDestroyed()&&D.view.webContents;if(wc&&wc.isLoading())donRetry(D,'halaman terlalu lama memuat');},25000);
}
// muat ulang otomatis dengan jeda makin lama (3, 6, 12, 24, 48 dtk), berhenti setelah DON_TRY kali supaya tidak berputar tanpa ujung
const DON_TRY=5;
function donRetry(D,why){
  if(!D.view)return;
  clearTimeout(D.T.hang);clearTimeout(D.T.stable);
  if(++D.tries>DON_TRY){log('Browser Dock "'+D.cfg.name+'": berhenti mencoba setelah '+DON_TRY+' kali ('+why+'). Cek URL dan internet, lalu klik "Muat ulang".');return;}
  const d=Math.min(60000,3000*Math.pow(2,D.tries-1));
  log('Browser Dock "'+D.cfg.name+'": '+why+', muat ulang dalam '+Math.round(d/1000)+' dtk ('+D.tries+'/'+DON_TRY+')');
  clearTimeout(D.T.retry);D.T.retry=setTimeout(()=>donGo(D),d);
}
// dipanggil tiap pengaturan berubah: nama, bisu, ukuran acuan, URL; dock yang dihapus / URL-nya kosong ditutup
function donSync(){
  docks.forEach(D=>{
    if(!donOpen(D))return;
    const cfg=donFind(D.id);
    if(!cfg||!donCheck(cfg).url){D.win.close();return;}
    D.cfg=cfg;try{D.win.setTitle(cfg.name);}catch{}donBg(D);
    try{D.view.webContents.setAudioMuted(!!cfg.mute);}catch{}
    if((cfg.opacity||100)!==D.opAp)donCss(D);
    if(cfg.url!==D.loaded){D.tries=0;donGo(D);}
    dockFit(D);
  });
}
function makeDock(id,L){
  const cfg=donFind(id);if(!cfg)return null;
  const old=docks.get(id),sv=donSavedBounds(id);
  // v1.0.2: SATU jenis jendela: transparan, tanpa bingkai, selalu di atas (dulu jendela biasa berlatar saat tidak terkunci, jadi kunci / buka kunci membuat jendela baru dan widget dimuat ulang).
  const o={x:sv.x,y:sv.y,width:sv.width||420,height:sv.height||520,title:cfg.name,icon:ICON,minWidth:160,minHeight:100,show:false,frame:false,autoHideMenuBar:true,maximizable:false,minimizable:false,skipTaskbar:true,webPreferences:{spellcheck:false},
    transparent:true,backgroundColor:'#00000000',hasShadow:false,resizable:false,focusable:!L,thickFrame:false};
  const w=new BrowserWindow(o);
  w.setAlwaysOnTop(true,'screen-saver');
  const part='persist:donate-'+id; // satu partisi per dock: zoom dan data halaman tidak bercampur antar dock
  try{session.fromPartition(part).setPermissionRequestHandler((wc,perm,cb)=>cb(false));}catch{}
  const v=new WebContentsView({webPreferences:{partition:part,autoplayPolicy:'no-user-gesture-required',backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false}});
  v.setBackgroundColor('#00000000');
  const bg=new View();w.contentView.addChildView(bg);w.contentView.addChildView(v); // bg = latar polos (Opacity Dock) di bawah halaman widget, lihat donBg
  // tombol (mata, gembok, pindah, ubah ukuran, tutup): jendela kecil di LUAR jendela dock
  attachCtl(w,id,true);
  const D={id,cfg,win:w,view:v,bg,locked:!!L,loaded:'',tries:0,T:{},rects:[],sig:'',zoom:1,dragT:null,rzT:null,scanT:null,cssKey:null,opAp:0};
  const layout=()=>{if(w.isDestroyed())return;const [cw,ch]=w.getContentSize();bg.setBounds({x:0,y:0,width:cw,height:ch});v.setBounds({x:0,y:0,width:cw,height:ch});dockFit(D);if(D.locked)applyDockInput(D);};
  D.layout=layout;layout();w.on('resize',layout);
  const wc=v.webContents;
  wc.setAudioMuted(!!cfg.mute);
  wc.setWindowOpenHandler(()=>({action:'deny'}));
  wc.on('console-message',(...a)=>{const e=a[0],m=String((e&&e.message)||a[2]||'');if(m.slice(0,7)!=='__csrz|')return;const p=m.split('|');dockResize(id,p[2]==='1',p[1]);}); // pegangan resize di halaman (donFrame)
  const onlyHttp=(e,u)=>{if(!/^https?:\/\//i.test(u))e.preventDefault();};
  wc.on('will-navigate',onlyHttp);wc.on('will-redirect',onlyHttp);
  wc.on('dom-ready',()=>{try{wc.setAudioMuted(!!D.cfg.mute);}catch{}donCss(D);dockFit(D);});
  wc.on('did-navigate',()=>dockFit(D));
  wc.on('did-finish-load',()=>{
    clearTimeout(D.T.hang);donCss(D);dockFit(D);
    clearTimeout(D.T.stable);D.T.stable=setTimeout(()=>{D.tries=0;},30000); // dianggap sehat kalau bertahan 30 dtk
  });
  wc.on('did-fail-load',(e,c,d,u,isMain)=>{if(c===-3||isMain===false)return;donRetry(D,'gagal memuat ('+d+')');});
  wc.on('render-process-gone',()=>donRetry(D,'proses halaman berhenti'));
  const moved=()=>{if(!D.locked&&!w.isDestroyed())donSaveBounds(D);};
  w.on('moved',moved);w.on('resized',moved);
  w.on('show',refreshTray);w.on('hide',refreshTray);
  w.on('closed',()=>{
    clearTimeout(D.T.hang);clearTimeout(D.T.retry);clearTimeout(D.T.stable);clearInterval(D.scanT);clearInterval(D.dragT);clearInterval(D.rzT);clearInterval(D.measT);
    if(docks.get(id)===D)docks.delete(id);
    // WebContentsView TIDAK ikut tertutup saat jendelanya ditutup: tanpa ini halaman widget lama tetap hidup dan suaranya terus bunyi (dobel)
    [v].forEach(x=>{try{const c=x.webContents;if(!c.isDestroyed()){c.setAudioMuted(true);c.close();}}catch{}});
    refreshTray();
  });
  docks.set(id,D);
  showWin(w,!!L);
  dockModeOn(D,true);
  D.measT=setInterval(()=>donMeasure(D),1000);
  donGo(D);
  if(old&&!old.win.isDestroyed()){try{old.view.webContents.setAudioMuted(true);}catch{}old.win.destroy();}
  refreshTray();
  return D;
}
// v1.0.2: perilaku jendela dock sesuai keadaan D.locked, pada jendela YANG SAMA (init=true: baru dibuat, jendelanya sudah dibuat sesuai keadaan itu).
//   terkunci: tidak bisa difokus, tembus-klik / bentuk lubang (applyDockInput); tidak terkunci: menerima klik di seluruh area, bisa difokus.
function dockModeOn(D,init){
  if(!donOpen(D))return;
  const w=D.win;
  clearInterval(D.scanT);D.scanT=null;
  if(D.locked){
    if(!init)w.setFocusable(false);
    applyDockInput(D);
    [0,300,1200].forEach(t=>setTimeout(()=>{if(docks.get(D.id)===D&&D.locked)applyDockInput(D);},t));
    if(!PROTECT_PASSTHRU)D.scanT=setInterval(()=>dockScan(D),1500); // v15.5.0: dockScan hanya berguna di mode lubang; di mode bawaan (tembus-klik) tidak perlu dijadwalkan
  }else if(!init){
    D.rects=[];D.sig='';
    const b=w.getBounds();
    setIgn(w,false);setShpIf(w,[{x:0,y:0,width:b.width,height:b.height}]); // bentuk jendela = seluruh area (kalau tidak, bentuk lubang lama memotong tampilan, lihat bagian 27)
    w.setFocusable(true);
  }
  donBg(D);if(!init)donCss(D);
}
// beri tahu kotak tombol dock bahwa kunci berubah (ikon gembok terisi = terkunci)
function pushDockLk(D){try{const c=D.win&&D.win.__ctl;if(c&&!c.isDestroyed())c.webContents.executeJavaScript('window.__st&&window.__st({lk:'+(D.locked?'true':'false')+'})').catch(()=>{});}catch{}}
// kunci / buka kunci satu dock: jendela yang SAMA (v1.0.2; dulu dibuat ulang sehingga widget / media share ikut hilang)
function dockSetLock(id,on){
  on=!!on;donSaveLock(id,on);
  const D=docks.get(id);
  if(!donOpen(D)||D.locked===on)return;
  dockDrag(id,false);dockResize(id,false);
  if(D.win.isMinimized())D.win.restore();
  D.locked=on;dockModeOn(D);pushDockLk(D);
  donSaveBounds(D);
}
// v1.0.2: ubah ukuran dock yang TIDAK di-pin, sama seperti jendela chat (resizeOn): halaman widget diberi pegangan di tepi dan sudut (donFrame, disuntik saat tidak di-pin) yang melapor lewat console ("__csrz|<sisi>|1/0"),
//   main.js mengikuti kursor lewat setBounds. Jendela transparan tidak bisa di-resize lewat tepinya (jebakan 5). Sisi yang berlawanan dengan yang ditarik tetap diam.
const DK_MINW=160,DK_MINH=100;
function dockResize(id,on,edge){
  const D=docks.get(id),E=String(edge||'');
  if(!on){if(D&&D.rzT){clearInterval(D.rzT);D.rzT=null;donSaveBounds(D);}return;}
  if(!donOpen(D)||D.locked||D.rzT||!/^(n|s|e|w|ne|nw|se|sw)$/.test(E))return;
  dockDrag(id,false);
  const c0=screen.getCursorScreenPoint(),m0=D.win.getBounds(),t0=Date.now();
  D.rzT=setInterval(()=>{
    if(!donOpen(D)||D.locked){dockResize(id,false);return;}
    const c=screen.getCursorScreenPoint(),dx=c.x-c0.x,dy=c.y-c0.y;
    let wd=m0.width,ht=m0.height;
    if(E.includes('e'))wd=m0.width+dx;else if(E.includes('w'))wd=m0.width-dx;
    if(E.includes('n'))ht=m0.height-dy;else if(E.includes('s'))ht=m0.height+dy;
    wd=Math.max(DK_MINW,Math.round(wd));ht=Math.max(DK_MINH,Math.round(ht));
    const x=E.includes('w')?m0.x+m0.width-wd:m0.x,y=E.includes('n')?m0.y+m0.height-ht:m0.y,b=D.win.getBounds();
    if(b.x!==x||b.y!==y||b.width!==wd||b.height!==ht){D.win.setBounds({x,y,width:wd,height:ht});if(D.layout)D.layout();setShpIf(D.win,[{x:0,y:0,width:wd,height:ht}]);} // bentuk jendela ikut ukuran baru (sama seperti resizeOn jendela chat); kalau tidak, bentuk lama memotong tampilan dan jendela terlihat 'naik'
    if(Date.now()-t0>25000)dockResize(id,false);
  },16);
}
// dijalankan DI DALAM halaman widget: pasang (on=true) / copot (on=false) bingkai tipis + 8 pegangan. z = zoom halaman (ukuran pegangan dibagi z supaya tetap ~10 px di layar).
function frameFn(z,on){
  const ID='__cs_rz',old=document.getElementById(ID);if(old)old.remove();
  if(!on)return;
  const t=Math.max(6,Math.round(10/z)),c=Math.round(24/z),S=(e,o)=>{Object.assign(e.style,o);return e;},root=S(document.createElement('div'),{position:'fixed',left:'0',top:'0',right:'0',bottom:'0',zIndex:'2147483647',pointerEvents:'none',boxSizing:'border-box',boxShadow:'inset 0 0 0 '+Math.max(1,Math.round(2/z))+'px rgba(255,255,255,.4)'});
  root.id=ID;
  const send=(e,v)=>console.log('__csrz|'+e+'|'+v);
  [['n',{left:c+'px',right:c+'px',top:'0',height:t+'px',cursor:'ns-resize'}],['s',{left:c+'px',right:c+'px',bottom:'0',height:t+'px',cursor:'ns-resize'}],
   ['e',{top:c+'px',bottom:c+'px',right:'0',width:t+'px',cursor:'ew-resize'}],['w',{top:c+'px',bottom:c+'px',left:'0',width:t+'px',cursor:'ew-resize'}],
   ['ne',{top:'0',right:'0',width:c+'px',height:c+'px',cursor:'nesw-resize'}],['nw',{top:'0',left:'0',width:c+'px',height:c+'px',cursor:'nwse-resize'}],
   ['se',{bottom:'0',right:'0',width:c+'px',height:c+'px',cursor:'nwse-resize'}],['sw',{bottom:'0',left:'0',width:c+'px',height:c+'px',cursor:'nesw-resize'}]].forEach(([e,o])=>{
    const h=S(document.createElement('div'),{position:'absolute',pointerEvents:'auto',touchAction:'none',userSelect:'none',...o});
    h.addEventListener('pointerdown',ev=>{ev.preventDefault();try{h.setPointerCapture(ev.pointerId);}catch{}send(e,1);});
    ['pointerup','pointercancel','lostpointercapture'].forEach(n=>h.addEventListener(n,()=>send('',0)));
    root.appendChild(h);});
  (document.documentElement||document.body).appendChild(root);
}
function donFrame(D){
  const wc=D.view&&D.view.webContents;if(!wc||wc.isDestroyed())return;
  D.frZ=D.zoom||1;
  wc.executeJavaScript('('+frameFn.toString()+')('+D.frZ+','+(D.locked?'false':'true')+')',false).catch(()=>{});
}
function dockDrag(id,on){
  const D=docks.get(id);if(!donOpen(D))return;
  if(!on){if(D.dragT){clearInterval(D.dragT);D.dragT=null;donSaveBounds(D);}return;}
  if(D.dragT)return;
  const c0=screen.getCursorScreenPoint(),m0=D.win.getBounds(),t0=Date.now();
  D.dragT=setInterval(()=>{
    if(!donOpen(D)){clearInterval(D.dragT);D.dragT=null;return;}
    const c=screen.getCursorScreenPoint(),dx=c.x-c0.x,dy=c.y-c0.y;
    D.win.setBounds({x:m0.x+dx,y:m0.y+dy,width:m0.width,height:m0.height});if(D.win.__pos)D.win.__pos();
    if(Date.now()-t0>25000)dockDrag(id,false);
  },16);
}
// act: open | close | reload | toggle. id kosong = semua dock
function donateAct(act,id){
  if(!appReady)return{ok:true};
  if(act==='toggle'){const any=[...docks.values()].some(d=>donOpen(d)&&d.win.isVisible());return donateAct(any?'close':'open',id);}
  if(!['open','close','reload'].includes(act))return{error:'Perintah tidak dikenal.'};
  const ids=id?[String(id)]:donCfg().map(d=>d.id);
  if(!ids.length)return{error:'Belum ada Browser Dock. Tambahkan dulu di menu Browser Dock.'};
  let err=null;
  for(const i of ids){
    const D=docks.get(i),open=donOpen(D);
    if(act==='close'){if(open)D.win.close();continue;}
    if(act==='reload'){if(open){D.tries=0;donGo(D);}else if(id)err='Browser Dock belum dibuka.';continue;}
    const cfg=donFind(i);
    if(!cfg){err='Browser Dock tidak ditemukan.';continue;}
    const c=donCheck(cfg);
    if(!c.url){err=c.error;continue;}
    if(open){if(!D.win.isVisible())showWin(D.win,D.locked);continue;}
    makeDock(i,donLockSaved(i));
  }
  return err?{error:err}:{ok:true};
}
function dashState(){
  const d={};
  donCfg().forEach(c=>{const D=docks.get(c.id),o=donOpen(D);d[c.id]={open:o,locked:o?D.locked:donLockSaved(c.id)};});
  return{chat:{open:!!(main&&!main.isDestroyed()),locked},docks:d};
}
// ===== hotkey =====
const HK_DEF={lock:'Ctrl+Alt+L',hide:'Ctrl+Alt+H',obs:'Ctrl+Alt+O',up:'Ctrl+Alt+PageUp',down:'Ctrl+Alt+PageDown',clear:'Ctrl+Alt+C',filter:'Ctrl+Alt+F',settings:'Ctrl+Alt+S',report:'Ctrl+Alt+R',donate:'Ctrl+Alt+D',
  chat:'',lockscroll:'',send:'',alertgift:'',donatereload:'',newsession:''}; // v15.3.4: hotkey tambahan, kosong bawaan (setHotkeys melewati yang kosong); v15.5.5: alertlike dihapus bersama alert like
const ACTIONS={
  lock:()=>setLock(!locked),
  hide:()=>{if(!appReady||!main||main.isDestroyed())return;
    if(main.isVisible())main.hide();
    else{if(locked)main.showInactive();else main.show();}},
  obs:()=>{if(srv){protect=!protect;srv.setGlobal({protect});}},
  up:()=>srv&&srv.cmd('up'),down:()=>srv&&srv.cmd('down'),clear:()=>srv&&srv.cmd('clear'),filter:()=>srv&&srv.cmd('filter'),
  settings:()=>openSettings(),
  report:()=>openReport(),
  donate:()=>{donateAct('toggle');},
  // v15.3.4: hotkey tambahan
  chat:()=>openChat(),
  lockscroll:()=>{if(srv)srv.setGlobal({lockScroll:G().lockScroll!==true});},
  send:()=>{if(srv)srv.setGlobal({sendOn:G().sendOn!==true});},
  alertgift:()=>srv&&srv.cmd('alertgift'), // halaman dock yang membalik pengaturannya (butuh jendela chat terbuka)
  donatereload:()=>{donateAct('reload');},
  newsession:()=>{if(srv&&srv.endSession)srv.endSession();}
};
function setHotkeys(map){
  globalShortcut.unregisterAll();const res={};
  for(const [a,acc] of Object.entries({...HK_DEF,...(map||{})})){
    if(!acc||!ACTIONS[a]){res[a]=true;continue;}
    try{res[a]=globalShortcut.register(acc.replace(/Ctrl/g,'CommandOrControl'),ACTIONS[a]);}catch{res[a]=false;}
  }
  return res;
}
// ===== v15.2.0: folder ekstensi TETAP di data pengguna (%APPDATA%/ChatStream Labs/extension) =====
// Ekstensi dipasang manual (Load unpacked) dari folder ini, bukan dari folder instalasi aplikasi. Tiap aplikasi mulai, isinya disamakan dengan extension/ milik aplikasi
// (hanya berkas yang berbeda yang ditulis; manifest.json terakhir). Sesudah itu server memberi tahu versi aplikasi ke service worker ekstensi ('ver'), dan ekstensi memuat dirinya sendiri kalau versinya beda.
const extSrc=()=>app.isPackaged?path.join(process.resourcesPath,'extension'):path.join(__dirname,'..','extension');
const extDir=()=>path.join(app.getPath('userData'),'extension');
let extOk=false; // true = folder tetap sudah sama dengan extension/ aplikasi; hanya saat itu versi dikirim ke ekstensi
function syncExtension(){
  try{
    const dst=extDir(),changed=require('./extsync.js').syncDir(extSrc(),dst); // lihat src/extsync.js (berkas yang beda saja, manifest.json terakhir)
    if(changed.length)log('ekstensi: folder tetap diperbarui ke v'+app.getVersion()+' ('+changed.join(', ')+') di '+dst);
    extOk=true;
  }catch(e){extOk=false;log('ekstensi: gagal menyalin ke folder tetap: '+(e&&e.message||e));}
}
const hooks={
  protect:on=>{protect=on;BrowserWindow.getAllWindows().forEach(w=>prot(w,true));pushCtl();applyLockedInput();applyDonateInput();},
  open:what=>{if(what==='ext')shell.openPath(path.dirname(extSrc()));else shell.openExternal(what);}, // 'ext' = folder induk ekstensi (v15.3.0): terpasang = <folder aplikasi>\resources (isinya folder 'extension'); mode dev = folder proyek
  appVersion:()=>extOk?app.getVersion():'', // dikirim server ke service worker ekstensi (pesan 'ver'); kosong = jangan kirim
  window:(url,opt)=>openWin(url,opt||{}),
  saveCss:async(name,css)=>{const w=BrowserWindow.getFocusedWindow();const r=await dialog.showSaveDialog(w||undefined,{title:'Ekspor gaya (.css)',defaultPath:path.join(app.getPath('documents'),name+'.css'),filters:[{name:'CSS',extensions:['css']}]});
    if(r.canceled||!r.filePath)return{canceled:true};fs.writeFileSync(r.filePath,css,'utf8');return{ok:true,path:r.filePath};},
  // dipakai konektor Kick: mesin jaringan Chromium lebih sering lolos Cloudflare daripada fetch Node biasa
  netFetch:async url=>{const {net}=require('electron');const r=await net.fetch(url,{headers:{Accept:'application/json'}});return{status:r.status,text:await r.text()};},
  relaunch:()=>{quitting=true;app.relaunch();app.exit(0);},
  lock:(on,id)=>(id&&id!=='chat')?dockSetLock(id,on):setLock(on),
  chatFocus,
  drag:(on,id)=>(id&&id!=='chat')?dockDrag(id,on):dragOn(on),
  resize:(on,edge,id)=>(id&&id!=='chat')?dockResize(id,on,edge):resizeOn(on,edge), // v15.6.1: tarik pegangan tepi/sudut jendela chat yang tidak terpin; v1.0.2: dengan id = Browser Dock
  openSettings,
  openReport,
  openChat,
  setHotkeys,
  winCtl,
  shape:(rects,list)=>{lastRects=rects;lastList=list||null;applyLockedInput();},
  galert:galertPush,
  global:g=>{ctrlPos=(g&&g.ctrlPos)||'top-right';lockScroll=!!(g&&g.lockScroll===true);applyLockedInput();docks.forEach(D=>D.layout&&D.layout());posAllCtl();donSync();},
  donate:(act,id)=>donateAct(act,id),
  checkUpdate:()=>checkUpdates(dashRun,true),
  // v15.4.2: proses terpisah untuk konektor YouTube/TikTok (src/conn-worker.js). Server memakainya lewat objek {post,on,kill}; gagal/tidak menjawab -> server memakai cadangan di proses ini.
  spawnConn:()=>{
    const {utilityProcess}=require('electron');
    const c=utilityProcess.fork(path.join(__dirname,'conn-worker.js'),[],{serviceName:'ChatStream Labs - konektor'});
    return{post:m=>{try{c.postMessage(m);}catch{}},on:(ev,fn)=>c.on(ev,fn),kill:()=>{try{c.kill();}catch{}}};
  },
  dashState
};
app.whenReady().then(()=>{
  if(!gotLock)return;
  Menu.setApplicationMenu(null);
  startUp();
  try{tray=new Tray(nativeImage.createFromPath(ICON).resize({width:16,height:16}));tray.setToolTip('ChatStream Labs');tray.setContextMenu(trayMenu());tray.on('click',()=>showDash());}catch{}
  syncExtension(); // sebelum server hidup: ekstensi baru boleh muat ulang begitu menerima 'ver', folder harus sudah siap
  setTimeout(()=>{
    srv=require('./server.js');Object.assign(srv.hooks,hooks);
    setHotkeys(G().hotkeys);
    srv.ready.then(srvReady);
  },30);
});
app.on('before-quit',()=>{quitting=true;try{srv&&srv.flush&&srv.flush();}catch{}});
app.on('will-quit',()=>{globalShortcut.unregisterAll();hkStop();});
app.on('window-all-closed',()=>{app.quit();});
