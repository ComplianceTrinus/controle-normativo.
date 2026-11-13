'use strict';
// Camada de dados: converte entre o formato usado pela tela (camelCase)
// e as tabelas do PostgreSQL (snake_case), e aplica as regras de gravação.
const fs = require('fs');
const path = require('path');
const { q, tx } = require('./db');
const { config } = require('./config');

const CARIMBO = { criadoEm: 'criado_em', criadoPor: 'criado_por', atualizadoEm: 'atualizado_em', atualizadoPor: 'atualizado_por' };

const COLECOES = {
  normas: {
    tabela: 'normas',
    campos: {
      orgao: 'orgao', tipo: 'tipo', numero: 'numero', chave: 'chave',
      dataPublicacao: 'data_publicacao', vigencia: 'vigencia', prazoAdequacao: 'prazo_adequacao',
      ementa: 'ementa', tema: 'tema', link: 'link', status: 'status', criticidade: 'criticidade', criteriosRisco: 'criterios_risco',
      responsavel: 'responsavel', area: 'area', observacoes: 'observacoes', origem: 'origem',
      triadaEm: 'triada_em', analisadaEm: 'analisada_em', ...CARIMBO,
    },
    datas: ['dataPublicacao', 'vigencia', 'prazoAdequacao', 'triadaEm', 'analisadaEm'],
    obrigatorios: ['orgao', 'tipo', 'numero', 'chave', 'ementa'],
    listar: `SELECT * FROM normas ORDER BY data_publicacao DESC NULLS LAST, id`,
  },
  acoes: {
    tabela: 'acoes',
    campos: {
      normaId: 'norma_id', descricao: 'descricao', gap: 'gap', responsavel: 'responsavel', area: 'area',
      prazo: 'prazo', status: 'status', observacoes: 'observacoes', concluidaEm: 'concluida_em', ...CARIMBO,
    },
    datas: ['prazo', 'concluidaEm'],
    referencias: ['normaId'],
    obrigatorios: ['descricao'],
    listar: `SELECT a.*, COALESCE(
               json_agg(json_build_object('id', e.id, 'nome', e.nome, 'tamanho', e.tamanho,
                        'em', e.enviado_em, 'por', e.enviado_por) ORDER BY e.enviado_em)
               FILTER (WHERE e.id IS NOT NULL), '[]') AS evidencias
             FROM acoes a LEFT JOIN evidencias e ON e.acao_id = a.id
             GROUP BY a.id ORDER BY a.prazo NULLS LAST, a.id`,
  },
  obrigacoes: {
    tabela: 'obrigacoes',
    campos: {
      titulo: 'titulo', orgao: 'orgao', periodicidade: 'periodicidade', proximoVencimento: 'proximo_vencimento',
      canal: 'canal', normaId: 'norma_id', responsavel: 'responsavel', area: 'area', descricao: 'descricao',
      ultimoEnvio: 'ultimo_envio', concluida: 'concluida', ...CARIMBO,
    },
    datas: ['proximoVencimento', 'ultimoEnvio'],
    referencias: ['normaId'],
    obrigatorios: ['titulo', 'orgao', 'periodicidade'],
    listar: `SELECT o.*, COALESCE(
               (SELECT json_agg(json_build_object('data', v.data, 'vencimento', v.vencimento, 'obs', v.obs, 'por', v.por)
                                ORDER BY v.data DESC, v.id DESC)
                  FROM obrigacao_envios v WHERE v.obrigacao_id = o.id), '[]') AS historico
             FROM obrigacoes o ORDER BY o.proximo_vencimento NULLS LAST, o.id`,
  },
};

const ID_VALIDO = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

class ErroValidacao extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

function deLinha(col, linha) {
  const def = COLECOES[col];
  const doc = { id: linha.id };
  for (const [campo, coluna] of Object.entries(def.campos)) {
    let v = linha[coluna];
    if (v instanceof Date) v = v.toISOString();
    if (v == null) v = (campo === 'criadoPor' || campo === 'atualizadoPor') ? null : (campo === 'concluida' ? false : '');
    doc[campo] = v;
  }
  if (col === 'acoes') doc.evidencias = (linha.evidencias || []).map(e => ({ ...e, em: e.em && new Date(e.em).toISOString() }));
  if (col === 'obrigacoes') doc.historico = linha.historico || [];
  return doc;
}

