/* Camada de acesso ao servidor do Controle Normativo.
   Expõe window.claude.use(nome) com a mesma interface que a página usava no piloto
   (db, user, assets, downloads), agora apoiada na API REST deste servidor. */
(function () {
  'use strict';
  var INTERVALO = 15000; // atualização automática das listas (ms)
  var CAB = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };

  function erro(code, message) { return { code: code, message: message }; }

  async function chamar(metodo, url, corpo) {
    var r;
    try {
      r = await fetch(url, { method: metodo, headers: CAB, credentials: 'same-origin', body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    } catch (e) { throw erro('unavailable', 'Sem conexão com o servidor.'); }
    if (r.status === 401) { location.href = '/auth/login'; throw erro('unavailable', 'Sessão expirada.'); }
    var j = null;
    try { j = await r.json(); } catch (e) { /* sem corpo */ }
    if (!r.ok) {
      var code = r.status >= 500 ? 'unavailable' : 'invalid_argument';
      throw erro(code, (j && j.erro) || ('Erro ' + r.status));
    }
    return j;
  }

  // ---- assinaturas com atualização periódica ----
  var assinaturas = new Map();
  function assinar(chave, buscar, prox, falha) {
    var a = assinaturas.get(chave);
    if (!a) { a = { buscar: buscar, ouvintes: new Set(), timer: null }; assinaturas.set(chave, a); }
    var o = { prox: prox, falha: falha };
    a.ouvintes.add(o);
    atualizar(chave);
    if (!a.timer) a.timer = setInterval(function () { atualizar(chave); }, INTERVALO);
    return function () {
      a.ouvintes.delete(o);
      if (!a.ouvintes.size) { clearInterval(a.timer); assinaturas.delete(chave); }
    };
  }
  async function atualizar(chave) {
    var a = assinaturas.get(chave);
    if (!a) return;
    try { var v = await a.buscar(); a.ouvintes.forEach(function (o) { o.prox(v); }); }
    catch (e) { if (e && e.code !== 'unavailable') a.ouvintes.forEach(function (o) { o.falha && o.falha(e); }); }
  }
  function atualizarTudo() { var ps = []; assinaturas.forEach(function (_, k) { ps.push(atualizar(k)); }); return Promise.all(ps); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) atualizarTudo(); });

  function snapLista(linhas) {
    return {
      docs: linhas.map(function (l) { var id = l.id; var d = Object.assign({}, l); delete d.id; return { id: id, exists: true, data: function () { return d; } }; }),
      size: linhas.length, empty: !linhas.length,
    };
  }
  function snapDoc(id, d) { return { id: id, exists: !!d, data: function () { return d || undefined; } }; }
  function novoId() {
    return (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(16) + Math.random().toString(16).slice(2)).replace(/-/g, '');
  }

  function refDoc(caminho) {
    var p = caminho.split('/'); var col = p[0]; var id = p[1];
    var base = col === 'sistema' ? '/api/sistema/' + encodeURIComponent(id) : '/api/c/' + col + '/' + encodeURIComponent(id);
    return {
      id: id, path: caminho,
      get: async function () {
        if (col === 'sistema') { var r = await chamar('GET', base); return snapDoc(id, r && r.dados); }
        var lista = await chamar('GET', '/api/c/' + col);
        var achado = lista.find(function (x) { return x.id === id; });
        return snapDoc(id, achado);
      },
      // espera a lista recarregar antes de devolver, para a tela já mostrar o dado salvo
      set: async function (d) { await chamar('PUT', base, d); await atualizarTudo(); },
      update: async function (d) { await chamar('PATCH', base, d); await atualizarTudo(); },
      delete: async function () { await chamar('DELETE', base); await atualizarTudo(); },
      onSnapshot: function (prox, falha) {
        return assinar('d:' + caminho, async function () {
          if (col !== 'sistema') return (await refDoc(caminho).get());
          var r = await chamar('GET', base); return snapDoc(id, r && r.dados);
        }, prox, falha);
      },
    };
  }

  function refColecao(col, opcoes) {
    opcoes = opcoes || {};
    var url = '/api/c/' + col + (opcoes.limite ? '?limit=' + opcoes.limite : '');
    var ref = {
      path: col,
      orderBy: function () { return refColecao(col, opcoes); },
      where: function () { return ref; },
      limit: function (n) { return refColecao(col, Object.assign({}, opcoes, { limite: n })); },
      doc: function (id) { return refDoc(col + '/' + (id || novoId())); },
      add: async function (d) {
        if (col === 'auditoria') { await chamar('POST', '/api/c/auditoria', d); atualizar('c:/api/c/auditoria?limit=300'); return refDoc('auditoria/' + novoId()); }
        var r = refDoc(col + '/' + novoId()); await r.set(d); return r;
      },
      get: async function () { return snapLista(await chamar('GET', url)); },
      onSnapshot: function (prox, falha) { return assinar('c:' + url, async function () { return snapLista(await chamar('GET', url)); }, prox, falha); },
    };
    return ref;
  }

  var db = { doc: refDoc, collection: refColecao };

  // ---- usuário e perfil (vem do login corporativo) ----
  var mePromessa = null;
  function eu() { return mePromessa || (mePromessa = chamar('GET', '/api/me')); }
  var nomes = {};
  var user = {
    me: async function () { var m = await eu(); return { id: m.id, name: m.nome, email: m.email, avatarUrl: '', color: '#0B5D57', isOwner: m.perfil === 'Admin', canEdit: m.perfil === 'Admin', perfil: m.perfil, modoLogin: m.modoLogin }; },
    id: async function () { return (await eu()).id; },
    isOwner: async function () { return (await eu()).perfil === 'Admin'; },
    canEdit: async function () { return (await eu()).perfil === 'Admin'; },
    can: async function (nome) {
      var m = await eu();
      if (nome === 'data.write') return m.perfil !== 'Leitura';
      if (nome === 'assets.write') return m.perfil === 'Admin';
      return false;
    },
    profiles: async function (ids) {
      var lista = Array.from(new Set([].concat(ids).filter(Boolean)));
      var faltam = lista.filter(function (i) { return !(i in nomes); });
      if (faltam.length) {
        try { var r = await chamar('GET', '/api/usuarios?ids=' + encodeURIComponent(faltam.join(','))); faltam.forEach(function (i) { nomes[i] = (r[i] && r[i].nome) || ''; }); }
        catch (e) { /* sem nomes */ }
      }
      var out = {};
      lista.forEach(function (i) { out[i] = { id: i, name: nomes[i] || '', avatarUrl: '', color: '#8A9690', email: null, isMe: false, guest: false }; });
      return out;
    },
    search: async function () { return []; },
  };

  // ---- evidências (arquivos) ----
  var assets = {
    upload: async function (arquivo, opcoes) {
      var fd = new FormData();
      fd.append('arquivo', arquivo, arquivo.name || 'arquivo');
      var r = await fetch('/api/evidencias', { method: 'POST', body: fd, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' });
      var j = {}; try { j = await r.json(); } catch (e) { /* vazio */ }
      if (!r.ok) throw erro(r.status === 413 ? 'too_large' : r.status === 415 ? 'unsupported_type' : 'upstream_error', j.erro || '');
      return j;
    },
    delete: async function (id) { return chamar('DELETE', '/api/evidencias/' + encodeURIComponent(id)); },
    list: async function () { return { assets: [], usage: {} }; },
  };

  // ---- downloads (exportação para Excel) ----
  var downloads = {
    save: async function (p) {
      var blob = p.data instanceof Blob ? p.data : new Blob([p.data], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = p.filename || 'arquivo';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return { status: 'saved' };
    },
  };

  window.CN_SERVIDOR = true;
  window.CN_executarCaptura = function () { return chamar('POST', '/api/captura/executar', {}); };
  window.claude = {
    use: async function (nome) {
      if (nome === 'db') return db;
      if (nome === 'user') return user;
      if (nome === 'downloads') return downloads;
      if (nome === 'assets') { try { var m = await eu(); return m.perfil === 'Leitura' ? null : assets; } catch (e) { return null; } }
      return null;
    },
  };
})();
