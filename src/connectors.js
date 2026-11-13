// Konektor baca-chat YouTube dan TikTok (v15.4.2). Kode SAMA dipakai dua tempat:
//   1) src/conn-worker.js, di proses terpisah (utilityProcess): memuat pustaka + mengurai payload TIDAK lagi memblokir proses utama Electron
//      (dulu terasa sebagai buka aplikasi lama dan lag saat chat dock dibuka / digembok, lihat AGENTS.md bagian 6 jebakan 7 dan bagian 31);
//   2) src/server.js sebagai CADANGAN di proses utama, kalau proses terpisah tidak bisa jalan.
// Konektor tidak mengenal server: semua keluaran lewat objek `api`:
//   api.alive() = masih generasi yang berlaku?  api.status(platform,teks)  api.push(pesan)  api.viewers(platform,n)  api.like(n)  api.live(idVideoYouTube)
// startYT/startTT mengembalikan fungsi stop(), atau null kalau pustaka gagal dimuat (statusnya sudah dilaporkan lewat api.status).
const first=u=>{if(!u)return'';for(const k of['avatarThumb','avatarMedium','avatarLarge','profilePicture']){const i=u[k];if(i){const x=(i.urlList&&i.urlList[0])||(i.urls&&i.urls[0])||i.url;if(x)return x;}}return'';};

let likeBuf=new Map(),likeT=null,likeTot=new Map(),roomLikes=0; // roomLikes (v15.6.3) = total like seluruh live ini
// v15.5.3: selain name/others/n (dipakai chat, overlay, alert), pesan like membawa `list` = sampai 8 penyuka teratas di jendela 5 detik itu, tiap isi [nama, jumlah, TOTAL like orang itu sejak live ini].
//   Dock memakai daftar ini untuk notif di bawah "Total penonton" (1 nama saja, nama yang baru tampil dilewati). Total per orang direset tiap startTT (live baru).
function likeAdd(api,name,n){likeBuf.set(name,(likeBuf.get(name)||0)+n);likeTot.set(name,(likeTot.get(name)||0)+n);if(likeTot.size>5000)likeTot.delete(likeTot.keys().next().value);
  if(!likeT)likeT=setTimeout(()=>{likeT=null;const a=[...likeBuf].sort((x,y)=>y[1]-x[1]);likeBuf=new Map();if(!a.length)return;api.push({p:'tiktok',kind:'like',name:a[0][0],others:a.length-1,n:a.reduce((s,x)=>s+x[1],0),list:a.slice(0,8).map(([nm,c])=>[nm,c,likeTot.get(nm)||c])});},5000);}