function paraColunas(col, dados) {
  const def = COLECOES[col];
  const out = {};
  for (const [campo, v0] of Object.entries(dados)) {
    const coluna = def.campos[campo];
    if (!coluna || campo in CARIMBO) continue; // carimbos são definidos pelo servidor
    let v = v0;
    if (typeof v === 'string') v = v.trim();
    if ((def.datas || []).includes(campo)) {
      if (v === '' || v == null) v = null;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ErroValidacao(`Data inválida em "${campo}".`);
    }
    if ((def.referencias || []).includes(campo) && (v === '' || v == null)) v = null;
    if (campo === 'concluida') v = !!v;
    if (typeof v === 'string' && v.length > 20000) throw new ErroValidacao(`Texto muito longo em "${campo}".`);
    out[coluna] = v;
  }
  return out;
}

async function listar(col) {
  const def = COLECOES[col];
  const r = await q(def.listar);
  return r.rows.map(l => deLinha(col, l));
}

async function obter(col, id, c = { query: q }) {
  const r = await c.query(`SELECT * FROM ${COLECOES[col].tabela} WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

// "set": cria o documento (ou substitui, mantendo os carimbos de criação)
async function gravar(col, id, dados, usuario) {
  if (!COLECOES[col]) throw new ErroValidacao('Coleção desconhecida.', 404);
  if (!ID_VALIDO.test(id)) throw new ErroValidacao('Identificador inválido.');
  const def = COLECOES[col];
  for (const k of def.obrigatorios) if (!String(dados[k] ?? '').trim()) throw new ErroValidacao(`Campo obrigatório ausente: ${k}.`);
  const cols = paraColunas(col, dados);
  const agora = new Date();
  return tx(async c => {
    const existe = await obter(col, id, c);
    cols.atualizado_em = agora; cols.atualizado_por = usuario.id;
    if (existe) {
      await atualizarLinha(c, def.tabela, id, cols);
    } else {
      cols.criado_em = agora; cols.criado_por = usuario.id;
      const nomes = Object.keys(cols);
      await c.query(
        `INSERT INTO ${def.tabela} (id, ${nomes.join(', ')}) VALUES ($1, ${nomes.map((_, i) => '$' + (i + 2)).join(', ')})`,
        [id, ...nomes.map(n => cols[n])]);
    }
    await sincronizarFilhos(c, col, id, dados, usuario);
  });
}

// "update": mescla campos em um documento existente
async function atualizar(col, id, dados, usuario) {
  if (!COLECOES[col]) throw new ErroValidacao('Coleção desconhecida.', 404);
  const def = COLECOES[col];
  const cols = paraColunas(col, dados);
  for (const k of def.obrigatorios) {
    const coluna = def.campos[k];
    if (coluna in cols && !String(cols[coluna] ?? '').trim()) throw new ErroValidacao(`Campo obrigatório vazio: ${k}.`);
  }
  return tx(async c => {
    const existe = await obter(col, id, c);
    if (!existe) throw new ErroValidacao('Registro não encontrado. Ele pode ter sido excluído por outra pessoa.', 404);
    cols.atualizado_em = new Date(); cols.atualizado_por = usuario.id;
    await atualizarLinha(c, def.tabela, id, cols);
    await sincronizarFilhos(c, col, id, dados, usuario);
  });
}

async function atualizarLinha(c, tabela, id, cols) {
  const nomes = Object.keys(cols);
  if (!nomes.length) return;
  await c.query(`UPDATE ${tabela} SET ${nomes.map((n, i) => `${n} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...nomes.map(n => cols[n])]);
}

// Evidências (ações) e histórico de envios (obrigações) ficam em tabelas próprias
async function sincronizarFilhos(c, col, id, dados, usuario) {
  if (col === 'acoes' && Array.isArray(dados.evidencias)) {
    const ids = dados.evidencias.map(e => String(e && e.id || '')).filter(Boolean);
    const atuais = (await c.query('SELECT id FROM evidencias WHERE acao_id = $1', [id])).rows.map(r => r.id);
    const removidas = atuais.filter(x => !ids.includes(x));
    if (removidas.length && usuario.perfil !== 'Admin') throw new ErroValidacao('Somente o perfil Admin remove evidências.', 403);
    if (ids.length) {
      await c.query('UPDATE evidencias SET acao_id = $1 WHERE id = ANY($2) AND (acao_id IS NULL OR acao_id = $1)', [id, ids]);
    }
    if (removidas.length) {
      await c.query('DELETE FROM evidencias WHERE id = ANY($1)', [removidas]);
      removidas.forEach(apagarArquivo);
    }
  }
  if (col === 'obrigacoes' && Array.isArray(dados.historico) && dados.historico.length) {
    // O histórico só cresce: grava o envio mais recente, se ainda não existir.
    const novo = dados.historico[0] || {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(novo.data || '')) {
      const venc = /^\d{4}-\d{2}-\d{2}$/.test(novo.vencimento || '') ? novo.vencimento : null;
      const ja = await c.query(
        'SELECT 1 FROM obrigacao_envios WHERE obrigacao_id = $1 AND data = $2 AND vencimento IS NOT DISTINCT FROM $3',
        [id, novo.data, venc]);
      if (!ja.rowCount) {
        await c.query('INSERT INTO obrigacao_envios (obrigacao_id, data, vencimento, obs, por) VALUES ($1, $2, $3, $4, $5)',
          [id, novo.data, venc, String(novo.obs || '').slice(0, 1000), usuario.id]);
      }
    }
  }
}

async function excluir(col, id) {
  if (!COLECOES[col]) throw new ErroValidacao('Coleção desconhecida.', 404);
  if (col === 'acoes') {
    const ev = (await q('SELECT id FROM evidencias WHERE acao_id = $1', [id])).rows.map(r => r.id);
    await q('DELETE FROM acoes WHERE id = $1', [id]);
    ev.forEach(apagarArquivo);
    return;
  }
  await q(`DELETE FROM ${COLECOES[col].tabela} WHERE id = $1`, [id]);
}

function apagarArquivo(id) {
  fs.unlink(path.join(config.uploadDir, id), () => {});
}

// ---- Auditoria (somente inclusão) ----
async function listarAuditoria(limite = 300) {
  const r = await q('SELECT * FROM auditoria ORDER BY em DESC LIMIT $1', [Math.min(Number(limite) || 300, 1000)]);
  return r.rows.map(l => ({ id: l.id, em: l.em.toISOString(), por: l.por, acao: l.acao, tipo: l.tipo, ref: l.ref || '', detalhe: l.detalhe || '' }));
}

async function registrarAuditoria({ acao, tipo, ref, detalhe }, usuarioId, c = { query: q }) {
  const id = require('crypto').randomUUID();
  await c.query('INSERT INTO auditoria (id, por, acao, tipo, ref, detalhe) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, usuarioId, String(acao || '').slice(0, 60), String(tipo || '').slice(0, 60), String(ref || '').slice(0, 200), String(detalhe || '').slice(0, 2000)]);
}

// ---- Sistema (estado da captura, configurações) ----
async function lerSistema(id) {
  const r = await q('SELECT dados FROM sistema WHERE id = $1', [id]);
  return r.rows[0] ? r.rows[0].dados : null;
}
async function gravarSistema(id, dados, c = { query: q }) {
  await c.query(`INSERT INTO sistema (id, dados, atualizado_em) VALUES ($1, $2, now())
                 ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados, atualizado_em = now()`, [id, dados]);
}

// ---- Áreas da empresa (lista cuidada pelo Admin na tela de Usuários) ----
const AREAS_PADRAO = ['Tesouraria', 'Operações', 'Tecnologia', 'Compliance', 'Riscos', 'Jurídico', 'Pessoas', 'Contabilidade', 'Gestão'];
// Compara áreas sem diferenciar maiúsculas, acentos e espaços nas pontas
const normArea = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
async function listarAreas() {
  const d = await lerSistema('areas');
  return d && Array.isArray(d.lista) && d.lista.length ? d.lista : AREAS_PADRAO;
}

module.exports = {
  AREAS_PADRAO, normArea, listarAreas,
  COLECOES, ErroValidacao, listar, gravar, atualizar, excluir,
  listarAuditoria, registrarAuditoria, lerSistema, gravarSistema, deLinha, paraColunas,
};
