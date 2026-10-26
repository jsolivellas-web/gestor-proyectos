/* Diagrama de flujo compartido: varias personas editan el mismo tablero a la vez.
   - flujo.html?tablero=<id> abre un tablero de Supabase en lugar del diagrama personal.
   - Cada cambio se envía por forma/flecha (Realtime broadcast) y se guarda con la función apply_flow_ops,
     así dos personas que tocan cosas distintas no se pisan.
   - En vivo se ve el cursor de cada persona, lo que tiene seleccionado, lo que arrastra y lo que escribe.
   - La presencia es por ventana: la misma cuenta abierta en dos sitios aparece como «otra ventana».
   Usa D, H, SEL, VIEW, DRAG, EDIT, PROPS_BEFORE, svg, ed, fix, snap, node, edge, toWorld, cleanSel,
   render, draw, fit, toast y esc de flujo.html. En la app de Windows (sin cloud.js) no hace nada. */
(function(){
  if(window.NL_PORT||!window.cloudReady){window.FlowCollab=null;return;}
  var params=new URLSearchParams(location.search);
  var boardId=params.get('tablero');
  if(boardId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(boardId))boardId=null;
  var C={boardId:boardId};
  window.FlowCollab=C;

  var sb=null,user=null,token=null,channel=null,owner=null;
  // Identificador de esta ventana: cada ventana es un participante distinto.
  var conn=Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);
  var SYNCED=null,pend=null,flushT=0,retryT=0,loading=false,buffer=[];
  var peers={},peerSel={},peerCur={},typing={},liveTouched={};
  var lastSel='',selT=0,liveT=0,curT=0,typeT=0;
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
    // Lo que otra persona está arrastrando o escribiendo solo se ve: no es un cambio mío y no se guarda desde aquí.
    for(id in liveTouched){
      if(busyWith(id))continue;
      if(id in cur.n&&id in SYNCED.n)cur.n[id]=SYNCED.n[id];
      if(id in cur.e&&id in SYNCED.e)cur.e[id]=SYNCED.e[id];
    }
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
  function busyWith(id){
    if(EDIT&&EDIT.id===id)return true;
    if(DRAG&&(DRAG.id===id||(DRAG.start&&DRAG.start.some(function(s){return s.id===id;}))))return true;
    return false;
  }

  /* ---------- cambios de otras personas ---------- */
  function onRemote(ops){
    if(loading){buffer.push(ops);return;}
    // Si estoy escribiendo en esa misma forma, conservo mi texto.
    var mine=EDIT&&EDIT.kind==='node'?node(EDIT.id):EDIT&&EDIT.kind==='edge'?edge(EDIT.id):null;
    var keep=mine?{id:mine.id,text:mine.text,label:mine.label,h:mine.h,y:mine.y}:null;
    applyTo(D,clone(ops));
    if(keep){var it=node(keep.id)||edge(keep.id);if(it){if(EDIT.kind==='node')Object.assign(it,{text:keep.text,h:keep.h,y:keep.y});else it.label=keep.label;}}
    (ops.nodes||[]).forEach(function(n){SYNCED.n[n.id]=JSON.stringify(n);delete liveTouched[n.id];});
    (ops.edges||[]).forEach(function(e){SYNCED.e[e.id]=JSON.stringify(e);delete liveTouched[e.id];});
    (ops.del||[]).forEach(function(id){delete SYNCED.n[id];delete SYNCED.e[id];delete liveTouched[id];});
    if(ops.name!=null)SYNCED.name=ops.name;
    // Deshacer solo debe deshacer lo propio: los cambios ajenos se incorporan también a las copias guardadas.
    var patch=function(s){var d=JSON.parse(s);applyTo(d,clone(ops));return JSON.stringify(d);};
    H.past=H.past.map(patch);H.future=H.future.map(patch);
    if(EDIT&&EDIT.before)EDIT.before=patch(EDIT.before);
    if(DRAG&&DRAG.before)DRAG.before=patch(DRAG.before);
    if(typeof PROPS_BEFORE==='string'&&PROPS_BEFORE)PROPS_BEFORE=patch(PROPS_BEFORE);
    cleanSel();render();
  }
  // Cambios en curso (arrastrar, escribir): se ven al momento pero no se guardan hasta que la persona termina.
  function onLive(p){
    if(loading||!p)return;
    var now=Date.now();
    (p.nodes||[]).forEach(function(n){
      var o=node(n.id);if(!o||busyWith(n.id))return;
      ['x','y','w','h','text'].forEach(function(k){if(n[k]!==undefined)o[k]=n[k];});
      liveTouched[n.id]=now;
    });
    (p.edges||[]).forEach(function(e){
      var o=edge(e.id);if(!o||busyWith(e.id))return;
      if(e.label!==undefined)o.label=e.label;
      liveTouched[e.id]=now;
    });
    if(p.conn){if(p.typing)typing[p.conn]={id:p.typing,t:now};else delete typing[p.conn];}
    // Terminó de escribir o canceló: se muestra lo guardado (si terminó, el cambio ya llegó antes por «ops»).
    if(p.done){
      delete liveTouched[p.done];
      var s=SYNCED&&(SYNCED.n[p.done]||SYNCED.e[p.done]),list=SYNCED&&SYNCED.n[p.done]?D.nodes:D.edges;
      var i=list.findIndex(function(x){return x.id===p.done;});
      if(s&&i>=0&&!busyWith(p.done))list[i]=JSON.parse(s);
    }
    render();
  }
  // Si alguien deja de enviar (canceló o se fue) se vuelve a lo guardado.
  setInterval(function(){
    if(!SYNCED)return;
    var now=Date.now(),changed=false;
    Object.keys(liveTouched).forEach(function(id){
      if(now-liveTouched[id]<6000)return;
      delete liveTouched[id];
      if(busyWith(id))return;
      var s=SYNCED.n[id],list=D.nodes;
      if(!s){s=SYNCED.e[id];list=D.edges;}
      if(!s)return;
      var i=list.findIndex(function(x){return x.id===id;});
      if(i>=0&&JSON.stringify(list[i])!==s){list[i]=JSON.parse(s);changed=true;}
    });
    Object.keys(typing).forEach(function(k){if(now-typing[k].t>5000){delete typing[k];changed=true;}});
    Object.keys(peerCur).forEach(function(k){if(now-peerCur[k].t>30000){delete peerCur[k];changed=true;}});
    // Mientras escribo, aviso cada poco aunque esté pensando, para que no desaparezca mi texto en los demás.
    if(EDIT&&channel&&now-typeT>2000)sendTyping();
    if(changed)render();
  },1500);

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
    send('cur',{conn:conn,x:null});
    if(!pend||!token)return;
    var p=pend;pend=null;
    var b=JSON.stringify(body(p));
    fetch(window.SUPABASE_URL+'/rest/v1/rpc/apply_flow_ops',{method:'POST',keepalive:b.length<60000,
      headers:{'apikey':window.SUPABASE_KEY,'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:b});
  });

  // Arrastrar o cambiar el tamaño: los demás lo ven moverse. Y mi cursor, siempre.
  function onPointerMove(ev){
    if(!channel||!SYNCED)return;
    var now=Date.now();
    if(now-curT>=50&&ev.target&&ev.target.closest&&ev.target.closest('#stage')){
      curT=now;var p=toWorld(ev.clientX,ev.clientY);
      send('cur',{conn:conn,x:Math.round(p.x),y:Math.round(p.y)});
    }
    if(!DRAG)return;
    var ids=DRAG.k==='move'&&DRAG.moved?DRAG.start.map(function(s){return s.id;}):DRAG.k==='rsz'?[DRAG.id]:null;
    if(!ids||now-liveT<60)return;
    liveT=now;
    send('live',{conn:conn,nodes:ids.map(function(id){var n=node(id);return n&&{id:n.id,x:n.x,y:n.y,w:n.w,h:n.h};}).filter(Boolean)});
  }
  function sendTyping(){
    if(!EDIT)return;
    typeT=Date.now();
    var it=EDIT.kind==='node'?node(EDIT.id):edge(EDIT.id);if(!it)return;
    if(EDIT.kind==='node')send('live',{conn:conn,typing:it.id,nodes:[{id:it.id,text:ed.value,h:it.h,y:it.y}]});
    else send('live',{conn:conn,typing:it.id,edges:[{id:it.id,label:ed.value}]});
  }
  var typingSendT=0;
  function onType(){clearTimeout(typingSendT);typingSendT=setTimeout(sendTyping,Date.now()-typeT>150?0:150);}

  /* ---------- lo que hacen los demás, dibujado sobre el lienzo ---------- */
  function sendSel(){var ids=[...SEL];lastSel=ids.join(',');send('sel',{conn:conn,ids:ids});}
  window.collabOverlay=function(){
    if(!channel)return '';
    var key=[...SEL].join(',');
    if(key!==lastSel){clearTimeout(selT);selT=setTimeout(sendSel,120);}
    var z=VIEW.z,s='';
    Object.keys(peers).forEach(function(k){
      var p=peers[k],ids=(peerSel[k]||[]).slice();
      if(typing[k]&&ids.indexOf(typing[k].id)<0)ids.push(typing[k].id);
      ids.forEach(function(id){
        var n=node(id);if(!n)return;var m=5/z;
        var label=p.label+(typing[k]&&typing[k].id===id?' ✎ escribiendo…':'');
        s+='<rect x="'+(n.x-m)+'" y="'+(n.y-m)+'" width="'+(n.w+2*m)+'" height="'+(n.h+2*m)+'" rx="'+(6/z)+'" fill="none" stroke="'+p.color+'" stroke-width="'+(2.5/z)+'" stroke-dasharray="'+(7/z)+' '+(4/z)+'" pointer-events="none"/>'+
           '<text x="'+(n.x-m)+'" y="'+(n.y-m-5/z)+'" font-size="'+(11/z)+'" font-weight="700" font-family="Arial,sans-serif" fill="'+p.color+'" pointer-events="none">'+esc(label)+'</text>';
      });
    });
    Object.keys(peerCur).forEach(function(k){
      var p=peers[k],c=peerCur[k];if(!p||c.x==null)return;
      var w=Math.round(p.label.length*6.6+12);
      s+='<g transform="translate('+c.x+','+c.y+') scale('+(1/z)+')" pointer-events="none">'+
         '<path d="M0,0 L0,17 L4.6,12.6 L8,20 L11,18.7 L7.7,11.6 L14,11.6 Z" fill="'+p.color+'" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>'+
         '<rect x="13" y="17" rx="5" width="'+w+'" height="19" fill="'+p.color+'"/>'+
         '<text x="19" y="30.5" font-size="11.5" font-weight="700" font-family="Arial,sans-serif" fill="#fff">'+esc(p.label)+'</text></g>';
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
    '.cl-tag{font-size:.72rem;font-weight:700;color:var(--accent);border:1px solid var(--accent);border-radius:99px;padding:1px 8px;white-space:nowrap}'+
    '.cl-tag.mine{color:var(--muted);border-color:var(--line)}';
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
    // Etiqueta junto al título: que siempre quede claro si es el diagrama propio o el compartido.
    var tag=document.createElement('span');
    tag.className='cl-tag'+(boardId?'':' mine');
    tag.textContent=boardId?'Compartido':'Personal';
    tag.title=boardId?'Lo ven y editan en vivo todas las personas invitadas':'Solo lo ves tú. Para trabajar en equipo usa «Compartir».';
    var t=document.querySelector('header.top .title');if(t)t.appendChild(tag);
    if(boardId)ui.btn.lastChild.textContent='Invitar';
  }
  function closePanel(){if(ui.panel){ui.panel.hidden=true;ui.btn.setAttribute('aria-expanded','false');}}
  function inviteUrl(){return location.origin+location.pathname+'?tablero='+boardId;}
  async function openPanel(){
    ui.panel.hidden=false;ui.btn.setAttribute('aria-expanded','true');
    var h='';
    if(boardId){
      h+='<h3>Invitar a este tablero</h3><p>Quien abra este enlace e inicie sesión verá y editará el diagrama contigo en tiempo real.</p>'+
         '<div class="cl-link"><input readonly value="'+esc(inviteUrl())+'" aria-label="Enlace de invitación"><button class="btn small" type="button" data-a="copy">Copiar</button></div>';
    }else{
      h+='<h3>Trabajar en equipo</h3><p>Este diagrama es personal: solo lo ves tú. Crea un tablero compartido a partir de él e invita a otras personas con un enlace; todos veréis en vivo lo que hace cada uno.</p>'+
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
    var all=[{label:'Tú',name:nameOf(user),color:colorFor(conn)}].concat(Object.keys(peers).map(function(k){return peers[k];}));
    ui.people.innerHTML=all.slice(0,6).map(function(p){
      return '<span class="cl-av" style="background:'+p.color+'" title="'+esc(p.label==='Tú'?p.name+' (tú)':p.label)+'">'+esc(initials(p.name))+'</span>';
    }).join('')+(all.length>6?'<span class="cl-av" style="background:#495057" title="'+(all.length-6)+' más">+'+(all.length-6)+'</span>':'');
  }

  /* ---------- conexión ---------- */
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
    var ch=sb.channel('flow:'+boardId,{config:{private:true,broadcast:{self:false},presence:{key:conn}}});
    channel=ch;
    ch.on('broadcast',{event:'ops'},function(m){onRemote(m.payload);});
    ch.on('broadcast',{event:'live'},function(m){onLive(m.payload);});
    ch.on('broadcast',{event:'sel'},function(m){if(m.payload&&m.payload.conn){peerSel[m.payload.conn]=m.payload.ids||[];render();}});
    ch.on('broadcast',{event:'cur'},function(m){
      var p=m.payload;if(!p||!p.conn)return;
      if(p.x==null)delete peerCur[p.conn];else peerCur[p.conn]={x:p.x,y:p.y,t:Date.now()};
      render();
    });
    ch.on('presence',{event:'sync'},function(){
      var st=ch.presenceState(),next={};
      Object.keys(st).forEach(function(k){
        var p=st[k][0];if(k===conn||!p)return;
        var name=p.name||'Usuario',same=p.uid===user.id;
        next[k]={name:name,label:same?name+' (otra ventana)':name,color:p.color||colorFor(k),uid:p.uid};
      });
      [peerSel,peerCur,typing].forEach(function(map){Object.keys(map).forEach(function(k){if(!next[k])delete map[k];});});
      peers=next;renderPeers();render();
    });
    ch.on('presence',{event:'join'},function(){flush();setTimeout(sendSel,300);});
    return new Promise(function(resolve){
      var done=false;
      ch.subscribe(function(status){
        if(ch!==channel)return;
        if(status==='SUBSCRIBED'){
          ch.track({uid:user.id,name:nameOf(user),color:colorFor(conn)});
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
    if(!boardId){
      // Para que nadie se confunda trabajando en su diagrama personal creyendo que es el compartido.
      var b=await sb.from('flow_boards').select('id',{count:'exact',head:true});
      if(!b.error&&b.count)toast('Estás en tu diagrama personal. Tus tableros compartidos están en «Compartir».');
      return;
    }
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
    document.addEventListener('pointermove',onPointerMove);
    svg.addEventListener('pointerleave',function(){send('cur',{conn:conn,x:null});});
    ed.addEventListener('input',onType);
    // Al terminar o cancelar la escritura, los demás dejan de ver «escribiendo…» al momento.
    var origFinish=finishEdit,origCancel=cancelEdit;
    finishEdit=function(){var id=EDIT&&EDIT.id;origFinish();if(id)send('live',{conn:conn,done:id});};
    cancelEdit=function(){var id=EDIT&&EDIT.id;origCancel();if(id)send('live',{conn:conn,done:id});};
    document.title=D.name+' · Diagrama compartido';
    renderPeers();draw();if(D.nodes.length)fit();
  };
})();
