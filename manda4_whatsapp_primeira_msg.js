/* =====================================================================
   manda4 - Primeiras mensagens de WhatsApp por colaborador
   Canal Aberto (IMOPENLINES) - dedup por negocio (OWNER_ID)
   JS externo servido via jsDelivr. Gerado a partir do bloco HTML.
   ===================================================================== */
(function(){
"use strict";
if (window.__wzStarted) return;
window.__wzStarted = true;

/* ===================== CONFIG ===================== */
var CFG = {
  WEBHOOK: "https://manda4.bitrix24.com.br/rest/1/2r1lc32qfv3jck4h/",
  CATEGORY_ID: 28,                 /* funil Suporte */
  PROVIDER: "IMOPENLINES_SESSION", /* sessões de Canal Aberto (WhatsApp) */
  DIRECTION_IN: "1",               /* 1 = mensagem de entrada (cliente -> empresa) */
  OWNER_TYPE_DEAL: "2",            /* OWNER_TYPE_ID 2 = Deal/negócio */
  MAX_CONCURRENT: 4,
  PAGE_SIZE: 25
};
/* paleta Power BI */
var PALETA = ["#118dff","#12239e","#e66c37","#6b007b","#107c41","#f2a900","#d13438","#8764b8","#00b7c3","#e3008c","#742774","#0099bc"];

/* ===================== REST ===================== */
var _sem={running:0,queue:[]};
function acq(){return new Promise(function(res){if(CFG.MAX_CONCURRENT>_sem.running){_sem.running++;res();}else _sem.queue.push(res);});}
function rel(){_sem.running--;if(_sem.queue.length){_sem.running++;_sem.queue.shift()();}}
function call(method,params){
  return acq().then(function(){
    var url=CFG.WEBHOOK+method+".json", body=JSON.stringify(params||{});
    return fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:body})
    .then(function(r){
      if(r.status===503)return new Promise(function(x){setTimeout(x,1000);}).then(function(){rel();return call(method,params);});
      if(!r.ok)throw new Error(method+" HTTP "+r.status);
      return r.json();
    }).then(function(j){rel();if(j.error)throw new Error(method+": "+(j.error_description||j.error));return j;})
    .catch(function(e){rel();throw e;});
  });
}
function listAll(method,params,extract){
  extract=extract||function(r){return r||[];};
  var all=[];
  function page(start){
    var p=Object.assign({},params,{start:start});
    return call(method,p).then(function(r){
      var chunk=extract(r.result);
      all=all.concat(chunk);
      var total=typeof r.total==="number"?r.total:0;
      var next=(typeof r.next==="number")?r.next:(chunk.length===50?start+50:0);
      if(next && all.length<total && chunk.length) return page(next);
      return all;
    });
  }
  return page(0);
}

