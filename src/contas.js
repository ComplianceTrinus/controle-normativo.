'use strict';
// Login próprio (AUTH_MODE=local): e-mail e senha, troca de senha e cadastro de usuários pelo Admin.
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { config } = require('./config');
const { q } = require('./db');
const { registrarAuditoria, listarAreas, gravarSistema, normArea } = require('./colecoes');

const scrypt = promisify(crypto.scrypt);
const PERFIS = ['Admin', 'Analista', 'Área responsável', 'Leitura'];
const SENHA_MIN = 10;
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MIN = 15;

// ---- senhas (scrypt, sal aleatório) ----
async function gerarHash(senha) {
  const sal = crypto.randomBytes(16);
  const h = await scrypt(senha, sal, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${sal.toString('base64')}$${h.toString('base64')}`;
}
async function conferir(senha, armazenado) {
  try {
    const [alg, N, r, p, sal, h] = String(armazenado).split('$');
    if (alg !== 'scrypt') return false;
    const esperado = Buffer.from(h, 'base64');
    const calc = await scrypt(senha, Buffer.from(sal, 'base64'), esperado.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(calc, esperado);
  } catch { return false; }
}
function senhaTemporaria() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(14), b => alfabeto[b % alfabeto.length]).join('');
}
function validarSenha(s) {
  if (typeof s !== 'string' || s.length < SENHA_MIN) return `A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`;
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'Use letras e números na senha.';
  return '';
}
const emailValido = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ---- primeiro administrador, a partir das variáveis ADMIN_EMAIL e ADMIN_SENHA_INICIAL ----
async function garantirPrimeiroAdmin() {
  if (config.authMode !== 'local') return;
  const existe = await q("SELECT 1 FROM usuarios WHERE senha_hash IS NOT NULL AND perfil = 'Admin' AND ativo LIMIT 1");
  if (existe.rowCount) return;
  const { adminEmail, adminSenhaInicial, adminNome } = config.local;
  if (!adminEmail || !adminSenhaInicial) {
    console.warn('[login] Nenhum administrador cadastrado. Defina ADMIN_EMAIL e ADMIN_SENHA_INICIAL e reinicie.');
    return;
  }
  const id = 'loc-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  await q(`INSERT INTO usuarios (id, nome, email, perfil, senha_hash, ativo, trocar_senha)
           VALUES ($1, $2, $3, 'Admin', $4, true, true)`, [id, adminNome, adminEmail, await gerarHash(adminSenhaInicial)]);
  await registrarAuditoria({ acao: 'Criou', tipo: 'Usuário', ref: adminEmail, detalhe: 'Primeiro administrador (variáveis de ambiente)' }, null);
  console.log(`[login] Administrador ${adminEmail} criado. Troca de senha exigida no primeiro acesso.`);
}

// ---- proteção simples por IP contra tentativas em massa ----
const porIp = new Map();
function limiteIp(ip) {
  const agora = Date.now();
  const r = porIp.get(ip) || { n: 0, desde: agora };
  if (agora - r.desde > 15 * 60e3) { r.n = 0; r.desde = agora; }
  r.n++; porIp.set(ip, r);
  return r.n <= 30;
}

// ---- token anti-CSRF dos formulários ----
function tokenCsrf(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}
function conferirCsrf(req) {
  const t = String(req.body && req.body._csrf || '');
  return !!req.session.csrf && t.length === req.session.csrf.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(req.session.csrf));
}

// ---- páginas (HTML simples, mesmo visual do sistema) ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAM8AAABACAYAAAC9ZyNSAAATOUlEQVR42u1de9Rd45n/Peec5DOCJEgYCeJ+S6nVMrRCxiUiCS3VahU1M7Q6pkOxhmGNXigtYxY1xCVB3IqyKB0ULTJGpKhMXGoiiDRUSoSQy/d955zf/HF+bzx5s/f5zjnf/i5J9rPWXuecffZ+b/v9vc/1fTZIHkFyAcklJO8j+Q2Sm8ARyaIOQ0455bQSGO9xdXqb5FSSXya5cQ6knHJKBk8HyQrJqj6XRUD6M8lpJI8iOTQHUk45fQqAGwWSsgD0PsnzSV5Ecn4EpHcEpCNzIOWUg4fcluTHAk7ZgWSs/p9IcjLJNxJEu5tyIOW0rgPo5wLEqyQfdwA5yV2zIcnxJK8m+WYCkG6UjpQDKad1BjhGcmuSn5BcIQDc4IDxw4R7NhCQJudAymldBk9Rn1dp8s+IfpPklTpXIjkgAUiHdQGkL5EckgMpp7UNPAVxn22k+5DkkfrvRw4Id5JscyAqBuBFot1hJK8hOS8C0gJxtBxIOa2V3Oc/NdF/T7Kkc6fIhE2Svwt+H3eP5UDKKec+5CjHfb5EsqD/j5JORJKzSG4TOFCC/lQPSNeSfCsBSFNzIOW0Nuk+MwWqgTo/huS7+m8eyT2TANQgkCYISDFH+pOAdEQOpJzWVN0ncJkj9N96+tyN5Bz9t4jkIfUA1ASQrkvgSB5Ig3Mg5bSmcp+C04FG6Dxl2j7WGRGsQdN4GpAmdgGkw0lulAMppzWN+xQduDYi+aCb3Ke7a6xJH1MSkDaqA6T5JKfkQMqpP3OfqzVZnwncJwDMcZppblJf7ABYaNFZmwakSQ0AKRftcurX3Kfkr9H3S9xknhqDrBtRD/WAdH1C0Op8nZ+Uc6SVfS7kM7qfcR8/wfX9LDeJ7ye5gS8ng/ChJCANFsepB6SJ6xqQ/MLWiiidU89wn8NjQOiawI1OINkeQnxI/nUjlriMgTRFxoUYSNelAMkyGqvVjr56bu77OJJ7ZdnXnDLkPu7aAKDxJBe7CO2dswZQg0CalAKktwSkw0muvzZNKidG703yYfW3qv5umQOob7jPtgncp1QHQHs5Meodkl/sKQB1kyO9SnJn3dsd/Wxr+b921bEbyS36QL8xkse4UKqwuZHaat/tvubUPe4zo55Y4gC0HcnZumdJbHDohS0WSUDaRCFCl5P8UG2b1kq7nFHkswnb1inuu1VvrfZu3Kc4/1ugIEp/JSs9NKcaFbp+LjQA/w5gKYB9AEw0s2rSQzCzMsmSmb0O4EAATwLYEMA9JL8d/u/JCWVmNLOKmVUEpIFq0yIAvwOwAkDYVtEqmEP7hwP4KwDV6P8hAAZH1/YGLQPQCYAAyjqocx35dO877jPZcZ+67N/dsx7Je9wqeF6SRagnOZD7fbKLzQuJTka3YlZ3/TvQJU7xVCW5a3dN9i1wnuuZTkflnKdvdZ+lehCTunoQkeVnsnuIV7jJXejJyeR0sMdc/cv1+fetTiYHnoMcGGParRfBE8TIfRRwe62AdJ0+fx70sNxo0D+4T5cmWQ8Qkj90E+sOt7GumDHQQ30bk7xMqbWCAh2+39gdHay/gaeXt+yvPNbWfmXaN8d9tmuG+yT4gr7rJtpj8ca6bnbec5vjSc6NHLfB2vYiyfVbdR7qvjbpbuPqgGd3XTNQn6Wkfoa2JxwWjX8p5ShEbVsv4WhL6mtKecWE/pZS7m/K4Vynr8UWnkHdsWjUqJTWdldHIUvuc40mx9PNiF4OQEc7AL5AclQWXEDf9yT5X24Cv0byUJI/INmpej+TFUeQTyUNPCMzWhELfbgaFxLCozYlOTThv+IawmGSFrBBssZuor6V6kVtoFlLkAaLALYFMBvA+gAON7Nfy5pVbgRAsrgdAOCXAIYBmAfgSDOb1Wg5fvLL8jcYwNkATpf1awWAqwCcD2BvAI/rtpPMbGoz9fj6VNchAA6Q9Wp7AMdrXOKxnAzgL7JoVgEUAbwOYJq3DMpZ+11Z6CrOCnqDmc1T3aMB7Adgc1cP9fmAmT0fzPEAvh1ZAIsAFgCYEiyQqrcNwMkANnP1FgG8pbqrQY8CcAyALwIYJUtlFcBCzYNfAbjXzFaQLJpZJWnSqs7hqrNN7afqfBPATaHOBp/BGLW74MbifjP7Q7guqQ36PgTAeADjAIwGMEJjZurb+wBeA/CUynzF198n3CfiQKPFGagspQc1sbHOi2hfk8Mz0MMkP+f2Hi3KSM8JutSzbJ1WhB2ybhz2S7n2RIlbN7tklEk0zbXxK3WuGxk9w+1SrvvE+cV+0WC/XiI5Po0Dub5+K+X+cni5QD0R0D2Dp1PK+UVKeoCC4yBna+t/o9Sh3QNbdIvDpug+E5st1A3mSCUbCVawr3extduLaKNJ3us6+SbJb7n/B5Kc7vScQd0xkbvwl+kSAVd0ManLuq5TD6CT5EKn54UxGKv/2l25nSTvjsJsOqNjuT6vj8Djywj1LnNOWw+e5dF14d6jNGZBJO10+cyrzjwf+hjojKS5EIEnqX3vkxzWBHgejcoJ/bglwdoantswJbCJn09ZfYmPuG8LxIW7BaAw+Ne2yn2icjZyk4QkT4ujgSMr2gay3C3R9Z2KGtg0gEafPw0rKcnduyuXu7Y85Qa/Uao6DhuD54A6elO9esKDnZLAecpRve0p4OmIrovb4cupOAAltTFce3LCQhdznrh9i5sEz2+jcsJY3BrVZ5o7G5J8znGSakrb/UJVcb/DOH3opJpCobV5RANwCWoe7X0BTEiLOkB6JEBFMuQSAIcDuEV/XU7yoiA7kxxgZlWV/2UAMwD8ALXIhccB7G9mp5vZ+yTbzKxDMXj/ovJON7PZ0nMqGeidVXzqva9XXsVd18j1q42z05WYUl45IboBGUWdVJ0OYDpf0PeK0zOCrhTOXykHcbUfGBGCjnIxgM9JTx0Q6Y1FHd4OUHK6qumeCmpRI/eETLiFFsJfqmrU6wBu1elzBSg2W5ZWk7KZnQDgMv31rxJHCmbWSXInkncBuFcK3gIAp5jZgWY2I5gdzSyssFPU6WlmNqUVA0Ed2kCD2xYNekxFXVfS4JcADG1ijCx6gL68EoD19Ll+D4dvFQAsBvAqgLkAljuwMLqWGpcLg3Lel859LdCjZKSourAsvzjcD+CrAD4DYBcZmL4H4CU3/uF5dgLYGsB5ZlYttd42GoBLARwH4AsADjOzB9MsLl0AyHTfWSQXiqudBGAoyedlSRusjlwL4Mdm9q7aEFbHsHPyZtRizl4GcKpWvyw4Tpgsl8hS0wlgK1lskqxt92nShQdQ0AT8qImFJtxXBvAsgDdUr7e23eItSRlRqHc2gAsATAewSOdGADgKwL/JQuj7HrjkJJLbm9ncPnQSh3EfD2CgxrAU9e98M7sg4d5nSU7VXDpaHCv0oxPA8SQvzcLvE3Sf/+mOXyJypp7otkEE+m+S+6eE4IT7LnZ6zh497X8g+Td19JWtGhy/NJ0n/H4i+KYaKCtLnecRkoPq1DlaLz6LY/uC/vFP3hHb2zqPq/NSp8f4/r3hnKWlaDNj0JuHJszDQAeWujd3suE+wecBoExyoJndpK3cVwBYIn/NVU6vqgYxTHWVFfFwtor7vpn9b8bimp+oRa1eg+tcOoTkO44zrtT1Glz5Tf6PSWb2iSaORfK6ZazzhDLfA3CsmS1VYv9yxIEHmNlLJL8jP08S19u7n/hG21L8mZ2acxUBreB8T52aV4tlgt8j4rBLADxT6kbof1UVzCV5m+TKc0k+1KzuE08cTZTN1KGHzOxKrQirgNLJtVsCmKrO3Wxm1/cEcJyhI3zWNRgI1K041qoSMSYLOAPNrKORKItuUkX13iYDzAAz60wAWLv6dT/JlwHs5kShMMG2jESkvqK3E3SzKoAdSf4EwEVmtjRpLDSHnpKztOn9PM1wn2XyQh/WrOUt4QFCFjgAeCSs9hFwDEAh0nNeAfCPOlcB1vh9Vi+on73VlzDxn25ALwttnOFA4ssY5gxMfWIz0OfjEcf2bT8XwEt6w+H3tX1/15DGzC++8hu2+djDUjdX4cB9XsuC+7jwix21mrUDeFKrfFxeENcuAjBW4P2mRI1iHz60LMHzgcJa2MvgWdxEvYu6KKtPyLlCfk/yERl2OmQ88Av1KB2e3iM5H8AcADMBPGZmLzs1oYKM2KnnPsvFfca3yH1CBMBYiQ8vAJgna1LViykCzkQA5zg9Z1aG/pz+QH21AHS0ADj048QoJ8lSOVCAqTgfT5LfbhhqfqFvALgcwCySD5EcE0CZCXic3+c1ALfp9Hmt+H1kCCCAQ3TvY/pdjCwuVcVqBT3nFjO7rqf0nHWQ1oq9OpqbZmZ/AvC3AB5yTtFgbKlGPi06B3XFmbjHA5hO8rzAGArZAXxl1EFL3CdwF8mbY9S5x7z8GvQcnbtZRoW1Rc/JqYcAJPFtvplNAHAEgAdkMSs4p7O3ZladoaPkIjwqAC4keaqZVQoZIry73KfgTJzDZSV5PhJfiuIsF2olWQbgODP7RCsM8+mSc7Q6jngzswfM7AgAOwGYiJob5E4Af3D6W4jmMGei9tzqZyS3KWUrXq7Ufb4p7nOomT3coN8nDOzBavATMtMWJWcGPWeC03POMLMXcnFtjaFOpIc8bST/UuqCG0AQLHmNgFHXFyOzPs3sXQAP6gj/DUXNxL6LFudjUYuhpAuXqgAYBODEQsbyZcHM5rTIfYIidrAa+kgo2uk5IwDcoE7cambX9mPg5Ik2VqfFCWMUfEt7RmJ5Wn6KkQB2aHSMlYqs7I724DOLt4Gb2WIzm21md5rZKTJcfRSZvsN8PqiUvXFjFe6zXyPcx5modwCwO2om6umR15tOz/mj03P6q0k66HvmLL5cR0XL0OcF+p4EkNPM7G6FvpQi/dUAlBQxfypqQbGVeoG5bvfqFgAmuGtDW34rC5y5XbPm9J6SdqXehZoLpuxEOQOwWakHZMuimc0heTuAfxD3+U1XDjf5FMaqgc+a2bzQGYlrF6CWSHG59JyPWwkD6gXuEhTNwWuRyTwrk/tcAH8GsIUbp2Au3o/kT83snBTwdSjr6ZkNRi0UNeH/TjpyTM+Z2V4uprKa8myXpT37Qs+Y1lexvO0HYJyAlQZWRibqR3W+TcAZj5o3GADO1IrQH/w59fwh/0HyC/JY76xj03Uxd5o4QNHMluFTC2o1IWTmbJK/0sujN9TEblP+78sB3O0Ud2uQ281U2R3On9MB4PMCa1XiXNUdFeVkGIlaBDkjzkUA7/Z0nrcpLiLaUt6wYG5H6UJdP8bJuSMUvUtFMfRKzusG8xnsmRCVXG8n6avu7QyN7CT9bCOZfjKMqg5tOKCBpJah/T+LIptDGS+ntHGf6Hqm7GJ9W1vB34jOV+vsqk3aSVpS3vRqtGM0lPmkovj3ILmDjv1JnuPSlVUTdtee29NZRnd0GToPTdnfHgb1YLdXfJBLQBeyff5Rq1Ghr1fuCPDvpWxP9ueqbhvvJusieKJF5xa3JTppS3e1zvlmwBP6OillC3bSNpBKysLn27CQ5PBCD3p2V7O8Rew0li0PcSbqpRLjfgTgIK/n9Ad/jhNDlgC4Q2JHR0L0riWYarluJ59lAbWdmq+gtrOzM0FXMeflr0ZGI8OqWyS6im8rmtmvAVyp+spRiq9K9LvgEuVX3TMsu7adbGZ/KfTwQAXdZwWAMSQPTYg6CCbqQ9Swx3XzRAe4s8zs+X4Wtxa2TpyP2o7Ltjq5C+rlG7A617dC5SZyJ1QyqJeN9jUsemb2IWrhLi9qQtO1k9ECQ5efrQDgDAB36fr2qE6mWT3N7J9Ry6U3IIppQxRVUHUWQbprSlrET9BWjGJv5bieKrY3Pc6jpc+dXKqfkSSHuzca3N4f9JwuxLfhJG+P3ouTRO0heUQDedu6I7Yl0ZYN5m0jybFNiG2XpZTxRgM64xAlo+9sIAPRPJLH6b5zUq65IyVvm8+Z/tUWcu+VleZsld3J1guKNQHsCGCW7PPjzew3wQcia9p3AFwD4Bkz25fko6g5S/8PtXCdT/p4b0hXMXkh9m571N5hNAq1xByMsrTMRc3J68W/QQBORS05iM/c+QGAq7XFoq6o6nwam6KWfTTOGDofwHXhnK4dqGs3j+r9GLVdux/Vq9f55nYD8PUoLqwEYKaZ3ZdWht8kqEl5DGqZWLd1Y/cBarkoHgBwl5l9qDm1OWqZUQdEqsB9ZvZc2gbEqM4DxP32RS0XxcYOD+2ypr0O4GkAD5vZi/GWhN58w0LgPk86o0L4L7zD5zQdIQni59eEPMj56wqzyx0to9AwHW1Z75hNyWjapgypw1Xv4Hpv4OiL9/vs5Cxv46L3hr4vkecnLhPpqf1VXOuir6U6RzNvSSi1mkSl0bLqtNMy6HOxhTKsztsKrIF+NvuWhFJXL2nL7E0JGXCfG5xtPcigh+rcUpIf1ZNdc1pnuFGvvgOoR9/P00PcZ4L+uyJKaTpH/pNC/haznHJK5j5P6Pds58BqJ7lX/u7MnHJK5z7t8uSeKVEteHG/l4trOeVUn/vc7N5X067vd+XAySmnxmLevEPx1VzPySmnxiOSjyY5U+/m2WVte3N0Tms//T+xNd58kgAZ4wAAAABJRU5ErkJggg==';
function pagina(titulo, corpo, { largo = false } = {}) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · Controle Normativo</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<style>
:root{--bg:#F5F5F5;--sf:#fff;--ink:#191A1C;--mu:#5F6673;--ln:#E5E7EC;--ac:#2E4CFF;--aci:#fff;--cr:#B3261E;--crs:#F8E0DE;--ok:#1D7646;--oks:#DDF0E4;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;-webkit-font-smoothing:antialiased}
.topo{background:#191A1C;height:64px;display:flex;align-items:center;gap:14px;padding:0 max(20px,calc((100vw - 1280px)/2))}
.topo img{height:26px;width:auto;display:block}.topo span{color:rgba(255,255,255,.72);font-weight:600;font-size:14px;padding-left:14px;border-left:1px solid rgba(255,255,255,.18)}
main{padding:56px 16px 72px}
.box{max-width:${largo ? 1040 : 440}px;margin:0 auto;background:var(--sf);border:1px solid var(--ln);border-radius:20px;padding:32px;box-shadow:0 1px 2px rgba(25,26,28,.04),0 24px 48px -28px rgba(25,26,28,.18)}
h1{font-size:30px;line-height:1.1;font-weight:800;letter-spacing:-.035em;margin:0 0 8px}h2{font-size:18px;font-weight:700;letter-spacing:-.02em}p{margin:0 0 18px}.mu{color:var(--mu);font-size:14px}
form{display:flex;flex-direction:column;gap:14px}label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:var(--mu)}
input,select{font:inherit;color:var(--ink);background:var(--sf);border:1px solid #DADDE4;border-radius:10px;padding:9px 12px;min-height:42px}
input:focus,select:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px rgba(46,76,255,.16)}
button,.bt{font:inherit;font-weight:600;border:1px solid var(--ac);background:var(--ac);color:var(--aci);border-radius:10px;padding:10px 18px;cursor:pointer;text-decoration:none;display:inline-block;box-shadow:0 8px 18px -8px rgba(46,76,255,.7)}
button:hover,.bt:hover{background:#2340E6}
:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.sec{background:var(--sf);color:var(--ink);border-color:#DADDE4;box-shadow:none}.sec:hover{background:#F1F3F8}.peq{padding:5px 11px;font-size:13px;font-weight:600;border-radius:8px}
.msg{padding:12px 14px;border-radius:12px;font-size:14px;margin-bottom:14px}.err{background:var(--crs);color:var(--cr)}.ok{background:var(--oks);color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-size:12.5px;font-weight:600;color:var(--mu);padding:10px;border-bottom:1px solid var(--ln);background:#FAFAFB}
td{padding:10px;border-top:1px solid var(--ln);vertical-align:middle}.tw{overflow-x:auto;border:1px solid var(--ln);border-radius:14px}.linha{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;align-items:end}
code{font-size:15px;background:var(--bg);border:1px solid var(--ln);padding:5px 9px;border-radius:8px;user-select:all}
a{color:var(--ac)}
@media (max-width:560px){main{padding-top:28px}.box{padding:22px;border-radius:16px}h1{font-size:26px}.topo span{display:none}}
</style></head><body><header class="topo"><img src="${LOGO}" alt="Trinus" width="84" height="26"><span>Controle Normativo</span></header><main><div class="box">${corpo}</div></main></body></html>`;
}

// Lê as áreas marcadas num formulário (uma ou várias caixas "areas") e mantém só as que existem na lista
const areasDoForm = (valor, lista) => {
  const marcadas = new Set([].concat(valor || []).map(normArea));
  return lista.filter(a => marcadas.has(normArea(a)));
};
const aviso = m => m ? `<div class="msg ${m.tipo}">${m.html ? m.texto : esc(m.texto)}</div>` : '';

const router = express.Router();
router.use(['/login', '/auth/local', '/conta/senha', '/usuarios'], express.urlencoded({ extended: false, limit: '20kb' }));

function telaLogin(req, res, msg, email = '') {
  res.status(msg && msg.tipo === 'err' ? 401 : 200).send(pagina('Entrar', `<h1>Entrar</h1><p class="mu">Use o e-mail e a senha cadastrados pelo administrador.</p>${aviso(msg)}
<form method="post" action="/auth/local"><input type="hidden" name="_csrf" value="${tokenCsrf(req)}">
<label>E-mail<input type="email" name="email" id="email" autocomplete="username" required value="${esc(email)}" autofocus></label>
<label>Senha<input type="password" name="senha" id="senha" autocomplete="current-password" required></label>
<button type="submit">Entrar</button></form>`));
}

router.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/');
  req.session.save(() => telaLogin(req, res, req.query.saiu ? { tipo: 'ok', texto: 'Você saiu do sistema.' } : null));
});

