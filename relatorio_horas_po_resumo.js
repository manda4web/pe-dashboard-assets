(function(){
"use strict";
if (window.__rhrStarted) return;   /* evita rodar duas vezes */
window.__rhrStarted = true;

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
  /* campos da PO */
  PO: {
    HORAS_PLAN: "ufCrm23_1787740461744",
    DEAL_ID   : "ufCrm23_1788344159444"
  },
  /* campo horas na Deal (fallback) */
  DEAL_HORAS: "UF_CRM_1787738361509",
  UNIDADE_ENTITY: 1062,   /* SPA Unidades (o campo Unidade é referência crm) */
  NATUREZA_MAP: {
    "469":"Auditoria","471":"Consultoria","473":"Inspeção","475":"Teste",
    "477":"Treinamento","505":"Interno"
  },
  LOCAL_MAP: {
    "479":"Onshore Cliente","481":"Offshore","503":"Onshore Home-Office","525":"Deslocamento"
  }
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
/* IMPORTANTE: usa Content-Type JSON. O filtro de range por data (>=/<=)
   só é respeitado pelo crm.item.list quando o corpo é JSON, não form-urlencoded. */
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
/* Paginação via call() JSON puro — necessária quando há filtro de range por data,
   que o batch (querystring) ignora. Usa "start" numérico; segue enquanto vier página cheia. */
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
/* Paginação rápida via batch — só para métodos SEM filtro de data (user.get). */
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
function pct(v){return (Math.round((Number(v)||0)*10)/10).toLocaleString("pt-BR")+"%";}
function num(v){return Number(String(v==null?"":v).replace(",","."))||0;}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function iso(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function fmtData(s){if(!s)return"";var d=new Date(s);if(isNaN(d))return String(s).slice(0,10);return String(d.getDate()).padStart(2,"0")+"/"+String(d.getMonth()+1).padStart(2,"0")+"/"+d.getFullYear();}
function setStatus(m){var e=$("rhStatus");if(e)e.textContent=m;}

/* ===================== ESTADO ===================== */
var DIM={users:{},companies:{},unidades:{}};
var DATA={rows:[]};      /* linhas de timesheet enriquecidas */
var POINFO={};           /* poId -> {title, planejado, dealId, resp} */
var EXPANDIDAS={};       /* poId -> true quando o grupo está expandido */

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

/* ===================== CARGA PRINCIPAL ===================== */
function carregar(de, ate){
  setStatus("Carregando timesheets...");
  /* data do trabalho no intervalo (campo ufCrm15_1753036495093) */
  var filtro={};
  filtro[">="+CFG.TS.DATA]=de+"T00:00:00";
  filtro["<="+CFG.TS.DATA]=ate+"T23:59:59";
  filtro["categoryId"]=CFG.TS_CATEGORY;

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
      return {
        id: it.id,
        poId: it[CFG.TS.PO]?String(it[CFG.TS.PO]):"",
        data: it[CFG.TS.DATA]||"",
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
    });
    /* horas apontadas = trabalhadas + extras + deslocamento */
    DATA.rows.forEach(function(r){ r.apontado = r.hTrab + r.hExtra + r.hDesl; });

    /* POs únicas referenciadas */
    var poIds={};
    DATA.rows.forEach(function(r){ if(r.poId) poIds[r.poId]=1; });
    var ids=Object.keys(poIds);
    if(!ids.length) return;

    setStatus("Carregando POs ("+ids.length+")...");
    /* busca POs em lotes por ID, depois nomes das empresas */
    return carregarPOs(ids).then(carregarEmpresas);
  });
}

