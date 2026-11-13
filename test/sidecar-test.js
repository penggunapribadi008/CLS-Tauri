// Tes jembatan sidecar dengan server PALSU (tanpa npm install). Jalankan: node test/sidecar-test.js
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sc-'));
fs.copyFileSync(path.join(__dirname,'../src/sidecar.js'),path.join(dir,'sidecar.js'));
fs.writeFileSync(path.join(dir,'server.js'),`
const hooks={};let r;const ready=new Promise(x=>r=x);setTimeout(r,50);
const log=[];
module.exports={hooks,ready,get port(){return 3456;},cmd:n=>{hooks.__log=(hooks.__log||[]);hooks.__log.push('cmd:'+n);if(n==='probe'){hooks.lock(true,'chat');hooks.setHotkeys({lock:'Ctrl+Alt+L'}).then(r=>hooks.donate('toggle','d1').then(d=>process.stdout.write(JSON.stringify({t:'probe',hk:r,don:d,ver:hooks.appVersion(),dash:hooks.dashState()})+'\\n')));}},
  setGlobal:o=>{process.stdout.write(JSON.stringify({t:'sg',o})+'\\n');},endSession:()=>process.stdout.write(JSON.stringify({t:'es'})+'\\n'),flush:()=>process.stdout.write(JSON.stringify({t:'flush'})+'\\n')};`);
fs.writeFileSync(path.join(dir,'extsync.js'),"module.exports={syncDir:(s,d)=>{require('fs').mkdirSync(d,{recursive:true});return ['manifest.json'];}};");
const data=path.join(dir,'data');fs.mkdirSync(data);
const p=spawn(process.execPath,[path.join(dir,'sidecar.js')],{stdio:['pipe','pipe','inherit'],env:{...process.env,CG_DATA:data,CSL_EXT_SRC:path.join(dir,'ext')}});
const got=[];let buf='',fails=0;
const ck=(c,m)=>{if(!c){console.log('GAGAL',m);fails++;}};
p.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);let m;try{m=JSON.parse(l);}catch{continue;}got.push(m);
  if(m.t==='hook'&&m.id){const v=m.name==='setHotkeys'?{lock:true}:m.name==='donate'?{ok:true,id:m.args[1]}:undefined;p.stdin.write(JSON.stringify({t:'reply',id:m.id,value:v})+'\n');}}});
const send=o=>p.stdin.write(JSON.stringify(o)+'\n');
setTimeout(()=>{send({t:'ver',v:'1.1.1'});send({t:'state',dash:{chat:{open:true,locked:true},docks:{}}});send({t:'setGlobal',obj:{protect:false}});send({t:'endSession'});send({t:'cmd',name:'probe'});send('bukan json');},200);
setTimeout(()=>{
  ck(got.some(m=>m.t==='ready'&&m.port===3456),'ready+port');
  ck(got.some(m=>m.t==='hook'&&m.name==='lock'&&m.args[0]===true&&m.args[1]==='chat'&&!m.id),'hook lock tanpa id');
  ck(got.some(m=>m.t==='sg'&&m.o.protect===false),'setGlobal diteruskan');
  ck(got.some(m=>m.t==='es'),'endSession diteruskan');
  const pr=got.find(m=>m.t==='probe');
  ck(pr&&pr.hk.lock===true&&pr.don.ok===true&&pr.don.id==='d1','hook ber-id mendapat jawaban');
  ck(pr&&pr.ver==='1.1.1'&&pr.dash.chat.locked===true,'ver + dashState dari cangkang');
  ck(fs.existsSync(path.join(data,'extension')),'folder ekstensi disalin');
  send({t:'quit'});
},900);
p.on('exit',c=>{ck(got.some(m=>m.t==='flush'),'flush saat quit');ck(c===0,'keluar bersih');console.log(fails?fails+' tes gagal':'tes sidecar lulus');process.exit(fails?1:0);});
