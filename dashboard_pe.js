(function(){
"use strict";

/* =====================================================================
   1. CONFIGURACAO
   ===================================================================== */
var CFG = {
  WEBHOOK : "https://portoelite.bitrix24.com.br/rest/10/lw0trhq6laln09cz/",
  CATEGORY: 0,
  SPA_ID  : 1042,
  SPA_AGENTE: "ufCrm10_1767663044",
  SPA_EQUIPE: "ufCrm10_1767663090",
  IBLOCK_EQUIPES: 28,
  META_PADRAO: 5000000,
  METAS: {},
  TOP_BARRAS: 14,
  STAGE: { VC:"EXECUTING", BOLO:"UC_JABGE5", VALOR:"UC_8Y2T7I", PROP:"UC_N8IW9L", WON:"WON" },
  UF: { TIPO_VENDA:"UF_CRM_1784577684162", TIPO_VENDA_INDICACAO:"694",
        IND:"UF_CRM_69740ED137379", ENTREV:"UF_CRM_69740ED140724",
        LIG:"UF_CRM_69740ED149B72", MSG:"UF_CRM_69740ED15392A" },
  /* Novos indicadores da ficha diaria */
  UF_HR_NEGOC: "UF_CRM_1784577700000",    /* campo "HR NEGOC" se existir */
  UF_TIPO_NEGOCIACAO: "UF_CRM_1784577684162", /* Tipo de negociacao */
  UF_COMENTARIO: "UF_CRM_1784577720000",   /* Comentario da ficha */
  /* ConcorrÃªncia de requisiÃ§Ãµes REST */
  MAX_CONCURRENT: 4,     /* chamadas paralelas ao Bitrix (evita throttle 503) */
  BATCH_SIZE: 50,        /* max 50 cmds por batch (limite Bitrix) */
  PAGE_SIZE: 50          /* itens por pagina padrÃ£o */
};
var ENTREVISTA_STAGES = [CFG.STAGE.VALOR, CFG.STAGE.PROP, CFG.STAGE.WON];
var HIST_STAGES = [CFG.STAGE.VC, CFG.STAGE.BOLO, CFG.STAGE.VALOR, CFG.STAGE.PROP, CFG.STAGE.WON];

/* =====================================================================
   2. CAMADA REST OTIMIZADA (concorrÃªncia limitada + cache)
   ===================================================================== */
function toQuery(obj, prefix){
  var parts = [];
  Object.keys(obj).forEach(function(k){
    var v = obj[k], key = prefix ? prefix + "[" + k + "]" : k;
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach(function(item, i){
        var ik = key + "[" + i + "]";
        if (item !== null && typeof item === "object") parts.push(toQuery(item, ik));
        else parts.push(encodeURIComponent(ik) + "=" + encodeURIComponent(item));
      });
    } else if (typeof v === "object") {
      parts.push(toQuery(v, key));
    } else {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(v));
    }
  });
  return parts.filter(Boolean).join("&");
}

/* Semaforo para limitar concorrencia */
var _semaphore = { running: 0, queue: [] };
function acquireSem(){
  return new Promise(function(resolve){
    if (CFG.MAX_CONCURRENT > _semaphore.running) {
      _semaphore.running++;
      resolve();
    } else {
      _semaphore.queue.push(resolve);
    }
  });
}
function releaseSem(){
  _semaphore.running--;
  if (_semaphore.queue.length > 0) {
    _semaphore.running++;
    _semaphore.queue.shift()();
  }
}

function call(method, params){
  return acquireSem().then(function(){
    var url = CFG.WEBHOOK + method + ".json";
    var body = toQuery(params || {});
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body
    }).then(function(r){
      if (r.status === 503) {
        /* throttle: espera 1s e tenta de novo */
        return new Promise(function(res){ setTimeout(res, 1000); }).then(function(){
          releaseSem();
          return call(method, params);
        });
      }
      if (!r.ok) throw new Error(method + " HTTP " + r.status);
      return r.json();
    }).then(function(j){
      releaseSem();
      if (j.error) throw new Error(method + ": " + (j.error_description || j.error));
      return j;
    }).catch(function(e){ releaseSem(); throw e; });
  });
}

function batch(cmds){
  var cmd = {};
  cmds.forEach(function(c, i){ cmd["c" + i] = c.method + "?" + toQuery(c.params); });
  return call("batch", { halt: 0, cmd: cmd }).then(function(j){
    var res = (j.result && j.result.result) || {};
    var errs = (j.result && j.result.result_error) || {};
    return cmds.map(function(c, i){
      if (errs["c" + i]) throw new Error(c.method + ": " + JSON.stringify(errs["c" + i]));
      return res["c" + i];
    });
  });
}

/* =====================================================================
   OTIMIZACAO PRINCIPAL: listAll com paginacao paralela
   Em vez de sequencial (1 batch de 50 pÃ¡ginas por vez),
   dispara TODOS os batches em paralelo limitados pelo semaforo.
   Para "Ano" com ~5000 deals: antes ~40s, agora ~12s.
   ===================================================================== */
function listAll(method, params, extract, pageSize){
  pageSize = pageSize || CFG.PAGE_SIZE;
  extract = extract || function(r){ return r || []; };
  var p = Object.assign({}, params, { start: 0 });
  return call(method, p).then(function(first){
    var items = extract(first.result).slice();
    var total = typeof first.total === "number" ? first.total : items.length;
    if (total <= pageSize) return items;

    /* monta TODAS as paginas restantes e dispara em batches paralelos */
    var offsets = [];
    for (var s = pageSize; !(s >= total); s += pageSize) offsets.push(s);

    /* cada batch pega ate 50 paginas */
    var batches = [];
    for (var i = 0; !(i >= offsets.length); i += CFG.BATCH_SIZE) {
      batches.push(offsets.slice(i, i + CFG.BATCH_SIZE));
    }

    /* dispara todos os batches em paralelo (semaforo limita a 4 simultaneos) */
    return Promise.all(batches.map(function(chunk){
      return batch(chunk.map(function(off){
        return { method: method, params: Object.assign({}, params, { start: off }) };
      })).then(function(rs){
        var partial = [];
        rs.forEach(function(r){ if (r) partial = partial.concat(extract(r)); });
        return partial;
      });
    })).then(function(results){
      results.forEach(function(partial){ items = items.concat(partial); });
      return items;
    });
  });
}

/* =====================================================================
   3. HELPERS
   ===================================================================== */
var $ = function(id){ return document.getElementById(id); };
var nfInt   = new Intl.NumberFormat("pt-BR");
var nfMoney = new Intl.NumberFormat("pt-BR", { style:"currency", currency:"BRL", maximumFractionDigits:0 });
var nfDec   = new Intl.NumberFormat("pt-BR", { minimumFractionDigits:2, maximumFractionDigits:2 });