// v1.0.2: gambar YouTube (Super Sticker, emblem member, emoji kustom channel) ikut dibawa ke chat, seperti gambar gift TikTok. Alamat dari YouTube kadang berawalan "//" (tanpa https:); hanya https yang diterima.
const yImg=o=>{let u=String((o&&(o.url||(o.thumbnail&&o.thumbnail.url)))||'');if(u.startsWith('//'))u='https:'+u;return /^https:\/\//.test(u)?u:undefined;};
// teks pesan + posisi emoji kustom ([mulai,akhir,url] dalam hitungan karakter, format yang sama dengan emote Twitch/Kick: fillText di app.js)
function yMsg(c){let t='';const emo=[];for(const x of (c.message||[])){const s=String(x.text||x.emojiText||x.alt||''),u=(x&&x.isCustomEmoji)?yImg(x):undefined,a=Array.from(t).length;t+=s;if(u&&s)emo.push([a,a+Array.from(s).length,u]);}return{t,emo:emo.length?emo:undefined};}
function startYT(t,api){
  let LiveChat;try{({LiveChat}=require('youtube-chat'));}catch(e){api.status('youtube','modul gagal dimuat: '+String(e&&e.message||e).split('\n')[0]);return null;}
  let stopped=false,cur=null;
  const attempt=()=>{
    if(stopped||!api.alive())return;
    const lc=new LiveChat(t);let dead=false;
    const retry=msg=>{if(dead)return;dead=true;try{lc.stop()}catch{}if(stopped||!api.alive())return;api.status('youtube',msg+' - coba lagi 15 detik');setTimeout(attempt,15000);};
    cur=()=>{dead=true;try{lc.stop()}catch{}};
    lc.on('start',id=>{if(id)api.live(id);api.status('youtube','terhubung');});
    lc.on('chat',c=>api.push({p:'youtube',member:!!c.isMembership,newMember:!!(c.isMembership&&!c.superchat&&!(c.message||[]).some(x=>String(x.text||x.emojiText||x.alt||'').trim())),sticker:!!(c.superchat&&c.superchat.sticker),stk:yImg(c.superchat&&c.superchat.sticker),mbd:yImg(c.author&&c.author.badge&&c.author.badge.thumbnail),emo:yMsg(c).emo,sc:c.superchat?{amount:String(c.superchat.amount||''),color:/^#?[0-9a-f]{6}$/i.test(c.superchat.color||'')?('#'+String(c.superchat.color).replace('#','')):'#ffca28'}:undefined,name:c.author.name,avatar:(c.author.thumbnail&&c.author.thumbnail.url)||'',mod:!!c.isModerator,owner:!!c.isOwner,text:yMsg(c).t||((c.superchat&&c.superchat.sticker)?'[Super Sticker]':'')}));
    lc.on('error',e=>retry('gagal: '+(e&&e.message||e)));
    lc.on('end',()=>retry('live berakhir/terputus'));
    api.status('youtube','menyambung...');
    lc.start().then(ok=>{if(!ok)retry('live tidak ditemukan (sudah mulai?)');}).catch(e=>retry('gagal: '+(e&&e.message||e)));
  };attempt();
  return ()=>{stopped=true;if(cur)cur();};
}
function startTT(user,api){
  likeTot=new Map();likeBuf=new Map();roomLikes=0; // v15.6.6: likeBuf live sebelumnya ikut dibuang. v15.5.3: total like per orang dihitung ulang untuk tiap live; v15.6.3: total like seluruh live juga
  let lib;try{lib=require('tiktok-live-connector');}catch(e){api.status('tiktok','modul gagal dimuat: '+String(e&&e.message||e).split('\n')[0]);return null;}
  let stopped=false,cur=null;
  const {TikTokLiveConnection,WebcastEvent,ControlEvent}=lib;
  const attempt=()=>{
    if(stopped||!api.alive())return;
    const c=new TikTokLiveConnection(user,{});let dead=false;
    // v15.6.5: total like harus SAMA dengan angka di live TikTok (yang sudah berjalan berjam-jam), bukan mulai dari 0.
    //   Sumber angka asli hanya dua: (1) field totalLikeCount di tiap event like, (2) info room TikTok (saat tersambung dan diperiksa berkala).
    //   Sebelum angka asli didapat, angka TIDAK ditampilkan (tetap "-") dan like yang masuk tidak dijumlahkan dari 0 lagi.
    //   Nama field info room beda antar versi, jadi dicari di beberapa tempat (kedalaman terbatas, cabang pemilik/hadiah/dll dilewati) dan diambil yang terbesar.
    let lpoll=null,lfail=0,lnone=0,synced=false,noTot=false;const stopPoll=()=>{if(lpoll){clearInterval(lpoll);lpoll=null;}};
    const numOf=v=>{if(typeof v==='object'&&v&&typeof v.toNumber==='function'){try{v=v.toNumber();}catch{return null;}}if(v&&typeof v==='object'&&typeof v.low==='number'&&typeof v.high==='number')v=v.high*4294967296+(v.low>>>0);if(typeof v!=='number'&&typeof v!=='string'&&typeof v!=='bigint')return null;if(v==='')return null;const n=Number(v);return Number.isFinite(n)&&n>=0?n:null;};
    const LKEY=/^(total_?)?likes?(_?(count|cnt|num|total))?$/i,LSKIP=/^(owner|user|author|anchor|host|gift|battle|link|cover|avatar|badge|fans|rank|top_?viewer|room_?auth)/i;
    const findLikes=(o,d)=>{if(!o||typeof o!=='object'||d>4||(Array.isArray(o)&&o.length>20))return null;let best=null;
      for(const k of Object.keys(o)){const v=o[k];let n=null;if(LKEY.test(k))n=numOf(v);else if(v&&typeof v==='object'&&!LSKIP.test(k))n=findLikes(v,d+1);if(n!=null&&(best==null||n>best))best=n;}return best;};
    const likesOf=r=>{if(!r||typeof r!=='object')return null;return findLikes(r.data&&typeof r.data==='object'?r.data:r,0);};
    const setLk=(n,src)=>{if(n==null||n<=0)return false; // v15.6.6: angka 0 dari info room bukan angka asli: jangan jadi titik awal (penyebab total like mulai dari 0 lalu hanya bertambah dari like yang masuk)
      if(!synced){synced=true;roomLikes=Math.max(roomLikes,n);if(api.note)api.note('likes: sumber='+src+', total di live='+roomLikes);if(api.likes)api.likes('tiktok',roomLikes);return true;}
      if(n>roomLikes){roomLikes=n;if(api.likes)api.likes('tiktok',roomLikes);}return true;};
    const takeLikes=r=>{const n=likesOf(r);if(n!=null){lnone=0;return setLk(n,'info room');}
      if(++lnone===3&&api.note){try{const d=r&&r.data&&typeof r.data==='object'?r.data:r||{};api.note('likes: info room TikTok tidak memuat jumlah like; field data = '+Object.keys(d).slice(0,40).join(',')+(d.stats&&typeof d.stats==='object'?' | stats = '+Object.keys(d.stats).slice(0,40).join(','):''));}catch{}}return false;};
    const pollOnce=()=>{if(dead||stopped||!api.alive()){stopPoll();return;}Promise.resolve().then(()=>c.fetchRoomInfo()).then(r=>{lfail=0;takeLikes(r);}).catch(e=>{if(lfail===0&&api.note)api.note('likes: fetchRoomInfo gagal: '+String(e&&e.message||e).slice(0,200));if(++lfail>=3)stopPoll();});};
    const startPoll=()=>{stopPoll();if(typeof c.fetchRoomInfo!=='function')return;lpoll=setInterval(pollOnce,45000);if(lpoll.unref)lpoll.unref();if(!synced){const t=setTimeout(pollOnce,3000);if(t.unref)t.unref();}};
    const retry=msg=>{if(dead)return;dead=true;stopPoll();try{c.disconnect()}catch{}if(stopped||!api.alive())return;api.viewers('tiktok',null);api.status('tiktok',msg+' - coba lagi 15 detik');setTimeout(attempt,15000);};
    cur=()=>{dead=true;stopPoll();try{c.disconnect()}catch{}};
    c.on(WebcastEvent.CHAT,d=>{const u=d.user||{};api.push({p:'tiktok',name:u.nickname||u.displayId||u.uniqueId||'?',avatar:first(u),mod:!!(u.isModerator||u.isModeratorOfAnchor||(u.userAttr&&u.userAttr.isAdmin)),text:String(d.content??d.comment??'')});});
    // Semua handler aktivitas dibungkus safe(): bentuk payload bisa beda antar versi, dan tidak boleh sampai menjatuhkan aplikasi.
    const E=WebcastEvent||{},safe=f=>(...a)=>{try{f(...a);}catch(e){console.log('[tiktok] '+(e&&e.message||e));}},nm=u=>(u&&(u.nickname||u.displayId||u.uniqueId))||'?';
    c.on(E.MEMBER||'member',safe(d=>api.push({p:'tiktok',kind:'join',name:nm(d.user)})));
    c.on(E.FOLLOW||'follow',safe(d=>api.push({p:'tiktok',kind:'follow',name:nm(d.user)})));
    // v15.3.3: "posting ulang" (repost). Pengenalan berdasarkan teks displayType/label pada payload share/social (TEBAKAN, belum diuji dengan live TikTok sungguhan). Event yang sama dari dua jalur tidak dihitung dua kali.
    const rp=d=>/repost|re-?share/i.test([d&&d.displayType,d&&d.label,d&&d.action,d&&d.common&&d.common.displayText&&d.common.displayText.key].filter(x=>typeof x==='string').join(' ')),rpAt=new Map(),repost=d=>{const n=nm(d.user),t=Date.now();if(t-(rpAt.get(n)||0)<3000)return;rpAt.set(n,t);api.push({p:'tiktok',kind:'repost',name:n});};
    c.on(E.SHARE||'share',safe(d=>{if(rp(d))repost(d);else api.push({p:'tiktok',kind:'share',name:nm(d.user)});}));
    c.on(E.SOCIAL||'social',safe(d=>{if(rp(d))repost(d);}));
    c.on(E.SUBSCRIBE||'subscribe',safe(d=>api.push({p:'tiktok',kind:'sub',name:nm(d.user)})));
    c.on(E.GIFT||'gift',safe(d=>{
      const gd=d.giftDetails||d.gift||{},type=gd.giftType!=null?gd.giftType:d.giftType;
      if(type===1&&!d.repeatEnd)return; // streak masih berjalan: tunggu event akhir supaya tidak terhitung berkali-kali
      const n=Number(d.repeatCount)||1,dia=Number(gd.diamondCount!=null?gd.diamondCount:d.diamondCount)||0;
      const gi=gd.giftImage||gd.image||d.giftImage||{},img=gd.giftPictureUrl||d.giftPictureUrl||gi.giftPictureUrl||(gi.urlList&&gi.urlList[0])||(gd.icon&&gd.icon.urlList&&gd.icon.urlList[0])||'';
      api.push({p:'tiktok',kind:'gift',name:nm(d.user),gift:String(gd.giftName||gd.name||d.giftName||'hadiah'),n,coins:dia*n,img:/^https?:\/\//.test(img)?img:undefined});}));
    // like datang bertubi-tubi: dihitung semua untuk statistik, tapi ditampilkan sebagai satu baris per 5 detik
    // v15.6.5: totalLikeCount = total like seluruh live menurut TikTok, dipakai apa adanya begitu ada (angka asli, bukan mulai dari 0).
    //   Kalau event tidak membawanya: sesudah angka asli pernah didapat (info room) like yang masuk ditambahkan ke angka itu; sebelum itu tidak ada yang ditampilkan.
    c.on(E.LIKE||'like',safe(d=>{const n=Number(d.likeCount)||1;api.like(n);likeAdd(api,nm(d.user),n);
      const tc=[d.totalLikeCount,d.total,d.totalLikes].map(numOf).find(x=>x!=null&&x>0); // v15.6.6: nama field total dicoba beberapa, angka berbentuk Long {low,high} ikut terbaca
      if(tc==null&&!noTot){noTot=true;if(api.note)api.note('likes: event like tanpa total; field = '+Object.keys(d).slice(0,40).join(','));}
      if(tc!=null&&tc>0){if(!synced&&api.note)api.note('likes: sumber=event like (totalLikeCount), total di live='+tc);synced=true;if(tc>roomLikes){roomLikes=tc;if(api.likes)api.likes('tiktok',roomLikes);}}
      else{roomLikes+=n;if(api.likes)api.likes('tiktok',roomLikes);}})); // v15.6.6: like yang masuk selalu dihitung dan tampil; begitu angka asli didapat (event/info room), angka langsung melompat ke angka asli (setLk memakai yang terbesar)
    c.on(E.ROOM_USER||'roomUser',safe(d=>{
      // hanya penonton yang sedang menonton (viewerCount/total); popularity & totalUser bersifat kumulatif, sengaja tidak dipakai
      const a=[d.viewerCount,d.total].map(x=>x==null?NaN:Number(x)).filter(x=>Number.isFinite(x)&&x>=0);
      const n=a.find(x=>x>0);if(n!==undefined)api.viewers('tiktok',n);else if(a.length)api.viewers('tiktok',0);}));
    c.on(ControlEvent.DISCONNECTED,()=>retry('terputus'));
    api.status('tiktok','menyambung...');
    c.connect().then(st=>{api.status('tiktok','terhubung');if(api.likes&&!synced)api.likes('tiktok',roomLikes); // v15.6.6: setelah pindah live, total like tampil (0 dulu) dan melompat ke angka asli begitu didapat, tidak tertahan "-"
      try{takeLikes((st&&st.roomInfo)||c.roomInfo);}catch{}startPoll();}).catch(e=>retry('gagal: '+(e&&e.message||e)));
  };attempt();
  return ()=>{stopped=true;if(cur)cur();};
}
module.exports={startYT,startTT};
