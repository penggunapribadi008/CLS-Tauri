// Menyiapkan bahan untuk cangkang Tauri (shell/). Jalankan: node scripts/build-tauri.js
//   shell/app/     -> resource yang ikut terpasang: index.html, ctl.html, galert.html, sidecar.js (server + konektor, satu bundel), gambar, extension/
//   shell/splash/  -> frontendDist (ditanam di dalam exe): splash.html + gambar splash
const fs=require('fs'),path=require('path'),esbuild=require('esbuild');
require('./build.js'); // UI + server -> build/ (dan cek versi)
const root=path.join(__dirname,'..'),b=path.join(root,'build'),app=path.join(root,'shell','app'),sp=path.join(root,'shell','splash');
for(const d of[app,sp]){fs.rmSync(d,{recursive:true,force:true});fs.mkdirSync(d,{recursive:true});}
esbuild.buildSync({entryPoints:[path.join(root,'src/sidecar.js')],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:path.join(app,'sidecar.js'),
  external:['bufferutil','utf-8-validate'],minifyWhitespace:true,minifySyntax:true,logLevel:'error'});
for(const f of['index.html','ctl.html','galert.html','yt.png','tt.png','tw.png','kick.png','icon.png'])fs.copyFileSync(path.join(b,f),path.join(app,f)); // server melayani berkas-berkas ini dari folder sidecar.js
fs.cpSync(path.join(root,'extension'),path.join(app,'extension'),{recursive:true});
fs.copyFileSync(path.join(b,'splash.html'),path.join(sp,'splash.html'));
for(const f of['splash-bg.webp','splash-logo.png'])fs.copyFileSync(path.join(root,'assets',f),path.join(sp,f));
console.log('shell/app dan shell/splash siap');