/* ===================== HELPERS ===================== */
var $=function(id){return document.getElementById(id);};
var nfInt=new Intl.NumberFormat("pt-BR");
function pct(v){ if(v==null||isNaN(v))return "—"; return (Math.round(v*10)/10).toLocaleString("pt-BR")+"%"; }
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function iso(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function setStatus(m){var e=$("wzStatus");if(e)e.textContent=m;}
var MES_PT=["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];

/* extrai o nome do canal a partir do SUBJECT da sessão.
   Ex.: Bate-papo do Canal Aberto: "Fulano - Manda4 Suporte" (WhatsApp MandaZap)
   -> canal = "WhatsApp MandaZap". Fallback para o texto entre aspas. */
function canalDoSubject(s){
  s=String(s||"");
  var m=s.match(/\(([^()]+)\)\s*$/);           /* último parêntese: (WhatsApp MandaZap) */
  if(m) return m[1].trim();
  return "Canal Aberto";
}
/* nome/telefone do cliente a partir do SUBJECT (texto entre aspas) */
function clienteDoSubject(s){
  s=String(s||"");
  var m=s.match(/"([^"]+)"/) || s.match(/\u0022([^\u0022]+)\u0022/);
  if(m){
    var t=m[1].replace(/\s*-\s*Manda4 Suporte\s*$/i,"").trim();
    return t||m[1].trim();
  }
  return "—";
}

/* ===================== ESTADO ===================== */
var DIM={users:{},sources:{}};
var DATA={rows:[]};              /* 1 linha por DEAL = 1ª mensagem */
var tblPage=1, tblSearch="";

/* ===================== DIMENSÕES ===================== */
function carregarDimensoes(){
  var p1=listAll("user.get",{},function(r){return r||[];}).then(function(us){
    us.forEach(function(u){ DIM.users[String(u.ID)]=((u.NAME||"")+" "+(u.LAST_NAME||"")).trim()||("Usuário #"+u.ID); });
  }).catch(function(){});
  var p2=call("crm.status.list",{filter:{ENTITY_ID:"SOURCE"}}).then(function(j){
    (j.result||[]).forEach(function(s){ DIM.sources[String(s.STATUS_ID)]=s.NAME||s.STATUS_ID; });
  }).catch(function(){});
  return Promise.all([p1,p2]);
}
function respNome(id){ return DIM.users[String(id)] || ("Colaborador #"+id); }
function fonteNome(id){ if(!id) return "(sem fonte)"; return DIM.sources[String(id)] || id; }

/* ===================== CARGA =====================
   1) Carrega TODAS as sessões IMOPENLINES de entrada (DIRECTION=1) vinculadas a deals.
   2) Deduplica por OWNER_ID: mantém a de MENOR CREATED (1ª mensagem do negócio).
   3) Carrega os deals da categoria 28 p/ obter SOURCE_ID (fonte) e TITLE (cliente). */
function carregar(){
  setStatus("Carregando sessões de WhatsApp...");
  var filtro={
    PROVIDER_ID: CFG.PROVIDER,
    DIRECTION: CFG.DIRECTION_IN,
    OWNER_TYPE_ID: CFG.OWNER_TYPE_DEAL
  };
  return listAll("crm.activity.list",{
    filter:filtro,
    select:["ID","PROVIDER_ID","DIRECTION","RESPONSIBLE_ID","CREATED","OWNER_TYPE_ID","OWNER_ID","SUBJECT","ORIGIN_ID"],
    order:{CREATED:"ASC"}
  },function(r){return r||[];}).then(function(acts){
    /* dedup por deal: 1ª (menor CREATED). Como order=ASC, o 1º visto por OWNER_ID é o menor. */
    var primeira={};
    acts.forEach(function(a){
      var deal=String(a.OWNER_ID||"");
      if(!deal) return;
      if(!primeira[deal]){
        primeira[deal]={
          dealId:deal,
          actId:a.ID,
          respId:String(a.RESPONSIBLE_ID||""),
          created:a.CREATED?new Date(a.CREATED):null,
          canal:canalDoSubject(a.SUBJECT),
          cliente:clienteDoSubject(a.SUBJECT),
          srcId:"",             /* preenchido com os deals */
          dealTitle:""
        };
      }
    });
    DATA.rows=Object.keys(primeira).map(function(k){return primeira[k];});
    return enriquecerComDeals();
  });
}
/* busca SOURCE_ID e TITLE dos deals em lotes por ID */
function enriquecerComDeals(){
  setStatus("Cruzando com negócios (fonte/cliente)...");
  var ids=DATA.rows.map(function(r){return r.dealId;});
  var byId={};
  var lotes=[]; for(var i=0;i<ids.length;i+=50){ lotes.push(ids.slice(i,i+50)); }
  return lotes.reduce(function(p,lote){
    return p.then(function(){
      return call("crm.deal.list",{
        filter:{ID:lote},
        select:["ID","TITLE","SOURCE_ID","CATEGORY_ID"]
      }).then(function(j){
        (j.result||[]).forEach(function(d){ byId[String(d.ID)]={src:String(d.SOURCE_ID||""),title:d.TITLE||""}; });
      }).catch(function(){});
    });
  }, Promise.resolve()).then(function(){
    DATA.rows.forEach(function(r){
      var d=byId[r.dealId];
      if(d){ r.srcId=d.src; r.dealTitle=d.title; }
    });
  });
}

/* ===================== FILTRO ===================== */
function parseDate(v){ return v?new Date(v+"T00:00:00"):null; }
function filtrar(){
  var de=parseDate($("wzDe").value), ate=parseDate($("wzAte").value);
  if(ate) ate=new Date(ate.getTime()+86399000); /* fim do dia */
  var fResp=$("wzResp").value, fCanal=$("wzCanal").value, fFonte=$("wzFonte").value;
  var fCli=($("wzCliente").value||"").trim().toLowerCase();
  return DATA.rows.filter(function(r){
    if(de && (!r.created || r.created<de)) return false;
    if(ate && (!r.created || r.created>ate)) return false;
    if(fResp && r.respId!==fResp) return false;
    if(fCanal && r.canal!==fCanal) return false;
    if(fFonte && r.srcId!==fFonte) return false;
    if(fCli){
      var hay=(r.cliente+" "+r.dealTitle+" #"+r.dealId).toLowerCase();
      if(hay.indexOf(fCli)<0) return false;
    }
    return true;
  });
}

/* ===================== AGREGAÇÃO ===================== */
function agregar(rows){
  var porResp={}, porCanal={}, porFonte={}, porDia={};
  rows.forEach(function(r){
    porResp[r.respId]=(porResp[r.respId]||0)+1;
    porCanal[r.canal]=(porCanal[r.canal]||0)+1;
    porFonte[r.srcId]=(porFonte[r.srcId]||0)+1;
    if(r.created){ var k=iso(r.created); porDia[k]=(porDia[k]||0)+1; }
  });
  return {
    total:rows.length,
    nResp:Object.keys(porResp).length,
    nCanais:Object.keys(porCanal).length,
    porResp:porResp, porCanal:porCanal, porFonte:porFonte, porDia:porDia
  };
}

/* ===================== RENDER: CARDS ===================== */
function renderCards(a){
  var topNome="—", topVal=0;
  Object.keys(a.porResp).forEach(function(k){ if(a.porResp[k]>topVal){topVal=a.porResp[k];topNome=respNome(k);} });
  var mediaResp = a.nResp? (a.total/a.nResp):0;
  function card(lbl,val,hint,cls,sm){
    return '<div class="wzCard '+(cls||"")+'"><div class="lbl">'+esc(lbl)+'</div><div class="val'+(sm?" sm":"")+'">'+val+'</div><div class="hint">'+(hint||"&nbsp;")+'</div></div>';
  }
  $("wzCards").innerHTML =
    card("Total 1ª mensagens", nfInt.format(a.total), "clientes únicos (por negócio)", "") +
    card("Colaboradores", nfInt.format(a.nResp), "com ao menos 1 atendimento", "alt") +
    card("Média por colaborador", (Math.round(mediaResp*10)/10).toLocaleString("pt-BR"), "1ª mensagens ÷ colaboradores", "ok", true) +
    card("Top colaborador", esc(topNome), nfInt.format(topVal)+" atendimentos", "warn", true) +
    card("Canais ativos", nfInt.format(a.nCanais), "Canais Abertos no período", "alt", true);
}

/* ===================== RENDER: barras ===================== */
function barras(elId, arr, nomeFn){
  var el=$(elId);
  var max=arr.length?Math.max.apply(null,arr.map(function(x){return x.n;})):1;
  el.innerHTML = arr.map(function(x,i){
    var w=Math.round(x.n/max*100);
    var cor=PALETA[i%PALETA.length];
    return '<div class="wzBarRow"><span class="wzBarNome" title="'+esc(nomeFn(x))+'">'+esc(nomeFn(x))+'</span>'
      +'<div class="wzBarWrap"><div class="wzBarFill" style="width:'+Math.max(w,2)+'%;background:'+cor+'"></div><span class="wzBarVal">'+nfInt.format(x.n)+'</span></div></div>';
  }).join("") || '<p style="color:#605e5c;font-size:12px">Sem dados no período/filtros.</p>';
}
function renderPorResp(a){
  var arr=Object.keys(a.porResp).map(function(k){return {id:k,n:a.porResp[k]};}).sort(function(x,y){return y.n-x.n;});
  barras("wzPorResp", arr, function(x){return respNome(x.id);});
}
function renderPorCanal(a){
  var arr=Object.keys(a.porCanal).map(function(k){return {id:k,n:a.porCanal[k]};}).sort(function(x,y){return y.n-x.n;}).slice(0,12);
  barras("wzPorCanal", arr, function(x){return x.id;});
}
function renderPorFonte(a){
  var arr=Object.keys(a.porFonte).map(function(k){return {id:k,n:a.porFonte[k]};}).sort(function(x,y){return y.n-x.n;}).slice(0,12);
  barras("wzPorFonte", arr, function(x){return fonteNome(x.id);});
}

/* ===================== RENDER: donut participação ===================== */
function renderDonut(a){
  var arr=Object.keys(a.porResp).map(function(k){return {id:k,n:a.porResp[k],nome:respNome(k)};}).sort(function(x,y){return y.n-x.n;});
  var top=arr.slice(0,8);
  var resto=arr.slice(8).reduce(function(s,x){return s+x.n;},0);
  if(resto>0) top.push({id:"_",n:resto,nome:"Outros"});
  var tot=top.reduce(function(s,x){return s+x.n;},0)||1;
  var cx=90,cy=90,r=78, ang=-Math.PI/2, paths="";
  top.forEach(function(f,i){
    var frac=f.n/tot, a2=ang+frac*2*Math.PI;
    var x1=cx+r*Math.cos(ang), y1=cy+r*Math.sin(ang);
    var x2=cx+r*Math.cos(a2), y2=cy+r*Math.sin(a2);
    var large=frac>0.5?1:0, cor=PALETA[i%PALETA.length];
    if(top.length===1){ paths+='<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+cor+'"/>'; }
    else { paths+='<path d="M'+cx+','+cy+' L'+x1+','+y1+' A'+r+','+r+' 0 '+large+',1 '+x2+','+y2+' Z" fill="'+cor+'"><title>'+esc(f.nome)+': '+f.n+' ('+Math.round(frac*100)+'%)</title></path>'; }
    ang=a2;
  });
  var leg=top.map(function(f,i){ return '<span><i class="wzDot" style="background:'+PALETA[i%PALETA.length]+'"></i>'+esc(f.nome)+' · '+nfInt.format(f.n)+'</span>'; }).join("");
  $("wzDonut").innerHTML='<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">'
    +'<svg viewBox="0 0 180 180" width="180" height="180">'+paths+'<circle cx="90" cy="90" r="46" fill="#fff"/>'
    +'<text x="90" y="85" font-size="12" fill="#605e5c" text-anchor="middle">Total</text>'
    +'<text x="90" y="106" font-size="18" font-weight="600" fill="#252423" text-anchor="middle">'+nfInt.format(a.total)+'</text></svg>'
    +'<div class="wzLegend" style="flex-direction:column">'+leg+'</div></div>';
}

/* ===================== RENDER: evolução por dia ===================== */
function renderEvol(a){
  var keys=Object.keys(a.porDia).sort();
  if(!keys.length){ $("wzEvol").innerHTML='<p style="color:#605e5c;font-size:12px">Sem dados.</p>'; return; }
  var vals=keys.map(function(k){return a.porDia[k];});
  var max=Math.max.apply(null,vals)||1;
  var W=Math.max(560, keys.length*26), H=180, pad=28, bw=(W-pad*2)/keys.length;
  var bars=keys.map(function(k,i){
    var bh=Math.round(a.porDia[k]/max*(H-pad*2));
    var xx=pad+i*bw, yy=H-pad-bh;
    var d=new Date(k+"T00:00:00");
    var lbl=String(d.getDate())+"/"+MES_PT[d.getMonth()];
    var showLbl = keys.length<=20 || i%Math.ceil(keys.length/20)===0;
    return '<rect x="'+(xx+1)+'" y="'+yy+'" width="'+Math.max(bw-2,2)+'" height="'+bh+'" fill="#118dff" rx="2"><title>'+lbl+': '+a.porDia[k]+'</title></rect>'
      + (showLbl?'<text x="'+(xx+bw/2)+'" y="'+(H-9)+'" font-size="9" fill="#605e5c" text-anchor="middle">'+lbl+'</text>':'');
  }).join("");
  $("wzEvol").innerHTML='<div style="overflow-x:auto"><svg viewBox="0 0 '+W+' '+H+'" width="100%" style="min-width:'+Math.min(W,1400)+'px;height:'+H+'px">'+bars+'</svg></div>';
}

/* ===================== RENDER: tabela ===================== */
function linhasFiltradas(rows){
  var q=tblSearch.trim().toLowerCase();
  if(!q) return rows;
  return rows.filter(function(r){
    return (r.cliente+" "+r.dealTitle+" "+respNome(r.respId)+" "+r.canal+" "+fonteNome(r.srcId)+" #"+r.dealId).toLowerCase().indexOf(q)>=0;
  });
}
function renderTabela(rows){
  var filtered=linhasFiltradas(rows.slice().sort(function(x,y){return (y.created||0)-(x.created||0);}));
  var totalPg=Math.max(1,Math.ceil(filtered.length/CFG.PAGE_SIZE));
  if(tblPage>totalPg) tblPage=totalPg;
  var ini=(tblPage-1)*CFG.PAGE_SIZE, slice=filtered.slice(ini,ini+CFG.PAGE_SIZE);
  var body=slice.map(function(r){
    var dt=r.created?(String(r.created.getDate()).padStart(2,"0")+"/"+MES_PT[r.created.getMonth()]+"/"+r.created.getFullYear()+" "+String(r.created.getHours()).padStart(2,"0")+":"+String(r.created.getMinutes()).padStart(2,"0")):"—";
    return '<tr><td>'+dt+'</td><td>'+esc(r.cliente)+'</td><td>'+esc(respNome(r.respId))+'</td>'
      +'<td>'+esc(r.canal)+'</td><td>'+esc(fonteNome(r.srcId))+'</td>'
      +'<td class="num">#'+esc(r.dealId)+'</td></tr>';
  }).join("");
  $("wzTblWrap").innerHTML='<table class="wzTbl"><thead><tr>'
    +'<th>Data 1ª msg</th><th>Cliente</th><th>Colaborador</th><th>Canal</th><th>Fonte</th><th class="num">Negócio</th>'
    +'</tr></thead><tbody>'+(body||'<tr><td colspan="6" style="text-align:center;color:#605e5c;padding:18px">Sem registros.</td></tr>')+'</tbody></table>';
  /* paginação */
  var pg="";
  if(totalPg>1){
    var from=Math.max(1,tblPage-2), to=Math.min(totalPg,from+4); from=Math.max(1,to-4);
    if(tblPage>1) pg+='<button class="wzPg" data-pg="'+(tblPage-1)+'">‹</button>';
    for(var i=from;i<=to;i++){ pg+='<button class="wzPg'+(i===tblPage?" on":"")+'" data-pg="'+i+'">'+i+'</button>'; }
    if(tblPage<totalPg) pg+='<button class="wzPg" data-pg="'+(tblPage+1)+'">›</button>';
  }
  $("wzPaging").innerHTML=pg;
  Array.prototype.forEach.call($("wzPaging").querySelectorAll(".wzPg"),function(b){
    b.addEventListener("click",function(){ tblPage=parseInt(b.getAttribute("data-pg"),10); renderTabela(rows); });
  });
}

/* ===================== POPULAR FILTROS ===================== */
function popularFiltros(){
  var resps={}, canais={}, fontes={};
  DATA.rows.forEach(function(r){ resps[r.respId]=1; canais[r.canal]=1; if(r.srcId)fontes[r.srcId]=1; });
  var selR=$("wzResp");
  Object.keys(resps).map(function(k){return {id:k,nome:respNome(k)};}).sort(function(a,b){return a.nome.localeCompare(b.nome);})
    .forEach(function(x){ var o=document.createElement("option"); o.value=x.id; o.textContent=x.nome; selR.appendChild(o); });
  var selC=$("wzCanal");
  Object.keys(canais).sort().forEach(function(k){ var o=document.createElement("option"); o.value=k; o.textContent=k; selC.appendChild(o); });
  var selF=$("wzFonte");
  Object.keys(fontes).map(function(k){return {id:k,nome:fonteNome(k)};}).sort(function(a,b){return a.nome.localeCompare(b.nome);})
    .forEach(function(x){ var o=document.createElement("option"); o.value=x.id; o.textContent=x.nome; selF.appendChild(o); });
}

/* ===================== RENDER GERAL ===================== */
function render(){
  var rows=filtrar();
  var a=agregar(rows);
  renderCards(a);
  renderPorResp(a);
  renderDonut(a);
  renderPorCanal(a);
  renderPorFonte(a);
  renderEvol(a);
  tblPage=1; renderTabela(rows);
  $("wzMeta").innerHTML="Atualizado: "+new Date().toLocaleString("pt-BR")+"<br>"+nfInt.format(DATA.rows.length)+" negócios com WhatsApp · "+nfInt.format(rows.length)+" no filtro";
  setStatus("Pronto. "+nfInt.format(rows.length)+" primeira(s) mensagem(ns) no filtro atual.");
}

/* ===================== PRESETS DE PERÍODO ===================== */
function aplicarPreset(p){
  var hoje=new Date(), de=new Date(), ate=new Date();
  if(p==="7"){ de.setDate(hoje.getDate()-6); }
  else if(p==="30"){ de.setDate(hoje.getDate()-29); }
  else if(p==="mes"){ de=new Date(hoje.getFullYear(),hoje.getMonth(),1); }
  else if(p==="mesant"){ de=new Date(hoje.getFullYear(),hoje.getMonth()-1,1); ate=new Date(hoje.getFullYear(),hoje.getMonth(),0); }
  else if(p==="ano"){ de=new Date(hoje.getFullYear(),0,1); }
  else if(p==="tudo"){ $("wzDe").value=""; $("wzAte").value=""; return; }
  $("wzDe").value=iso(de); $("wzAte").value=iso(ate);
}

/* ===================== EVENTOS ===================== */
function bind(){
  Array.prototype.forEach.call(document.querySelectorAll(".wzP"),function(b){
    b.addEventListener("click",function(){
      Array.prototype.forEach.call(document.querySelectorAll(".wzP"),function(x){x.classList.remove("wzPon");});
      b.classList.add("wzPon");
      aplicarPreset(b.getAttribute("data-preset"));
      render();
    });
  });
  $("wzGo").addEventListener("click",render);
  ["wzResp","wzCanal","wzFonte"].forEach(function(id){ $(id).addEventListener("change",render); });
  $("wzCliente").addEventListener("keydown",function(e){ if(e.key==="Enter")render(); });
  $("wzBusca").addEventListener("input",function(){ tblSearch=this.value; tblPage=1; renderTabela(filtrar()); });
  $("wzCsv").addEventListener("click",exportarCsv);
}
function exportarCsv(){
  var rows=filtrar().slice().sort(function(x,y){return (y.created||0)-(x.created||0);});
  var out=[["Data 1a mensagem","Cliente","Colaborador","Canal","Fonte","Negocio ID"]];
  rows.forEach(function(r){
    out.push([
      r.created?r.created.toLocaleString("pt-BR"):"",
      r.cliente, respNome(r.respId), r.canal, fonteNome(r.srcId), r.dealId
    ]);
  });
  var csv=out.map(function(l){return l.map(function(c){return '"'+String(c==null?"":c).replace(/"/g,'""')+'"';}).join(";");}).join("\r\n");
  var blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"});
  var a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="primeiras_mensagens_whatsapp.csv"; a.click();
}

/* ===================== INIT ===================== */
function init(){
  bind();
  aplicarPreset("mes");
  carregarDimensoes()
    .then(carregar)
    .then(function(){ popularFiltros(); render(); })
    .catch(function(e){ setStatus("Erro ao carregar: "+(e&&e.message?e.message:e)); });
}
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",init); else init();

})();
