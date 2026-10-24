/* Puente entre las páginas y Windows (Neutralino): guarda los datos en disco,
   abre y guarda archivos con el diálogo de Windows, gestiona el tema claro/oscuro y añade el botón «Menú». */
(function(){
  var N=window.Neutralino, active=!!(N&&window.NL_PORT);
  var KEYS=[
    'gestor-proyectos-v1','gestor-proyectos-vista',
    'diagrama-pert-ejercicio-v1','diagrama-pert-ejercicio-v1-vista',
    'diagrama-flujo-v1','diagrama-flujo-v1-vista',
    'app-ultima-carpeta','app-tema'
  ];
  var rawSet=Storage.prototype.setItem;
  var pendingWrites=[];
  var restored=false;
  var restorePromise=null;
  var bufferedSets={};

  if(active){try{N.init();}catch(e){active=false;}}

  function pushWrite(k,v){
    if(!active)return;
    try{
      var p=N.storage.setData(k,String(v)).catch(function(){});
      pendingWrites.push(p);
      p.then(function(){
        var idx=pendingWrites.indexOf(p);
        if(idx>=0)pendingWrites.splice(idx,1);
      });
    }catch(e){}
  }

  // Copia en disco de todo lo que las páginas guardan en localStorage.
  if(active){
    try{
      var orig=Storage.prototype.setItem;
      Storage.prototype.setItem=function(k,v){
        orig.apply(this,arguments);
        if(this===window.localStorage&&KEYS.indexOf(k)>=0){
          if(!restored){bufferedSets[k]=String(v);return;}
          pushWrite(k,v);
        }
      };
    }catch(e){}
  }else{
    restored=true;
  }

  async function flush(){
    if(!pendingWrites.length)return;
    try{await Promise.all(pendingWrites.slice());}catch(e){}
  }

  function toBytes(data){
    if(data instanceof ArrayBuffer)return Promise.resolve(data);
    if(data instanceof Uint8Array)return Promise.resolve(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
    if(data instanceof Blob)return data.arrayBuffer();
    return Promise.resolve(new TextEncoder().encode(String(data)).buffer);
  }
  var DESC={
    json:'Archivo de datos (*.json)',
    xml:'XML de ProjectLibre / MS Project (*.xml)',
    zip:'Archivo ZIP (*.zip)',
    png:'Imagen PNG (*.png)',
    svg:'Imagen vectorial SVG (*.svg)',
    docx:'Documento de Word (*.docx)',
    csv:'CSV para Excel (*.csv)',
    pdf:'Documento PDF (*.pdf)'
  };
  var lastDir=null;
  try{lastDir=localStorage.getItem('app-ultima-carpeta');}catch(e){}

  async function save(filename,data,toast){
    toast=toast||function(){};
    var ext=(filename.match(/\.([^.]+)$/)||[])[1]||'';
    try{
      var def=lastDir?(lastDir.replace(/[\\/]+$/,'')+'\\'+filename):filename;
      var path=await N.os.showSaveDialog('Guardar como',{
        defaultPath:def,
        filters:ext?[{name:DESC[ext]||ext.toUpperCase(),extensions:[ext]},{name:'Todos los archivos',extensions:['*']}]:[]
      });
      if(!path)return false;
      if(ext&&!new RegExp('\\.'+ext+'$','i').test(path))path+='.'+ext;
      if(typeof data==='string')await N.filesystem.writeFile(path,data);
      else await N.filesystem.writeBinaryFile(path,await toBytes(data));
      var m=path.match(/^(.*)[\\/][^\\/]*$/);
      if(m){lastDir=m[1];try{localStorage.setItem('app-ultima-carpeta',lastDir);}catch(e){}}
      toast('Guardado en '+path);
      return true;
    }catch(e){
      toast('No se ha podido guardar el archivo'+(e&&e.message?': '+e.message:'.'));
      return false;
    }
  }

  async function openDialog(filters,toast){
    toast=toast||function(){};
    if(!active||!N.os||!N.os.showOpenDialog)return null;
    try{
      var opts={multiSelections:false};
      if(lastDir)opts.defaultPath=lastDir;
      if(filters&&filters.length)opts.filters=filters;
      var entries=await N.os.showOpenDialog('Abrir archivo',opts);
      var path=Array.isArray(entries)?entries[0]:entries;
      if(!path)return false;
      var m=path.match(/^(.*)[\\/][^\\/]*$/);
      if(m){lastDir=m[1];try{localStorage.setItem('app-ultima-carpeta',lastDir);}catch(e){}}
      var text=await N.filesystem.readFile(path);
      return {path:path,name:path.split(/[\\/]/).pop(),text:text,content:text};
    }catch(e){
      return null;
    }
  }

  // Al arrancar: recupera del disco lo guardado la última vez.
  function restore(){
    if(restorePromise)return restorePromise;
    if(!active){restored=true;return Promise.resolve();}
    restorePromise=(async function(){
      try{
        // Si ya se restauró en esta misma sesión (mismo puerto), evitamos machacar cambios recientes en memoria,
        // pero verificamos las claves que falten en localStorage.
        var alreadySession=false;
        try{alreadySession=sessionStorage.getItem('nl-restored')==='1';}catch(e){}
        var keys=[];
        try{keys=await N.storage.getKeys();}catch(e){keys=[];}
        for(var i=0;i<keys.length;i++){
          var k=keys[i];
          if(KEYS.indexOf(k)<0)continue;
          if(alreadySession&&localStorage.getItem(k)!==null)continue;
          try{
            var v=await N.storage.getData(k);
            if(typeof v==='string')rawSet.call(localStorage,k,v);
          }catch(e){}
        }
        try{sessionStorage.setItem('nl-restored','1');}catch(e){}
      }finally{
        restored=true;
        try{lastDir=localStorage.getItem('app-ultima-carpeta');}catch(e){}
        applyTheme(getTheme());
        // Si se intentó guardar algo nuevo que no existía en disco, lo volcamos.
        Object.keys(bufferedSets).forEach(function(k){
          if(localStorage.getItem(k)===bufferedSets[k])pushWrite(k,bufferedSets[k]);
        });
        bufferedSets={};
      }
    })();
    return restorePromise;
  }

  /* ---- Tema claro / oscuro ---- */
  function getTheme(){
    try{
      var t=localStorage.getItem('app-tema');
      if(t==='dark'||t==='light')return t;
    }catch(e){}
    return 'dark';
  }
  function applyTheme(t){
    document.documentElement.setAttribute('data-theme',t);
    var btn=document.getElementById('nl-theme');
    if(btn){
      var isDark=t==='dark';
      btn.title=isDark?'Cambiar a modo claro':'Cambiar a modo oscuro';
      btn.setAttribute('aria-label',btn.title);
      btn.innerHTML=isDark
        ?'<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg><span>Claro</span>'
        :'<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg><span>Oscuro</span>';
    }
    window.dispatchEvent(new CustomEvent('nl-theme-change',{detail:{theme:t}}));
  }
  function toggleTheme(){
    var next=getTheme()==='dark'?'light':'dark';
    try{localStorage.setItem('app-tema',next);}catch(e){}
    applyTheme(next);
    try{if(window.self!==window.top&&window.parent&&window.parent.document){window.parent.document.documentElement.setAttribute('data-theme',next);}}catch(e){}
  }
  applyTheme(getTheme());

  window.NLBridge={
    active:active,
    save:save,
    open:openDialog,
    restore:restore,
    flush:flush,
    getTheme:getTheme,
    toggleTheme:toggleTheme,
    keys:KEYS
  };

  // Botón para volver al menú principal y selector de tema.
  function addTopControls(){
    var isIndex=/(^|\/)(index\.html)?$/.test(location.pathname);
    var inFrame=false;try{inFrame=window.self!==window.top;}catch(e){inFrame=true;}
    var host=document.querySelector('header.top .actions')||document.querySelector('.top-actions');

    if(!document.getElementById('nl-theme')){
      var tb=document.createElement('button');
      tb.type='button';tb.id='nl-theme';tb.className='btn';
      tb.addEventListener('click',toggleTheme);
      if(host)host.insertBefore(tb,host.firstChild);
    }

    if(!isIndex&&!inFrame&&!document.getElementById('nl-menu')){
      var b=document.createElement('a');
      b.id='nl-menu';b.href='index.html';b.className='btn';
      b.title='Volver al menú principal (Alt+Inicio)';
      b.innerHTML='<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>Menú';
      b.addEventListener('click',function(e){
        if(pendingWrites.length){
          e.preventDefault();
          flush().then(function(){location.href='index.html';});
        }
      });
      if(host){host.insertBefore(b,host.firstChild);}
      else{
        var h=document.querySelector('header');
        if(h){b.classList.add('nl-float');h.insertBefore(b,h.firstChild);}
        else{b.classList.add('nl-float');document.body.insertBefore(b,document.body.firstChild);}
      }
    }
    applyTheme(getTheme());
  }

  var css=document.createElement('style');
  css.textContent='#nl-menu,#nl-theme{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:inherit}'+
    '#nl-menu.nl-float{margin-bottom:14px;color:inherit}';
  document.head.appendChild(css);

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addTopControls);
  else addTopControls();

  document.addEventListener('keydown',function(e){
    if(e.altKey&&e.key==='Home'){
      e.preventDefault();
      flush().then(function(){location.href='index.html';});
    }
  });
})();
