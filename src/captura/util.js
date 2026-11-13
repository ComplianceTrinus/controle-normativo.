'use strict';
// Funções comuns da captura: normalização, datas no fuso de Brasília e HTTP com proxy corporativo.

const FUSO = 'America/Sao_Paulo';

function semAcento(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Mesma regra da tela: órgão|tipo|só dígitos do número
function chave(orgao, tipo, numero) {
  return semAcento(orgao) + '|' + semAcento(tipo) + '|' + semAcento(numero).replace(/[^a-z0-9_]/g, '');
}

const numeroComPonto = n => Number(n).toLocaleString('pt-BR', { useGrouping: true, maximumFractionDigits: 0 });

// Data (AAAA-MM-DD) de um instante, no fuso de Brasília
const dataSP = (d = new Date()) => new Date(d).toLocaleDateString('sv-SE', { timeZone: FUSO });

function somarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// dd/mm/aaaa -> aaaa-mm-dd
function brParaIso(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

const limpa = s => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

let proxyConfigurado = false;
function configurarProxy() {
  if (proxyConfigurado) return;
  proxyConfigurado = true;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log('[captura] usando proxy corporativo do ambiente');
  }
}

const UA = 'ControleNormativo/1.0 (+compliance; captura diaria de normas)';

async function buscar(url, { tipo = 'text', tentativas = 3, timeoutMs = 30000 } = {}) {
  configurarProxy();
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: tipo === 'json' ? 'application/json' : 'text/html,*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} em ${new URL(url).host}`);
      return tipo === 'json' ? await r.json() : await r.text();
    } catch (err) {
      ultimo = err;
      await new Promise(ok => setTimeout(ok, 2000 * (i + 1)));
    }
  }
  throw ultimo;
}

module.exports = { FUSO, semAcento, chave, numeroComPonto, dataSP, somarDias, brParaIso, limpa, buscar };