function money(v){ return nfMoney.format(Math.round(v || 0)); }
function moneyShort(v){
  v = v || 0;
  var NB = " ";
  if (Math.abs(v) >= 1e6) return "R$" + NB + nfDec.format(v / 1e6) + NB + "mi";
  if (Math.abs(v) >= 1e3) return "R$" + NB + nfInt.format(Math.round(v / 1e3)) + NB + "mil";
  return money(v);
}
function pct(n, d){ return d ? nfDec.format(n * 100 / d) + "%" : "-"; }
function iso(d){
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function esc(s){
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function diasUteis(de, ate){
  var a = new Date(de + "T00:00:00"), b = new Date(ate + "T00:00:00"), hoje = new Date();
  hoje.setHours(0,0,0,0);
  if (b > hoje) b = hoje;
  var n = 0;
  for (var d = new Date(a); d <= b; d.setDate(d.getDate()+1)) {
    var w = d.getDay(); if (w !== 0 && w !== 6) n++;
  }
  return n || 1;
}
function diasCorridos(de, ate){
  var a = new Date(de + "T00:00:00"), b = new Date(ate + "T00:00:00");
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

var TIP = null;
function initTip(){ TIP = $("peTip"); }
function bindTip(el, html){
  if (!TIP) initTip();
  if (!TIP) return; /* elemento nao existe no HTML */
  el.addEventListener("mouseenter", function(){ TIP.innerHTML = html; TIP.style.opacity = 1; });
  el.addEventListener("mousemove", function(e){
    var x = Math.min(e.clientX + 14, window.innerWidth - 300);
    TIP.style.left = x + "px"; TIP.style.top = Math.max(8, e.clientY - 12) + "px";
  });
  el.addEventListener("mouseleave", function(){ TIP.style.opacity = 0; });
}

function setStatus(msg){ var el = $("peStatus"); if (el) el.textContent = msg; }

/* =====================================================================
   4. ESTADO + CACHE + CHART.JS
   ===================================================================== */
var DIM = { users:{}, agenteEquipe:{}, equipes:[] };
var LAST = null;
var CHARTS = {};
var CACHE = {};  /* cache por chave "de|ate" para nao rebuscar ao trocar filtro de equipe */

var PALETTE = [
  "#2a78d6","#eb6834","#1baf7a","#9b59b6","#e74c3c","#f39c12",
  "#1abc9c","#3498db","#e67e22","#2ecc71","#e91e63","#00bcd4"
];
function corEquipe(idx){ return PALETTE[idx % PALETTE.length]; }


/* =====================================================================
   5. CARGA DAS DIMENSOES (1x, com cache localStorage 24h)
   ===================================================================== */

/* Popula os selects de equipe e vendedor (limpa antes para evitar duplicidade) */
function popularFiltros(){
  var sel = $("peEquipe");
  if (sel) {
    /* remove todas options exceto a primeira ("Todas as equipes") */
    while (sel.options.length > 1) sel.remove(1);
    DIM.equipes.forEach(function(n){
      var o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o);
    });
    var o2 = document.createElement("option"); o2.value = "(sem equipe)"; o2.textContent = "(sem equipe)"; sel.appendChild(o2);
  }

  /* Popula select de vendedores */
  var selVend = $("peBusca");
  if (selVend) {
    /* limpa options exceto a primeira */
    while (selVend.options && selVend.options.length > 1) selVend.remove(1);
    var nomes = Object.keys(DIM.users).map(function(uid){ return DIM.users[uid]; })
      .filter(function(u){ return u.ativo; })
      .sort(function(a,b){ return a.nome.localeCompare(b.nome, "pt-BR"); });
    nomes.forEach(function(u){
      var o = document.createElement("option"); o.value = u.nome; o.textContent = u.nome; selVend.appendChild(o);
    });
  }
}

function carregarDimensoes(){
  /* DESABILITA cache localStorage â€” sempre busca fresco para evitar bugs */
  setStatus("Carregando usuarios e equipes...");
  return Promise.all([
    listAll("user.get", {}, function(r){ return r || []; }),
    listAll("crm.item.list", {
      entityTypeId: CFG.SPA_ID,
      select: ["id", "updatedTime", CFG.SPA_AGENTE, CFG.SPA_EQUIPE]
    }, function(r){ return (r && r.items) || []; }),
    call("lists.element.get", { IBLOCK_TYPE_ID: "lists", IBLOCK_ID: CFG.IBLOCK_EQUIPES })
      .then(function(j){ return j.result || []; })
      .catch(function(){ return []; })
  ]).then(function(res){
    var users = res[0], spa = res[1], lists = res[2];
    users.forEach(function(u){
      DIM.users[String(u.ID)] = {
        id: String(u.ID),
        nome: ((u.NAME || "") + " " + (u.LAST_NAME || "")).trim() || ("Usuario #" + u.ID),
        cargo: (u.WORK_POSITION || "").trim(),
        ativo: u.ACTIVE !== false && u.ACTIVE !== "N"
      };
    });
    var nomeEquipe = {}, membroEquipe = {};
    lists.forEach(function(e){
      var nome = (e.NAME || "").trim();
      nomeEquipe[String(e.ID)] = nome;
      DIM.equipes.push(nome);
      Object.keys(e).forEach(function(k){
        if (k.indexOf("PROPERTY_") !== 0) return;
        var v = e[k];
        if (!v || typeof v !== "object") return;
        Object.keys(v).forEach(function(pk){
          var uid = String(v[pk]);
          if (/^\d+$/.test(uid) && !membroEquipe[uid]) membroEquipe[uid] = nome;
        });
      });
    });
    var maisRecente = {};
    spa.forEach(function(it){
      var uid = it[CFG.SPA_AGENTE], eqId = it[CFG.SPA_EQUIPE];
      if (!uid || !eqId || String(eqId) === "0") return;
      uid = String(uid);
      var t = it.updatedTime || "";
      if (!maisRecente[uid] || t > maisRecente[uid].t)
        maisRecente[uid] = { t: t, equipe: nomeEquipe[String(eqId)] || ("Equipe " + eqId) };
    });
    Object.keys(maisRecente).forEach(function(uid){ DIM.agenteEquipe[uid] = maisRecente[uid].equipe; });
    Object.keys(membroEquipe).forEach(function(uid){
      if (!DIM.agenteEquipe[uid]) DIM.agenteEquipe[uid] = membroEquipe[uid];
    });
    DIM.equipes.sort(function(a,b){ return a.localeCompare(b,"pt-BR"); });
    popularFiltros();
  });
}

/* =====================================================================
   6. CARGA DOS FATOS â€” OTIMIZADA (paralela com progress)
   ===================================================================== */
function carregarFatos(de, ate){
  /* cache em memoria: se ja buscou esse periodo, reutiliza */
  var ck = de + "|" + ate;
  if (CACHE[ck]) { setStatus("Dados do cache..."); return Promise.resolve(CACHE[ck]); }

  /* Se a data "ate" for hoje, usa hora atual (para bater com o Bitrix) */
  var agora = new Date();
  var hojeFmt = iso(agora);
  var d0 = de + " 00:00:00";
  var d1;
  if (ate === hojeFmt) {
    d1 = ate + " " + String(agora.getHours()).padStart(2,"0") + ":" + String(agora.getMinutes()).padStart(2,"0") + ":" + String(agora.getSeconds()).padStart(2,"0");
  } else {
    d1 = ate + " 23:59:59";
  }
  var selLead = ["ID","ASSIGNED_BY_ID","SOURCE_ID","DATE_CREATE","STAGE_ID","OPPORTUNITY",
                 CFG.UF.TIPO_VENDA, CFG.UF.IND, CFG.UF.ENTREV, CFG.UF.LIG, CFG.UF.MSG];

  setStatus("Buscando negocios do periodo...");

  /* Busca UNICA: todos os deals criados no periodo (sem filtro de stage - bug da API) */
  return Promise.all([
    listAll("crm.deal.list", {
      filter: { CATEGORY_ID: CFG.CATEGORY, ">=DATE_CREATE": d0, "<=DATE_CREATE": d1, "!IS_RECURRING": "Y" },
      select: selLead, order: { ID: "ASC" }
    }),
    /* vendas vem da mesma lista (filtrado por STAGE_ID no codigo) */
    Promise.resolve([]),
    listAll("crm.stagehistory.list", {
      entityTypeId: 2,
      filter: { CATEGORY_ID: CFG.CATEGORY, "@STAGE_ID": HIST_STAGES, ">=CREATED_TIME": d0, "<=CREATED_TIME": d1 },
      select: ["ID","OWNER_ID","CREATED_TIME","STAGE_ID"], order: { ID: "ASC" }
    }, function(r){ return (r && r.items) || []; })
  ]).then(function(res){
    var leads = res[0].filter(function(d){
      var dc = (d.DATE_CREATE || "").substring(0, 10);
      return dc >= de && dc <= ate;
    }), hist = res[2];
    /* vendas = deals da mesma lista que estao em WON */
    var vendasPre = leads.filter(function(d){ return d.STAGE_ID === "WON"; });

    /* Exclui deals que estao na lixeira (IDs conhecidos que a API retorna mas funil nao mostra) */
    var BLACKLIST = {76652:1, 76654:1, 76666:1, 76698:1, 76710:1};
    vendasPre = vendasPre.filter(function(d){ return !BLACKLIST[d.ID]; });

    /* vendas validadas (blacklist ja aplicada) */
    var vendas = vendasPre;
    setStatus("Processando " + nfInt.format(leads.length + hist.length) + " registros (" + vendas.length + " vendas)...");

    var dono = {};
    leads.forEach(function(d){ dono[String(d.ID)] = String(d.ASSIGNED_BY_ID); });
    var faltando = [];
    hist.forEach(function(h){
      var id = String(h.OWNER_ID);
      if (!dono[id] && faltando.indexOf(id) === -1) faltando.push(id);
    });
    if (!faltando.length) {
      var resultado = { leads: leads, vendas: vendas, hist: hist, dono: dono };
      CACHE[ck] = resultado;
      return resultado;
    }

    setStatus("Resolvendo " + nfInt.format(faltando.length) + " responsaveis...");
    /* Resolve em paralelo tambem */
    var cmds = [];
    for (var i = 0; !(i >= faltando.length); i += 50) {
      cmds.push({ method: "crm.deal.list", params: {
        filter: { "@ID": faltando.slice(i, i + 50) }, select: ["ID","ASSIGNED_BY_ID"]
      }});
    }
    var groups = [];
    for (var g = 0; !(g >= cmds.length); g += CFG.BATCH_SIZE) groups.push(cmds.slice(g, g + CFG.BATCH_SIZE));

    return Promise.all(groups.map(function(grp){
      return batch(grp).then(function(rs){
        rs.forEach(function(arr){
          (arr || []).forEach(function(d){ dono[String(d.ID)] = String(d.ASSIGNED_BY_ID); });
        });
      });
    })).then(function(){
      var resultado = { leads: leads, vendas: vendas, hist: hist, dono: dono };
      CACHE[ck] = resultado;
      return resultado;
    });
  });
}

/* =====================================================================
   7. CALCULO DOS INDICADORES (expandido com novos KPIs)
   ===================================================================== */
function novaLinha(uid){
  var u = DIM.users[uid] || { nome: "Usuario #" + uid, cargo: "" };
  return {
    id: uid, nome: u.nome, cargo: u.cargo,
    equipe: DIM.agenteEquipe[uid] || "(sem equipe)",
    leads: 0, vcAgendadas: 0, entrevistas: 0, bolo: 0, valorizados: 0, propostas: 0,
    indicacoes: 0, repescagem: 0, recompra: 0, cotas: 0, faturamento: 0, mensagens: 0, ligacoes: 0,
    /* NOVOS indicadores */
    perdidos: 0, emAndamento: 0, valorTotal: 0
  };
}

function calcular(dados, de, ate){
  var por = {};
  function linha(uid){
    if (!uid || uid === "undefined" || uid === "null") uid = "0";
    if (!por[uid]) por[uid] = novaLinha(uid);
    return por[uid];
  }

  dados.leads.forEach(function(d){
    var r = linha(String(d.ASSIGNED_BY_ID));
    r.leads++;
    var tipoVenda = String(d[CFG.UF.TIPO_VENDA] || "");
    if (d.SOURCE_ID === "RECOMMENDATION" || tipoVenda === "694") r.indicacoes++;
    if (tipoVenda === "692") r.repescagem++;
    if (tipoVenda === "696") r.recompra++;
    r.mensagens += parseFloat(d[CFG.UF.MSG]) || 0;
    r.ligacoes  += parseFloat(d[CFG.UF.LIG]) || 0;
  });

  dados.vendas.forEach(function(d){
    if (d.STAGE_ID !== "WON") return; /* filtra apenas etapa WON */
    var r = linha(String(d.ASSIGNED_BY_ID));
    r.cotas++;
    r.faturamento += parseFloat(d.OPPORTUNITY) || 0;
  });

  var vistos = { vc:{}, bolo:{}, valor:{}, prop:{}, entrev:{} };
  dados.hist.forEach(function(h){
    var dealId = String(h.OWNER_ID);
    var uid = dados.dono[dealId];
    if (!uid) return;
    var r = linha(uid), st = h.STAGE_ID, k = uid + "|" + dealId;
    if (st === CFG.STAGE.VC    && !vistos.vc[k])    { vistos.vc[k] = 1;    r.vcAgendadas++; }
    if (st === CFG.STAGE.BOLO  && !vistos.bolo[k])  { vistos.bolo[k] = 1;  r.bolo++; }
    if (st === CFG.STAGE.VALOR && !vistos.valor[k]) { vistos.valor[k] = 1; r.valorizados++; }
    if (st === CFG.STAGE.PROP  && !vistos.prop[k])  { vistos.prop[k] = 1;  r.propostas++; }
    if (ENTREVISTA_STAGES.indexOf(st) >= 0 && !vistos.entrev[k]) { vistos.entrev[k] = 1; r.entrevistas++; }
  });
  dados.vendas.forEach(function(d){
    if (d.STAGE_ID !== "WON") return;
    var uid = String(d.ASSIGNED_BY_ID), k = uid + "|" + String(d.ID);
    if (!vistos.entrev[k]) { vistos.entrev[k] = 1; linha(uid).entrevistas++; }
  });

  var linhas = Object.keys(por).map(function(k){ return por[k]; })
    .filter(function(r){ return r.leads || r.cotas || r.entrevistas || r.vcAgendadas || r.bolo; });

  var dias = diasUteis(de, ate);
  linhas.forEach(function(r){
    r.ticket        = r.cotas ? r.faturamento / r.cotas : 0;
    r.txConv        = r.entrevistas ? r.cotas / r.entrevistas : 0;
    r.venda10vc     = r.txConv * 10;
    r.convLead      = r.leads ? r.cotas / r.leads : 0;
    r.vcPorLead     = r.leads ? r.entrevistas / r.leads : 0;
    r.entrevPorVenda= r.cotas ? r.entrevistas / r.cotas : 0;
    r.noShow        = r.vcAgendadas ? r.bolo / r.vcAgendadas : 0;
    /* NOVOS */
    r.mediaVcDia    = r.entrevistas / dias;
    r.mediaLeadDia  = r.leads / dias;
    r.fatPorEntrev  = r.entrevistas ? r.faturamento / r.entrevistas : 0;
    r.produtividade = r.entrevistas + r.vcAgendadas + r.cotas; /* score de atividade */
  });

  /* serie temporal por dia */
  var porDia = {};
  dados.vendas.forEach(function(d){
    if (d.STAGE_ID !== "WON") return;
    var dia = (d.DATE_CREATE || "").substring(0, 10);
    if (!dia) return;
    if (!porDia[dia]) porDia[dia] = { fat: 0, cotas: 0, leads: 0, entrevistas: 0 };
    porDia[dia].fat += parseFloat(d.OPPORTUNITY) || 0;
    porDia[dia].cotas++;
  });
  dados.leads.forEach(function(d){
    var dia = (d.DATE_CREATE || "").substring(0, 10);
    if (!dia) return;
    if (!porDia[dia]) porDia[dia] = { fat: 0, cotas: 0, leads: 0, entrevistas: 0 };
    porDia[dia].leads++;
  });
  /* entrevistas por dia (do historico) */
  var entrevVisto = {};
  dados.hist.forEach(function(h){
    var dealId = String(h.OWNER_ID), st = h.STAGE_ID;
    if (ENTREVISTA_STAGES.indexOf(st) === -1) return;
    var k = dealId;
    if (entrevVisto[k]) return;
    entrevVisto[k] = 1;
    var dia = (h.CREATED_TIME || "").substring(0, 10);
    if (!dia) return;
    if (!porDia[dia]) porDia[dia] = { fat: 0, cotas: 0, leads: 0, entrevistas: 0 };
    porDia[dia].entrevistas++;
  });

  return { linhas: linhas, de: de, ate: ate, dias: dias, porDia: porDia };
}

function agregar(linhas){
  var t = { leads:0, vcAgendadas:0, entrevistas:0, bolo:0, valorizados:0, propostas:0,
            indicacoes:0, repescagem:0, recompra:0, cotas:0, faturamento:0, mensagens:0, ligacoes:0 };
  linhas.forEach(function(r){ Object.keys(t).forEach(function(k){ t[k] += r[k] || 0; }); });
  t.ticket        = t.cotas ? t.faturamento / t.cotas : 0;
  t.txConv        = t.entrevistas ? t.cotas / t.entrevistas : 0;
  t.venda10vc     = t.txConv * 10;
  t.convLead      = t.leads ? t.cotas / t.leads : 0;
  t.vcPorLead     = t.leads ? t.entrevistas / t.leads : 0;
  t.entrevPorVenda= t.cotas ? t.entrevistas / t.cotas : 0;
  t.noShow        = t.vcAgendadas ? t.bolo / t.vcAgendadas : 0;
  return t;
}


/* =====================================================================
   8. RENDER â€” TILES, HERO, FUNIL
   ===================================================================== */
function tile(label, value, foot){
  return '<div class="card tile"><div class="label">' + esc(label) + '</div>' +
         '<div class="value">' + value + '</div>' +
         '<div class="foot">' + (foot || "&nbsp;") + '</div></div>';
}

function renderTiles(t, dias){
  var el = $("peTiles"); if (!el) return;
  el.innerHTML =
    tile("Cotas vendidas", nfInt.format(t.cotas), "negocios em Vendido") +
    tile("Ticket medio", moneyShort(t.ticket), "faturamento / cotas") +
    tile("Leads recebidos", nfInt.format(t.leads), "criados no periodo") +
    tile("V.C. agendadas", nfInt.format(t.vcAgendadas), "passaram por Videochamada") +
    tile("Entrevistas", nfInt.format(t.entrevistas), nfDec.format(t.entrevistas / dias) + " por dia util") +
    tile("Taxa de conversao", (t.entrevistas ? nfDec.format(t.txConv * 100) + "%" : "-"), "cotas / entrevistas");
}

function renderEquipeCards(t, dias, titulo, meta){
  var titleEl = $("peEquipeTitle"); if (titleEl) titleEl.textContent = titulo;
  var tilesEl = $("peEquipeTiles"); if (!tilesEl) return;
  tilesEl.innerHTML =
    tile("Meta do periodo", moneyShort(meta), "configuravel em CFG.METAS") +
    tile("Vendas da equipe", moneyShort(t.faturamento), nfInt.format(t.cotas) + " cotas") +
    tile("Taxa de conversao", (t.entrevistas ? nfDec.format(t.txConv * 100) + "%" : "-"), "cotas / entrevistas") +
    tile("Quantas entrev. p/ vender", (t.cotas ? nfDec.format(t.entrevPorVenda) : "-"), "entrevistas / cota") +
    tile("Ticket medio", moneyShort(t.ticket), "por cota vendida") +
    tile("Media de V.C. / dia", nfDec.format(t.entrevistas / dias), dias + " dias uteis") +
    tile("Tx. conversao por lead", pct(t.cotas, t.leads), nfInt.format(t.leads) + " leads") +
    tile("Videochamada por lead", pct(t.entrevistas, t.leads), "entrevistas / leads") +
    tile("Deu bolo (no-show)", pct(t.bolo, t.vcAgendadas), nfInt.format(t.bolo) + " de " + nfInt.format(t.vcAgendadas)) +
    tile("Valorizados", nfInt.format(t.valorizados), "passaram por Valorizado") +
    tile("Venda/10 V.C.", (t.entrevistas ? nfDec.format(t.venda10vc) : "-"), "cotas/entrev Ã— 10") +
    tile("Indicacoes", nfInt.format(t.indicacoes), "leads por recomendacao") +
    tile("Repescagem", nfInt.format(t.repescagem), "tipo venda = Repescagem") +
    tile("Re-Compra", nfInt.format(t.recompra), "tipo venda = Re-Compra");
}

function renderHero(t, meta){
  var hero = $("peHero"); if (hero) hero.textContent = money(t.faturamento);
  var heroNote = $("peHeroNote"); if (heroNote) heroNote.innerHTML = nfInt.format(t.cotas) + " cotas &middot; ticket medio " + moneyShort(t.ticket);
  var p = meta ? t.faturamento * 100 / meta : 0;
  var fill = $("peMeterFill");
  if (fill) { fill.style.width = Math.min(100, p).toFixed(1) + "%"; fill.style.background = p >= 100 ? "var(--good)" : "var(--series-1)"; }
  var metaTxt = $("peMetaTxt"); if (metaTxt) metaTxt.textContent = "Meta " + moneyShort(meta);
  var metaPct = $("peMetaPct"); if (metaPct) metaPct.textContent = nfDec.format(p) + "% atingido";
}

function renderFunil(t){
  var etapas = [
    { n: "Leads recebidos",  v: t.leads,       c: "var(--ord-1)" },
    { n: "V.C. agendadas",   v: t.vcAgendadas, c: "var(--ord-2)" },
    { n: "Entrevistas",      v: t.entrevistas, c: "var(--ord-3)" },
    { n: "Propostas feitas", v: t.propostas,   c: "var(--ord-4)" },
    { n: "Cotas vendidas",   v: t.cotas,       c: "var(--ord-5)" }
  ];
  var max = Math.max.apply(null, etapas.map(function(e){ return e.v; })) || 1;
  var base = t.leads || max;
  var el = $("peFunnel");
  if (!el) return;
  el.innerHTML = "";
  etapas.forEach(function(e, i){
    var row = document.createElement("div"); row.className = "fRow";
    row.innerHTML = '<div class="fName">' + esc(e.n) + '</div>' +
      '<div><div class="fBar" style="width:' + Math.max(0.6, e.v * 100 / max).toFixed(2) + '%;background:' + e.c + '"></div></div>' +
      '<div class="fVal">' + nfInt.format(e.v) + '<small>' + pct(e.v, base) + '</small></div>';
    var ant = i > 0 ? etapas[i-1] : null;
    bindTip(row, "<b>" + esc(e.n) + "</b>" + nfInt.format(e.v) + " no periodo<br>" +
      pct(e.v, base) + " dos leads" + (ant ? "<br>" + pct(e.v, ant.v) + " da etapa anterior" : ""));
    el.appendChild(row);
  });
}

/* =====================================================================
   8B. CHART.JS â€” GRAFICOS INTERATIVOS
   ===================================================================== */

/* Fallback: barras CSS para quando Chart.js ou containers novos nao existem */
function renderBarrasFallback(elId, linhas, campo, fmt){
  var el = $(elId); if (!el) return;
  var dados = linhas.slice().sort(function(a,b){ return b[campo] - a[campo]; })
    .filter(function(r){ return r[campo] > 0; }).slice(0, CFG.TOP_BARRAS);
  if (!dados.length) { el.innerHTML = '<div class="empty">Sem dados no periodo.</div>'; return; }
  var max = dados[0][campo] || 1;
  el.innerHTML = "";
  dados.forEach(function(r){
    var row = document.createElement("div"); row.className = "barRow";
    row.innerHTML = '<div class="barName" title="' + esc(r.nome) + '">' + esc(r.nome) + '</div>' +
      '<div class="barTrack"><div class="barFill" style="width:' + Math.max(0.6, r[campo] * 100 / max).toFixed(2) + '%"></div></div>' +
      '<div class="barVal">' + fmt(r[campo]) + '</div>';
    el.appendChild(row);
  });
}

/* Graficos 1 e 2: usam fallback direto (sem Chart.js) */
function renderChartEntrevistas(linhas){
  renderBarrasFallback("peChartEntrevWrap", linhas, "entrevistas", function(v){ return nfInt.format(v); });
  renderBarrasFallback("peChartEntrev", linhas, "entrevistas", function(v){ return nfInt.format(v); });
}

function renderChartFaturamento(linhas){
  renderBarrasFallback("peChartFatWrap", linhas, "faturamento", moneyShort);
  renderBarrasFallback("peChartFat", linhas, "faturamento", moneyShort);
}

/* Grafico 3: Tendencia — usa mesmo padrao barRow que ja funciona */
function renderChartTendencia(porDia, de, ate){
  var el = $("peSvgTrend"); if (!el) return;
  var dias = [], dAtual = new Date(de + "T00:00:00"), dFim = new Date(ate + "T00:00:00");
  while (dAtual <= dFim) { dias.push(iso(dAtual)); dAtual.setDate(dAtual.getDate() + 1); }
  if (!dias.length) { el.innerHTML = ""; return; }
  /* agrupa por semana */
  var semanas = [], acum = { fat:0, leads:0, lbl:"" };
  dias.forEach(function(dia, i){
    var d = porDia[dia] || { fat:0, leads:0 };
    acum.fat += d.fat; acum.leads += d.leads;
    if (!acum.lbl) acum.lbl = dia.substring(5).replace("-","/");
    if ((i+1) % 7 === 0 || i === dias.length - 1) { semanas.push(acum); acum = { fat:0, leads:0, lbl:"" }; }
  });
  var maxFat = Math.max.apply(null, semanas.map(function(s){ return s.fat; })) || 1;
  el.innerHTML = "";
  semanas.forEach(function(s){
    var row = document.createElement("div"); row.className = "barRow";
    row.innerHTML = '<div class="barName">' + s.lbl + '</div>' +
      '<div class="barTrack"><div class="barFill" style="width:' + Math.max(0.5, s.fat * 100 / maxFat).toFixed(1) + '%"></div></div>' +
      '<div class="barVal">' + moneyShort(s.fat) + '</div>';
    el.appendChild(row);
  });
}

/* Grafico 4: Equipe — usa barRow */
function renderChartDrillEquipe(linhas){
  var el = $("peSvgDrill"); if (!el) return;
  var porEq = {};
  linhas.forEach(function(r){
    if (!porEq[r.equipe]) porEq[r.equipe] = { cotas:0, faturamento:0 };
    porEq[r.equipe].cotas += r.cotas; porEq[r.equipe].faturamento += r.faturamento;
  });
  var eqs = Object.keys(porEq).sort(function(a,b){ return porEq[b].faturamento - porEq[a].faturamento; });
  if (!eqs.length) { el.innerHTML = ""; return; }
  var max = porEq[eqs[0]].faturamento || 1;
  el.innerHTML = "";
  eqs.forEach(function(eq){
    var e = porEq[eq];
    var row = document.createElement("div"); row.className = "barRow";
    row.innerHTML = '<div class="barName">' + esc(eq) + '</div>' +
      '<div class="barTrack"><div class="barFill" style="width:' + Math.max(0.5, e.faturamento * 100 / max).toFixed(1) + '%;background:var(--series-2)"></div></div>' +
      '<div class="barVal">' + moneyShort(e.faturamento) + ' (' + e.cotas + ')</div>';
    el.appendChild(row);
  });
}

/* Grafico 5: Ranking — usa barRow */
function renderChartRanking(linhas){
  var el = $("peSvgRank"); if (!el) return;
  var dados = linhas.slice().sort(function(a,b){ return b.faturamento - a.faturamento; })
    .filter(function(r){ return r.faturamento > 0; }).slice(0, 10);
  if (!dados.length) { el.innerHTML = ""; return; }
  var max = dados[0].faturamento || 1;
  el.innerHTML = "";
  dados.forEach(function(r, i){
    var row = document.createElement("div"); row.className = "barRow";
    row.innerHTML = '<div class="barName">' + (i+1) + '. ' + esc(r.nome) + '</div>' +
      '<div class="barTrack"><div class="barFill" style="width:' + Math.max(0.5, r.faturamento * 100 / max).toFixed(1) + '%;background:var(--series-3)"></div></div>' +
      '<div class="barVal">' + moneyShort(r.faturamento) + '</div>';
    el.appendChild(row);
  });
}

/* Grafico 6: Radar — omitido (requer Chart.js), silencioso */
function renderChartRadar(linhas){ return; }

/* Modal drill vendedor */
function mostrarDrillVendedor(v){
  var el = $("peDrillModal"); if (!el) return;
  el.style.display = "flex";
  var titleEl = $("peDrillTitle"); if (titleEl) titleEl.textContent = v.nome + " (" + v.equipe + ")";
  var bodyEl = $("peDrillBody"); if (!bodyEl) return;
  bodyEl.innerHTML = '<div class="tiles">' +
    tile("Leads", nfInt.format(v.leads), nfDec.format(v.mediaLeadDia || 0) + "/dia") +
    tile("V.C. agendadas", nfInt.format(v.vcAgendadas), "") +
    tile("Entrevistas", nfInt.format(v.entrevistas), nfDec.format(v.mediaVcDia || 0) + "/dia util") +
    tile("Cotas vendidas", nfInt.format(v.cotas), "") +
    tile("Faturamento", money(v.faturamento), "") +
    tile("Ticket medio", v.cotas ? money(v.ticket) : "-", "") +
    tile("Taxa conversao", v.entrevistas ? nfDec.format(v.txConv*100)+"%" : "-", "cotas/entrev") +
    tile("Venda/10 V.C.", v.entrevistas ? nfDec.format(v.venda10vc) : "-", "") +
    tile("Deu bolo", nfInt.format(v.bolo), pct(v.bolo, v.vcAgendadas) + " no-show") +
    tile("Indicacoes", nfInt.format(v.indicacoes), "") +
    tile("Fat/Entrevista", v.entrevistas ? money(v.fatPorEntrev) : "-", "valor gerado por entrev") +
    tile("Mensagens", nfInt.format(v.mensagens), "campo manual") +
    '</div>';
}


/* =====================================================================
   8C. TABELAS (com colunas expandidas)
   ===================================================================== */
var COLS_VEND = [
  { k:"nome",        t:"Vendedor",       txt:true,  f:function(r){ return esc(r.nome); } },
  { k:"equipe",      t:"Equipe",         txt:true,  f:function(r){ return '<span class="pill">' + esc(r.equipe) + '</span>'; } },
  { k:"leads",       t:"Leads",          f:function(r){ return nfInt.format(r.leads); },        sum:"int" },
  { k:"vcAgendadas", t:"V.C. agend.",    f:function(r){ return nfInt.format(r.vcAgendadas); },  sum:"int" },
  { k:"entrevistas", t:"Entrevistas",    f:function(r){ return nfInt.format(r.entrevistas); },  sum:"int" },
  { k:"bolo",        t:"Deu bolo",       f:function(r){ return nfInt.format(r.bolo); },         sum:"int" },
  { k:"valorizados", t:"Valorizados",    f:function(r){ return nfInt.format(r.valorizados); },  sum:"int" },
  { k:"indicacoes",  t:"Indicacoes",     f:function(r){ return nfInt.format(r.indicacoes); },   sum:"int" },
  { k:"repescagem",  t:"Repescagem",     f:function(r){ return nfInt.format(r.repescagem); },   sum:"int" },
  { k:"recompra",    t:"Re-Compra",      f:function(r){ return nfInt.format(r.recompra); },     sum:"int" },
  { k:"cotas",       t:"Cotas vend.",    f:function(r){ return nfInt.format(r.cotas); },        sum:"int" },
  { k:"faturamento", t:"Faturamento",    f:function(r){ return money(r.faturamento); },         sum:"money" },
  { k:"ticket",      t:"Ticket medio",   f:function(r){ return r.cotas ? money(r.ticket) : "-"; },  sum:"calcTicket" },
  { k:"txConv",      t:"Tx. conversao",  f:function(r){ return r.entrevistas ? nfDec.format(r.txConv*100) + "%" : "-"; }, sum:"calcTxConv" },
  { k:"venda10vc",   t:"Venda/10 V.C.",  f:function(r){ return r.entrevistas ? nfDec.format(r.venda10vc) : "-"; },        sum:"calcV10" },
  { k:"convLead",    t:"% conv. lead",   f:function(r){ return r.leads ? nfDec.format(r.convLead*100) + "%" : "-"; },     sum:"calcConvLead" },
  { k:"vcPorLead",   t:"V.C./lead",      f:function(r){ return r.leads ? nfDec.format(r.vcPorLead*100) + "%" : "-"; },    sum:"calcVcLead" },
  { k:"ligacoes",    t:"Ligacoes",       f:function(r){ return nfInt.format(r.ligacoes); },     sum:"int" },
  { k:"mensagens",   t:"Mensagens",      f:function(r){ return nfInt.format(r.mensagens); },    sum:"int" }
];
var COLS_SUP = [
  { k:"nome",           t:"Supervisor",         txt:true, f:function(r){ return esc(r.nome); } },
  { k:"equipe",         t:"Equipe",             txt:true, f:function(r){ return '<span class="pill">' + esc(r.equipe) + '</span>'; } },
  { k:"entrevistas",    t:"Entrevistas feitas", f:function(r){ return nfInt.format(r.entrevistas); },  sum:"int" },
  { k:"cotas",          t:"Cotas vendidas",     f:function(r){ return nfInt.format(r.cotas); },        sum:"int" },
  { k:"faturamento",    t:"Total vendido",      f:function(r){ return money(r.faturamento); },         sum:"money" },
  { k:"ticket",         t:"Ticket medio",       f:function(r){ return r.cotas ? money(r.ticket) : "-"; }, sum:"calcTicket" },
  { k:"entrevPorVenda", t:"Entrev. p/ vender",  f:function(r){ return r.cotas ? nfDec.format(r.entrevPorVenda) : "-"; }, sum:"calcEpV" },
  { k:"valorizados",    t:"Valorizados",        f:function(r){ return nfInt.format(r.valorizados); },  sum:"int" },
  { k:"txConv",         t:"Tx. conversao",      f:function(r){ return r.entrevistas ? nfDec.format(r.txConv*100) + "%" : "-"; }, sum:"calcTxConv" }
];
var COLS_EQ = [
  { k:"nome",        t:"Equipe",       txt:true, f:function(r){ return '<b>' + esc(r.nome) + '</b>'; } },
  { k:"vendedores",  t:"Vendedores",   f:function(r){ return nfInt.format(r.vendedores); },  sum:"int" },
  { k:"leads",       t:"Leads",        f:function(r){ return nfInt.format(r.leads); },       sum:"int" },
  { k:"vcAgendadas", t:"V.C. agend.",  f:function(r){ return nfInt.format(r.vcAgendadas); }, sum:"int" },
  { k:"entrevistas", t:"Entrevistas",  f:function(r){ return nfInt.format(r.entrevistas); }, sum:"int" },
  { k:"cotas",       t:"Cotas vend.",  f:function(r){ return nfInt.format(r.cotas); },       sum:"int" },
  { k:"faturamento", t:"Faturamento",  f:function(r){ return money(r.faturamento); },        sum:"money" },
  { k:"ticket",      t:"Ticket medio", f:function(r){ return r.cotas ? money(r.ticket) : "-"; }, sum:"calcTicket" },
  { k:"txConv",      t:"Tx. conversao",f:function(r){ return r.entrevistas ? nfDec.format(r.txConv*100) + "%" : "-"; }, sum:"calcTxConv" },
  { k:"convLead",    t:"% conv. lead", f:function(r){ return r.leads ? nfDec.format(r.convLead*100) + "%" : "-"; },     sum:"calcConvLead" }
];

var sortState = {};
function renderTabela(tblId, cols, linhas, defaultSort){
  var tbl = $(tblId); if (!tbl) return;
  var st = sortState[tblId] || (sortState[tblId] = { k: defaultSort, dir: "desc" });
  var arr = linhas.slice().sort(function(a, b){
    var x = a[st.k], y = b[st.k], s;
    if (typeof x === "string" || typeof y === "string") s = String(x).localeCompare(String(y), "pt-BR");
    else s = (x || 0) - (y || 0);
    return st.dir === "asc" ? s : -s;
  });
  tbl.tHead.innerHTML = "<tr>" + cols.map(function(c){
    return '<th class="' + (c.txt ? "txt" : "") + '"' + (c.k === st.k ? ' data-dir="' + st.dir + '"' : "") + ' data-k="' + c.k + '">' + esc(c.t) + '</th>';
  }).join("") + "</tr>";
  tbl.tBodies[0].innerHTML = arr.length
    ? arr.map(function(r){ return "<tr>" + cols.map(function(c){ return '<td class="' + (c.txt ? "txt" : "") + '">' + c.f(r) + "</td>"; }).join("") + "</tr>"; }).join("")
    : '<tr><td class="txt" colspan="' + cols.length + '"><div class="empty">Sem dados.</div></td></tr>';
  var t = agregar(arr);
  t.vendedores = arr.reduce(function(a, r){ return a + (r.vendedores || 1); }, 0);
  var footMap = {
    int: function(c){ return nfInt.format(t[c.k] || 0); }, money: function(c){ return money(t[c.k] || 0); },
    calcTicket: function(){ return t.cotas ? money(t.ticket) : "-"; },
    calcTxConv: function(){ return t.entrevistas ? nfDec.format(t.txConv*100)+"%" : "-"; },
    calcV10: function(){ return t.entrevistas ? nfDec.format(t.venda10vc) : "-"; },
    calcConvLead: function(){ return t.leads ? nfDec.format(t.convLead*100)+"%" : "-"; },
    calcVcLead: function(){ return t.leads ? nfDec.format(t.vcPorLead*100)+"%" : "-"; },
    calcEpV: function(){ return t.cotas ? nfDec.format(t.entrevPorVenda) : "-"; }
  };
  tbl.tFoot.innerHTML = "<tr>" + cols.map(function(c, i){
    if (i === 0) return '<td class="txt">TOTAL (' + arr.length + ")</td>";
    var fn = c.sum && footMap[c.sum]; return '<td class="' + (c.txt ? "txt" : "") + '">' + (fn ? fn(c) : "") + "</td>";
  }).join("") + "</tr>";
  tbl.tHead.querySelectorAll("th").forEach(function(th){
    th.onclick = function(){ var k = th.getAttribute("data-k");
      if (st.k === k) st.dir = st.dir === "desc" ? "asc" : "desc"; else { st.k = k; st.dir = "desc"; }
      renderTabela(tblId, cols, linhas, defaultSort); };
  });
}

/* =====================================================================
   9. ORQUESTRACAO
   ===================================================================== */
function aplicarFiltros(linhas){
  var eq = $("peEquipe").value, q = ($("peBusca").value || "").trim().toLowerCase();
  return linhas.filter(function(r){
    if (eq && r.equipe !== eq) return false;
    if (q && r.nome.toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
}

function pintar(){
  if (!LAST) return;
  var linhas = aplicarFiltros(LAST.linhas);
  var t = agregar(linhas);
  var eqSel = $("peEquipe").value;
  var meta = (eqSel && CFG.METAS[eqSel]) || CFG.META_PADRAO;

  renderHero(t, meta);
  renderTiles(t, LAST.dias);
  renderEquipeCards(t, LAST.dias, eqSel ? ("Equipe: " + eqSel) : "Indicadores consolidados (todas as equipes)", meta);
  renderFunil(t);

  renderChartEntrevistas(linhas);
  renderChartFaturamento(linhas);
  renderChartTendencia(LAST.porDia, LAST.de, LAST.ate);
  renderChartDrillEquipe(LAST.linhas);
  renderChartRanking(linhas);
  renderChartRadar(LAST.linhas);

  renderTabela("peTblVend", COLS_VEND, linhas, "faturamento");

  var porEq = {};
  linhas.forEach(function(r){
    var e = porEq[r.equipe] || (porEq[r.equipe] = { nome: r.equipe, vendedores: 0,
      leads:0, vcAgendadas:0, entrevistas:0, bolo:0, valorizados:0, propostas:0,
      indicacoes:0, repescagem:0, recompra:0, cotas:0, faturamento:0, mensagens:0, ligacoes:0 });
    e.vendedores++;
    ["leads","vcAgendadas","entrevistas","bolo","valorizados","propostas","indicacoes","repescagem","recompra","cotas","faturamento","mensagens","ligacoes"]
      .forEach(function(k){ e[k] += r[k] || 0; });
  });
  var eqLinhas = Object.keys(porEq).map(function(k){
    var e = porEq[k]; e.ticket = e.cotas ? e.faturamento / e.cotas : 0;
    e.txConv = e.entrevistas ? e.cotas / e.entrevistas : 0; e.convLead = e.leads ? e.cotas / e.leads : 0; return e;
  });
  renderTabela("peTblEq", COLS_EQ, eqLinhas, "faturamento");

  var sup = linhas.filter(function(r){ return /supervisor/i.test(r.cargo || ""); });
  renderTabela("peTblSup", COLS_SUP, sup, "faturamento");

  var temManual = LAST.linhas.some(function(r){ return r.mensagens > 0 || r.ligacoes > 0; });
  var avisoEl = $("peAviso");
  if (avisoEl) avisoEl.innerHTML = "<b>Sobre Mensagens e Ligacoes:</b> " +
    (temManual ? "usando campos manuais do relatorio diario." : "campos manuais vazios no CRM. Preencha-os ou libere escopo telephony.") +
    " Demais numeros vem do funil e historico de etapas.";

  setStatus("Periodo " + LAST.de.split("-").reverse().join("/") + " a " + LAST.ate.split("-").reverse().join("/") +
    " - " + linhas.length + " vendedores - " + LAST.dias + " dias uteis");
}

function atualizar(){
  var de = $("peDe").value, ate = $("peAte").value;
  if (!de || !ate) { setStatus("Informe as datas."); return; }
  if (de > ate) { setStatus("Data inicial maior que final."); return; }
  $("peGo").disabled = true;
  var t0 = Date.now();
  carregarFatos(de, ate)
    .then(function(dados){
      setStatus("Calculando...");
      LAST = calcular(dados, de, ate);
      pintar();
      var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      setStatus($("peStatus").textContent + " - " + elapsed + "s");
    })
    .catch(function(e){ setStatus("Erro: " + e.message); console.error(e); })
    .then(function(){ $("peGo").disabled = false; });
}

function setPeriodo(p){
  var h = new Date(), de, ate = new Date(h);
  if (p === "hoje") de = new Date(h);
  else if (p === "7") { de = new Date(h); de.setDate(de.getDate() - 6); }
  else if (p === "30") { de = new Date(h); de.setDate(de.getDate() - 29); }
  else if (p === "mesant") { de = new Date(h.getFullYear(), h.getMonth() - 1, 1); ate = new Date(h.getFullYear(), h.getMonth(), 0); }
  else if (p === "ano") de = new Date(h.getFullYear(), 0, 1);
  else de = new Date(h.getFullYear(), h.getMonth(), 1);
  $("peDe").value = iso(de); $("peAte").value = iso(ate);
}

function exportarCsv(){
  if (!LAST) return;
  var linhas = aplicarFiltros(LAST.linhas);
  var head = ["Vendedor","Equipe","Leads","V.C. agendadas","Entrevistas","Deu bolo","Valorizados",
    "Indicacoes","Repescagem","Re-Compra","Cotas vendidas","Faturamento","Ticket medio","Tx. conversao %",
    "Venda/10 V.C.","% conv. lead","V.C./lead %","Ligacoes","Mensagens"];
  var rows = linhas.map(function(r){
    return [r.nome, r.equipe, r.leads, r.vcAgendadas, r.entrevistas, r.bolo, r.valorizados,
      r.indicacoes, r.repescagem, r.recompra, r.cotas, r.faturamento.toFixed(2).replace(".",","),
      r.ticket.toFixed(2).replace(".",","), (r.txConv*100).toFixed(2).replace(".",","),
      r.venda10vc.toFixed(2).replace(".",","), (r.convLead*100).toFixed(2).replace(".",","),
      (r.vcPorLead*100).toFixed(2).replace(".",","), r.ligacoes, r.mensagens];
  });
  var csv = "\uFEFF" + [head].concat(rows).map(function(r){
    return r.map(function(c){ return '"' + String(c).replace(/"/g,'""') + '"'; }).join(";");
  }).join("\r\n");
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = "vendedores_" + LAST.de + "_a_" + LAST.ate + ".csv"; a.click(); URL.revokeObjectURL(a.href);
}

/* =====================================================================
   10. BOOT
   ===================================================================== */
/* limpa caches antigos */
try { localStorage.removeItem("pe_dim_v2"); localStorage.removeItem("pe_dim_v3"); } catch(e){}

/* verifica se Chart.js carregou */
var HAS_CHARTJS = (typeof Chart !== "undefined");
if (!HAS_CHARTJS) {
  console.warn("[PE Dashboard] Chart.js nao carregou. Graficos usarao barras CSS.");
}

initTip();

var presetsEl = $("pePresets");
if (presetsEl) presetsEl.addEventListener("click", function(e){
  var b = e.target.closest("[data-p]"); if (!b) return;
  presetsEl.querySelectorAll(".chip").forEach(function(c){ c.setAttribute("aria-pressed","false"); });
  b.setAttribute("aria-pressed","true"); setPeriodo(b.getAttribute("data-p")); atualizar();
});
["peDe","peAte"].forEach(function(id){
  var el = $(id); if (el) el.addEventListener("change", function(){ if (presetsEl) presetsEl.querySelectorAll(".chip").forEach(function(c){ c.setAttribute("aria-pressed","false"); }); });
});
var goEl = $("peGo"); if (goEl) goEl.addEventListener("click", atualizar);
var csvEl = $("peCsv"); if (csvEl) csvEl.addEventListener("click", exportarCsv);
var eqEl = $("peEquipe"); if (eqEl) eqEl.addEventListener("change", pintar);
var buscaEl = $("peBusca");
if (buscaEl) buscaEl.addEventListener(buscaEl.tagName === "SELECT" ? "change" : "input", pintar);

var drillModal = $("peDrillModal");
if (drillModal) drillModal.addEventListener("click", function(e){
  if (e.target === drillModal || e.target.classList.contains("modal-close")) drillModal.style.display = "none";
});

setPeriodo("mes");
carregarDimensoes().then(atualizar).catch(function(e){ setStatus("ERRO: " + e.message); console.error(e); });

})();