/* nomes das empresas e das unidades presentes nos apontamentos */
function carregarEmpresas(){
  var comp={}, uni={};
  DATA.rows.forEach(function(r){
    if(r.companyId) comp[String(r.companyId)]=1;
    if(r.unidadeId) uni[r.unidadeId]=1;
  });
  var jobs=[];
  var lComp=Object.keys(comp);
  if(lComp.length){
    setStatus("Carregando empresas ("+lComp.length+")...");
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
  return Promise.all(jobs).catch(function(){/* ignora falha de enriquecimento */});
}

function carregarPOs(ids){
  /* batch de crm.item.get para cada PO (lotes de 50) */
  var cmds=ids.map(function(id){
    return {method:"crm.item.get",params:{entityTypeId:CFG.PO_ENTITY,id:id}};
  });
  var lotes=[];
  for(var i=0;i<cmds.length;i+=CFG.BATCH_SIZE) lotes.push(cmds.slice(i,i+CFG.BATCH_SIZE));
  return Promise.all(lotes.map(function(l){return batch(l);})).then(function(results){
    var dealIds={};
    results.forEach(function(res){
      res.forEach(function(r){
        var it=r&&r.item; if(!it)return;
        var plan=num(it[CFG.PO.HORAS_PLAN]);
        var dealId=it[CFG.PO.DEAL_ID]?String(Math.trunc(num(it[CFG.PO.DEAL_ID]))):"";
        POINFO[String(it.id)]={
          title: it.title||("PO #"+it.id),
          planejado: plan,
          dealId: dealId,
          respId: String(it.assignedById||"")
        };
        if(dealId) dealIds[dealId]=String(it.id);
      });
    });
    /* FALLBACK 1: POs sem horas planejadas mas com ID do deal -> Qtd Horas da deal por ID */
    var faltantes=Object.keys(POINFO).filter(function(pid){
      return !POINFO[pid].planejado && POINFO[pid].dealId;
    }).map(function(pid){ return POINFO[pid].dealId; });
    faltantes=faltantes.filter(function(v,i,a){return a.indexOf(v)===i;});
    var passo1=Promise.resolve();
    if(faltantes.length){
      setStatus("Horas planejadas via deal (ID) — "+faltantes.length+"...");
      var dcmds=faltantes.map(function(did){return {method:"crm.deal.get",params:{id:did}};});
      var dlotes=[];
      for(var j=0;j<dcmds.length;j+=CFG.BATCH_SIZE) dlotes.push(dcmds.slice(j,j+CFG.BATCH_SIZE));
      passo1=Promise.all(dlotes.map(function(l){return batch(l);})).then(function(dres){
        var dealHoras={};
        dres.forEach(function(res){res.forEach(function(d){if(d&&d.ID)dealHoras[String(d.ID)]=num(d[CFG.DEAL_HORAS]);});});
        Object.keys(POINFO).forEach(function(pid){
          var info=POINFO[pid];
          if(!info.planejado&&info.dealId&&dealHoras[info.dealId]) info.planejado=dealHoras[info.dealId];
        });
      });
    }
    /* FALLBACK 2: POs ainda sem horas -> casa PO.title com deal.UF_CRM_1742312440 (PO/Contrato).
       Soma a Qtd Horas de todas as deals cujo campo PO/Contrato bate com o título da PO. */
    return passo1.then(function(){
      var semHoras=Object.keys(POINFO).filter(function(pid){ return !POINFO[pid].planejado; });
      if(!semHoras.length) return;
      /* índice título(normalizado) -> [poIds] */
      var porTitulo={};
      semHoras.forEach(function(pid){
        var t=normTitle(POINFO[pid].title);
        if(t) (porTitulo[t]=porTitulo[t]||[]).push(pid);
      });
      if(!Object.keys(porTitulo).length) return;
      setStatus("Horas planejadas via deal (nº PO)...");
      /* busca todas as deals com Qtd Horas > 0 e PO/Contrato preenchido */
      var dfilter={ "!UF_CRM_1742312440":"" }; dfilter[">"+CFG.DEAL_HORAS]=0;
      return listAllJson("crm.deal.list",{
        filter:dfilter,
        select:["ID","UF_CRM_1742312440",CFG.DEAL_HORAS]
      },function(r){return r||[];}).then(function(deals){
        var horasPorTitulo={};
        deals.forEach(function(d){
          var t=normTitle(d.UF_CRM_1742312440);
          if(!t) return;
          horasPorTitulo[t]=(horasPorTitulo[t]||0)+num(d[CFG.DEAL_HORAS]);
        });
        Object.keys(porTitulo).forEach(function(t){
          if(horasPorTitulo[t]) porTitulo[t].forEach(function(pid){
            if(!POINFO[pid].planejado) POINFO[pid].planejado=horasPorTitulo[t];
          });
        });
      });
    });
  });
}
function normTitle(s){ return String(s==null?"":s).trim().toUpperCase(); }

/* ===================== AGREGAÇÃO POR PO ===================== */
/* Aplica filtros e devolve { resumo:[...por PO...], rows:[...filtradas...] } */
function agregarPorPO(){
  var fResp=$("rhResp").value;
  var fPo=$("rhPo").value;
  var fStatus=$("rhStatus2")?$("rhStatus2").value:"";
  var q=($("rhBusca").value||"").trim().toLowerCase();

  var rows=DATA.rows.filter(function(r){
    if(fResp && r.respId!==fResp) return false;
    if(fPo){
      /* o filtro de PO agora casa pelo NÚMERO da PO (consistente com o agrupamento) */
      var poNum=(POINFO[r.poId]&&POINFO[r.poId].title)?normTitle(POINFO[r.poId].title):(r.poId?("PO #"+r.poId):"");
      if(poNum!==fPo) return false;
    }
    if(q){
      var po=(POINFO[r.poId]&&POINFO[r.poId].title)||"";
      var resp=DIM.users[r.respId]?DIM.users[r.respId].nome:"";
      var cli=r.companyId?(DIM.companies[String(r.companyId)]||""):"";
      var uni=r.unidadeId?(DIM.unidades[r.unidadeId]||""):"";
      var blob=(po+" "+resp+" "+cli+" "+uni+" "+r.desc+" "+r.natureza+" "+r.local).toLowerCase();
      if(blob.indexOf(q)<0) return false;
    }
    return true;
  });

  /* agrupa por NÚMERO da PO (título), não pelo id do item.
     Vários itens de PO (poId distintos) podem compartilhar o mesmo número.
     Agrupando pelo número, o saldo vira uma única conta corrente por PO —
     o planejado é contado uma só vez e não "vaza" para outra linha. */
  var grupos={};
  rows.forEach(function(r){
    var info=POINFO[r.poId];
    var numeroPo = info && info.title ? normTitle(info.title)
                 : (r.poId ? "PO #"+r.poId : "__sem_po__");
    (grupos[numeroPo]=grupos[numeroPo]||[]).push(r);
  });

  var resumo=Object.keys(grupos).map(function(chave){
    /* conta corrente por DATA: ordena todos os lançamentos da PO (de todos os itens
       que compartilham o número) cronologicamente; desempata por id do lançamento
       para o acumulado ficar determinístico quando há mais de um na mesma data. */
    var lista=grupos[chave].slice().sort(function(a,b){
      var c=String(a.data).localeCompare(String(b.data));
      if(c!==0) return c;
      return (Number(a.id)||0)-(Number(b.id)||0);
    });
    /* título exibido: usa o título original do primeiro item com PO conhecida */
    var primeiroComInfo=null;
    for(var i=0;i<lista.length;i++){ if(POINFO[lista[i].poId]){ primeiroComInfo=POINFO[lista[i].poId]; break; } }
    var title = primeiroComInfo ? primeiroComInfo.title
              : (chave==="__sem_po__" ? "(sem PO vinculada)" : chave);
    /* poIds distintos que compõem esta PO (usado no toggle do filtro/expand) */
    var poIdsGrupo={}; lista.forEach(function(r){ if(r.poId) poIdsGrupo[r.poId]=1; });
    /* PLANEJADO contado UMA vez por número de PO: pega o maior valor planejado
       entre os itens que compartilham o número (evita somar duplicatas). */
    var planPorItem={};
    lista.forEach(function(r){
      var inf=POINFO[r.poId];
      if(inf && r.poId) planPorItem[r.poId]=inf.planejado||0;
    });
    var apontado=lista.reduce(function(s,r){return s+r.apontado;},0);
    var trab=lista.reduce(function(s,r){return s+r.hTrab;},0);
    var extra=lista.reduce(function(s,r){return s+r.hExtra;},0);
    var desl=lista.reduce(function(s,r){return s+r.hDesl;},0);
    var plan=Object.keys(planPorItem).reduce(function(m,k){return Math.max(m,planPorItem[k]);},0);
    var info={title:title, planejado:plan, respId:(primeiroComInfo?primeiroComInfo.respId:"")};
    var poId=Object.keys(poIdsGrupo)[0]||chave; /* id representativo p/ data-po */
    var saldo=plan?plan-apontado:null;
    var perc=plan?(apontado/plan*100):null;
    /* status: sem planejado / ok (<90%) / no limite (90-100%) / estourou (>100%) */
    var status;
    if(!plan) status="sem";
    else if(perc>100) status="bad";
    else if(perc>=90) status="warn";
    else status="ok";
    /* responsáveis presentes (nomes distintos) */
    var respSet={}; lista.forEach(function(r){ if(r.respId) respSet[r.respId]=1; });
    var respIds=Object.keys(respSet);
    var respNome = info.respId && DIM.users[info.respId] ? DIM.users[info.respId].nome
                 : (respIds.length===1 ? (DIM.users[respIds[0]]?DIM.users[respIds[0]].nome:("#"+respIds[0]))
                 : (respIds.length>1 ? (respIds.length+" responsáveis") : "—"));
    /* cliente (empresa mais frequente do grupo) */
    var compSet={}; lista.forEach(function(r){ if(r.companyId){var c=String(r.companyId);compSet[c]=(compSet[c]||0)+1;} });
    var cliId=Object.keys(compSet).sort(function(a,b){return compSet[b]-compSet[a];})[0];
    var cliNome=cliId?(DIM.companies[cliId]||("Empresa #"+cliId)):"—";

    var datas=lista.map(function(r){return r.data;}).filter(Boolean).sort();
    return {
      poId: poId,
      title: info.title,
      cliente: cliNome,
      responsavel: respNome,
      planejado: plan,
      apontado: apontado,
      trab: trab, extra: extra, desl: desl,
      saldo: saldo,
      perc: perc,
      status: status,
      nLanc: lista.length,
      primeira: datas[0]||"",
      ultima: datas[datas.length-1]||"",
      lista: lista
    };
  });

  /* filtro por status (aplicado depois de calcular) */
  if(fStatus){
    resumo=resumo.filter(function(g){ return g.status===fStatus; });
  }

  /* ordena: estouradas primeiro, depois maior % consumido, depois título */
  resumo.sort(function(a,b){
    var pa=a.perc==null?-1:a.perc, pb=b.perc==null?-1:b.perc;
    if(pb!==pa) return pb-pa;
    return String(a.title).localeCompare(String(b.title),"pt-BR");
  });

  return {resumo:resumo, rows:rows};
}

/* ===================== RENDER ===================== */
function statusTag(status,perc){
  if(status==="sem") return '<span class="rhTag none">sem planejado</span>';
  if(status==="bad") return '<span class="rhTag bad">estourou</span>';
  if(status==="warn") return '<span class="rhTag warn">no limite</span>';
  return '<span class="rhTag ok">ok</span>';
}
function barra(perc,status){
  var p = perc==null ? 0 : Math.min(perc,100);
  var cls = status==="bad"?"bad":(status==="warn"?"warn":(status==="sem"?"none":"ok"));
  var over = (perc!=null && perc>100);
  var label = perc==null ? "—" : pct(perc);
  return '<div class="rhBarWrap" title="'+label+'">'
       +   '<div class="rhBarFill '+cls+'" style="width:'+p+'%"></div>'
       +   (over?'<div class="rhBarOver"></div>':'')
       +   '<span class="rhBarLbl">'+label+'</span>'
       + '</div>';
}

function linhasLancamentos(g){
  var acum=0, plan=g.planejado||0;
  var out='';
  g.lista.forEach(function(r){
    acum+=r.apontado;
    var saldo=plan?plan-acum:null;
    var resp=DIM.users[r.respId]?DIM.users[r.respId].nome:("#"+r.respId);
    var cli=r.companyId?(DIM.companies[String(r.companyId)]||("Empresa #"+r.companyId)):"";
    var uni=r.unidadeId?(DIM.unidades[r.unidadeId]||("Un #"+r.unidadeId)):"";
    out+='<tr class="rhSub">'
      +'<td>'+fmtData(r.data)+'</td>'
      +'<td>'+esc(cli)+'</td>'
      +'<td>'+esc(resp)+'</td>'
      +'<td>'+esc(uni)+'</td>'
      +'<td>'+esc(r.natureza)+'</td>'
      +'<td>'+esc(r.local)+'</td>'
      +'<td class="rhDesc">'+esc(r.desc)+'</td>'
      +'<td class="num">'+h(r.apontado)+'</td>'
      +'<td class="num">'+h(acum)+'</td>'
      +'<td class="num '+(saldo!=null&&saldo<0?"rhNeg":"rhPos")+'">'+(saldo!=null?h(saldo):"—")+'</td>'
      +'</tr>';
  });
  return out;
}

function render(){
  var ag=agregarPorPO();
  var resumo=ag.resumo;
  DATA._agregado=resumo;
  DATA._filtradas=ag.rows;

  var html="";
  resumo.forEach(function(g){
    var aberto=!!EXPANDIDAS[g.poId];
    html+='<tr class="rhPoRow'+(aberto?' aberta':'')+'" data-po="'+esc(g.poId)+'">'
      +'<td class="rhCaret"><span class="rhArrow">'+(aberto?'▾':'▸')+'</span></td>'
      +'<td class="rhPoTitle">'+esc(g.title)+'</td>'
      +'<td>'+esc(g.cliente)+'</td>'
      +'<td class="rhRespCol">—</td>'  /* responsável fica oculto no agrupamento; aparece só ao expandir */
      +'<td class="num">'+(g.planejado?h(g.planejado):"—")+'</td>'
      +'<td class="num">'+h(g.apontado)+'</td>'
      +'<td class="num '+(g.saldo!=null&&g.saldo<0?"rhNeg":"rhPos")+'">'+(g.saldo!=null?h(g.saldo):"—")+'</td>'
      +'<td class="rhBarCell">'+barra(g.perc,g.status)+'</td>'
      +'<td class="num">'+nfInt.format(g.nLanc)+'</td>'
      +'<td>'+statusTag(g.status,g.perc)+'</td>'
      +'</tr>';
    /* linha de detalhe (drill-down) */
    html+='<tr class="rhDetail" data-detail="'+esc(g.poId)+'"'+(aberto?'':' style="display:none"')+'>'
      +'<td></td>'
      +'<td colspan="9">'
      +  '<div class="rhInner">'
      +    '<table class="rhSubTable">'
      +      '<thead><tr>'
      +        '<th>Data</th><th>Cliente</th><th>Responsável</th><th>Unidade</th>'
      +        '<th>Natureza</th><th>Local</th><th>Descrição</th>'
      +        '<th class="num">Apontado</th><th class="num">Acum.</th><th class="num">Saldo</th>'
      +      '</tr></thead>'
      +      '<tbody>'+linhasLancamentos(g)+'</tbody>'
      +    '</table>'
      +  '</div>'
      +'</td>'
      +'</tr>';
  });

  $("rhBody").innerHTML = html || '<tr><td colspan="10" style="text-align:center;padding:24px;color:#8a97a6">Nenhuma PO no período/filtro.</td></tr>';

  /* cards resumo */
  var totPlan=0, totApont=0, nOk=0, nWarn=0, nBad=0, nSem=0;
  resumo.forEach(function(g){
    totPlan+=g.planejado||0; totApont+=g.apontado;
    if(g.status==="ok")nOk++;else if(g.status==="warn")nWarn++;else if(g.status==="bad")nBad++;else nSem++;
  });
  var saldoTot=totPlan-totApont;
  var cards=[
    {lbl:"POs", val:nfInt.format(resumo.length), hint:"no período/filtro"},
    {lbl:"Horas planejadas", val:h(totPlan), hint:"soma das POs"},
    {lbl:"Horas apontadas", val:h(totApont), hint:"trab. + extra + desloc."},
    {lbl:"Saldo total", val:h(saldoTot), hint:saldoTot<0?"estourou":"disponível", cls:saldoTot<0?"bad":"ok"},
    {lbl:"POs no limite", val:nfInt.format(nWarn), hint:"≥ 90% consumido", cls:nWarn?"warn":""},
    {lbl:"POs estouradas", val:nfInt.format(nBad), hint:"passaram do planejado", cls:nBad?"bad":"ok"}
  ];
  $("rhCards").innerHTML=cards.map(function(c){
    return '<div class="rhCard '+(c.cls||"")+'"><div class="lbl">'+c.lbl+'</div><div class="val">'+c.val+'</div><div class="hint">'+c.hint+'</div></div>';
  }).join("");

  /* liga o clique de expandir/recolher nas linhas de PO.
     A linha de detalhe é sempre a irmã imediatamente seguinte (nextSibling),
     o que dispensa seletores por atributo (robusto p/ qualquer poId). */
  Array.prototype.forEach.call(document.querySelectorAll("#rhBody .rhPoRow"),function(tr){
    tr.addEventListener("click",function(){
      var po=tr.getAttribute("data-po");
      EXPANDIDAS[po]=!EXPANDIDAS[po];
      var det=tr.nextElementSibling;
      if(det && !det.classList.contains("rhDetail")) det=null;
      var arrow=tr.querySelector(".rhArrow");
      if(EXPANDIDAS[po]){ tr.classList.add("aberta"); if(det)det.style.display=""; if(arrow)arrow.textContent="▾"; }
      else{ tr.classList.remove("aberta"); if(det)det.style.display="none"; if(arrow)arrow.textContent="▸"; }
    });
  });

  setStatus(resumo.length+" POs · "+(DATA._filtradas.length)+" apontamentos · atualizado "+new Date().toLocaleTimeString("pt-BR"));
}

/* ===================== EXPANDIR / RECOLHER TUDO ===================== */
function expandirTudo(abrir){
  (DATA._agregado||[]).forEach(function(g){ EXPANDIDAS[g.poId]=abrir; });
  render();
}

/* ===================== FILTROS: popular selects ===================== */
function popularSelects(){
  var respSel=$("rhResp");
  while(respSel.options.length>1)respSel.remove(1);
  var ids={};DATA.rows.forEach(function(r){if(r.respId)ids[r.respId]=1;});
  Object.keys(ids).map(function(id){return{id:id,nome:DIM.users[id]?DIM.users[id].nome:("#"+id)};})
    .sort(function(a,b){return a.nome.localeCompare(b.nome,"pt-BR");})
    .forEach(function(u){var o=document.createElement("option");o.value=u.id;o.textContent=u.nome;respSel.appendChild(o);});

  var poSel=$("rhPo");
  while(poSel.options.length>1)poSel.remove(1);
  /* dropdown de PO deduplicado por NÚMERO (valor = número normalizado,
     rótulo = título original) — evita entradas repetidas para a mesma PO. */
  var pos={};
  DATA.rows.forEach(function(r){
    if(!r.poId) return;
    var title=(POINFO[r.poId]&&POINFO[r.poId].title)||("PO #"+r.poId);
    var key=normTitle(title)||("PO #"+r.poId);
    if(!pos[key]) pos[key]=title;
  });
  Object.keys(pos).map(function(key){return{value:key,title:pos[key]};})
    .sort(function(a,b){return String(a.title).localeCompare(String(b.title),"pt-BR");})
    .forEach(function(p){var o=document.createElement("option");o.value=p.value;o.textContent=p.title;poSel.appendChild(o);});
}

/* ===================== EXPORT CSV (resumo por PO) ===================== */
function exportarCSV(){
  var resumo=DATA._agregado||agregarPorPO().resumo;
  var head=["PO","Cliente","Responsavel","Planejado","Apontado","Trabalhadas","Extras","Deslocamento","Saldo","Percentual consumido","Lancamentos","Primeiro apontamento","Ultimo apontamento","Status"];
  var linhas=[head];
  var statusTxt={ok:"ok",warn:"no limite",bad:"estourou",sem:"sem planejado"};
  resumo.forEach(function(g){
    linhas.push([
      g.title, g.cliente, g.responsavel,
      g.planejado||"", g.apontado, g.trab, g.extra, g.desl,
      g.saldo==null?"":g.saldo,
      g.perc==null?"":(Math.round(g.perc*10)/10),
      g.nLanc,
      g.primeira?fmtData(g.primeira):"", g.ultima?fmtData(g.ultima):"",
      statusTxt[g.status]||g.status
    ]);
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
  var a=document.createElement("a");
  a.href=url;a.download="resumo_horas_po_"+$("rhDe").value+"_a_"+$("rhAte").value+".csv";
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ===================== PERÍODOS ===================== */
function setPeriodo(preset){
  var hoje=new Date(), de, ate=new Date(hoje);
  if(preset==="7"){de=new Date(hoje);de.setDate(de.getDate()-6);}
  else if(preset==="30"){de=new Date(hoje);de.setDate(de.getDate()-29);}
  else if(preset==="mes"){de=new Date(hoje.getFullYear(),hoje.getMonth(),1);}
  else if(preset==="mesant"){de=new Date(hoje.getFullYear(),hoje.getMonth()-1,1);ate=new Date(hoje.getFullYear(),hoje.getMonth(),0);}
  else if(preset==="ano"){de=new Date(hoje.getFullYear(),0,1);}
  else{de=new Date(hoje.getFullYear(),hoje.getMonth(),1);}
  $("rhDe").value=iso(de);$("rhAte").value=iso(ate);
}

/* ===================== ATUALIZAR ===================== */
var carregando=false;
function atualizar(){
  if(carregando)return;
  carregando=true;
  var de=$("rhDe").value, ate=$("rhAte").value;
  POINFO={}; EXPANDIDAS={};
  $("rhMeta").textContent="Período "+fmtData(de)+" a "+fmtData(ate);
  var t0=Date.now();
  carregar(de,ate).then(function(){
    popularSelects();
    render();
    $("rhMeta").innerHTML="Período "+fmtData(de)+" a "+fmtData(ate)+"<br>"+((Date.now()-t0)/1000).toFixed(1)+"s";
  }).catch(function(e){
    setStatus("Erro: "+e.message);
    console.error(e);
  }).then(function(){carregando=false;});
}

/* ===================== INIT ===================== */
function init(){
  setPeriodo("mes");
  document.querySelectorAll(".rhP").forEach(function(b){
    b.addEventListener("click",function(){
      document.querySelectorAll(".rhP").forEach(function(x){x.classList.remove("rhPon");});
      b.classList.add("rhPon");
      setPeriodo(b.getAttribute("data-preset"));
      atualizar();
    });
  });
  $("rhGo").addEventListener("click",atualizar);
  $("rhCsv").addEventListener("click",exportarCSV);
  $("rhResp").addEventListener("change",render);
  $("rhPo").addEventListener("change",render);
  if($("rhStatus2")) $("rhStatus2").addEventListener("change",render);
  if($("rhExpand")) $("rhExpand").addEventListener("click",function(){expandirTudo(true);});
  if($("rhCollapse")) $("rhCollapse").addEventListener("click",function(){expandirTudo(false);});
  $("rhBusca").addEventListener("input",function(){
    clearTimeout(init._t);init._t=setTimeout(render,250);
  });

  setStatus("Carregando usuários...");
  carregarUsuarios().then(atualizar).catch(function(e){
    setStatus("Erro inicial: "+e.message);console.error(e);
  });
}

/* Espera o container do relatório existir no DOM antes de iniciar
   (o bloco HTML do Bitrix pode injetar o markup em momentos diferentes). */
function boot(){
  if($("rhWrap") && $("rhStatus")){ init(); return; }
  var tries=0;
  var iv=setInterval(function(){
    tries++;
    if($("rhWrap") && $("rhStatus")){ clearInterval(iv); init(); }
    else if(tries>60){ clearInterval(iv); }   /* desiste após ~15s */
  },250);
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);
else boot();
})();
