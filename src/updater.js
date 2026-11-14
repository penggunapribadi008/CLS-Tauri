// Pemeriksa + pengunduh pembaruan lewat GitHub Releases (dipanggil cangkang Tauri sebagai proses node terpisah).
//   node updater.js check <pemilik/repo> <versi-sekarang>
//   node updater.js download <pemilik/repo> <berkas-tujuan>
// Keluaran: satu JSON per baris di stdout. Repo harus PUBLIC (tanpa token). Pemasangan TIDAK dilakukan di sini.
// Keamanan: hanya aset *x64-setup.exe dari github.com; SHA-256 wajib cocok (dari 'digest' rilis atau berkas .sha256), kalau tidak berkas dihapus.
'use strict';
const fs=require('fs'),crypto=require('crypto');
const API=(process.env.CSL_GH_API||'https://api.github.com').replace(/\/+$/,'');
const TEST=!!process.env.CSL_GH_API; // hanya tes yang boleh memakai alamat selain github.com
const out=o=>process.stdout.write(JSON.stringify(o)+'\n');
const UA='ChatStreamLabs-updater';

function parts(v){const m=/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v||'').trim());return m?[+m[1],+(m[2]||0),+(m[3]||0)]:[0,0,0];}
function newer(a,b){const x=parts(a),y=parts(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;}
const okUrl=u=>TEST||String(u||'').startsWith('https://github.com/');

async function getJson(url){
  const r=await fetch(url,{headers:{'User-Agent':UA,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
  if(r.status===404)return{status:404};
  if(!r.ok)throw new Error('HTTP '+r.status);
  return{status:200,json:await r.json()};
}
async function latest(repo){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo))throw new Error('repo tidak sah');
  const g=await getJson(API+'/repos/'+repo+'/releases/latest');
  if(g.status===404)return null;
  const j=g.json;
  if(!j||j.draft||j.prerelease||!j.tag_name)return null;
  const assets=Array.isArray(j.assets)?j.assets:[];
  const exe=assets.find(a=>/x64-setup\.exe$/i.test(String(a.name||''))&&okUrl(a.browser_download_url));
  if(!exe)return null;
  const sha=assets.find(a=>String(a.name||'').toLowerCase()===String(exe.name).toLowerCase()+'.sha256'&&okUrl(a.browser_download_url));
  const dg=/^sha256:([0-9a-f]{64})$/i.exec(String(exe.digest||''));
  return{tag:String(j.tag_name),version:String(j.tag_name).replace(/^v/i,''),name:String(exe.name),url:exe.browser_download_url,sha256:dg?dg[1].toLowerCase():'',shaUrl:sha?sha.browser_download_url:'',size:+exe.size||0};
}
async function expectedSha(rel){
  if(rel.sha256)return rel.sha256;
  if(!rel.shaUrl)return '';
  const r=await fetch(rel.shaUrl,{headers:{'User-Agent':UA},signal:AbortSignal.timeout(15000)});
  if(!r.ok)return '';
  const m=/^\s*([0-9a-f]{64})/i.exec((await r.text()).slice(0,200));
  return m?m[1].toLowerCase():'';
}

async function check(repo,cur){
  const rel=await latest(repo);
  if(!rel||!newer(rel.tag,cur))return out({status:'none'});
  out({status:'available',tag:rel.tag,version:rel.version,name:rel.name,size:rel.size});
}

async function download(repo,dest){
  const rel=await latest(repo);
  if(!rel)return out({status:'error',error:'rilis tidak ditemukan'});
  const want=await expectedSha(rel);
  if(!want)return out({status:'error',error:'rilis tidak punya checksum SHA-256, dibatalkan demi keamanan'});
  const r=await fetch(rel.url,{headers:{'User-Agent':UA},redirect:'follow',signal:AbortSignal.timeout(600000)});
  if(!r.ok||!r.body)return out({status:'error',error:'gagal mengunduh (HTTP '+r.status+')'});
  const total=+r.headers.get('content-length')||rel.size||0,MAX=400*1024*1024,part=dest+'.part';
  const h=crypto.createHash('sha256'),fd=fs.openSync(part,'w');
  let got=0,last=-1;
  try{
    for await(const chunk of r.body){
      got+=chunk.length;if(got>MAX)throw new Error('berkas terlalu besar');
      h.update(chunk);fs.writeSync(fd,chunk);
      if(total){const p=Math.min(99,Math.floor(got*100/total));if(p!==last){last=p;out({p});}}
    }
  }catch(e){try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(part);}catch{}return out({status:'error',error:String(e&&e.message||e)});}
  fs.closeSync(fd);
  if(got<64*1024){try{fs.unlinkSync(part);}catch{}return out({status:'error',error:'berkas terlalu kecil'});}
  if(h.digest('hex')!==want){try{fs.unlinkSync(part);}catch{}return out({status:'error',error:'checksum tidak cocok, berkas ditolak'});}
  fs.renameSync(part,dest);
  out({p:100});out({status:'done',path:dest,tag:rel.tag});
}

(async()=>{
  const [,,mode,a,b]=process.argv;
  try{
    if(mode==='check')await check(a,b);
    else if(mode==='download')await download(a,b);
    else out({status:'error',error:'perintah tidak dikenal'});
  }catch(e){out({status:'error',error:String(e&&e.message||e)});}
  process.exit(0);
})();
module.exports={newer,parts};
