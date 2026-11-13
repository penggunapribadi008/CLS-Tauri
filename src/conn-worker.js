// Proses konektor YouTube/TikTok (v15.4.2), dijalankan Electron lewat utilityProcess.fork (lihat hooks.spawnConn di main.js).
// Memuat pustaka berat + mengurai payload di sini, bukan di proses utama, supaya jendela dan tombol gembok tidak ikut macet.
// Protokol (JSON biasa lewat parentPort):
//   dari server  : {cmd:'yt',target,my} | {cmd:'tt',user,my} | {cmd:'stop',k} | {cmd:'warm',yt,tt}
//   ke server    : {t:'ready'} | {t:'status'|'push'|'viewers'|'likes'|'like'|'live', k, my, ...}   (`my` = generasi sambungan; server membuang yang basi)
const C=require('./connectors.js');
const port=process.parentPort;
const send=m=>{try{port.postMessage(m);}catch{}};
const stops={youtube:null,tiktok:null};
const apiFor=(k,my)=>({
  alive:()=>true, // yang basi dihentikan lewat cmd 'stop' dan dibuang server lewat `my`
  status:(p,v)=>send({t:'status',k,my,p,v}),
  push:m=>send({t:'push',k,my,m}),
  viewers:(p,n)=>send({t:'viewers',k,my,p,n}),
  likes:(p,n)=>send({t:'likes',k,my,p,n}),
  like:n=>send({t:'like',k,my,n}),
  note:msg=>send({t:'note',k,my,msg}), // v15.6.5: catatan diagnosa ke log.txt (asal total like)
  live:id=>send({t:'live',k,my,id})
});
const stop=k=>{const f=stops[k];stops[k]=null;if(f){try{f();}catch{}}};
port.on('message',e=>{
  const d=(e&&e.data)||{};
  try{
    if(d.cmd==='yt'){stop('youtube');stops.youtube=C.startYT(d.target,apiFor('youtube',d.my));}
    else if(d.cmd==='tt'){stop('tiktok');stops.tiktok=C.startTT(d.user,apiFor('tiktok',d.my));}
    else if(d.cmd==='stop'){stop(d.k);}
    else if(d.cmd==='warm'){if(d.yt){try{require('youtube-chat');}catch{}}if(d.tt){try{require('tiktok-live-connector');}catch{}}}
  }catch(err){send({t:'error',msg:String(err&&err.message||err)});}
});
process.on('uncaughtException',err=>send({t:'error',msg:String(err&&err.stack||err).slice(0,500)}));
send({t:'ready'});