// ---- 2FA por e-mail ----
// DOIS_FATORES=admin (só perfil Admin), todos, ou vazio/desligado (padrão). O código vale CODIGO_MIN minutos.
const DOIS_FATORES = (process.env.DOIS_FATORES || '').trim().toLowerCase();
const CODIGO_MIN = 10;
const exige2fa = u => DOIS_FATORES === 'todos' || (DOIS_FATORES === 'admin' && u.perfil === 'Admin');
const hashCodigo = (codigo, sal) => crypto.createHash('sha256').update(sal + ':' + codigo).digest('hex');

function entrar(req, res, next, u) {
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.usuario = { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, trocarSenha: u.trocar_senha };
    req.session.save(() => res.redirect(u.trocar_senha ? '/conta/senha' : '/'));
  });
}

function telaCodigo(req, res, msg) {
  const p = req.session.pendente2fa;
  if (!p) return res.redirect('/login');
  const mascara = String(p.email).replace(/^(.{2})[^@]*(@.*)$/, '$1•••$2');
  res.status(msg && msg.tipo === 'err' ? 401 : 200).send(pagina('Código de acesso', `<h1>Código de acesso</h1><p class="mu">Enviamos um código de 6 dígitos para <b>${esc(mascara)}</b>. Ele vale por ${CODIGO_MIN} minutos.</p>${aviso(msg)}
<form method="post" action="/auth/codigo"><input type="hidden" name="_csrf" value="${tokenCsrf(req)}">
<label>Código<input name="codigo" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
<button type="submit">Confirmar</button></form>
<form method="post" action="/auth/codigo/reenviar" style="margin-top:10px"><input type="hidden" name="_csrf" value="${tokenCsrf(req)}"><button type="submit">Reenviar código</button></form>
<p class="mu" style="margin-top:12px"><a href="/login">Voltar ao login</a></p>`));
}

