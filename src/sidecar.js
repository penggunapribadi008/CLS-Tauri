// Menjalankan server.js TANPA Electron (dipakai cangkang Tauri/Rust; lihat shell/).
// Server tetap sama persis. Hanya "hooks" (hal yang butuh jendela/OS) yang dialihkan ke cangkang:
//   sidecar -> cangkang (stdout, 1 JSON per baris):
//     {t:'ready',port}                        server siap
//     {t:'hook',name,args}                    perintah tanpa jawaban (lock, drag, resize, openChat, ...)
//     {t:'hook',id,name,args}                 perintah yang ditunggu jawabannya (donate, saveCss, netFetch, checkUpdate, setHotkeys)
//   cangkang -> sidecar (stdin, 1 JSON per baris):
//     {t:'reply',id,value}                    jawaban untuk hook ber-id
//     {t:'state',dash}                        status jendela untuk /dash-state ({chat:{open,locked},docks:{id:{open,locked}}})
//     {t:'ver',v}                             versi aplikasi (untuk ekstensi Chrome)
//     {t:'cmd',name} | {t:'setGlobal',obj} | {t:'endSession'}   (hotkey di cangkang -> server)
//     {t:'quit'}                              simpan data lalu keluar
// stdin tertutup (cangkang mati) = simpan data lalu keluar.
'use strict';
// stdout dipakai KHUSUS untuk protokol di atas; log biasa server (console.log) dialihkan ke stderr.
console.log=(...a)=>{try{process.stderr.write(a.map(String).join(' ')+'\n');}catch{}};
const readline=require('readline'),path=require('path');
const srv=require('./server.js');

// Folder ekstensi Chrome tetap di data pengguna disamakan dengan extension/ milik aplikasi (dulu dilakukan main.js: syncExtension).
let extOk=false;
if(process.env.CSL_EXT_SRC&&process.env.CG_DATA){
  try{const ch=require('./extsync.js').syncDir(process.env.CSL_EXT_SRC,path.join(process.env.CG_DATA,'extension'));extOk=true;if(ch.length)console.log('ekstensi: diperbarui ('+ch.join(', ')+')');}
  catch(e){console.log('ekstensi: gagal menyalin: '+(e&&e.message||e));}
}

const WAIT_MS=20000;
let seq=0,dash={chat:{},docks:{}},appVer='';
const pending=new Map();
const out=o=>{try{process.stdout.write(JSON.stringify(o)+'\n');}catch{}};
const fire=name=>(...args)=>{out({t:'hook',name,args});};
const ask=(name,args,dflt)=>new Promise(res=>{
  const id=++seq;
  const to=setTimeout(()=>{pending.delete(id);res(dflt);},WAIT_MS);
  pending.set(id,v=>{clearTimeout(to);res(v===undefined?dflt:v);});
  out({t:'hook',id,name,args});
});

Object.assign(srv.hooks,{
  protect:fire('protect'),open:fire('open'),window:fire('window'),lock:fire('lock'),chatFocus:fire('chatFocus'),
  drag:fire('drag'),resize:fire('resize'),openSettings:fire('openSettings'),openReport:fire('openReport'),openChat:fire('openChat'),
  winCtl:fire('winCtl'),shape:fire('shape'),galert:fire('galert'),global:fire('global'),relaunch:fire('relaunch'),
  setHotkeys:map=>ask('setHotkeys',[map],{}),
  donate:(act,id)=>ask('donate',[act,id],{error:'tidak tersedia'}),
  saveCss:(name,css)=>ask('saveCss',[name,css],{canceled:true}),
  netFetch:url=>ask('netFetch',[url],{status:0,text:''}),
  checkUpdate:()=>ask('checkUpdate',[],'error'),
  appVersion:()=>extOk?appVer:'',
  dashState:()=>dash
  // spawnConn sengaja tidak diisi: di sini server sudah terpisah dari UI, jadi konektor YouTube/TikTok jalan di proses ini (cadangan bawaan server).
});

function bye(){try{srv.flush&&srv.flush();}catch{}process.exit(0);}
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  if(!m||typeof m!=='object')return;
  try{
    if(m.t==='reply'){const f=pending.get(m.id);if(f){pending.delete(m.id);f(m.value);}}
    else if(m.t==='state'&&m.dash&&typeof m.dash==='object')dash=m.dash;
    else if(m.t==='ver')appVer=String(m.v||'');
    else if(m.t==='cmd'&&typeof m.name==='string')srv.cmd(m.name);
    else if(m.t==='setGlobal'&&m.obj&&typeof m.obj==='object')srv.setGlobal(m.obj);
    else if(m.t==='endSession')srv.endSession&&srv.endSession();
    else if(m.t==='quit')bye();
  }catch(e){process.stderr.write('sidecar: '+(e&&e.message||e)+'\n');}
});
rl.on('close',bye);
process.on('SIGTERM',bye);
process.on('uncaughtException',e=>process.stderr.write('sidecar uncaught: '+(e&&e.stack||e)+'\n'));
process.on('unhandledRejection',e=>process.stderr.write('sidecar rejection: '+(e&&e.stack||e)+'\n'));
srv.ready.then(()=>out({t:'ready',port:srv.port}));
