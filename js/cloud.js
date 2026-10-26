/* Versión web: exige iniciar sesión con Supabase y sincroniza con la nube lo que las páginas
   guardan en localStorage (proyectos, ejercicio PERT, diagrama de flujo y preferencias de vista).
   Se carga en <head>, después de supabase-js y supabase-config.js. En la app de Windows no hace nada. */
(function(){
  if(window.NL_PORT)return;
  var KEYS=[
    'gestor-proyectos-v1','gestor-proyectos-vista',
    'diagrama-pert-ejercicio-v1','diagrama-pert-ejercicio-v1-vista',
    'diagrama-flujo-v1','diagrama-flujo-v1-vista',
    'app-tema'
  ];
  var META='cloud-meta', USER='cloud-user', REST=window.SUPABASE_URL+'/rest/v1/app_data';
  var inFrame=false;try{inFrame=window.self!==window.top;}catch(e){inFrame=true;}
  var rawSet=Storage.prototype.setItem;
  var client=window.supabase.createClient(window.SUPABASE_URL,window.SUPABASE_KEY);
  var session=null, pending={}, timer=null, leaving=false;
  // Otras partes (p. ej. el diagrama de flujo compartido) esperan a tener sesión con esto.
  var readyResolve;
  window.cloudReady=new Promise(function(r){readyResolve=r;});

  // Oculta la página hasta saber quién es el usuario y traer sus datos.
  var root=document.documentElement;
  root.style.visibility='hidden';
  var revealTimer=setTimeout(reveal,6000);
  function reveal(){clearTimeout(revealTimer);root.style.visibility='';}

  function readMeta(){try{return JSON.parse(localStorage.getItem(META))||{};}catch(e){return {};}}
  function writeMeta(m){try{rawSet.call(localStorage,META,JSON.stringify(m));}catch(e){}}
  function clearLocal(){
    KEYS.forEach(function(k){try{localStorage.removeItem(k);}catch(e){}});
    try{localStorage.removeItem(META);}catch(e){}
  }

  function goLogin(){
    var next=inFrame?'index.html':(location.pathname.split('/').pop()||'index.html');
    var url='login.html?next='+encodeURIComponent(next);
    try{(inFrame?window.top:window).location.replace(url);}catch(e){location.replace(url);}
  }

  // Cada cambio en una clave de datos se marca con su hora y se sube a los pocos segundos.
  Storage.prototype.setItem=function(k,v){
    rawSet.apply(this,arguments);
    if(this===window.localStorage&&KEYS.indexOf(k)>=0){
      var m=readMeta();m[k]=Date.now();writeMeta(m);
      pending[k]=String(v);
      clearTimeout(timer);timer=setTimeout(flush,1500);
    }
  };

  function flush(onLeave){
    clearTimeout(timer);
    var keys=Object.keys(pending);
    if(!session||!keys.length)return;
    var m=readMeta(), batch=pending;
    pending={};
    var rows=keys.map(function(k){
      return {user_id:session.user.id,key:k,value:batch[k],updated_at:new Date(m[k]||Date.now()).toISOString()};
    });
    var body=JSON.stringify(rows);
    fetch(REST+'?on_conflict=user_id,key',{
      method:'POST',
      keepalive:!!onLeave&&body.length<60000,
      headers:{
        'apikey':window.SUPABASE_KEY,
        'Authorization':'Bearer '+session.access_token,
        'Content-Type':'application/json',
        'Prefer':'resolution=merge-duplicates,return=minimal'
      },
      body:body
    }).then(function(r){if(!r.ok)throw new Error(r.status);}).catch(function(){
      // Si falla, se vuelve a intentar con el siguiente cambio (sin pisar valores más nuevos).
      keys.forEach(function(k){if(!(k in pending))pending[k]=batch[k];});
    });
  }
  window.addEventListener('pagehide',function(){flush(true);});
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flush(true);});

  async function pull(){
    var res=await client.from('app_data').select('key,value,updated_at');
    if(res.error)return false;
    var m=readMeta(), remote={}, changed=false;
    (res.data||[]).forEach(function(row){
      if(KEYS.indexOf(row.key)<0)return;
      var ts=Date.parse(row.updated_at);
      remote[row.key]=ts;
      if(!m[row.key]||m[row.key]<ts){
        if(localStorage.getItem(row.key)!==row.value){rawSet.call(localStorage,row.key,row.value);changed=true;}
        m[row.key]=ts;
      }
    });
    // Lo que solo existe aquí, o es más reciente aquí, se sube.
    KEYS.forEach(function(k){
      var v=localStorage.getItem(k);
      if(v===null)return;
      if(!(k in remote)||(m[k]&&m[k]>remote[k])){m[k]=m[k]||Date.now();pending[k]=v;}
    });
    writeMeta(m);
    flush();
    return changed;
  }

  function addAccountUI(){
    if(inFrame||document.getElementById('cloud-account'))return;
    var host=document.querySelector('.dl-pills')||document.querySelector('header.top .actions')||document.querySelector('.top-actions');
    if(!host)return;
    var b=document.createElement('button');
    b.type='button';b.id='cloud-account';
    b.className=host.classList.contains('dl-pills')?'pill-btn ghost':'btn';
    b.title='Sesión iniciada como '+session.user.email+'. Pulsa para cerrar sesión.';
    b.innerHTML='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg><span>Cerrar sesión</span>';
    // Confirmación dentro del propio botón: algunos navegadores bloquean confirm() y lo dan por cancelado.
    var label=b.querySelector('span'),armT=0;
    b.addEventListener('click',async function(){
      if(!b.dataset.armed){
        b.dataset.armed='1';label.textContent='Pulsa otra vez para salir';
        armT=setTimeout(function(){delete b.dataset.armed;label.textContent='Cerrar sesión';},4000);
        return;
      }
      clearTimeout(armT);b.disabled=true;label.textContent='Cerrando…';
      leaving=true;
      flush();
      await new Promise(function(r){setTimeout(r,400);});
      try{var r=await client.auth.signOut();if(r&&r.error)await client.auth.signOut({scope:'local'});}
      catch(e){try{await client.auth.signOut({scope:'local'});}catch(e2){}}
      // Por si el servidor no respondió: la sesión se borra de este navegador igualmente.
      try{Object.keys(localStorage).forEach(function(k){if(/^sb-.*-auth-token/.test(k))localStorage.removeItem(k);});}catch(e){}
      clearLocal();
      try{localStorage.removeItem(USER);}catch(e){}
      location.replace('login.html');
    });
    host.appendChild(b);
  }

  (async function(){
    var s=null;
    try{s=(await client.auth.getSession()).data.session;}catch(e){}
    if(!s){goLogin();return;}
    session=s;
    client.auth.onAuthStateChange(function(ev,ns){
      if(ns)session=ns;
      if(ev==='SIGNED_OUT'&&!leaving)goLogin();
    });
    // Otro usuario en este navegador: no mezclar sus datos. La primera vez, lo que ya hubiera se sube.
    var prev=localStorage.getItem(USER);
    if(prev!==s.user.id){if(prev)clearLocal();rawSet.call(localStorage,USER,s.user.id);}
    var changed=false;
    try{changed=await pull();}catch(e){}
    if(changed){
      // Las páginas leen sus datos al arrancar: recargar una vez para mostrar lo traído de la nube.
      var flag='cloud-reload-'+location.pathname, last=0;
      try{last=Number(sessionStorage.getItem(flag))||0;}catch(e){}
      if(Date.now()-last>10000){
        try{sessionStorage.setItem(flag,String(Date.now()));}catch(e){}
        location.reload();return;
      }
    }
    reveal();
    readyResolve({client:client,user:s.user});
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addAccountUI);
    else addAccountUI();
  })();
})();