async function enviarCodigo(req, u) {
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const sal = crypto.randomBytes(16).toString('hex');
  req.session.pendente2fa = { uid: u.id, email: u.email, sal, hash: hashCodigo(codigo, sal), expira: Date.now() + CODIGO_MIN * 60e3, tentativas: 0, enviadoEm: Date.now() };
  await require('./email').enviarCodigoLogin(u.email, codigo, CODIGO_MIN);
}

function iniciar2fa(req, res, next, u) {
  req.session.regenerate(async err => {
    if (err) return next(err);
    try { await enviarCodigo(req, u); } catch (e) {
      console.error('[2fa]', e);
      delete req.session.pendente2fa;
      return telaLogin(req, res, { tipo: 'err', texto: 'Não foi possível enviar o código de acesso por e-mail. Tente de novo em instantes ou fale com o administrador.' }, u.email);
    }
    req.session.save(() => res.redirect('/auth/codigo'));
  });
}

router.get('/auth/codigo', (req, res) => { req.session.save(() => telaCodigo(req, res)); });

router.post('/auth/codigo', async (req, res, next) => {
  try {
    if (!conferirCsrf(req)) return telaCodigo(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const p = req.session.pendente2fa;
    if (!p) return res.redirect('/login');
    if (!limiteIp(req.ip)) return telaCodigo(req, res, { tipo: 'err', texto: 'Muitas tentativas. Aguarde 15 minutos.' });
    if (Date.now() > p.expira) {
      delete req.session.pendente2fa;
      return telaLogin(req, res, { tipo: 'err', texto: 'O código expirou. Entre de novo para receber outro.' }, p.email);
    }
    const codigo = String(req.body.codigo || '').replace(/\D/g, '');
    const ok = codigo.length === 6 && crypto.timingSafeEqual(Buffer.from(hashCodigo(codigo, p.sal), 'hex'), Buffer.from(p.hash, 'hex'));
    if (!ok) {
      p.tentativas = (p.tentativas || 0) + 1;
      if (p.tentativas >= MAX_TENTATIVAS) {
        delete req.session.pendente2fa;
        await registrarAuditoria({ acao: 'Bloqueou', tipo: 'Usuário', ref: p.email, detalhe: `${MAX_TENTATIVAS} códigos de acesso errados` }, null);
        return telaLogin(req, res, { tipo: 'err', texto: 'Código errado muitas vezes. Entre de novo para receber outro.' }, p.email);
      }
      return req.session.save(() => telaCodigo(req, res, { tipo: 'err', texto: 'Código incorreto.' }));
    }
    const r = await q('SELECT * FROM usuarios WHERE id = $1', [p.uid]);
    const u = r.rows[0];
    delete req.session.pendente2fa;
    if (!u || !u.ativo) return telaLogin(req, res, { tipo: 'err', texto: 'Usuário desativado. Fale com o administrador.' });
    entrar(req, res, next, u);
  } catch (e) { next(e); }
});

router.post('/auth/codigo/reenviar', async (req, res) => {
  try {
    if (!conferirCsrf(req)) return telaCodigo(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const p = req.session.pendente2fa;
    if (!p) return res.redirect('/login');
    if (Date.now() - (p.enviadoEm || 0) < 60e3) return telaCodigo(req, res, { tipo: 'err', texto: 'Aguarde um minuto para pedir outro código.' });
    const r = await q('SELECT * FROM usuarios WHERE id = $1', [p.uid]);
    if (!r.rows[0]) return res.redirect('/login');
    await enviarCodigo(req, r.rows[0]);
    req.session.save(() => telaCodigo(req, res, { tipo: 'ok', texto: 'Enviamos um novo código.' }));
  } catch (e) { console.error('[2fa]', e); telaCodigo(req, res, { tipo: 'err', texto: 'Não foi possível reenviar o código agora.' }); }
});

router.post('/auth/local', async (req, res, next) => {
  try {
    if (!conferirCsrf(req)) return telaLogin(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');
    if (!limiteIp(req.ip)) return telaLogin(req, res, { tipo: 'err', texto: 'Muitas tentativas. Aguarde 15 minutos.' }, email);
    const r = await q('SELECT * FROM usuarios WHERE lower(email) = $1 AND senha_hash IS NOT NULL', [email]);
    const u = r.rows[0];
    const falha = () => telaLogin(req, res, { tipo: 'err', texto: 'E-mail ou senha incorretos.' }, email);
    if (!u) { await gerarHash(senha); return falha(); } // tempo semelhante, não revela se o e-mail existe
    if (u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date()) {
      return telaLogin(req, res, { tipo: 'err', texto: `Acesso bloqueado temporariamente por tentativas erradas. Tente após ${new Date(u.bloqueado_ate).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}.` }, email);
    }
    if (!(await conferir(senha, u.senha_hash))) {
      const n = u.tentativas + 1;
      await q('UPDATE usuarios SET tentativas = $2, bloqueado_ate = $3 WHERE id = $1',
        [u.id, n >= MAX_TENTATIVAS ? 0 : n, n >= MAX_TENTATIVAS ? new Date(Date.now() + BLOQUEIO_MIN * 60e3) : null]);
      if (n >= MAX_TENTATIVAS) await registrarAuditoria({ acao: 'Bloqueou', tipo: 'Usuário', ref: u.email, detalhe: `${MAX_TENTATIVAS} tentativas de senha erradas` }, null);
      return falha();
    }
    if (!u.ativo) return telaLogin(req, res, { tipo: 'err', texto: 'Usuário desativado. Fale com o administrador.' }, email);
    await q('UPDATE usuarios SET tentativas = 0, bloqueado_ate = NULL, ultimo_acesso = now() WHERE id = $1', [u.id]);
    if (exige2fa(u)) return iniciar2fa(req, res, next, u);
    entrar(req, res, next, u);
  } catch (err) { next(err); }
});

// Exige login para as páginas abaixo
function logado(req, res, next) { if (req.session.usuario) return next(); res.redirect('/login'); }

function telaSenha(req, res, msg) {
  const obrig = req.session.usuario.trocarSenha;
  res.send(pagina('Trocar senha', `<h1>${obrig ? 'Crie sua senha' : 'Trocar senha'}</h1>
<p class="mu">${obrig ? 'Por segurança, troque a senha provisória antes de continuar.' : 'Mínimo de 10 caracteres, com letras e números.'}</p>${aviso(msg)}
<form method="post" action="/conta/senha"><input type="hidden" name="_csrf" value="${tokenCsrf(req)}">
<label>Senha atual${obrig ? ' (provisória)' : ''}<input type="password" name="atual" id="atual" autocomplete="current-password" required></label>
<label>Nova senha<input type="password" name="nova" id="nova" autocomplete="new-password" required minlength="${SENHA_MIN}"></label>
<label>Repita a nova senha<input type="password" name="nova2" id="nova2" autocomplete="new-password" required minlength="${SENHA_MIN}"></label>
<div class="linha"><button type="submit">Salvar senha</button>${obrig ? '' : '<a class="bt sec" href="/">Voltar</a>'}</div></form>`));
}
router.get('/conta/senha', logado, (req, res) => {
  if (config.authMode !== 'local') return res.redirect('/');
  req.session.save(() => telaSenha(req, res));
});
router.post('/conta/senha', logado, async (req, res, next) => {
  try {
    if (config.authMode !== 'local') return res.redirect('/');
    if (!conferirCsrf(req)) return telaSenha(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const { atual = '', nova = '', nova2 = '' } = req.body;
    const r = await q('SELECT senha_hash FROM usuarios WHERE id = $1', [req.session.usuario.id]);
    if (!r.rows[0] || !(await conferir(atual, r.rows[0].senha_hash))) return telaSenha(req, res, { tipo: 'err', texto: 'A senha atual não confere.' });
    const prob = validarSenha(nova) || (nova !== nova2 ? 'As duas senhas novas não são iguais.' : '') || (nova === atual ? 'A nova senha precisa ser diferente da atual.' : '');
    if (prob) return telaSenha(req, res, { tipo: 'err', texto: prob });
    await q('UPDATE usuarios SET senha_hash = $2, trocar_senha = false WHERE id = $1', [req.session.usuario.id, await gerarHash(nova)]);
    await registrarAuditoria({ acao: 'Trocou a senha', tipo: 'Usuário', ref: req.session.usuario.email, detalhe: '' }, req.session.usuario.id);
    const u = { ...req.session.usuario, trocarSenha: false };
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.usuario = u;
      req.session.save(() => res.redirect('/'));
    });
  } catch (err) { next(err); }
});

// Enquanto a senha provisória não for trocada, só a página de troca fica acessível
function exigirSenhaDefinitiva(req, res, next) {
  const u = req.session.usuario;
  if (!u || !u.trocarSenha || req.path === '/conta/senha' || req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ erro: 'Troque a senha provisória antes de continuar.' });
  res.redirect('/conta/senha');
}

// ---- cadastro de usuários (somente Admin) ----
function soAdmin(req, res, next) {
  if (req.session.usuario && req.session.usuario.perfil === 'Admin') return next();
  res.status(403).send(pagina('Sem permissão', '<h1>Sem permissão</h1><p>Somente o perfil Admin gerencia usuários.</p><a class="bt sec" href="/">Voltar</a>'));
}

async function telaUsuarios(req, res, msg) {
  const lista = (await q('SELECT id, nome, email, perfil, ativo, trocar_senha, ultimo_acesso, bloqueado_ate, areas, ver_obrigacoes FROM usuarios WHERE senha_hash IS NOT NULL ORDER BY ativo DESC, nome')).rows;
  const caixaOb = marcado => `<label class="cx" style="margin-top:6px"><input type="checkbox" name="obrig" value="1"${marcado ? ' checked' : ''}> Acesso às obrigações regulatórias</label>`;
  const areas = await listarAreas();
  const caixas = (sel, rotulo) => `<div class="caixas" role="group" aria-label="${esc(rotulo)}">${areas.map(a => `<label class="cx"><input type="checkbox" name="areas" value="${esc(a)}"${(sel || []).some(x => normArea(x) === normArea(a)) ? ' checked' : ''}> ${esc(a)}</label>`).join('')}</div>`;
  const csrf = tokenCsrf(req);
  const opt = (sel) => PERFIS.map(p => `<option${p === sel ? ' selected' : ''}>${p}</option>`).join('');
  const linhas = lista.map(u => {
    const eu = u.id === req.session.usuario.id;
    const sit = !u.ativo ? 'Desativado' : u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date() ? 'Bloqueado (tentativas)' : u.trocar_senha ? 'Aguardando primeira senha' : 'Ativo';
    return `<tr><td><b>${esc(u.nome)}</b><div class="mu">${esc(u.email)}</div></td>
<td><form method="post" action="/usuarios/${esc(u.id)}" class="linha"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="acao" value="perfil">
<select name="perfil" aria-label="Perfil de ${esc(u.nome)}"${eu ? ' disabled' : ''}>${opt(u.perfil)}</select>${eu ? '' : '<button class="sec peq">Salvar</button>'}</form></td>
<td>${u.perfil === 'Área responsável' ? `<form method="post" action="/usuarios/${esc(u.id)}"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="acao" value="areas">${caixas(u.areas, 'Áreas de ' + u.nome)}${caixaOb(u.ver_obrigacoes)}<button class="sec peq" style="margin-top:6px;display:block">Salvar acesso</button>${(u.areas || []).length ? '' : '<div class="mu" style="color:#B3261E;margin-top:4px">Sem área: não vê nenhum item.</div>'}</form>` : '<span class="mu">Todas</span>'}</td>
<td>${esc(sit)}<div class="mu">${u.ultimo_acesso ? 'Último acesso ' + new Date(u.ultimo_acesso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : ''}</div></td>
<td>${eu ? '<span class="mu">Você</span>' : `<div class="linha">
<form method="post" action="/usuarios/${esc(u.id)}"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="acao" value="senha"><button class="sec peq">Gerar nova senha</button></form>
<form method="post" action="/usuarios/${esc(u.id)}"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="acao" value="${u.ativo ? 'desativar' : 'ativar'}"><button class="sec peq">${u.ativo ? 'Desativar' : 'Reativar'}</button></form></div>`}</td></tr>`;
  }).join('');
  res.send(pagina('Usuários', `<div class="linha" style="justify-content:space-between;margin-bottom:8px"><h1>Usuários</h1><a class="bt sec peq" href="/">Voltar ao sistema</a></div>
<p class="mu">Admin: tudo, inclusive exclusões e usuários. Analista: cadastra e edita. Área responsável: vê só as ações e obrigações das suas áreas, comenta e anexa evidências, sem alterar nada. Leitura: só consulta.</p>${aviso(msg)}
<h2 style="font-size:16px;margin:18px 0 8px">Novo usuário</h2>
<form method="post" action="/usuarios"><input type="hidden" name="_csrf" value="${csrf}"><div class="grid">
<label>Nome<input name="nome" id="novoNome" required maxlength="120"></label>
<label>E-mail<input type="email" name="email" id="novoEmail" required maxlength="200"></label>
<label>Perfil<select name="perfil" id="novoPerfil">${opt('Analista')}</select></label>
<button type="submit">Cadastrar</button></div>
<div style="margin-top:10px"><div class="mu" style="margin-bottom:4px">Áreas (só para o perfil Área responsável)</div>${caixas([], 'Áreas do novo usuário')}${caixaOb(false)}</div></form>
<p class="mu" style="margin-top:8px">O sistema gera uma senha provisória para você repassar à pessoa. Ela troca a senha no primeiro acesso.</p>
<h2 style="font-size:16px;margin:22px 0 8px">Equipe</h2>
<div class="tw"><table><thead><tr><th>Pessoa</th><th>Perfil</th><th>Áreas</th><th>Situação</th><th>Ações</th></tr></thead><tbody>${linhas}</tbody></table></div>
<h2 style="font-size:16px;margin:26px 0 8px">Lista de áreas</h2>
<p class="mu">As áreas aparecem para escolha nas ações e obrigações e definem o que cada pessoa do perfil Área responsável enxerga. Uma por linha.</p>
<form method="post" action="/usuarios/areas"><input type="hidden" name="_csrf" value="${csrf}">
<label>Áreas<textarea name="lista" rows="${Math.max(6, areas.length + 1)}" style="font:inherit;border:1px solid #DADDE4;border-radius:10px;padding:9px 12px;max-width:420px">${esc(areas.join('\n'))}</textarea></label>
<div style="margin-top:8px"><button type="submit">Salvar lista de áreas</button></div></form>
<style>.caixas{display:flex;flex-wrap:wrap;gap:4px 12px;max-width:420px}.cx{flex-direction:row!important;align-items:center;gap:6px!important;font-weight:500!important;color:#191A1C!important;font-size:13px!important}.cx input{min-height:auto;width:16px;height:16px;padding:0}</style>`, { largo: true }));
}

const msgSenha = (u, senha, prefixo) => ({
  tipo: 'ok', html: true,
  texto: `${esc(prefixo)} Senha provisória de <b>${esc(u)}</b>: <code>${esc(senha)}</code><br><span style="font-size:13px">Anote agora e repasse por um canal seguro: ela não será mostrada de novo. A pessoa troca a senha no primeiro acesso.</span>`,
});

router.get('/usuarios', logado, soAdmin, (req, res, next) => {
  if (config.authMode !== 'local') return res.status(404).send(pagina('Indisponível', '<h1>Usuários</h1><p>Com login corporativo, os usuários e perfis são gerenciados no Microsoft Entra ID.</p><a class="bt sec" href="/">Voltar</a>'));
  telaUsuarios(req, res).catch(next);
});

router.post('/usuarios', logado, soAdmin, async (req, res, next) => {
  try {
    if (config.authMode !== 'local') return res.redirect('/');
    if (!conferirCsrf(req)) return telaUsuarios(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const nome = String(req.body.nome || '').trim().slice(0, 120);
    const email = String(req.body.email || '').trim().toLowerCase();
    const perfil = PERFIS.includes(req.body.perfil) ? req.body.perfil : 'Leitura';
    if (!nome || !emailValido(email)) return telaUsuarios(req, res, { tipo: 'err', texto: 'Informe nome e um e-mail válido.' });
    const ja = await q('SELECT 1 FROM usuarios WHERE lower(email) = $1 AND senha_hash IS NOT NULL', [email]);
    if (ja.rowCount) return telaUsuarios(req, res, { tipo: 'err', texto: 'Já existe um usuário com esse e-mail.' });
    const senha = senhaTemporaria();
    const id = 'loc-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const areasNovo = perfil === 'Área responsável' ? areasDoForm(req.body.areas, await listarAreas()) : [];
    const obNovo = perfil === 'Área responsável' && req.body.obrig === '1';
    await q(`INSERT INTO usuarios (id, nome, email, perfil, senha_hash, ativo, trocar_senha, areas, ver_obrigacoes) VALUES ($1,$2,$3,$4,$5,true,true,$6,$7)`,
      [id, nome, email, perfil, await gerarHash(senha), areasNovo, obNovo]);
    await registrarAuditoria({ acao: 'Criou', tipo: 'Usuário', ref: email, detalhe: `Perfil ${perfil}${areasNovo.length ? ' · Áreas: ' + areasNovo.join(', ') : ''}${obNovo ? ' · com acesso às obrigações' : ''}` }, req.session.usuario.id);
    telaUsuarios(req, res, msgSenha(email, senha, 'Usuário cadastrado.'));
  } catch (err) { next(err); }
});

// Lista de áreas da empresa
router.post('/usuarios/areas', logado, soAdmin, async (req, res, next) => {
  try {
    if (config.authMode !== 'local') return res.redirect('/');
    if (!conferirCsrf(req)) return telaUsuarios(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const vistos = new Set();
    const lista = String(req.body.lista || '').split(/\r?\n/).map(s => s.trim().replace(/\s+/g, ' ').slice(0, 60))
      .filter(s => s && !vistos.has(normArea(s)) && vistos.add(normArea(s)));
    if (!lista.length) return telaUsuarios(req, res, { tipo: 'err', texto: 'Informe pelo menos uma área.' });
    if (lista.length > 50) return telaUsuarios(req, res, { tipo: 'err', texto: 'No máximo 50 áreas.' });
    const antes = await listarAreas();
    await gravarSistema('areas', { lista, atualizadoEm: new Date().toISOString(), atualizadoPor: req.session.usuario.id });
    await registrarAuditoria({ acao: 'Alterou', tipo: 'Configuração', ref: 'Lista de áreas', detalhe: antes.join(', ') + ' → ' + lista.join(', ') }, req.session.usuario.id);
    telaUsuarios(req, res, { tipo: 'ok', texto: 'Lista de áreas salva.' });
  } catch (err) { next(err); }
});

router.post('/usuarios/:id', logado, soAdmin, async (req, res, next) => {
  try {
    if (config.authMode !== 'local') return res.redirect('/');
    if (!conferirCsrf(req)) return telaUsuarios(req, res, { tipo: 'err', texto: 'A página expirou. Tente de novo.' });
    const id = req.params.id;
    if (id === req.session.usuario.id) return telaUsuarios(req, res, { tipo: 'err', texto: 'Você não pode alterar o próprio perfil ou desativar a si mesmo.' });
    const r = await q('SELECT * FROM usuarios WHERE id = $1 AND senha_hash IS NOT NULL', [id]);
    const u = r.rows[0];
    if (!u) return telaUsuarios(req, res, { tipo: 'err', texto: 'Usuário não encontrado.' });
    const quem = req.session.usuario.id;
    switch (req.body.acao) {
      case 'perfil': {
        const perfil = PERFIS.includes(req.body.perfil) ? req.body.perfil : u.perfil;
        if (perfil === u.perfil) return telaUsuarios(req, res);
        await q('UPDATE usuarios SET perfil = $2 WHERE id = $1', [id, perfil]);
        await q("DELETE FROM sessoes WHERE sess -> 'usuario' ->> 'id' = $1", [id]).catch(() => {});
        await registrarAuditoria({ acao: 'Alterou', tipo: 'Usuário', ref: u.email, detalhe: `Perfil: ${u.perfil} → ${perfil}` }, quem);
        return telaUsuarios(req, res, { tipo: 'ok', texto: `Perfil de ${u.email} alterado para ${perfil}.` });
      }
      case 'areas': {
        const novas = areasDoForm(req.body.areas, await listarAreas());
        const ob = req.body.obrig === '1';
        await q('UPDATE usuarios SET areas = $2, ver_obrigacoes = $3 WHERE id = $1', [id, novas, ob]);
        await registrarAuditoria({ acao: 'Alterou', tipo: 'Usuário', ref: u.email, detalhe: `Áreas: ${(u.areas || []).join(', ') || 'nenhuma'} → ${novas.join(', ') || 'nenhuma'} · Obrigações: ${u.ver_obrigacoes ? 'sim' : 'não'} → ${ob ? 'sim' : 'não'}` }, quem);
        return telaUsuarios(req, res, { tipo: 'ok', texto: `Acesso de ${u.email}: ${novas.join(', ') || 'nenhuma área'}${ob ? ', com obrigações' : ', sem obrigações'}.` });
      }
      case 'senha': {
        const senha = senhaTemporaria();
        await q('UPDATE usuarios SET senha_hash = $2, trocar_senha = true, tentativas = 0, bloqueado_ate = NULL WHERE id = $1', [id, await gerarHash(senha)]);
        await q("DELETE FROM sessoes WHERE sess -> 'usuario' ->> 'id' = $1", [id]).catch(() => {});
        await registrarAuditoria({ acao: 'Redefiniu a senha', tipo: 'Usuário', ref: u.email, detalhe: '' }, quem);
        return telaUsuarios(req, res, msgSenha(u.email, senha, 'Nova senha gerada.'));
      }
      case 'desativar':
      case 'ativar': {
        const ativo = req.body.acao === 'ativar';
        await q('UPDATE usuarios SET ativo = $2 WHERE id = $1', [id, ativo]);
        if (!ativo) await q("DELETE FROM sessoes WHERE sess -> 'usuario' ->> 'id' = $1", [id]).catch(() => {});
        await registrarAuditoria({ acao: ativo ? 'Reativou' : 'Desativou', tipo: 'Usuário', ref: u.email, detalhe: '' }, quem);
        return telaUsuarios(req, res, { tipo: 'ok', texto: `${u.email} ${ativo ? 'reativado' : 'desativado'}.` });
      }
      default:
        return telaUsuarios(req, res);
    }
  } catch (err) { next(err); }
});

// Revalida a cada requisição se o usuário continua ativo e com o mesmo perfil
async function revalidar(req, res, next) {
  const u = req.session && req.session.usuario;
  if (!u || config.authMode !== 'local') return next();
  try {
    const r = await q('SELECT perfil, ativo, nome, areas, ver_obrigacoes FROM usuarios WHERE id = $1', [u.id]);
    const atual = r.rows[0];
    if (!atual || !atual.ativo) return req.session.destroy(() => (req.path.startsWith('/api/') ? res.status(401).json({ erro: 'Sessão encerrada.' }) : res.redirect('/login')));
    u.perfil = atual.perfil; u.nome = atual.nome; u.areas = atual.areas || []; u.verObrigacoes = !!atual.ver_obrigacoes;
    next();
  } catch (err) { next(err); }
}

module.exports = { router, garantirPrimeiroAdmin, exigirSenhaDefinitiva, revalidar, gerarHash, conferir, validarSenha };
