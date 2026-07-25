(function(){
"use strict";

/* =====================================================================
   1. CONFIGURACAO  - ajuste aqui
   ===================================================================== */
var CFG = {
  WEBHOOK : "https://portoelite.bitrix24.com.br/rest/10/lw0trhq6laln09cz/",
  CATEGORY: 0,                 // funil Vendas
  SPA_ID  : 1042,              // SPA Controle de acesso aos leads
  SPA_AGENTE: "ufCrm10_1767663044",
  SPA_EQUIPE: "ufCrm10_1767663090",
  IBLOCK_EQUIPES: 28,          // lista "Equipes"
  META_PADRAO: 5000000,        // meta mensal quando a equipe nao tem meta propria
  METAS: {                     // meta mensal por equipe (nome exatamente como na lista)
    // "EQUIPE FURIA": 5000000,
    // "Equipe APOLO": 3000000
  },
  TOP_BARRAS: 14,              // quantos vendedores aparecem nos graficos
  STAGE: { VC:"EXECUTING", BOLO:"UC_JABGE5", VALOR:"UC_8Y2T7I", PROP:"UC_N8IW9L", WON:"WON" },
  UF: { TIPO_VENDA:"UF_CRM_1784577684162", TIPO_VENDA_INDICACAO:"694",
        IND:"UF_CRM_69740ED137379", ENTREV:"UF_CRM_69740ED140724",
        LIG:"UF_CRM_69740ED149B72", MSG:"UF_CRM_69740ED15392A" }
};
var ENTREVISTA_STAGES = [CFG.STAGE.VALOR, CFG.STAGE.PROP, CFG.STAGE.WON];
var HIST_STAGES = [CFG.STAGE.VC, CFG.STAGE.BOLO, CFG.STAGE.VALOR, CFG.STAGE.PROP, CFG.STAGE.WON];

/* =====================================================================
   2. CAMADA REST (webhook + batch)
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

function call(method, params){
  var url = CFG.WEBHOOK + method + ".json";
  var body = toQuery(params || {});
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body
  }).then(function(r){ if (!r.ok) throw new Error(method + " HTTP " + r.status); return r.json(); }).then(function(j){
    if (j.error) throw new Error(method + ": " + (j.error_description || j.error));
    return j;
  });
}

/* executa ate 50 comandos numa unica requisicao */
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

/* pagina 100% de uma lista usando batch (50 paginas por requisicao) */
function listAll(method, params, extract, pageSize){
  pageSize = pageSize || 50;
  extract = extract || function(r){ return r || []; };
  var p = Object.assign({}, params, { start: 0 });
  return call(method, p).then(function(first){
    var items = extract(first.result).slice();
    var total = typeof first.total === "number" ? first.total : items.length;
    var offsets = [];
    for (var s = pageSize; s < total; s += pageSize) offsets.push(s);
    var chunks = [];
    for (var i = 0; i < offsets.length; i += 50) chunks.push(offsets.slice(i, i + 50));
    return chunks.reduce(function(chain, chunk){
      return chain.then(function(){
        return batch(chunk.map(function(off){
          return { method: method, params: Object.assign({}, params, { start: off }) };
        })).then(function(rs){
          rs.forEach(function(r){ if (r) items = items.concat(extract(r)); });
        });
      });
    }, Promise.resolve()).then(function(){ return items; });
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
  var NB = "\u00A0"; // espaco inquebravel: mantem "R$ 5,00 mi" numa linha so
  if (Math.abs(v) >= 1e6) return "R$" + NB + nfDec.format(v / 1e6) + NB + "mi";
  if (Math.abs(v) >= 1e3) return "R$" + NB + nfInt.format(Math.round(v / 1e3)) + NB + "mil";
  return money(v);
}
function pct(n, d){ return d ? nfDec.format(n * 100 / d) + "%" : "-"; }
function ratio(n, d, dec){ return d ? nfDec.format(n / d) : "-"; }
function iso(d){
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function esc(s){
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
/* dias uteis (seg-sex) entre duas datas, inclusive, limitado a hoje */
function diasUteis(de, ate){
  var a = new Date(de + "T00:00:00"), b = new Date(ate + "T00:00:00"), hoje = new Date();
  hoje.setHours(0,0,0,0);
  if (b > hoje) b = hoje;
  var n = 0;
  for (var d = new Date(a); d <= b; d.setDate(d.getDate()+1)) {
    var w = d.getDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n || 1;
}

/* tooltip compartilhado */
var TIP = $("peTip");
function bindTip(el, html){
  el.addEventListener("mouseenter", function(){ TIP.innerHTML = html; TIP.style.opacity = 1; });
  el.addEventListener("mousemove", function(e){
    var x = Math.min(e.clientX + 14, window.innerWidth - 300);
    TIP.style.left = x + "px";
    TIP.style.top  = Math.max(8, e.clientY - 12) + "px";
  });
  el.addEventListener("mouseleave", function(){ TIP.style.opacity = 0; });
}

function setStatus(msg){ $("peStatus").textContent = msg; }

/* =====================================================================
   4. ESTADO
   ===================================================================== */
var DIM = { users:{}, agenteEquipe:{}, equipes:[] };  // dimensoes (carregadas 1x)
var LAST = null;                                       // ultimo resultado calculado

/* =====================================================================
   5. CARGA DAS DIMENSOES (usuarios, SPA 1042, lista de equipes)
   ===================================================================== */
function carregarDimensoes(){
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

    /* nomes das equipes + membros declarados na propria lista */
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

    /* vinculo primario: SPA 1042 (mais recente por agente) */
    var maisRecente = {};
    spa.forEach(function(it){
      var uid = it[CFG.SPA_AGENTE], eqId = it[CFG.SPA_EQUIPE];
      if (!uid || !eqId || String(eqId) === "0") return;
      uid = String(uid);
      var t = it.updatedTime || "";
      if (!maisRecente[uid] || t > maisRecente[uid].t) {
        maisRecente[uid] = { t: t, equipe: nomeEquipe[String(eqId)] || ("Equipe " + eqId) };
      }
    });
    Object.keys(maisRecente).forEach(function(uid){ DIM.agenteEquipe[uid] = maisRecente[uid].equipe; });
    /* fallback: membros declarados na lista de equipes */
    Object.keys(membroEquipe).forEach(function(uid){
      if (!DIM.agenteEquipe[uid]) DIM.agenteEquipe[uid] = membroEquipe[uid];
    });

    DIM.equipes.sort(function(a,b){ return a.localeCompare(b,"pt-BR"); });
    var sel = $("peEquipe");
    DIM.equipes.forEach(function(n){
      var o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o);
    });
    var o2 = document.createElement("option"); o2.value = "(sem equipe)"; o2.textContent = "(sem equipe)"; sel.appendChild(o2);
  });
}

/* =====================================================================
   6. CARGA DOS FATOS DO PERIODO
   ===================================================================== */
function carregarFatos(de, ate){
  var d0 = de + " 00:00:00", d1 = ate + " 23:59:59";
  var selLead = ["ID","ASSIGNED_BY_ID","SOURCE_ID","DATE_CREATE",
                 CFG.UF.TIPO_VENDA, CFG.UF.IND, CFG.UF.ENTREV, CFG.UF.LIG, CFG.UF.MSG];

  setStatus("Buscando negocios do periodo...");
  return Promise.all([
    /* leads: negocios criados no periodo */
    listAll("crm.deal.list", {
      filter: { CATEGORY_ID: CFG.CATEGORY, ">=DATE_CREATE": d0, "<=DATE_CREATE": d1 },
      select: selLead, order: { ID: "ASC" }
    }),
    /* vendas: negocios ganhos fechados no periodo */
    listAll("crm.deal.list", {
      filter: { CATEGORY_ID: CFG.CATEGORY, STAGE_SEMANTIC_ID: "S", ">=CLOSEDATE": d0, "<=CLOSEDATE": d1 },
      select: ["ID","ASSIGNED_BY_ID","OPPORTUNITY","CLOSEDATE"], order: { ID: "ASC" }
    }),
    /* historico de etapas no periodo */
    listAll("crm.stagehistory.list", {
      entityTypeId: 2,
      filter: { CATEGORY_ID: CFG.CATEGORY, "@STAGE_ID": HIST_STAGES, ">=CREATED_TIME": d0, "<=CREATED_TIME": d1 },
      select: ["ID","OWNER_ID","CREATED_TIME","STAGE_ID"], order: { ID: "ASC" }
    }, function(r){ return (r && r.items) || []; })
  ]).then(function(res){
    var leads = res[0], vendas = res[1], hist = res[2];

    /* resolve o responsavel dos negocios que so aparecem no historico */
    var dono = {};
    leads.forEach(function(d){ dono[String(d.ID)] = String(d.ASSIGNED_BY_ID); });
    vendas.forEach(function(d){ dono[String(d.ID)] = String(d.ASSIGNED_BY_ID); });
    var faltando = [];
    hist.forEach(function(h){
      var id = String(h.OWNER_ID);
      if (!dono[id] && faltando.indexOf(id) < 0) faltando.push(id);
    });
    if (!faltando.length) return { leads: leads, vendas: vendas, hist: hist, dono: dono };

    setStatus("Resolvendo responsaveis de " + nfInt.format(faltando.length) + " negocios...");
    var cmds = [];
    for (var i = 0; i < faltando.length; i += 50) {
      cmds.push({ method: "crm.deal.list", params: {
        filter: { "@ID": faltando.slice(i, i + 50) },
        select: ["ID","ASSIGNED_BY_ID"]
      }});
    }
    var groups = [];
    for (var g = 0; g < cmds.length; g += 50) groups.push(cmds.slice(g, g + 50));
    return groups.reduce(function(chain, grp){
      return chain.then(function(){
        return batch(grp).then(function(rs){
          rs.forEach(function(arr){
            (arr || []).forEach(function(d){ dono[String(d.ID)] = String(d.ASSIGNED_BY_ID); });
          });
        });
      });
    }, Promise.resolve()).then(function(){
      return { leads: leads, vendas: vendas, hist: hist, dono: dono };
    });
  });
}

/* =====================================================================
   7. CALCULO DOS INDICADORES
   ===================================================================== */
function novaLinha(uid){
  var u = DIM.users[uid] || { nome: "Usuario #" + uid, cargo: "" };
  return {
    id: uid, nome: u.nome, cargo: u.cargo,
    equipe: DIM.agenteEquipe[uid] || "(sem equipe)",
    leads: 0, vcAgendadas: 0, entrevistas: 0, bolo: 0, valorizados: 0, propostas: 0,
    indicacoes: 0, cotas: 0, faturamento: 0, mensagens: 0, ligacoes: 0
  };
}

function calcular(dados, de, ate){
  var por = {};
  function linha(uid){
    if (!uid || uid === "undefined" || uid === "null") uid = "0";
    if (!por[uid]) por[uid] = novaLinha(uid);
    return por[uid];
  }

  /* leads + indicacoes + campos do relatorio diario */
  dados.leads.forEach(function(d){
    var r = linha(String(d.ASSIGNED_BY_ID));
    r.leads++;
    if (d.SOURCE_ID === "RECOMMENDATION" || String(d[CFG.UF.TIPO_VENDA] || "") === CFG.UF.TIPO_VENDA_INDICACAO) r.indicacoes++;
    r.mensagens += parseFloat(d[CFG.UF.MSG]) || 0;
    r.ligacoes  += parseFloat(d[CFG.UF.LIG]) || 0;
  });

  /* vendas */
  dados.vendas.forEach(function(d){
    var r = linha(String(d.ASSIGNED_BY_ID));
    r.cotas++;
    r.faturamento += parseFloat(d.OPPORTUNITY) || 0;
  });

  /* historico: conta negocios DISTINTOS por etapa */
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
  /* uma venda tambem conta como entrevista realizada */
  dados.vendas.forEach(function(d){
    var uid = String(d.ASSIGNED_BY_ID), k = uid + "|" + String(d.ID);
    if (!vistos.entrev[k]) { vistos.entrev[k] = 1; linha(uid).entrevistas++; }
  });

  var linhas = Object.keys(por).map(function(k){ return por[k]; })
    .filter(function(r){ return r.leads || r.cotas || r.entrevistas || r.vcAgendadas || r.bolo; });

  linhas.forEach(function(r){
    r.ticket      = r.cotas ? r.faturamento / r.cotas : 0;
    r.txConv      = r.entrevistas ? r.cotas / r.entrevistas : 0;   // cotas / entrevistas
    r.venda10vc   = r.txConv * 10;
    r.convLead    = r.leads ? r.cotas / r.leads : 0;
    r.vcPorLead   = r.leads ? r.entrevistas / r.leads : 0;
    r.entrevPorVenda = r.cotas ? r.entrevistas / r.cotas : 0;
    r.noShow      = (r.vcAgendadas ? r.bolo / r.vcAgendadas : 0);
  });

  return { linhas: linhas, de: de, ate: ate, dias: diasUteis(de, ate) };
}

function agregar(linhas){
  var t = { leads:0, vcAgendadas:0, entrevistas:0, bolo:0, valorizados:0, propostas:0,
            indicacoes:0, cotas:0, faturamento:0, mensagens:0, ligacoes:0 };
  linhas.forEach(function(r){
    Object.keys(t).forEach(function(k){ t[k] += r[k] || 0; });
  });
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
   8. RENDER
   ===================================================================== */
function tile(label, value, foot){
  return '<div class="card tile"><div class="label">' + esc(label) + '</div>' +
         '<div class="value">' + value + '</div>' +
         '<div class="foot">' + (foot || "&nbsp;") + '</div></div>';
}

function renderTiles(t, dias){
  $("peTiles").innerHTML =
    tile("Cotas vendidas", nfInt.format(t.cotas), "negocios em Vendido") +
    tile("Ticket medio", moneyShort(t.ticket), "faturamento / cotas") +
    tile("Leads recebidos", nfInt.format(t.leads), "criados no periodo") +
    tile("V.C. agendadas", nfInt.format(t.vcAgendadas), "passaram por Videochamada") +
    tile("Entrevistas", nfInt.format(t.entrevistas), nfDec.format(t.entrevistas / dias) + " por dia util") +
    tile("Taxa de conversao", (t.entrevistas ? nfDec.format(t.txConv * 100) + "%" : "-"), "cotas / entrevistas");
}

function renderEquipeCards(t, dias, titulo, meta){
  $("peEquipeTitle").textContent = titulo;
  $("peEquipeTiles").innerHTML =
    tile("Meta do periodo", moneyShort(meta), "configuravel em CFG.METAS") +
    tile("Vendas", moneyShort(t.faturamento), nfInt.format(t.cotas) + " cotas") +
    tile("Taxa de conversao", (t.entrevistas ? nfDec.format(t.txConv * 100) + "%" : "-"), "cotas / entrevistas") +
    tile("Entrevistas p/ vender", (t.cotas ? nfDec.format(t.entrevPorVenda) : "-"), "entrevistas / cota") +
    tile("Ticket medio", moneyShort(t.ticket), "por cota vendida") +
    tile("Media de V.C. / dia", nfDec.format(t.entrevistas / dias), dias + " dias uteis") +
    tile("Conv. por lead recebido", pct(t.cotas, t.leads), nfInt.format(t.leads) + " leads") +
    tile("Videochamada por lead", pct(t.entrevistas, t.leads), "entrevistas / leads") +
    tile("Deu bolo (no-show)", pct(t.bolo, t.vcAgendadas), nfInt.format(t.bolo) + " de " + nfInt.format(t.vcAgendadas) + " agendadas") +
    tile("Valorizados", nfInt.format(t.valorizados), "passaram por Valorizado");
}

function renderHero(t, meta){
  $("peHero").textContent = money(t.faturamento);
  $("peHeroNote").innerHTML = nfInt.format(t.cotas) + " cotas &middot; ticket medio " + moneyShort(t.ticket);
  var p = meta ? t.faturamento * 100 / meta : 0;
  var fill = $("peMeterFill");
  fill.style.width = Math.min(100, p).toFixed(1) + "%";
  fill.style.background = p >= 100 ? "var(--good)" : "var(--series-1)";
  $("peMetaTxt").textContent = "Meta " + moneyShort(meta);
  $("peMetaPct").textContent = nfDec.format(p) + "% atingido";
}

function renderBarras(elId, linhas, campo, fmt, tipFn){
  var el = $(elId);
  var dados = linhas.slice().sort(function(a,b){ return b[campo] - a[campo]; })
    .filter(function(r){ return r[campo] > 0; })
    .slice(0, CFG.TOP_BARRAS);
  if (!dados.length) { el.innerHTML = '<div class="empty">Sem dados no periodo selecionado.</div>'; return; }
  var max = dados[0][campo] || 1;
  el.innerHTML = "";
  dados.forEach(function(r){
    var row = document.createElement("div");
    row.className = "barRow";
    row.innerHTML =
      '<div class="barName" title="' + esc(r.nome) + '">' + esc(r.nome) + '</div>' +
      '<div class="barTrack"><div class="barFill" style="width:' +
        Math.max(0.6, r[campo] * 100 / max).toFixed(2) + '%"></div></div>' +
      '<div class="barVal">' + fmt(r[campo]) + '</div>';
    bindTip(row, tipFn(r));
    el.appendChild(row);
  });
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
  el.innerHTML = "";
  etapas.forEach(function(e, i){
    var row = document.createElement("div");
    row.className = "fRow";
    row.innerHTML =
      '<div class="fName">' + esc(e.n) + '</div>' +
      '<div><div class="fBar" style="width:' + Math.max(0.6, e.v * 100 / max).toFixed(2) + '%;background:' + e.c + '"></div></div>' +
      '<div class="fVal">' + nfInt.format(e.v) + '<small>' + pct(e.v, base) + '</small></div>';
    var ant = i > 0 ? etapas[i-1] : null;
    bindTip(row, "<b>" + esc(e.n) + "</b>" + nfInt.format(e.v) + " no periodo<br>" +
      pct(e.v, base) + " dos leads recebidos" +
      (ant ? "<br>" + pct(e.v, ant.v) + " da etapa anterior (" + esc(ant.n) + ")" : ""));
    el.appendChild(row);
  });
}

/* ---- tabelas ordenaveis ---- */
var COLS_VEND = [
  { k:"nome",        t:"Vendedor",       txt:true,  f:function(r){ return esc(r.nome); } },
  { k:"equipe",      t:"Equipe",         txt:true,  f:function(r){ return '<span class="pill">' + esc(r.equipe) + '</span>'; } },
  { k:"leads",       t:"Leads",          f:function(r){ return nfInt.format(r.leads); },        sum:"int" },
  { k:"vcAgendadas", t:"V.C. agend.",    f:function(r){ return nfInt.format(r.vcAgendadas); },  sum:"int" },
  { k:"entrevistas", t:"Entrevistas",    f:function(r){ return nfInt.format(r.entrevistas); },  sum:"int" },
  { k:"bolo",        t:"Deu bolo",       f:function(r){ return nfInt.format(r.bolo); },         sum:"int" },
  { k:"valorizados", t:"Valorizados",    f:function(r){ return nfInt.format(r.valorizados); },  sum:"int" },
  { k:"indicacoes",  t:"Indicacoes",     f:function(r){ return nfInt.format(r.indicacoes); },   sum:"int" },
  { k:"cotas",       t:"Cotas vend.",    f:function(r){ return nfInt.format(r.cotas); },        sum:"int" },
  { k:"faturamento", t:"Faturamento",    f:function(r){ return money(r.faturamento); },         sum:"money" },
  { k:"ticket",      t:"Ticket medio",   f:function(r){ return r.cotas ? money(r.ticket) : "-"; },  sum:"calcTicket" },
  { k:"txConv",      t:"Tx. conversao",  f:function(r){ return r.entrevistas ? nfDec.format(r.txConv*100) + "%" : "-"; }, sum:"calcTxConv" },
  { k:"venda10vc",   t:"Venda/10 V.C.",  f:function(r){ return r.entrevistas ? nfDec.format(r.venda10vc) : "-"; },        sum:"calcV10" },
  { k:"convLead",    t:"% conv. lead",   f:function(r){ return r.leads ? nfDec.format(r.convLead*100) + "%" : "-"; },     sum:"calcConvLead" },
  { k:"vcPorLead",   t:"V.C./lead",      f:function(r){ return r.leads ? nfDec.format(r.vcPorLead*100) + "%" : "-"; },    sum:"calcVcLead" }
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
  var tbl = $(tblId);
  var st = sortState[tblId] || (sortState[tblId] = { k: defaultSort, dir: "desc" });

  var arr = linhas.slice().sort(function(a, b){
    var x = a[st.k], y = b[st.k], s;
    if (typeof x === "string" || typeof y === "string") s = String(x).localeCompare(String(y), "pt-BR");
    else s = (x || 0) - (y || 0);
    return st.dir === "asc" ? s : -s;
  });

  tbl.tHead.innerHTML = "<tr>" + cols.map(function(c){
    return '<th class="' + (c.txt ? "txt" : "") + '"' + (c.k === st.k ? ' data-dir="' + st.dir + '"' : "") +
           ' data-k="' + c.k + '">' + esc(c.t) + '</th>';
  }).join("") + "</tr>";

  tbl.tBodies[0].innerHTML = arr.length
    ? arr.map(function(r){
        return "<tr>" + cols.map(function(c){
          return '<td class="' + (c.txt ? "txt" : "") + '">' + c.f(r) + "</td>";
        }).join("") + "</tr>";
      }).join("")
    : '<tr><td class="txt" colspan="' + cols.length + '"><div class="empty">Sem dados no periodo.</div></td></tr>';

  /* rodape com totais */
  var t = agregar(arr);
  t.vendedores = arr.reduce(function(a, r){ return a + (r.vendedores || 1); }, 0);
  var footMap = {
    int:  function(c){ return nfInt.format(t[c.k] || 0); },
    money:function(c){ return money(t[c.k] || 0); },
    calcTicket:  function(){ return t.cotas ? money(t.ticket) : "-"; },
    calcTxConv:  function(){ return t.entrevistas ? nfDec.format(t.txConv*100) + "%" : "-"; },
    calcV10:     function(){ return t.entrevistas ? nfDec.format(t.venda10vc) : "-"; },
    calcConvLead:function(){ return t.leads ? nfDec.format(t.convLead*100) + "%" : "-"; },
    calcVcLead:  function(){ return t.leads ? nfDec.format(t.vcPorLead*100) + "%" : "-"; },
    calcEpV:     function(){ return t.cotas ? nfDec.format(t.entrevPorVenda) : "-"; }
  };
  tbl.tFoot.innerHTML = "<tr>" + cols.map(function(c, i){
    if (i === 0) return '<td class="txt">TOTAL (' + arr.length + ")</td>";
    var fn = c.sum && footMap[c.sum];
    return '<td class="' + (c.txt ? "txt" : "") + '">' + (fn ? fn(c) : "") + "</td>";
  }).join("") + "</tr>";

  tbl.tHead.querySelectorAll("th").forEach(function(th){
    th.onclick = function(){
      var k = th.getAttribute("data-k");
      if (st.k === k) st.dir = st.dir === "desc" ? "asc" : "desc";
      else { st.k = k; st.dir = "desc"; }
      renderTabela(tblId, cols, linhas, defaultSort);
    };
  });
}

/* =====================================================================
   9. ORQUESTRACAO
   ===================================================================== */
function aplicarFiltros(linhas){
  var eq = $("peEquipe").value;
  var q  = ($("peBusca").value || "").trim().toLowerCase();
  return linhas.filter(function(r){
    if (eq && r.equipe !== eq) return false;
    if (q && r.nome.toLowerCase().indexOf(q) < 0) return false;
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

  renderBarras("peChartEntrev", linhas, "entrevistas", function(v){ return nfInt.format(v); }, function(r){
    return "<b>" + esc(r.nome) + "</b>" + esc(r.equipe) + "<br>" +
      nfInt.format(r.entrevistas) + " entrevistas &middot; " + nfInt.format(r.vcAgendadas) + " agendadas<br>" +
      nfInt.format(r.cotas) + " cotas &middot; tx. conversao " + (r.entrevistas ? nfDec.format(r.txConv*100) + "%" : "-");
  });
  renderBarras("peChartFat", linhas, "faturamento", moneyShort, function(r){
    return "<b>" + esc(r.nome) + "</b>" + esc(r.equipe) + "<br>" +
      money(r.faturamento) + " em " + nfInt.format(r.cotas) + " cotas<br>" +
      "Ticket medio " + (r.cotas ? money(r.ticket) : "-");
  });

  renderTabela("peTblVend", COLS_VEND, linhas, "faturamento");

  /* equipes */
  var porEq = {};
  linhas.forEach(function(r){
    var e = porEq[r.equipe] || (porEq[r.equipe] = { nome: r.equipe, vendedores: 0,
      leads:0, vcAgendadas:0, entrevistas:0, bolo:0, valorizados:0, propostas:0,
      indicacoes:0, cotas:0, faturamento:0, mensagens:0, ligacoes:0 });
    e.vendedores++;
    ["leads","vcAgendadas","entrevistas","bolo","valorizados","propostas","indicacoes","cotas","faturamento","mensagens","ligacoes"]
      .forEach(function(k){ e[k] += r[k] || 0; });
  });
  var eqLinhas = Object.keys(porEq).map(function(k){
    var e = porEq[k];
    e.ticket   = e.cotas ? e.faturamento / e.cotas : 0;
    e.txConv   = e.entrevistas ? e.cotas / e.entrevistas : 0;
    e.convLead = e.leads ? e.cotas / e.leads : 0;
    return e;
  });
  renderTabela("peTblEq", COLS_EQ, eqLinhas, "faturamento");

  /* supervisores */
  var sup = linhas.filter(function(r){ return /supervisor/i.test(r.cargo || ""); });
  renderTabela("peTblSup", COLS_SUP, sup, "faturamento");

  /* aviso sobre campos manuais */
  var temManual = LAST.linhas.some(function(r){ return r.mensagens > 0 || r.ligacoes > 0; });
  $("peAviso").innerHTML =
    "<b>Sobre Mensagens e Ligacoes:</b> este webhook nao tem permissao de telefonia " +
    "(<code>telephony</code>) nem metodo REST para listar sessoes de canais abertos, entao " +
    (temManual
      ? "as colunas usam os campos manuais do relatorio diario do negocio."
      : "esses dois indicadores <b>nao aparecem</b> aqui. Os campos manuais do relatorio diario " +
        "(<i>Mensagens</i>, <i>Ligacoes</i>) estao praticamente vazios no CRM. Para exibi-los: " +
        "(a) passe a preencher esses campos nos negocios, ou (b) libere o escopo <code>telephony</code> " +
        "no webhook e me avise que eu somo as chamadas reais.") +
    " Os demais numeros vem do funil e do historico de etapas.";

  setStatus("Periodo " + LAST.de.split("-").reverse().join("/") + " a " + LAST.ate.split("-").reverse().join("/") +
            " · " + linhas.length + " vendedores · " + LAST.dias + " dias uteis");
}

function atualizar(){
  var de = $("peDe").value, ate = $("peAte").value;
  if (!de || !ate) { setStatus("Informe as datas."); return; }
  if (de > ate) { setStatus("A data inicial e maior que a final."); return; }
  $("peGo").disabled = true;
  carregarFatos(de, ate)
    .then(function(dados){
      setStatus("Calculando indicadores...");
      LAST = calcular(dados, de, ate);
      pintar();
    })
    .catch(function(e){ setStatus("Erro: " + e.message); console.error(e); })
    .then(function(){ $("peGo").disabled = false; });
}

/* ---- presets de periodo ---- */
function setPeriodo(p){
  var h = new Date(), de, ate = new Date(h);
  if (p === "hoje")        { de = new Date(h); }
  else if (p === "7")      { de = new Date(h); de.setDate(de.getDate() - 6); }
  else if (p === "30")     { de = new Date(h); de.setDate(de.getDate() - 29); }
  else if (p === "mesant") { de = new Date(h.getFullYear(), h.getMonth() - 1, 1);
                             ate = new Date(h.getFullYear(), h.getMonth(), 0); }
  else if (p === "ano")    { de = new Date(h.getFullYear(), 0, 1); }
  else                     { de = new Date(h.getFullYear(), h.getMonth(), 1); }
  $("peDe").value = iso(de);
  $("peAte").value = iso(ate);
}

/* ---- CSV ---- */
function exportarCsv(){
  if (!LAST) return;
  var linhas = aplicarFiltros(LAST.linhas);
  var head = ["Vendedor","Equipe","Leads","V.C. agendadas","Entrevistas","Deu bolo","Valorizados",
              "Indicacoes","Cotas vendidas","Faturamento","Ticket medio","Tx. conversao %",
              "Venda/10 V.C.","% conv. lead","V.C./lead %"];
  var rows = linhas.map(function(r){
    return [r.nome, r.equipe, r.leads, r.vcAgendadas, r.entrevistas, r.bolo, r.valorizados,
            r.indicacoes, r.cotas,
            r.faturamento.toFixed(2).replace(".", ","),
            r.ticket.toFixed(2).replace(".", ","),
            (r.txConv*100).toFixed(2).replace(".", ","),
            r.venda10vc.toFixed(2).replace(".", ","),
            (r.convLead*100).toFixed(2).replace(".", ","),
            (r.vcPorLead*100).toFixed(2).replace(".", ",")];
  });
  var csv = "\uFEFF" + [head].concat(rows).map(function(r){
    return r.map(function(c){ return '"' + String(c).replace(/"/g,'""') + '"'; }).join(";");
  }).join("\r\n");
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = "vendedores_" + LAST.de + "_a_" + LAST.ate + ".csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* =====================================================================
   10. BOOT
   ===================================================================== */
$("pePresets").addEventListener("click", function(e){
  var b = e.target.closest("[data-p]");
  if (!b) return;
  $("pePresets").querySelectorAll(".chip").forEach(function(c){ c.setAttribute("aria-pressed", "false"); });
  b.setAttribute("aria-pressed", "true");
  setPeriodo(b.getAttribute("data-p"));
  atualizar();
});
["peDe","peAte"].forEach(function(id){
  $(id).addEventListener("change", function(){
    $("pePresets").querySelectorAll(".chip").forEach(function(c){ c.setAttribute("aria-pressed", "false"); });
  });
});
$("peGo").addEventListener("click", atualizar);
$("peCsv").addEventListener("click", exportarCsv);
$("peEquipe").addEventListener("change", pintar);
$("peBusca").addEventListener("input", pintar);

setPeriodo("mes");
carregarDimensoes()
  .then(atualizar)
  .catch(function(e){ setStatus("ERRO: " + e.message); console.error(e); });

})();