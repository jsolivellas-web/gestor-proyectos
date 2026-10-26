/* Diagrama de flujo compartido: varias personas editan el mismo tablero a la vez.
   - flujo.html?tablero=<id> abre un tablero de Supabase en lugar del diagrama personal.
   - Cada cambio se envía por forma/flecha (Realtime broadcast) y se guarda con la función apply_flow_ops,
     así dos personas que tocan cosas distintas no se pisan.
   - La presencia muestra quién está conectado y qué forma tiene seleccionada cada uno.
   Usa D, H, SEL, VIEW, DRAG, fix, snap, node, cleanSel, render, draw, fit, toast y esc de flujo.html.
   En la app de Windows (sin cloud.js) no hace nada. */
(function(){
  if(window.NL_PORT||!window.cloudReady){window.FlowCollab=null;return;}
  var params=new URLSearchParams(location.search);
  var boardId=params.get('tablero');
  if(boardId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(boardId))boardId=null;
  var C={boardId:boardId};
  window.FlowCollab=C;

  var sb=null,user=null,token=null,channel=null,owner=null;
  var SYNCED=null,pend=null,flushT=0,retryT=0,loading=false,buffer=[];
  var peers={},peerSel={},lastSel='',selT=0,liveT=0;
  var COLORS=['#e8590c','#7048e8','#0ca678','#d6336c','#1c7ed6','#f08c00','#2f9e44','#ae3ec9'];
  function colorFor(id){var h=0;for(var i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))|0;return COLORS[Math.abs(h)%COLORS.length];}
  function nameOf(u){var m=u.user_metadata||{};return m.full_name||m.name||(u.email||'').split('@')[0]||'Usuario';}
  function initials(n){return n.split(/\s+/).filter(Boolean).slice(0,2).map(function(w){return w[0];}).join('').toUpperCase()||'?';}
  function clone(o){return JSON.parse(JSON.stringify(o));}

  /* ---------- diferencias por forma/flecha ---------- */
  function index(d){
    var s={n:{},e:{},name:d.name};
    d.nodes.forEach(function(n){s.n[n.id]=JSON.stringify(n);});
    d.edges.forEach(function(e){s.e[e.id]=JSON.stringify(e);});
    return s;
  }
  function diff(){
    var cur=index(D),ops={nodes:[],edges:[],del:[]},id;
    for(id in cur.n)if(SYNCED.n[id]!==cur.n[id])ops.nodes.push(JSON.parse(cur.n[id]));
    for(id in cur.e)if(SYNCED.e[id]!==cur.e[id])ops.edges.push(JSON.parse(cur.e[id]));
    for(id in SYNCED.n)if(!(id in cur.n))ops.del.push(id);
    for(id in SYNCED.e)if(!(id in cur.e))ops.del.push(id);
    if(cur.name!==SYNCED.name)ops.name=cur.name;
    SYNCED=cur;
    return (ops.nodes.length||ops.edges.length||ops.del.length||ops.name!=null)?ops:null;
  }
  function applyTo(d,ops){
    var del=new Set(ops.del||[]);
    if(del.size){
      d.nodes=d.nodes.filter(function(n){return !del.has(n.id);});
      d.edges=d.edges.filter(function(e){return !del.has(e.id);});
    }
    (ops.nodes||[]).forEach(function(n){var i=d.nodes.findIndex(function(x){return x.id===n.id;});if(i>=0)d.nodes[i]=n;else d.nodes.push(n);});
    (ops.edges||[]).forEach(function(e){var i=d.edges.findIndex(function(x){return x.id===e.id;});if(i>=0)d.edges[i]=e;else d.edges.push(e);});
    if(ops.name!=null)d.name=ops.name;
  }

  /* ---------- cambios de otras personas ---------- */
  function onRemote(ops){
    if(loading){buffer.push(ops);return;}
    applyTo(D,clone(ops));
    (ops.nodes||[]).forEach(function(n){SYNCED.n[n.id]=JSON.stringify(n);});
    (ops.edges||[]).forEach(function(e){SYNCED.e[e.id]=JSON.stringify(e);});
    (ops.del||[]).forEach(function(id){delete SYNCED.n[id];delete SYNCED.e[id];});
    if(ops.name!=null)SYNCED.name=ops.name;
    // Deshacer solo debe deshacer lo propio: los cambios ajenos se incorporan también al historial.
    var patch=function(s){var d=JSON.parse(s);applyTo(d,clone(ops));return JSON.stringify(d);};
    H.past=H.past.map(patch);H.future=H.future.map(patch);
    cleanSel();render();
  }
  function onLive(p){
    if(loading||!p||!p.nodes)return;
    p.nodes.forEach(function(n){var o=node(n.id);if(o)Object.assign(o,{x:n.x,y:n.y,w:n.w,h:n.h});});
    render();
  }

  /* ---------- envío y guardado ---------- */
  function send(event,payload){if(channel)channel.send({type:'broadcast',event:event,payload:payload});}
  function sharedSave(){
    if(!SYNCED)return;
    var ops=diff();if(!ops)return;
    send('ops',ops);queue(ops);
  }
  function queue(ops){
    pend=pend||{nodes:{},edges:{},del:{},name:null};
    ops.nodes.forEach(function(n){pend.nodes[n.id]=n;delete pend.del[n.id];});
    ops.edges.forEach(function(e){pend.edges[e.id]=e;delete pend.del[e.id];});
    ops.del.forEach(function(id){pend.del[id]=1;delete pend.nodes[id];delete pend.edges[id];});
    if(ops.name!=null)pend.name=ops.name;
    setStatus('saving');
    clearTimeout(flushT);flushT=setTimeout(flush,300);
  }
  function body(p){return {b:boardId,p_name:p.name,p_nodes:Object.values(p.nodes),p_edges:Object.values(p.edges),p_del:Object.keys(p.del)};}
  async function flush(){
    clearTimeout(flushT);
    if(!pend)return;
    var p=pend;pend=null;
    var r=await sb.rpc('apply_flow_ops',body(p));
    if(r.error){
      // Se reintenta sin pisar cambios más nuevos que hayan llegado mientras tanto.
      var cur=pend;pend=p;
      if(cur){Object.assign(pend.nodes,cur.nodes);Object.assign(pend.edges,cur.edges);
        Object.keys(cur.del).forEach(function(id){pend.del[id]=1;delete pend.nodes[id];delete pend.edges[id];});
        if(cur.name!=null)pend.name=cur.name;}
      setStatus('error');clearTimeout(retryT);retryT=setTimeout(flush,3000);
      return;
    }
    if(!pend)setStatus('live');
  }
  window.addEventListener('pagehide',function(){
    if(!pend||!token)return;
    var p=pend;pend=null;
    var b=JSON.stringify(body(p));
    fetch(window.SUPABASE_URL+'/rest/v1/rpc/apply_flow_ops',{method:'POST',keepalive:b.length<60000,
      headers:{'apikey':window.SUPABASE_KEY,'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:b});
  });

  // Mientras alguien arrastra o cambia el tamaño, los demás lo ven moverse.
  document.addEventListener('pointermove',function(){
    if(!channel||!SYNCED||typeof DRAG==='undefined'||!DRAG)return;
    var ids=DRAG.k==='move'&&DRAG.moved?DRAG.start.map(function(s){return s.id;}):DRAG.k==='rsz'?[DRAG.id]:null;
    if(!ids)return;
    var now=Date.now();if(now-liveT<60)return;liveT=now;
    send('live',{nodes:ids.map(function(id){var n=node(id);return n&&{id:n.id,x:n.x,y:n.y,w:n.w,h:n.h};}).filter(Boolean)});
  });

  /* ---------- selección de los demás (se dibuja sobre el lienzo) ---------- */
  function sendSel(){var ids=[...SEL];lastSel=ids.join(',');send('sel',{uid:user.id,ids:ids});}
  window.collabOverlay=function(){
    if(!channel)return '';
    var key=[...SEL].join(',');
    if(key!==lastSel){clearTimeout(selT);selT=setTimeout(sendSel,120);}
    var z=VIEW.z,s='';
    Object.keys(peerSel).forEach(function(uid){
      var p=peers[uid];if(!p)return;
      (peerSel[uid]||[]).forEach(function(id){
        var n=node(id);if(!n)return;var m=5/z;
        s+='<rect x="'+(n.x-m)+'" y="'+(n.y-m)+'" width="'+(n.w+2*m)+'" height="'+(n.h+2*m)+'" rx="'+(6/z)+'" fill="none" stroke="'+p.color+'" stroke-width="'+(2.5/z)+'" stroke-dasharray="'+(7/z)+' '+(4/z)+'" pointer-events="none"/>'+
           '<text x="'+(n.x-m)+'" y="'+(n.y-m-5/z)+'" font-size="'+(11/z)+'" font-weight="700" font-family="Arial,sans-serif" fill="'+p.color+'" pointer-events="none">'+esc(p.name)+'</text>';
      });
    });
    return s;
  };

  /* ---------- interfaz: botón Compartir, personas conectadas y panel ---------- */
  var css=document.createElement('style');
  css.textContent=
    '.cl-wrap{position:relative;display:flex;align-items:center;gap:8px}'+
    '.cl-people{display:flex;align-items:center}'+
    '.cl-av{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700;font-size:.78rem;border:2px solid var(--surface);margin-left:-8px;cursor:default}'+
    '.cl-av:first-child{margin-left:0}'+
    '.cl-st{display:inline-flex;align-items:center;gap:6px;font-size:.8rem;font-weight:700;color:var(--muted);white-space:nowrap}'+
    '.cl-st i{width:8px;height:8px;border-radius:50%;background:#8a94a6}'+
    '.cl-st[data-s="live"] i{background:#12b886}.cl-st[data-s="saving"] i{background:#fab005}.cl-st[data-s="error"] i,.cl-st[data-s="offline"] i{background:#fa5252}'+
    '.cl-panel{width:min(360px,calc(100vw - 24px));padding:12px}'+
    '.cl-panel h3{margin:2px 2px 6px;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}'+
    '.cl-panel p{margin:0 2px 10px;font-size:.86rem;color:var(--muted)}'+
    '.cl-link{display:flex;gap:6px;margin-bottom:12px}'+
    '.cl-link input{flex:1;min-width:0;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);padding:4px 8px;font-family:var(--mono);font-size:.78rem}'+
    '.cl-list{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto;margin-bottom:8px}'+
    '.cl-list a{display:block;padding:7px 9px;border-radius:7px;text-decoration:none;color:var(--ink);font-weight:700}'+
    '.cl-list a small{display:block;font-weight:400;color:var(--muted);font-size:.78rem}'+
    '.cl-list a:hover,.cl-list a.on{background:var(--accent-soft)}'+
    '.cl-panel .btn{width:100%;justify-content:center;margin-top:6px}'+
    '.cl-tag{font-size:.72rem;font-weight:700;color:var(--accent);border:1px solid var(--accent);border-radius:99px;padding:1px 8px;white-space:nowrap}';
  document.head.appendChild(css);

  var ui={};
  function buildUI(){
    var host=document.querySelector('header.top .actions');if(!host||ui.wrap)return;
    var w=document.createElement('div');w.className='cl-wrap menu';
    w.innerHTML=
      '<span class="cl-st" hidden><i></i><span></span></span>'+
      '<div class="cl-people"></div>'+
      '<button class="btn" type="button" aria-haspopup="true" aria-expanded="false">'+
        '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/></svg>'+
        '<span>Compartir</span></button>'+
      '<div class="menu-list cl-panel" hidden></div>';
    host.insertBefore(w,host.querySelector('.menu'));
    ui.wrap=w;ui.st=w.querySelector('.cl-st');ui.people=w.querySelector('.cl-people');ui.btn=w.querySelector('button');ui.panel=w.querySelector('.cl-panel');
    ui.btn.addEventListener('click',function(e){e.stopPropagation();ui.panel.hidden?openPanel():closePanel();});
    ui.panel.addEventListener('click',function(e){e.stopPropagation();});
    document.addEventListener('click',closePanel);
    if(boardId){
      ui.btn.lastChild.textContent='Invitar';
      var tag=document.createElement('span');tag.className='cl-tag';tag.textContent='Compartido';
      var t=document.querySelector('header.top .title');if(t)t.appendChild(tag);
    }
  }
  function closePanel(){if(ui.panel){ui.panel.hidden=true;ui.btn.setAttribute('aria-expanded','false');}}
  function inviteUrl(){return location.origin+location.pathname+'?tablero='+boardId;}
  async function openPanel(){
    ui.panel.hidden=false;ui.btn.setAttribute('aria-expanded','true');
    var h='';
    if(boardId){
      h+='<h3>Invitar a este tablero</h3><p>Quien abra este enlace e inicie sesión podrá editar el diagrama contigo en tiempo real.</p>'+
         '<div class="cl-link"><input readonly value="'+esc(inviteUrl())+'" aria-label="Enlace de invitación"><button class="btn small" type="button" data-a="copy">Copiar</button></div>';
    }else{
      h+='<h3>Trabajar en equipo</h3><p>Crea un tablero compartido a partir de este diagrama e invita a otras personas con un enlace.</p>'+
         '<button class="btn primary" type="button" data-a="create">Crear tablero compartido</button><br><br>';
    }
    h+='<h3>Tus tableros compartidos</h3><div class="cl-list"><p>Cargando…</p></div>';
    if(boardId){
      h+=owner===user.id
        ?'<button class="btn warn small" type="button" data-a="delete">Eliminar este tablero</button>'
        :'<button class="btn small" type="button" data-a="leave">Salir de este tablero</button>';
      h+='<a class="btn small" href="flujo.html" style="text-decoration:none">Volver a mi diagrama personal</a>';
    }
    ui.panel.innerHTML=h;
    ui.panel.querySelectorAll('[data-a]').forEach(function(b){b.addEventListener('click',function(){panelAction(b.dataset.a,b);});});
    var r=await sb.from('flow_boards').select('id,name,updated_at').order('updated_at',{ascending:false}).limit(30);
    var list=ui.panel.querySelector('.cl-list');if(!list)return;
    if(r.error||!r.data.length){list.innerHTML='<p>Aún no tienes ninguno.</p>';return;}
    list.innerHTML=r.data.map(function(b){
      return '<a href="flujo.html?tablero='+b.id+'"'+(b.id===boardId?' class="on"':'')+'>'+esc(b.name)+
        '<small>Modificado '+new Date(b.updated_at).toLocaleString('es-ES',{dateStyle:'short',timeStyle:'short'})+'</small></a>';
    }).join('');
  }
  async function panelAction(a,b){
    if(a==='copy'){
      var inp=ui.panel.querySelector('.cl-link input');
      try{await navigator.clipboard.writeText(inp.value);toast('Enlace copiado. Envíalo a quien quieras invitar.');}
      catch(e){inp.select();toast('Selecciona el enlace y cópialo con Ctrl+C.');}
      return;
    }
    if(a==='create'){
      b.disabled=true;b.textContent='Creando…';
      var id=crypto.randomUUID();
      var r=await sb.from('flow_boards').insert({id:id,name:D.name||'Diagrama de flujo',data:JSON.parse(snap())});
      if(r.error){b.disabled=false;b.textContent='Crear tablero compartido';toast('No se ha podido crear el tablero.');return;}
      location.href='flujo.html?tablero='+id;return;
    }
    if(a==='leave'||a==='delete'){
      if(!b.dataset.armed){b.dataset.armed='1';b.textContent=a==='delete'?'Pulsa otra vez: se borra para todos':'Pulsa otra vez para salir';return;}
      await flush();
      var q=a==='delete'
        ?sb.from('flow_boards').delete().eq('id',boardId)
        :sb.from('flow_board_members').delete().eq('board_id',boardId).eq('user_id',user.id);
      var res=await q;
      if(res.error){toast('No se ha podido completar.');return;}
      location.href='flujo.html';
    }
  }
  var STATUS={connecting:'Conectando…',live:'En vivo',saving:'Guardando…',error:'Sin guardar, reintentando…',offline:'Sin conexión'};
  function setStatus(s){if(!ui.st||!boardId)return;ui.st.hidden=false;ui.st.dataset.s=s;ui.st.lastChild.textContent=STATUS[s]||s;}
  function renderPeers(){
    if(!ui.people)return;
    var all=[{uid:user.id,name:nameOf(user)+' (tú)',color:colorFor(user.id)}].concat(Object.keys(peers).map(function(k){return peers[k];}));
    ui.people.innerHTML=all.slice(0,6).map(function(p){
      return '<span class="cl-av" style="background:'+p.color+'" title="'+esc(p.name)+'">'+esc(initials(p.name.replace(' (tú)','')))+'</span>';
    }).join('')+(all.length>6?'<span class="cl-av" style="background:#495057" title="'+(all.length-6)+' más">+'+(all.length-6)+'</span>':'');
  }

  /* ---------- arranque ---------- */
  // Si se pierde la conexión, se trae del servidor lo que haya cambiado mientras tanto.
  async function resync(){
    var r=await sb.from('flow_boards').select('data').eq('id',boardId).single();
    if(r.error||!SYNCED)return;
    var srv=fix(r.data.data),cur=index(srv),ops={nodes:[],edges:[],del:[]},p=pend||{nodes:{},edges:{},del:{}},id;
    for(id in cur.n)if(SYNCED.n[id]!==cur.n[id]&&!p.nodes[id]&&!p.del[id])ops.nodes.push(JSON.parse(cur.n[id]));
    for(id in cur.e)if(SYNCED.e[id]!==cur.e[id]&&!p.edges[id]&&!p.del[id])ops.edges.push(JSON.parse(cur.e[id]));
    for(id in SYNCED.n)if(!(id in cur.n)&&!p.nodes[id])ops.del.push(id);
    for(id in SYNCED.e)if(!(id in cur.e)&&!p.edges[id])ops.del.push(id);
    if(cur.name!==SYNCED.name&&(!pend||pend.name==null))ops.name=cur.name;
    if(ops.nodes.length||ops.edges.length||ops.del.length||ops.name!=null)onRemote(ops);
  }
  var reconnectT=0,subscribedOnce=false;
  function connect(){
    sb.realtime.setAuth(token);
    var ch=sb.channel('flow:'+boardId,{config:{private:true,broadcast:{self:false},presence:{key:user.id}}});
    channel=ch;
    ch.on('broadcast',{event:'ops'},function(m){onRemote(m.payload);});
    ch.on('broadcast',{event:'live'},function(m){onLive(m.payload);});
    ch.on('broadcast',{event:'sel'},function(m){if(m.payload&&m.payload.uid){peerSel[m.payload.uid]=m.payload.ids||[];render();}});
    ch.on('presence',{event:'sync'},function(){
      var st=ch.presenceState(),next={};
      Object.keys(st).forEach(function(k){if(k!==user.id&&st[k][0])next[k]=st[k][0];});
      Object.keys(peerSel).forEach(function(k){if(!next[k])delete peerSel[k];});
      peers=next;renderPeers();render();
    });
    ch.on('presence',{event:'join'},function(){flush();setTimeout(sendSel,300);});
    return new Promise(function(resolve){
      var done=false;
      ch.subscribe(function(status){
        if(ch!==channel)return;
        if(status==='SUBSCRIBED'){
          ch.track({uid:user.id,name:nameOf(user),color:colorFor(user.id)});
          setStatus(pend?'saving':'live');
          if(subscribedOnce)resync();
          subscribedOnce=true;
          if(!done){done=true;resolve();}
        }else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'){
          setStatus('offline');
          if(!done){done=true;resolve();}
          // Reintento propio: se cierra el canal y se abre uno nuevo.
          clearTimeout(reconnectT);
          reconnectT=setTimeout(function(){
            if(ch!==channel)return;
            channel=null;sb.removeChannel(ch);
            subscribedOnce=true;connect();
          },3000);
        }
      });
    });
  }

  C.init=async function(){
    var ctx=await window.cloudReady;
    sb=ctx.client;user=ctx.user;
    var s=(await sb.auth.getSession()).data.session;token=s&&s.access_token;
    sb.auth.onAuthStateChange(function(ev,ns){if(ns){token=ns.access_token;if(channel)sb.realtime.setAuth(token);}});
    buildUI();
    if(!boardId)return;
    setStatus('connecting');
    var j=await sb.rpc('join_flow_board',{b:boardId});
    if(j.error||!j.data){toast('Este tablero no existe o se ha eliminado.');setTimeout(function(){location.replace('flujo.html');},1800);return;}
    loading=true;
    await Promise.race([connect(),new Promise(function(r){setTimeout(r,5000);})]);
    var r=await sb.from('flow_boards').select('data,owner').eq('id',boardId).single();
    if(r.error){toast('No se ha podido abrir el tablero.');setStatus('error');return;}
    owner=r.data.owner;
    D=fix(r.data.data);
    H={past:[],future:[]};SEL=new Set();
    SYNCED=index(D);
    loading=false;
    buffer.splice(0).forEach(onRemote);
    // A partir de aquí, guardar = enviar los cambios al tablero (no al diagrama personal).
    save=sharedSave;
    document.title=D.name+' · Diagrama compartido';
    renderPeers();draw();if(D.nodes.length)fit();
  };
})();
