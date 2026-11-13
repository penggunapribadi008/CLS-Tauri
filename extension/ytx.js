// v1.1.0: berjalan di dunia HALAMAN (world MAIN) pada halaman chat YouTube. Hanya MEMBACA balasan get_live_chat milik halaman itu sendiri (tidak mengubah request / tampilan),
// lalu menitipkan dua hal ke yt.js lewat window.postMessage:
//  - k:'gift'   item chat yang BUKAN teks / Super Chat / Super Sticker / member (mis. hadiah "mengirimkan Go team!"), yang tidak dibaca modul youtube-chat
//  - k:'diag'   contoh bentuk data yang belum dikenal (sekali per jenis) supaya bisa dicatat ke log.txt aplikasi
(function(){
  if(window.__csytx)return;window.__csytx=1;
  const post=o=>{try{window.postMessage(Object.assign({__cs_yt:1},o),'*');}catch{}};
  const HANDLED=new Set(['liveChatTextMessageRenderer','liveChatPaidMessageRenderer','liveChatPaidStickerRenderer','liveChatMembershipItemRenderer']);
  const SYSTEM=/^liveChat(Placeholder|ViewerEngagement|ModeChange|AutoMod|Banner|Poll|Ticker|RestrictedParticipation)/;
  const seen=new Set(),diagDone=new Set();
  const diag=(tag,o)=>{if(diagDone.has(tag))return;diagDone.add(tag);let s='';try{s=JSON.stringify(o);}catch{}post({k:'diag',msg:'yt '+tag+': '+s.slice(0,700)});};
  const str=o=>{if(o==null)return'';if(typeof o==='string')return o;if(typeof o!=='object')return'';
    if(typeof o.simpleText==='string')return o.simpleText;if(typeof o.content==='string')return o.content;
    if(Array.isArray(o.runs))return o.runs.map(r=>r?(r.text||(r.emoji&&((r.emoji.shortcuts&&r.emoji.shortcuts[0])||r.emoji.emojiId))||''):'').join('');return'';};
  const findKey=(o,key,d)=>{if(!o||typeof o!=='object'||d>10)return;if(Array.isArray(o)){for(const x of o){const r=findKey(x,key,d+1);if(r!==undefined)return r;}return;}
    if(key in o)return o[key];for(const k in o){const r=findKey(o[k],key,d+1);if(r!==undefined)return r;}};
  // kumpulkan teks dan gambar dari sebuah item (nama & foto penulis dilewati)
  function gather(o,texts,imgs,d){if(!o||typeof o!=='object'||d>12)return;
    if(Array.isArray(o)){for(const x of o)gather(x,texts,imgs,d+1);return;}
    const t=(typeof o.simpleText==='string'||typeof o.content==='string'||Array.isArray(o.runs))?str(o).trim():'';if(t)texts.push(t);
    for(const k in o){if(k==='authorName'||k==='authorPhoto'||k==='authorBadges'||k==='avatar'||k==='authorAvatar'||k==='profileImage')continue;const v=o[k];
      if(typeof v==='string'&&(k==='url'||k==='src'||k==='imageUrl')){let u=v;if(u.startsWith('//'))u='https:'+u;if(/^https:\/\//.test(u))imgs.push(u);}
      else if((k==='thumbnails'||k==='sources')&&Array.isArray(v)){for(const x of v){let u=String(x&&x.url||'');if(u.startsWith('//'))u='https:'+u;if(/^https:\/\//.test(u))imgs.push(u);}}
      else gather(v,texts,imgs,d+1);}}
  function oneItem(it){
    const key=Object.keys(it||{})[0];if(!key||HANDLED.has(key)||SYSTEM.test(key))return;
    const body=it[key];if(!body)return;const id=String(body.id||'');if(id){if(seen.has(id))return;seen.add(id);if(seen.size>400)seen.clear();}
    const name=str(findKey(body,'authorName',0)).trim();
    if(!name){diag('item-tanpa-nama:'+key,it);return;}
    const ph=findKey(body,'authorPhoto',0),th=ph&&ph.thumbnails&&ph.thumbnails[0]&&ph.thumbnails[0].url;
    const texts=[],imgs=[];gather(body,texts,imgs,0);
    const seenT=new Set(),parts=[];for(const t of texts){const x=t.replace(name,'').trim();if(x&&x.length<200&&!seenT.has(x)){seenT.add(x);parts.push(x);}}
    const text=parts.join(' ').trim();diag('item:'+key,it);
    if(!text)return;
    // gambar hadiah = gambar pertama yang BUKAN foto profil (foto profil YouTube berpola /ytc/ atau ...c0x00ffffff...); tidak ada = alert memakai ikon kado
    const av=th?(String(th).startsWith('//')?'https:'+th:String(th)):'',pic=imgs.filter(u=>u!==av&&!/\/ytc\/|c0x00ffffff|-k-c0x/.test(u))[0]||'';
    post({k:'gift',name,avatar:av,text,img:pic});}
  function handle(j){try{
    const lc=j&&j.continuationContents&&j.continuationContents.liveChatContinuation;
    if(lc&&Array.isArray(lc.actions))for(const a of lc.actions){const it=a&&a.addChatItemAction&&a.addChatItemAction.item;if(it)oneItem(it);}
    }catch{}}
  const isLC=u=>String(u||'').includes('/live_chat/get_live_chat');
  try{const of=window.fetch;if(of)window.fetch=function(a){const p=of.apply(this,arguments);try{const u=a&&a.url?a.url:a;if(isLC(u))p.then(r=>r.clone().json()).then(handle).catch(()=>{});}catch{}return p;};}catch{}
  try{const oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{if(isLC(u))this.addEventListener('load',()=>{try{handle(JSON.parse(this.responseText));}catch{}});}catch{}return oo.apply(this,arguments);};}catch{}
})();
