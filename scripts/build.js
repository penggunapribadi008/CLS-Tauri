// Membangun folder build/ (dijalankan otomatis oleh npm start / npm run dist).
//   src/ui/{style.css,body.html,app.js} -> build/index.html   (satu berkas, dilayani server lokal)
//   src/ui/{ctl,galert}.html -> build/{ctl,galert}.html   (halaman mungil jendela tombol & jendela alert, v15.5.0)
//   src/server.js (+ ws, youtube-chat, tiktok-live-connector, seeds.json) -> build/server.js   (satu bundel CommonJS)
//   src/conn-worker.js (+ connectors.js, youtube-chat, tiktok-live-connector) -> build/conn-worker.js   (proses konektor terpisah, v15.4.2)
//   src/main.js + aset -> build/
const fs=require('fs'),path=require('path'),esbuild=require('esbuild');
const root=path.join(__dirname,'..'),out=path.join(root,'build'),VER=require('./version').check(true),ui=f=>fs.readFileSync(path.join(root,'src/ui',f),'utf8').split('{{VERSION}}').join(VER); // {{VERSION}} = versi dari package.json (tidak boleh ditulis manual)
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'index.html'),
  '<!doctype html><html lang="id"><head><meta charset="utf-8"><title>ChatStream Labs</title>\n<style>'+ui('style.css')+'</style><style id="usercss"></style></head>\n'+ui('body.html')+'<script>\n'+ui('app.js')+'</script></body></html>\n');
for(const f of['ctl.html','galert.html'])fs.writeFileSync(path.join(out,f),ui(f)); // v15.5.0: halaman mungil untuk jendela tombol (ctl) dan jendela alert; dulu keduanya memuat index.html penuh (±190 KB) di proses tampilan sendiri
esbuild.buildSync({entryPoints:[path.join(root,'src/server.js')],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:path.join(out,'server.js'),
  external:['bufferutil','utf-8-validate'],minifyWhitespace:true,minifySyntax:true,logLevel:'error'});
esbuild.buildSync({entryPoints:[path.join(root,'src/conn-worker.js')],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:path.join(out,'conn-worker.js'),
  external:['bufferutil','utf-8-validate','electron'],minifyWhitespace:true,minifySyntax:true,logLevel:'error'}); // v15.4.2: proses konektor YouTube/TikTok (utilityProcess), berisi youtube-chat + tiktok-live-connector
fs.copyFileSync(path.join(root,'src/main.js'),path.join(out,'main.js'));
fs.copyFileSync(path.join(root,'src/extsync.js'),path.join(out,'extsync.js')); // dipakai main.js (salin folder ekstensi tetap)
for(const f of['yt.png','tt.png','tw.png','kick.png','icon.png'])fs.copyFileSync(path.join(root,'assets',f),path.join(out,f));
fs.writeFileSync(path.join(out,'splash.html'),fs.readFileSync(path.join(root,'src/splash.html'),'utf8').split('{{VERSION}}').join(VER)); // versi di pojok kanan bawah splash (v15.3.3)
for(const f of['splash-bg.webp','splash-logo.png'])fs.copyFileSync(path.join(root,'assets',f),path.join(out,f));
console.log('build/ siap');
