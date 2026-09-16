(function(){
"use strict";
if (window.__rhcStarted) return;   /* evita rodar duas vezes */
window.__rhcStarted = true;

/* ===================== CONFIG ===================== */
var CFG = {
  WEBHOOK : "https://tekee.bitrix24.com.br/rest/141/q1fe2g8o7q7h8v9b/",
  TS_ENTITY  : 1050,   /* SPA Timesheet */
  TS_CATEGORY: 31,
  PO_ENTITY  : 1066,   /* SPA PO */
  MAX_CONCURRENT: 4,
  BATCH_SIZE: 50,
  PAGE_SIZE: 50,
  /* campos do Timesheet */
  TS: {
    PO   : "ufCrm15_1777513013",   /* -> ID item PO */
    DATA : "ufCrm15_1753036495093",
    H_TRAB: "ufCrm15_1753036521924",
    H_EXTRA:"ufCrm15_1753036552484",
    H_DESL: "ufCrm15_1777405323760",
    NATUREZA: "ufCrm15_1760211951562",
    LOCAL   : "ufCrm15_1760967418066",
    UNIDADE : "ufCrm15_1773101916"
  },
  UNIDADE_ENTITY: 1062,   /* SPA Unidades (o campo Unidade é referência crm) */
  NATUREZA_MAP: {
    "469":"Auditoria","471":"Consultoria","473":"Inspeção","475":"Teste",
    "477":"Treinamento","505":"Interno"
  },
  LOCAL_MAP: {
    "479":"Onshore Cliente","481":"Offshore","503":"Onshore Home-Office","525":"Deslocamento"
  },
  /* meta de horas por dia útil (usado só p/ colorir a intensidade do dia) */
  META_DIA: 8
};

/* ===================== CAMADA REST ===================== */
function toQuery(obj, prefix){
  var parts=[];
  Object.keys(obj).forEach(function(k){
    var v=obj[k], key=prefix?prefix+"["+k+"]":k;
    if(v===null||v===undefined)return;
    if(Array.isArray(v)){
      v.forEach(function(item,i){
        var ik=key+"["+i+"]";
        if(item!==null&&typeof item==="object")parts.push(toQuery(item,ik));
        else parts.push(encodeURIComponent(ik)+"="+encodeURIComponent(item));
      });
    }else if(typeof v==="object"){parts.push(toQuery(v,key));}
    else{parts.push(encodeURIComponent(key)+"="+encodeURIComponent(v));}
  });
  return parts.filter(Boolean).join("&");
}
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
function batch(cmds){
  var cmd={};
  cmds.forEach(function(c,i){cmd["c"+i]=c.method+"?"+toQuery(c.params);});
  return call("batch",{halt:0,cmd:cmd}).then(function(j){
    var res=(j.result&&j.result.result)||{}, errs=(j.result&&j.result.result_error)||{};
    return cmds.map(function(c,i){
      if(errs["c"+i])throw new Error(c.method+": "+JSON.stringify(errs["c"+i]));
      return res["c"+i];
    });
  });
}
function listAllJson(method,params,extract){
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
function listAll(method,params,extract,pageSize){
  pageSize=pageSize||CFG.PAGE_SIZE;
  extract=extract||function(r){return r||[];};
  var p=Object.assign({},params,{start:0});
  return call(method,p).then(function(first){
    var items=extract(first.result).slice();
    var total=typeof first.total==="number"?first.total:items.length;
    if(total<=pageSize)return items;
    var offsets=[];for(var s=pageSize;s<total;s+=pageSize)offsets.push(s);
    var batches=[];for(var i=0;i<offsets.length;i+=CFG.BATCH_SIZE)batches.push(offsets.slice(i,i+CFG.BATCH_SIZE));
    return Promise.all(batches.map(function(chunk){
      return batch(chunk.map(function(off){return{method:method,params:Object.assign({},params,{start:off})};}))
      .then(function(rs){var partial=[];rs.forEach(function(r){if(r)partial=partial.concat(extract(r));});return partial;});
    })).then(function(results){results.forEach(function(pt){items=items.concat(pt);});return items;});
  });
}

/* ===================== HELPERS ===================== */
var $=function(id){return document.getElementById(id);};
var nfDec=new Intl.NumberFormat("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
var nfInt=new Intl.NumberFormat("pt-BR");
function h(v){return nfDec.format(Number(v)||0)+"h";}
function hplain(v){return nfDec.format(Number(v)||0);}
function num(v){return Number(String(v==null?"":v).replace(",","."))||0;}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function iso(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
/* chave de dia (YYYY-MM-DD) a partir do valor de data do Bitrix */
function diaKey(s){ if(!s)return""; var d=new Date(s); if(isNaN(d)) return String(s).slice(0,10); return iso(d); }
function fmtData(s){if(!s)return"";var d=new Date(s);if(isNaN(d))return String(s).slice(0,10);return String(d.getDate()).padStart(2,"0")+"/"+String(d.getMonth()+1).padStart(2,"0")+"/"+d.getFullYear();}
function setStatus(m){var e=$("rhStatus");if(e)e.textContent=m;}
var MESES=["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
var DOW=["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];

/* ===================== ESTADO ===================== */
var DIM={users:{},companies:{},unidades:{}};
var DATA={rows:[]};      /* linhas de timesheet enriquecidas do mês */
var POINFO={};           /* poId -> {title} */
var VIEW={ano:0, mes:0}; /* mês exibido (mes 0-11) */
var DIA_SEL=null;        /* dia selecionado p/ painel de detalhe */

/* ===================== DIMENSÕES (usuários) ===================== */
function carregarUsuarios(){
  return listAll("user.get",{},function(r){return r||[];}).then(function(users){
    users.forEach(function(u){
      DIM.users[String(u.ID)]={
        nome:((u.NAME||"")+" "+(u.LAST_NAME||"")).trim()||("Usuário #"+u.ID),
        ativo:u.ACTIVE!==false&&u.ACTIVE!=="N"
      };
    });
  });
}

/* ===================== CARGA DO MÊS ===================== */
function carregar(ano, mes){
  setStatus("Carregando apontamentos...");
  var primeiro=new Date(ano,mes,1);
  var ultimo=new Date(ano,mes+1,0);
  var de=iso(primeiro), ate=iso(ultimo);

  var filtro={};
  filtro[">="+CFG.TS.DATA]=de+"T00:00:00";
  filtro["<="+CFG.TS.DATA]=ate+"T23:59:59";
  filtro["categoryId"]=CFG.TS_CATEGORY;
  /* filtro por responsável (obrigatório nesta visão) */
  var respId=$("rhResp").value;
  if(respId) filtro["assignedById"]=respId;

  var tsParams={
    entityTypeId:CFG.TS_ENTITY,
    filter:filtro,
    order:{},
    select:["id","title","assignedById","companyId","sourceDescription","stageId",
            CFG.TS.PO,CFG.TS.DATA,CFG.TS.H_TRAB,CFG.TS.H_EXTRA,CFG.TS.H_DESL,
            CFG.TS.NATUREZA,CFG.TS.LOCAL,CFG.TS.UNIDADE]
  };
  tsParams.order[CFG.TS.DATA]="ASC";

  return listAllJson("crm.item.list",tsParams,function(r){return(r&&r.items)||[];}).then(function(items){
    DATA.rows = items.map(function(it){
      var r={
        id: it.id,
        poId: it[CFG.TS.PO]?String(it[CFG.TS.PO]):"",
        data: it[CFG.TS.DATA]||"",
        dia: diaKey(it[CFG.TS.DATA]||""),
        respId: String(it.assignedById||""),
        companyId: it.companyId,
        desc: it.sourceDescription||"",
        natureza: CFG.NATUREZA_MAP[it[CFG.TS.NATUREZA]]||"",
        local: CFG.LOCAL_MAP[it[CFG.TS.LOCAL]]||"",
        unidadeId: it[CFG.TS.UNIDADE]?String(it[CFG.TS.UNIDADE]):"",
        hTrab: num(it[CFG.TS.H_TRAB]),
        hExtra: num(it[CFG.TS.H_EXTRA]),
        hDesl: num(it[CFG.TS.H_DESL])
      };
      r.apontado = r.hTrab + r.hExtra + r.hDesl;
      return r;
    });

    /* POs únicas referenciadas -> só nome */
    var poIds={};
    DATA.rows.forEach(function(r){ if(r.poId) poIds[r.poId]=1; });
    var ids=Object.keys(poIds);
    var jobs=[];
    if(ids.length){
      setStatus("Carregando POs ("+ids.length+")...");
      var cmds=ids.map(function(id){return {method:"crm.item.get",params:{entityTypeId:CFG.PO_ENTITY,id:id}};});
      for(var i=0;i<cmds.length;i+=CFG.BATCH_SIZE){
        jobs.push(batch(cmds.slice(i,i+CFG.BATCH_SIZE)).then(function(res){
          res.forEach(function(r){ var it=r&&r.item; if(it&&it.id) POINFO[String(it.id)]={title:it.title||("PO #"+it.id)}; });
        }));
      }
    }
    return Promise.all(jobs).then(carregarEmpresas).catch(function(){/* enriquecimento best-effort */});
  });
}

function carregarEmpresas(){
  var comp={}, uni={};
  DATA.rows.forEach(function(r){
    if(r.companyId) comp[String(r.companyId)]=1;
    if(r.unidadeId) uni[r.unidadeId]=1;
  });
  var jobs=[];
  var lComp=Object.keys(comp);
  if(lComp.length){
    var cCmds=lComp.map(function(id){return{method:"crm.company.get",params:{id:id}};});
    for(var i=0;i<cCmds.length;i+=CFG.BATCH_SIZE){
      jobs.push(batch(cCmds.slice(i,i+CFG.BATCH_SIZE)).then(function(res){
        res.forEach(function(c){ if(c&&c.ID) DIM.companies[String(c.ID)]=c.TITLE||("Empresa #"+c.ID); });
      }));
    }
  }
  var lUni=Object.keys(uni);
  if(lUni.length){
    var uCmds=lUni.map(function(id){return{method:"crm.item.get",params:{entityTypeId:CFG.UNIDADE_ENTITY,id:id}};});
    for(var k=0;k<uCmds.length;k+=CFG.BATCH_SIZE){
      jobs.push(batch(uCmds.slice(k,k+CFG.BATCH_SIZE)).then(function(res){
        res.forEach(function(r){ var it=r&&r.item; if(it&&it.id) DIM.unidades[String(it.id)]=it.title||("Unidade #"+it.id); });
      }));
    }
  }
  if(!jobs.length) return;
  return Promise.all(jobs).catch(function(){});
}

/* ===================== AGREGA POR DIA ===================== */
function agregarPorDia(){
  var porDia={};   /* 'YYYY-MM-DD' -> {total, lista:[rows], pos:{poId:horas}} */
  DATA.rows.forEach(function(r){
    if(!r.dia) return;
    var d=porDia[r.dia]||(porDia[r.dia]={total:0,trab:0,extra:0,desl:0,lista:[],pos:{}});
    d.total+=r.apontado; d.trab+=r.hTrab; d.extra+=r.hExtra; d.desl+=r.hDesl;
    d.lista.push(r);
    if(r.poId) d.pos[r.poId]=(d.pos[r.poId]||0)+r.apontado;
  });
  return porDia;
}

/* ===================== RENDER CALENDÁRIO ===================== */
function corIntensidade(total){
  if(!total) return "";
  var meta=CFG.META_DIA||8;
  var frac=total/meta;
  if(frac<=0.5) return "lv1";
  if(frac<=1)   return "lv2";
  if(frac<=1.25)return "lv3";
  return "lv4";   /* acima da meta */
}

function render(){
  var porDia=agregarPorDia();
  DATA._porDia=porDia;

  var ano=VIEW.ano, mes=VIEW.mes;
  var primeiro=new Date(ano,mes,1);
  var diasNoMes=new Date(ano,mes+1,0).getDate();
  var offset=primeiro.getDay();  /* 0=Dom */

  /* label do mês */
  $("rhMesLbl").textContent = MESES[mes]+" de "+ano;

  /* cabeçalho dos dias da semana */
  var head='';
  DOW.forEach(function(d){ head+='<div class="rhDow">'+d+'</div>'; });

  /* células */
  var cells='';
  /* dias vazios antes do dia 1 */
  for(var i=0;i<offset;i++) cells+='<div class="rhCell rhEmpty"></div>';

  var hojeIso=iso(new Date());
  var totMes=0, diasTrab=0;
  for(var dia=1;dia<=diasNoMes;dia++){
    var dt=new Date(ano,mes,dia);
    var key=iso(dt);
    var info=porDia[key];
    var dow=dt.getDay();
    var fds=(dow===0||dow===6);
    var total=info?info.total:0;
    if(total>0){ totMes+=total; diasTrab++; }

    var posHtml='';
    if(info){
      /* lista as POs do dia (top 3) com horas */
      var poArr=Object.keys(info.pos).map(function(pid){
        return {t:(POINFO[pid]&&POINFO[pid].title)||("PO #"+pid), horas:info.pos[pid]};
      }).sort(function(a,b){return b.horas-a.horas;});
      var top=poArr.slice(0,3);
      top.forEach(function(p){
        posHtml+='<div class="rhChip" title="'+esc(p.t)+' · '+h(p.horas)+'">'
              +   '<span class="rhChipH">'+hplain(p.horas)+'</span> '+esc(p.t)
              + '</div>';
      });
      if(poArr.length>3) posHtml+='<div class="rhMore">+'+(poArr.length-3)+' PO(s)</div>';
    }

    var cls="rhCell "+(fds?"rhFds ":"")+corIntensidade(total);
    if(key===hojeIso) cls+=" rhHoje";
    if(key===DIA_SEL) cls+=" rhSel";
    cells+='<div class="'+cls+'" data-dia="'+key+'"'+(info?'':' data-vazio="1"')+'>'
        +   '<div class="rhCellTop"><span class="rhDiaN">'+dia+'</span>'
        +     (total>0?'<span class="rhDiaH">'+h(total)+'</span>':'')+'</div>'
        +   '<div class="rhCellBody">'+posHtml+'</div>'
        + '</div>';
  }
  /* completa a última semana */
  var totalCells=offset+diasNoMes;
  var resto=totalCells%7; if(resto) for(var z=0;z<7-resto;z++) cells+='<div class="rhCell rhEmpty"></div>';

  $("rhGrid").innerHTML = '<div class="rhDowRow">'+head+'</div><div class="rhCells">'+cells+'</div>';

  /* liga clique nos dias com apontamento */
  Array.prototype.forEach.call(document.querySelectorAll("#rhGrid .rhCell"),function(c){
    if(c.getAttribute("data-vazio")||!c.getAttribute("data-dia")) return;
    c.addEventListener("click",function(){
      DIA_SEL = (DIA_SEL===c.getAttribute("data-dia")) ? null : c.getAttribute("data-dia");
      render();
      renderPainel();
    });
  });

  /* cards resumo do mês */
  var respNome = $("rhResp").value && DIM.users[$("rhResp").value] ? DIM.users[$("rhResp").value].nome : "Todos os responsáveis";
  var media = diasTrab?totMes/diasTrab:0;
  var cards=[
    {lbl:"Responsável", val:esc(respNome), hint:MESES[mes]+"/"+ano, small:true},
    {lbl:"Horas no mês", val:h(totMes), hint:"trab. + extra + desloc."},
    {lbl:"Dias com apontamento", val:nfInt.format(diasTrab), hint:"de "+diasNoMes+" dias"},
    {lbl:"Média por dia trabalhado", val:h(media), hint:"meta "+CFG.META_DIA+"h/dia"},
    {lbl:"Apontamentos", val:nfInt.format(DATA.rows.length), hint:"lançamentos no mês"}
  ];
  $("rhCards").innerHTML=cards.map(function(c){
    return '<div class="rhCard"><div class="lbl">'+c.lbl+'</div><div class="val'+(c.small?" sm":"")+'">'+c.val+'</div><div class="hint">'+c.hint+'</div></div>';
  }).join("");

  renderPainel();
  setStatus(diasTrab+" dias com apontamento · "+DATA.rows.length+" lançamentos · atualizado "+new Date().toLocaleTimeString("pt-BR"));
}

/* Painel lateral/inferior com o detalhe do dia selecionado */
function renderPainel(){
  var painel=$("rhPainel");
  if(!painel) return;
  if(!DIA_SEL || !DATA._porDia || !DATA._porDia[DIA_SEL]){
    painel.innerHTML='<div class="rhPainelVazio">Clique em um dia para ver os apontamentos.</div>';
    return;
  }
  var info=DATA._porDia[DIA_SEL];
  var lista=info.lista.slice().sort(function(a,b){return b.apontado-a.apontado;});
  var rows='';
  lista.forEach(function(r){
    var po=(POINFO[r.poId]&&POINFO[r.poId].title)||(r.poId?("PO #"+r.poId):"—");
    var cli=r.companyId?(DIM.companies[String(r.companyId)]||("Empresa #"+r.companyId)):"";
    var uni=r.unidadeId?(DIM.unidades[r.unidadeId]||("Un #"+r.unidadeId)):"";
    rows+='<tr>'
      +'<td>'+esc(po)+'</td>'
      +'<td>'+esc(cli)+'</td>'
      +'<td>'+esc(uni)+'</td>'
      +'<td>'+esc(r.natureza)+'</td>'
      +'<td>'+esc(r.local)+'</td>'
      +'<td class="rhDesc">'+esc(r.desc)+'</td>'
      +'<td class="num">'+h(r.hTrab)+'</td>'
      +'<td class="num">'+h(r.hExtra)+'</td>'
      +'<td class="num">'+h(r.hDesl)+'</td>'
      +'<td class="num"><b>'+h(r.apontado)+'</b></td>'
      +'</tr>';
  });
  painel.innerHTML=
     '<div class="rhPainelHead">'
   +   '<div class="rhPainelTit">'+fmtData(DIA_SEL)+'</div>'
   +   '<div class="rhPainelTot">'+h(info.total)+' · '+lista.length+' lançamento(s)</div>'
   +   '<button id="rhFechaPainel" class="rhBtn">Fechar</button>'
   + '</div>'
   + '<div class="rhPainelTblWrap"><table class="rhPainelTbl">'
   +   '<thead><tr><th>PO</th><th>Cliente</th><th>Unidade</th><th>Natureza</th><th>Local</th><th>Descrição</th>'
   +     '<th class="num">Trab.</th><th class="num">Extra</th><th class="num">Desl.</th><th class="num">Total</th></tr></thead>'
   +   '<tbody>'+rows+'</tbody>'
   + '</table></div>';
  var fx=$("rhFechaPainel");
  if(fx) fx.addEventListener("click",function(){ DIA_SEL=null; render(); });
}

/* ===================== FILTROS: popular responsáveis ===================== */
function popularResp(){
  var respSel=$("rhResp");
  var atual=respSel.value;
  while(respSel.options.length>1)respSel.remove(1);
  Object.keys(DIM.users)
    .map(function(id){return {id:id,nome:DIM.users[id].nome,ativo:DIM.users[id].ativo};})
    .filter(function(u){return u.ativo;})
    .sort(function(a,b){return a.nome.localeCompare(b.nome,"pt-BR");})
    .forEach(function(u){var o=document.createElement("option");o.value=u.id;o.textContent=u.nome;respSel.appendChild(o);});
  if(atual) respSel.value=atual;
}

/* ===================== EXPORT CSV (por dia) ===================== */
function exportarCSV(){
  var porDia=DATA._porDia||agregarPorDia();
  var head=["Data","PO","Cliente","Unidade","Natureza","Local","Descricao","Trabalhadas","Extras","Deslocamento","Total"];
  var linhas=[head];
  Object.keys(porDia).sort().forEach(function(dia){
    porDia[dia].lista.slice().sort(function(a,b){return b.apontado-a.apontado;}).forEach(function(r){
      var po=(POINFO[r.poId]&&POINFO[r.poId].title)||(r.poId?("PO #"+r.poId):"");
      var cli=r.companyId?(DIM.companies[String(r.companyId)]||("Empresa #"+r.companyId)):"";
      var uni=r.unidadeId?(DIM.unidades[r.unidadeId]||("Un #"+r.unidadeId)):"";
      linhas.push([fmtData(dia),po,cli,uni,r.natureza,r.local,r.desc,r.hTrab,r.hExtra,r.hDesl,r.apontado]);
    });
  });
  var csv=linhas.map(function(l){
    return l.map(function(c){
      var s=String(c==null?"":c);
      if(/[",;\n]/.test(s))s='"'+s.replace(/"/g,'""')+'"';
      return s;
    }).join(";");
  }).join("\r\n");
  var blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"});
  var url=URL.createObjectURL(blob);
  var respNome=($("rhResp").value&&DIM.users[$("rhResp").value])?DIM.users[$("rhResp").value].nome.replace(/\s+/g,"_"):"todos";
  var a=document.createElement("a");
  a.href=url;a.download="calendario_horas_"+respNome+"_"+VIEW.ano+"-"+String(VIEW.mes+1).padStart(2,"0")+".csv";
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ===================== NAVEGAÇÃO DE MÊS ===================== */
function irMes(delta){
  var m=VIEW.mes+delta, a=VIEW.ano;
  if(m<0){m=11;a--;} else if(m>11){m=0;a++;}
  VIEW.mes=m; VIEW.ano=a; DIA_SEL=null;
  atualizar();
}

/* ===================== ATUALIZAR ===================== */
var carregando=false;
function atualizar(){
  if(carregando)return;
  carregando=true;
  POINFO={};
  var t0=Date.now();
  setStatus("Carregando...");
  carregar(VIEW.ano,VIEW.mes).then(function(){
    render();
    $("rhMeta").innerHTML=MESES[VIEW.mes]+" de "+VIEW.ano+"<br>"+((Date.now()-t0)/1000).toFixed(1)+"s";
  }).catch(function(e){
    setStatus("Erro: "+e.message);
    console.error(e);
  }).then(function(){carregando=false;});
}

/* ===================== INIT ===================== */
function init(){
  var hoje=new Date();
  VIEW.ano=hoje.getFullYear(); VIEW.mes=hoje.getMonth();

  $("rhPrev").addEventListener("click",function(){irMes(-1);});
  $("rhNext").addEventListener("click",function(){irMes(1);});
  $("rhHoje").addEventListener("click",function(){var d=new Date();VIEW.ano=d.getFullYear();VIEW.mes=d.getMonth();DIA_SEL=null;atualizar();});
  $("rhResp").addEventListener("change",function(){DIA_SEL=null;atualizar();});
  $("rhCsv").addEventListener("click",exportarCSV);

  setStatus("Carregando usuários...");
  carregarUsuarios().then(function(){
    popularResp();
    atualizar();
  }).catch(function(e){
    setStatus("Erro inicial: "+e.message);console.error(e);
  });
}

function boot(){
  if($("rhWrap") && $("rhStatus")){ init(); return; }
  var tries=0;
  var iv=setInterval(function(){
    tries++;
    if($("rhWrap") && $("rhStatus")){ clearInterval(iv); init(); }
    else if(tries>60){ clearInterval(iv); }
  },250);
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);
else boot();
})();
