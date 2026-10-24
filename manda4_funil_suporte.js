/* =====================================================================
   manda4 - Funil de Suporte (categoria 28)
   Etapas, responsaveis, tempo de atendimento, backlog. Visual Power BI.
   JS externo servido via jsDelivr. Gerado a partir do bloco HTML.
   ===================================================================== */
(function(){
"use strict";
if (window.__fsStarted) return;
window.__fsStarted = true;

/* ===================== CONFIG ===================== */
var CFG = {
  WEBHOOK: "https://manda4.bitrix24.com.br/rest/1/2r1lc32qfv3jck4h/",
  CATEGORY_ID: 28,
  MAX_CONCURRENT: 4,
  STAGE_WON: "C28:WON",
  STAGE_LOSE: "C28:LOSE",
  STAGE_NEW: "C28:NEW",
  STAGE_SEM: "C28:UC_EKBT50",      /* SEM ATENDIMENTO (alerta) */
  /* etapas na ordem do funil */
  STAGES: [
    {id:"C28:NEW",         nome:"Solicitação (15 min)"},
    {id:"C28:UC_EKBT50",   nome:"SEM ATENDIMENTO"},
    {id:"C28:PREPARATION", nome:"Em Atendimento"},
    {id:"C28:UC_K1GEM2",   nome:"Follow-up"},
    {id:"C28:UC_QXR5H5",   nome:"GRUPOS"},
    {id:"C28:UC_BC5IGN",   nome:"Chamados (Parceiros)"},
    {id:"C28:UC_2CVMU7",   nome:"Agendamento"},
    {id:"C28:WON",         nome:"Encerrado"},
    {id:"C28:LOSE",        nome:"Cancelado"}
  ],
  BACKLOG_FAIXAS: [ {lbl:"0-1 dia",max:1},{lbl:"1-3 dias",max:3},{lbl:"3-7 dias",max:7},{lbl:"7-15 dias",max:15},{lbl:"15-30 dias",max:30},{lbl:"30+ dias",max:1e9} ]
};
var STAGE_NAME={}; CFG.STAGES.forEach(function(s){STAGE_NAME[s.id]=s.nome;});
/* cores por etapa (degradê azul -> verde para encerrado, vermelho p/ cancelado, âmbar p/ alerta) */
var STAGE_COLOR={
  "C28:NEW":"#118dff","C28:UC_EKBT50":"#f2a900","C28:PREPARATION":"#12239e",
  "C28:UC_K1GEM2":"#8764b8","C28:UC_QXR5H5":"#00b7c3","C28:UC_BC5IGN":"#e66c37",
  "C28:UC_2CVMU7":"#6b007b","C28:WON":"#107c41","C28:LOSE":"#d13438"
};
var PALETA=["#118dff","#12239e","#e66c37","#6b007b","#107c41","#f2a900","#d13438","#8764b8","#00b7c3","#e3008c"];

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
function num1(v){ if(v==null||isNaN(v))return "—"; return (Math.round(v*10)/10).toLocaleString("pt-BR"); }
function pct(v){ if(v==null||isNaN(v))return "—"; return (Math.round(v*10)/10).toLocaleString("pt-BR")+"%"; }
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function iso(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function setStatus(m){var e=$("fsStatus");if(e)e.textContent=m;}
function dias(min){ if(min==null||isNaN(min))return "—"; return num1(min/1440); }
var MES_PT=["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];

/* ===================== ESTADO ===================== */
var DIM={users:{},sources:{}};
var DATA={deals:[]};

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
function respNome(id){ return DIM.users[String(id)] || ("Resp. #"+id); }
function fonteNome(id){ if(!id) return "(sem fonte)"; return DIM.sources[String(id)] || id; }

/* ===================== CARGA ===================== */
function carregar(de, ate){
  setStatus("Carregando chamados do funil de Suporte...");
  var filtro={ CATEGORY_ID: CFG.CATEGORY_ID };
  if(de) filtro[">=DATE_CREATE"]=de+"T00:00:00";
  if(ate) filtro["<=DATE_CREATE"]=ate+"T23:59:59";
  return listAll("crm.deal.list",{
    filter:filtro,
    select:["ID","TITLE","STAGE_ID","STAGE_SEMANTIC_ID","ASSIGNED_BY_ID","SOURCE_ID","DATE_CREATE","CLOSEDATE","MOVED_TIME"],
    order:{DATE_CREATE:"DESC"}
  },function(r){return r||[];}).then(function(deals){
    DATA.deals = deals.map(prep);
  });
}
function prep(d){
  var dc=d.DATE_CREATE?new Date(d.DATE_CREATE):null;
  var cd=d.CLOSEDATE?new Date(d.CLOSEDATE):null;
  var sem=d.STAGE_SEMANTIC_ID; /* P=em processo, S=won, F=lose */
  var won=(d.STAGE_ID===CFG.STAGE_WON), lose=(d.STAGE_ID===CFG.STAGE_LOSE);
  var aberto=!(won||lose);
  /* tempo de resolução só para encerrados (WON) com closedate >= criação */
  var resMin=null;
  if(won && dc && cd && cd>=dc){ resMin=(cd-dc)/60000; }
  /* idade do backlog (abertos): agora - criação */
  var ageMin=null;
  if(aberto && dc){ ageMin=(new Date()-dc)/60000; }
  return {
    id:d.ID, title:d.TITLE||("#"+d.ID), stage:d.STAGE_ID, sem:sem,
    won:won, lose:lose, aberto:aberto,
    respId:String(d.ASSIGNED_BY_ID||""), srcId:String(d.SOURCE_ID||""),
    dc:dc, cd:cd, resMin:resMin, ageMin:ageMin
  };
}

/* ===================== FILTRO ===================== */
function filtrar(){
  var fResp=$("fsResp").value, fEtapa=$("fsEtapa").value, fFonte=$("fsFonte").value;
  return DATA.deals.filter(function(d){
    if(fResp && d.respId!==fResp) return false;
    if(fEtapa && d.stage!==fEtapa) return false;
    if(fFonte && d.srcId!==fFonte) return false;
    return true;
  });
}

/* ===================== AGREGAÇÃO ===================== */
function agregar(deals){
  var total=deals.length, won=0, lose=0, aberto=0;
  var somaRes=0,nRes=0;
  var porEtapa={}, porResp={}, porFonte={}, porMes={};
  var backlog=CFG.BACKLOG_FAIXAS.map(function(f){return {lbl:f.lbl,max:f.max,n:0};});
  deals.forEach(function(d){
    if(d.won)won++; else if(d.lose)lose++; else aberto++;
    porEtapa[d.stage]=(porEtapa[d.stage]||0)+1;
    if(d.resMin!=null){ somaRes+=d.resMin; nRes++; }
    var r=d.respId;
    if(!porResp[r]) porResp[r]={id:r,nome:respNome(r),total:0,won:0,lose:0,aberto:0,somaRes:0,nRes:0};
    var pr=porResp[r]; pr.total++;
    if(d.won){pr.won++;pr.somaRes+=d.resMin||0;if(d.resMin!=null)pr.nRes++;} else if(d.lose)pr.lose++; else pr.aberto++;
    var f=d.srcId; porFonte[f]=(porFonte[f]||0)+1;
    if(d.dc){
      var mk=d.dc.getFullYear()+"-"+String(d.dc.getMonth()+1).padStart(2,"0");
      if(!porMes[mk])porMes[mk]={k:mk,criados:0,encerrados:0};
      porMes[mk].criados++;
    }
    if(d.won && d.cd){
      var mk2=d.cd.getFullYear()+"-"+String(d.cd.getMonth()+1).padStart(2,"0");
      if(!porMes[mk2])porMes[mk2]={k:mk2,criados:0,encerrados:0};
      porMes[mk2].encerrados++;
    }
    if(d.aberto && d.ageMin!=null){
      var ad=d.ageMin/1440;
      for(var i=0;i<backlog.length;i++){ if(ad<=backlog[i].max){ backlog[i].n++; break; } }
    }
  });
  var taxaRes = (won+lose)? (won/(won+lose)*100):null;
  var tmRes = nRes? (somaRes/nRes):null;
  return {total:total,won:won,lose:lose,aberto:aberto,taxaRes:taxaRes,tmResMin:tmRes,nRes:nRes,
    porEtapa:porEtapa,porResp:porResp,porFonte:porFonte,porMes:porMes,backlog:backlog};
}

/* ===================== RENDER: CARDS ===================== */
function renderCards(a){
  var semAtend=a.porEtapa[CFG.STAGE_SEM]||0;
  function card(lbl,val,hint,cls,sm){
    return '<div class="fsCard '+(cls||"")+'"><div class="lbl">'+esc(lbl)+'</div><div class="val'+(sm?" sm":"")+'">'+val+'</div><div class="hint">'+(hint||"&nbsp;")+'</div></div>';
  }
  $("fsCards").innerHTML =
    card("Total de chamados", nfInt.format(a.total), "no período", "") +
    card("Em aberto", nfInt.format(a.aberto), "não encerrados/cancelados", a.aberto>0?"warn":"ok") +
    card("Encerrados", nfInt.format(a.won), "etapa Encerrado", "ok") +
    card("Taxa de resolução", pct(a.taxaRes), "encerrados ÷ (enc.+canc.)", a.taxaRes>=85?"ok":(a.taxaRes>=60?"warn":"bad")) +
    card("Tempo médio resolução", a.tmResMin!=null?dias(a.tmResMin)+" d":"—", a.nRes+" encerrados medidos", "alt", true) +
    card("SEM ATENDIMENTO", nfInt.format(semAtend), "alerta — chamados largados", semAtend>0?"bad":"ok", true);
}

/* ===================== RENDER: funil ===================== */
function renderFunil(a){
  var arr=CFG.STAGES.map(function(s){return {id:s.id,nome:s.nome,n:a.porEtapa[s.id]||0};});
  var max=Math.max.apply(null,arr.map(function(x){return x.n;}))||1;
  var totalBase=a.total||1;
  $("fsFunil").innerHTML = arr.map(function(x){
    var w=Math.round(x.n/max*100);
    var p=Math.round(x.n/totalBase*1000)/10;
    var cor=STAGE_COLOR[x.id]||"#118dff";
    return '<div class="fsFunRow"><span class="fsFunNome" title="'+esc(x.nome)+'">'+esc(x.nome)+'</span>'
      +'<div class="fsFunBarWrap"><div class="fsFunBar" style="width:'+Math.max(w,4)+'%;background:'+cor+'">'+nfInt.format(x.n)+'</div>'
      +'<span class="fsFunPct">'+p.toLocaleString("pt-BR")+'% do total</span></div></div>';
  }).join("");
}

/* ===================== RENDER: donut ===================== */
function renderDonut(a){
  var fatias=[
    {lbl:"Encerrado",n:a.won,cor:"#107c41"},
    {lbl:"Cancelado",n:a.lose,cor:"#d13438"},
    {lbl:"Em aberto",n:a.aberto,cor:"#118dff"}
  ].filter(function(x){return x.n>0;});
  var tot=fatias.reduce(function(s,x){return s+x.n;},0)||1;
  var cx=90,cy=90,r=78,ang=-Math.PI/2,paths="";
  fatias.forEach(function(f){
    var frac=f.n/tot,a2=ang+frac*2*Math.PI;
    var x1=cx+r*Math.cos(ang),y1=cy+r*Math.sin(ang),x2=cx+r*Math.cos(a2),y2=cy+r*Math.sin(a2);
    var large=frac>0.5?1:0;
    if(fatias.length===1){ paths+='<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+f.cor+'"/>'; }
    else{ paths+='<path d="M'+cx+','+cy+' L'+x1+','+y1+' A'+r+','+r+' 0 '+large+',1 '+x2+','+y2+' Z" fill="'+f.cor+'"><title>'+f.lbl+': '+f.n+' ('+Math.round(frac*100)+'%)</title></path>'; }
    ang=a2;
  });
  var leg=fatias.map(function(f){return '<span><i class="fsDot" style="background:'+f.cor+'"></i>'+f.lbl+' · '+nfInt.format(f.n)+' ('+pct(f.n/tot*100)+')</span>';}).join("");
  $("fsDonut").innerHTML='<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;justify-content:center">'
    +'<svg viewBox="0 0 180 180" width="180" height="180">'+paths+'<circle cx="90" cy="90" r="46" fill="#fff"/>'
    +'<text x="90" y="85" font-size="12" fill="#605e5c" text-anchor="middle">Total</text>'
    +'<text x="90" y="106" font-size="18" font-weight="600" fill="#252423" text-anchor="middle">'+nfInt.format(tot)+'</text></svg>'
    +'<div class="fsLegend" style="flex-direction:column">'+leg+'</div></div>';
}

/* ===================== RENDER: por responsável ===================== */
function cellBar(val,max,txt){
  var w=max?Math.round(val/max*100):0;
  return '<td class="num fsCell"><span class="fsCellBar" style="width:'+w+'%"></span><span>'+txt+'</span></td>';
}
function renderResp(a){
  var arr=Object.keys(a.porResp).map(function(k){var r=a.porResp[k];r.taxa=(r.won+r.lose)?(r.won/(r.won+r.lose)*100):null;r.tmDias=r.nRes?(r.somaRes/r.nRes/1440):null;return r;})
    .sort(function(x,y){return y.total-x.total;});
  var maxT=Math.max.apply(null,arr.map(function(r){return r.total;}))||1;
  var rows=arr.map(function(r){
    var tag=r.taxa==null?'<span class="fsTag">—</span>':r.taxa>=85?'<span class="fsTag ok">'+pct(r.taxa)+'</span>':r.taxa>=60?'<span class="fsTag warn">'+pct(r.taxa)+'</span>':'<span class="fsTag bad">'+pct(r.taxa)+'</span>';
    return '<tr><td>'+esc(r.nome)+'</td>'
      +cellBar(r.total,maxT,nfInt.format(r.total))
      +'<td class="num">'+nfInt.format(r.aberto)+'</td>'
      +'<td class="num">'+nfInt.format(r.won)+'</td>'
      +'<td class="num">'+nfInt.format(r.lose)+'</td>'
      +'<td>'+tag+'</td>'
      +'<td class="num">'+num1(r.tmDias)+'</td></tr>';
  }).join("");
  $("fsResp2").innerHTML='<table class="fsTbl"><thead><tr><th>Responsável</th><th class="num">Total</th>'
    +'<th class="num">Aberto</th><th class="num">Encerr.</th><th class="num">Canc.</th><th>Taxa resol.</th><th class="num">Tempo médio (d)</th></tr></thead><tbody>'
    +(rows||'<tr><td colspan="7" style="text-align:center;color:#605e5c;padding:18px">Sem dados.</td></tr>')+'</tbody></table>';
}

/* ===================== RENDER: backlog ===================== */
function renderBacklog(a){
  var tot=a.backlog.reduce(function(s,f){return s+f.n;},0)||1;
  var max=Math.max.apply(null,a.backlog.map(function(f){return f.n;}))||1;
  var rows=a.backlog.map(function(f){
    var cls=f.max<=3?"ok":f.max<=15?"warn":"bad";
    return '<tr><td><span class="fsTag '+cls+'">'+esc(f.lbl)+'</span></td>'
      +cellBar(f.n,max,nfInt.format(f.n))
      +'<td class="num">'+pct(f.n/tot*100)+'</td></tr>';
  }).join("");
  $("fsBacklog").innerHTML='<table class="fsTbl"><thead><tr><th>Idade na fila</th><th class="num">Chamados abertos</th><th class="num">%</th></tr></thead><tbody>'
    +rows+'</tbody></table><p style="font-size:11px;color:#605e5c;margin-top:8px">'+nfInt.format(tot)+' chamado(s) em aberto. Idade = hoje − data de criação.</p>';
}

/* ===================== RENDER: tempo de resolução ===================== */
function renderTempo(a){
  /* distribuição de tempo de resolução dos encerrados em faixas */
  var faixas=[{lbl:"< 1 dia",max:1},{lbl:"1-3 dias",max:3},{lbl:"3-7 dias",max:7},{lbl:"7-15 dias",max:15},{lbl:"15-30 dias",max:30},{lbl:"30+ dias",max:1e9}];
  var cont=faixas.map(function(f){return {lbl:f.lbl,max:f.max,n:0};});
  DATA.deals.forEach(function(d){ /* usa dataset filtrado? usamos agregado: recomputa pelos filtrados */ });
  var filtrados=filtrar().filter(function(d){return d.won && d.resMin!=null;});
  filtrados.forEach(function(d){ var dd=d.resMin/1440; for(var i=0;i<cont.length;i++){ if(dd<=cont[i].max){cont[i].n++;break;} } });
  var tot=filtrados.length||1;
  var max=Math.max.apply(null,cont.map(function(f){return f.n;}))||1;
  var rows=cont.map(function(f){
    var cls=f.max<=3?"ok":f.max<=15?"warn":"bad";
    return '<tr><td><span class="fsTag '+cls+'">'+esc(f.lbl)+'</span></td>'+cellBar(f.n,max,nfInt.format(f.n))+'<td class="num">'+pct(f.n/tot*100)+'</td></tr>';
  }).join("");
  $("fsTempo").innerHTML='<table class="fsTbl"><thead><tr><th>Tempo até encerrar</th><th class="num">Encerrados</th><th class="num">%</th></tr></thead><tbody>'
    +rows+'</tbody></table><p style="font-size:11px;color:#605e5c;margin-top:8px">'+nfInt.format(filtrados.length)+' encerrado(s) medido(s). Tempo = encerramento − criação.</p>';
}

/* ===================== RENDER: evolução mensal ===================== */
function renderEvol(a){
  var keys=Object.keys(a.porMes).sort();
  if(!keys.length){ $("fsEvol").innerHTML='<p style="color:#605e5c;font-size:12px">Sem dados.</p>'; return; }
  var maxV=0; keys.forEach(function(k){ maxV=Math.max(maxV,a.porMes[k].criados,a.porMes[k].encerrados); }); maxV=maxV||1;
  var W=Math.max(560,keys.length*70), H=210, pad=34, gw=(W-pad*2)/keys.length, bw=Math.min(22,(gw-10)/2);
  var g="";
  keys.forEach(function(k,i){
    var m=a.porMes[k];
    var x0=pad+i*gw+gw/2;
    var h1=Math.round(m.criados/maxV*(H-pad*2)), h2=Math.round(m.encerrados/maxV*(H-pad*2));
    g+='<rect x="'+(x0-bw-2)+'" y="'+(H-pad-h1)+'" width="'+bw+'" height="'+h1+'" fill="#118dff" rx="2"><title>'+k+' criados: '+m.criados+'</title></rect>';
    g+='<rect x="'+(x0+2)+'" y="'+(H-pad-h2)+'" width="'+bw+'" height="'+h2+'" fill="#107c41" rx="2"><title>'+k+' encerrados: '+m.encerrados+'</title></rect>';
    var dt=k.split("-"); g+='<text x="'+x0+'" y="'+(H-12)+'" font-size="10" fill="#605e5c" text-anchor="middle">'+MES_PT[parseInt(dt[1],10)-1]+'/'+dt[0].slice(2)+'</text>';
  });
  var leg='<div class="fsLegend"><span><i class="fsDot" style="background:#118dff"></i>Criados</span><span><i class="fsDot" style="background:#107c41"></i>Encerrados</span></div>';
  $("fsEvol").innerHTML='<div style="overflow-x:auto"><svg viewBox="0 0 '+W+' '+H+'" width="100%" style="min-width:'+Math.min(W,1400)+'px;height:'+H+'px">'+g+'</svg></div>'+leg;
}

/* ===================== RENDER: por fonte ===================== */
function renderPorFonte(a){
  var arr=Object.keys(a.porFonte).map(function(k){return {id:k,n:a.porFonte[k]};}).sort(function(x,y){return y.n-x.n;}).slice(0,12);
  var max=arr.length?Math.max.apply(null,arr.map(function(x){return x.n;})):1;
  $("fsPorFonte").innerHTML=arr.map(function(x,i){
    var w=Math.round(x.n/max*100), cor=PALETA[i%PALETA.length];
    return '<div class="fsBarRow"><span class="fsBarNome" title="'+esc(fonteNome(x.id))+'">'+esc(fonteNome(x.id))+'</span>'
      +'<div class="fsBarWrap"><div class="fsBarFill" style="width:'+Math.max(w,2)+'%;background:'+cor+'"></div><span class="fsBarVal">'+nfInt.format(x.n)+'</span></div></div>';
  }).join("")||'<p style="color:#605e5c;font-size:12px">Sem dados.</p>';
}

/* ===================== POPULAR FILTROS ===================== */
function popularFiltros(){
  var resps={}, fontes={};
  DATA.deals.forEach(function(d){ resps[d.respId]=1; if(d.srcId)fontes[d.srcId]=1; });
  var selR=$("fsResp");
  Object.keys(resps).map(function(k){return {id:k,nome:respNome(k)};}).sort(function(a,b){return a.nome.localeCompare(b.nome);})
    .forEach(function(x){ var o=document.createElement("option"); o.value=x.id; o.textContent=x.nome; selR.appendChild(o); });
  var selE=$("fsEtapa");
  CFG.STAGES.forEach(function(s){ var o=document.createElement("option"); o.value=s.id; o.textContent=s.nome; selE.appendChild(o); });
  var selF=$("fsFonte");
  Object.keys(fontes).map(function(k){return {id:k,nome:fonteNome(k)};}).sort(function(a,b){return a.nome.localeCompare(b.nome);})
    .forEach(function(x){ var o=document.createElement("option"); o.value=x.id; o.textContent=x.nome; selF.appendChild(o); });
}

/* ===================== RENDER GERAL ===================== */
function render(){
  var deals=filtrar();
  var a=agregar(deals);
  renderCards(a);
  renderFunil(a);
  renderDonut(a);
  renderResp(a);
  renderBacklog(a);
  renderTempo(a);
  renderEvol(a);
  renderPorFonte(a);
  $("fsMeta").innerHTML="Atualizado: "+new Date().toLocaleString("pt-BR")+"<br>"+nfInt.format(DATA.deals.length)+" chamados carregados · "+nfInt.format(deals.length)+" no filtro";
  setStatus("Pronto. "+nfInt.format(deals.length)+" chamado(s) no filtro atual.");
}

/* ===================== PRESETS ===================== */
var curDe="", curAte="";
function aplicarPreset(p){
  var hoje=new Date(), de=new Date(), ate=new Date();
  if(p==="7"){ de.setDate(hoje.getDate()-6); }
  else if(p==="30"){ de.setDate(hoje.getDate()-29); }
  else if(p==="mes"){ de=new Date(hoje.getFullYear(),hoje.getMonth(),1); }
  else if(p==="mesant"){ de=new Date(hoje.getFullYear(),hoje.getMonth()-1,1); ate=new Date(hoje.getFullYear(),hoje.getMonth(),0); }
  else if(p==="ano"){ de=new Date(hoje.getFullYear(),0,1); }
  else if(p==="tudo"){ $("fsDe").value=""; $("fsAte").value=""; return; }
  $("fsDe").value=iso(de); $("fsAte").value=iso(ate);
}

/* ===================== EVENTOS ===================== */
function recarregar(){
  var de=$("fsDe").value, ate=$("fsAte").value;
  setStatus("Carregando...");
  carregar(de,ate).then(function(){ render(); }).catch(function(e){ setStatus("Erro: "+(e&&e.message?e.message:e)); });
}
function bind(){
  Array.prototype.forEach.call(document.querySelectorAll(".fsP"),function(b){
    b.addEventListener("click",function(){
      Array.prototype.forEach.call(document.querySelectorAll(".fsP"),function(x){x.classList.remove("fsPon");});
      b.classList.add("fsPon");
      aplicarPreset(b.getAttribute("data-preset"));
      recarregar();
    });
  });
  $("fsGo").addEventListener("click",recarregar);
  ["fsResp","fsEtapa","fsFonte"].forEach(function(id){ $(id).addEventListener("change",render); });
  $("fsCsv").addEventListener("click",exportarCsv);
}
function exportarCsv(){
  var deals=filtrar();
  var out=[["ID","Titulo","Etapa","Responsavel","Fonte","Criado","Encerrado","Resolucao (dias)"]];
  deals.forEach(function(d){
    out.push([d.id,d.title,STAGE_NAME[d.stage]||d.stage,respNome(d.respId),fonteNome(d.srcId),
      d.dc?d.dc.toLocaleString("pt-BR"):"", d.cd&&d.won?d.cd.toLocaleString("pt-BR"):"",
      d.resMin!=null?(Math.round(d.resMin/1440*10)/10).toString().replace(".",","):""]);
  });
  var csv=out.map(function(l){return l.map(function(c){return '"'+String(c==null?"":c).replace(/"/g,'""')+'"';}).join(";");}).join("\r\n");
  var blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"});
  var a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="funil_suporte.csv"; a.click();
}

/* ===================== INIT ===================== */
function init(){
  bind();
  aplicarPreset("mes");
  carregarDimensoes()
    .then(function(){ return carregar($("fsDe").value,$("fsAte").value); })
    .then(function(){ popularFiltros(); render(); })
    .catch(function(e){ setStatus("Erro ao carregar: "+(e&&e.message?e.message:e)); });
}
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",init); else init();

})();
