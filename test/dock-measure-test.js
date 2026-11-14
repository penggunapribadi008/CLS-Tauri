const fs=require('fs');const src=(()=>{const s=fs.readFileSync(require('path').join(__dirname,'../shell/src-tauri/src/main.rs'),'utf8');return /const MEAS_JS: &str = r##"([\s\S]*?)"##;/.exec(s)[1];})();
function run(hash,rects){
  const calls=[];let timers=[];
  const el=(r,par)=>({nodeType:1,parentElement:par||null,tagName:'IMG',getBoundingClientRect:()=>r});
  const body={nodeType:1,parentElement:null};
  const els=rects.map(r=>el({width:r.w,height:r.h,left:r.x,top:r.y,right:r.x+r.w,bottom:r.y+r.h},body));
  const g={window:{},Map,Math,
    document:{body,documentElement:body,querySelectorAll:()=>els,createTreeWalker:()=>({nextNode:()=>null}),createRange:()=>({})},
    NodeFilter:{SHOW_TEXT:4},getComputedStyle:()=>({display:'block',opacity:'1',visibility:'visible'}),
    location:{hash,pathname:'/alert',search:'?key=RAHASIA'},history:{state:null,replaceState:(a,b,u)=>calls.push(u)},
    setInterval:f=>timers.push(f),setTimeout:f=>timers.push(f)};
  new Function(...Object.keys(g),'return '+src)(...Object.values(g));
  timers.forEach(f=>f());   // jalankan tick
  return calls;
}
let f=0;const ck=(c,m)=>{if(!c){console.log('GAGAL',m);f++;}};
let c=run('',[{x:100,y:50,w:300,h:120},{x:120,y:60,w:600,h:80}]);
ck(c[0]==='/alert?key=RAHASIA#__csl=620,120','gabungan kotak: lebar 100..720 = 620, tinggi 50..170 = 120 -> '+c[0]);
c=run('#__csl=1,1',[{x:0,y:0,w:200,h:100}]);ck(c[0]==='/alert?key=RAHASIA#__csl=200,100','hash milik sendiri boleh ditimpa');
c=run('#/rute-sendiri',[{x:0,y:0,w:200,h:100}]);ck(c.length===0,'halaman dengan # sendiri dibiarkan');
c=run('',[]);ck(c.length===0,'tanpa isi terlihat: tidak menulis apa pun');
c=run('',[{x:0,y:0,w:1,h:1}]);ck(c.length===0,'kotak <2px diabaikan');
console.log(f?f+' gagal':'tes ukur lulus');process.exit(f?1:0);
