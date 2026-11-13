# Controle Normativo

Sistema do time de Compliance para acompanhar normas do **Banco Central, CMN, CVM e ANBIMA**. Cobre a triagem, a aplicabilidade, os planos de ação com evidências, as obrigações regulatórias, os indicadores e a trilha de auditoria. Uma **captura diária automática** traz as publicações novas direto dos sites oficiais.

Esta é a versão para rodar fora do Claude, com as mesmas telas do piloto. Há três modos de login:
- **local**: e-mail e senha cadastrados no próprio sistema (padrão);
- **entra**: login corporativo Microsoft Entra ID;
- **dev**: sem senha, só para teste.

> **Quer publicar rápido num servidor externo?** Siga o [PUBLICAR-NO-RAILWAY.md](PUBLICAR-NO-RAILWAY.md): leva uns 20 minutos, tudo pelo navegador.
> O restante deste README é para o TI instalar na infraestrutura da instituição.

---

## Sumário

1. [Arquitetura](#1-arquitetura)
2. [Requisitos](#2-requisitos)
3. [Registrar o aplicativo no Microsoft Entra ID](#3-registrar-o-aplicativo-no-microsoft-entra-id)
4. [Configurar](#4-configurar)
5. [Instalar com Docker (recomendado)](#5-instalar-com-docker-recomendado)
6. [Instalar sem Docker](#6-instalar-sem-docker)
7. [Migrar os dados do piloto](#7-migrar-os-dados-do-piloto)
8. [Captura diária de normas](#8-captura-diária-de-normas)
9. [Perfis de acesso](#9-perfis-de-acesso)
10. [Segurança](#10-segurança)
11. [Backup e operação](#11-backup-e-operação)
12. [Teste local sem Entra ID](#12-teste-local-sem-entra-id)
13. [Estrutura do projeto](#13-estrutura-do-projeto)

---

## 1. Arquitetura

```
 Navegador ──HTTPS──▶ Proxy reverso (TLS) ──▶ App Node.js (Express) ──▶ PostgreSQL
                                                  │  ├─ API REST (/api)
                                                  │  ├─ Login Microsoft Entra ID (OIDC + PKCE)
                                                  │  ├─ Evidências em disco (/app/uploads)
                                                  │  └─ Captura diária (07:35)
                                                  │        ├─ Banco Central: API da Busca de normas
                                                  │        ├─ CVM: página de Resoluções
                                                  │        └─ ANBIMA: Circulares, Comunicados, Audiências (navegador headless)
```

| Componente | Tecnologia |
|---|---|
| Backend | Node.js 22, Express |
| Banco | PostgreSQL 14+ |
| Login | Microsoft Entra ID (OpenID Connect), `@azure/msal-node` |
| Captura | `fetch` (BCB e CVM) e Playwright/Chromium headless (ANBIMA) |
| Agendamento | `node-cron`, no próprio processo, com trava no banco contra execução duplicada |
| Frontend | Página única (HTML, CSS e JS), sem build, com SheetJS local para Excel |

## 2. Requisitos

- **Docker 24+** com Docker Compose, **ou** Node.js 22.9+ e PostgreSQL 14+.
- Um **proxy reverso com HTTPS** na frente da aplicação: IIS/ARR, Nginx, Apache, F5, Azure App Gateway etc.
- **Saída de rede (HTTPS 443)** do servidor para:
  - `www.bcb.gov.br`: Banco Central
  - `conteudo.cvm.gov.br`: CVM
  - `www.anbima.com.br`: ANBIMA
  - `login.microsoftonline.com`: login
  - `fonts.googleapis.com` e `fonts.gstatic.com` (opcional; sem eles a tela usa as fontes do sistema)

  Se a saída passar por proxy corporativo, configure `HTTPS_PROXY` (seção 4).
- Recursos sugeridos: 2 vCPU, 2 GB de RAM e 10 GB de disco, mais o espaço das evidências.

## 3. Registrar o aplicativo no Microsoft Entra ID

Quem faz: um administrador do Entra ID (Azure AD).

1. **Entra ID → Registros de aplicativo → Novo registro**
   - Nome: `Controle Normativo`
   - Tipos de conta: *Somente contas deste diretório organizacional*
   - URI de redirecionamento: plataforma **Web**, endereço `https://normas.suaempresa.com.br/auth/callback`
2. Anote o **ID do aplicativo (cliente)** e o **ID do diretório (locatário)**.
3. **Certificados e segredos → Novo segredo do cliente.** Anote o **valor** (é ele que vai em `ENTRA_CLIENT_SECRET`) e agende a renovação antes de vencer.
4. **Funções de aplicativo (App roles) → Criar função**, três vezes:

   | Nome de exibição | Valor | Tipos de membro |
   |---|---|---|
   | Admin | `Admin` | Usuários/Grupos |
   | Analista | `Analista` | Usuários/Grupos |
   | Leitura | `Leitura` | Usuários/Grupos |

5. **Aplicativos empresariais → Controle Normativo:**
   - em **Propriedades**, marque **Atribuição necessária = Sim**;
   - em **Usuários e grupos**, atribua cada pessoa ou grupo a uma das funções.
6. (Opcional) Em vez das App Roles, dá para usar grupos: em **Configuração do token → Adicionar declaração de grupos**, escolha *Grupos atribuídos ao aplicativo* e informe os Object IDs em `ENTRA_GRUPO_*`. As App Roles são recomendadas porque não sofrem com o limite de grupos no token.

## 4. Configurar

```bash
cp .env.example .env
# gere o segredo de sessão:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Preencha no `.env`:
- **sempre:** `BASE_URL` e `POSTGRES_PASSWORD` (ou `DATABASE_URL`);
- **login corporativo:** `AUTH_MODE=entra`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` e `ENTRA_CLIENT_SECRET`;
- **login próprio:** `AUTH_MODE=local`, `ADMIN_EMAIL` e `ADMIN_SENHA_INICIAL`.

O `SESSION_SECRET` é opcional: se ficar vazio, é gerado e guardado no banco. Cada variável está comentada no próprio `.env.example`.

## 5. Instalar com Docker (recomendado)

```bash
docker compose up -d --build
docker compose logs -f app        # acompanhe a inicialização
curl http://localhost:3000/saude  # {"ok":true}
```

- As tabelas são criadas automaticamente na primeira inicialização.
- Configure o proxy reverso para encaminhar `https://normas.suaempresa.com.br` → `http://servidor:3000` e mantenha `TRUST_PROXY=true`.
- Para usar um PostgreSQL já existente, remova o serviço `db` do `docker-compose.yml` e informe a `DATABASE_URL` no `.env`.

## 6. Instalar sem Docker

```bash
npm ci --omit=dev
npx playwright install --with-deps chromium   # navegador usado na captura da ANBIMA
npm run migrar                                # cria as tabelas
npm start
```

Para manter o processo ativo, use um gerenciador de serviços: systemd, PM2, NSSM ou serviço do Windows.

## 7. Migrar os dados do piloto

O arquivo `dados/backup-claude-2026-11-03.json` traz o que estava no piloto do claude.ai: 36 normas e os registros de captura.

```bash
# Docker:
docker compose exec app node scripts/importar.js dados/backup-claude-2026-11-03.json
# Sem Docker:
npm run importar -- dados/backup-claude-2026-11-03.json
```

A importação pode ser repetida sem duplicar nada. Se houver ações ou obrigações cadastradas no piloto depois dessa data, gere um novo backup antes de desligá-lo e importe da mesma forma.

**Depois da migração:**
- desligue a tarefa agendada "Captura diária de normas" no claude.ai, para não ter duas capturas paralelas;
- avise o time do endereço novo.

## 8. Captura diária de normas

Roda todo dia às **07:35** (horário de Brasília), dentro da própria aplicação. Ela só **acrescenta** normas novas, com status **Nova**: nunca altera nem exclui o que o time já classificou.

| Fonte | Onde | O que entra |
|---|---|---|
| Banco Central | API da Busca de normas (`bcb.gov.br/estabilidadefinanceira/buscanormas`) | Resoluções BCB, Resoluções CMN, Resoluções Conjuntas, Circulares, Cartas Circulares e Instruções Normativas BCB. Comunicados e atos administrativos ficam de fora. |
| CVM | `conteudo.cvm.gov.br/legislacao/resolucoes.html` (lista "Mais Recentes") | Resoluções CVM |
| ANBIMA | Circulares, Comunicados da Autorregulação e Audiências Públicas | Comunicações aos associados e revisões dos Códigos |

- **Duplicidade:** cada norma tem uma chave única (órgão|tipo|número), e o banco recusa repetições.
- **Janela de busca:** cada execução busca a partir da última data capturada menos 3 dias, para pegar publicações tardias.
- **Resultado:** aparece na faixa do Painel ("Atualização automática diária") e na Auditoria (ação "Capturou").
- **Rodar agora:**
  - o Admin tem o botão **Atualizar agora** no Painel;
  - pela linha de comando: `npm run captura` (ou `docker compose exec app node scripts/captura.js`).
- **Mudar o horário:** `CAPTURA_CRON` no `.env`.
- **Falha em uma fonte:** as outras continuam. O Painel mostra o status "parcial" e o motivo.
- **Proxy corporativo:** defina `HTTPS_PROXY`. O `fetch` e o Chromium usam o mesmo proxy.

> Os sites dos reguladores podem mudar de layout. Os leitores ficam isolados em `src/captura/bcb.js`, `cvm.js` e `anbima.js` e têm testes em `test/captura.test.js` (`npm test`). Se uma fonte começar a falhar sempre, o ajuste costuma ser pequeno e fica restrito ao arquivo dela.

## 9. Perfis de acesso

| Perfil | Pode |
|---|---|
| **Admin** | Tudo, inclusive excluir normas, ações e obrigações, remover evidências, rodar a captura manualmente e, no login próprio, cadastrar usuários |
| **Analista** | Cadastrar e editar normas, ações e obrigações, anexar evidências, registrar envios e importar planilhas |
| **Leitura** | Consultar e exportar |

O servidor confere o perfil em toda requisição. Os botões escondidos na tela são só conveniência.

## 10. Segurança

- **Login:** pelo Entra ID (OIDC com PKCE e validação de `state`) ou pelo login próprio. A sessão fica em cookie `HttpOnly`, `SameSite=Lax` e `Secure` quando a URL é HTTPS, e expira após 8 horas sem uso (`SESSAO_HORAS`).
- **Regras do login próprio:**
  - senhas guardadas com scrypt e sal aleatório, com mínimo de 10 caracteres, letras e números;
  - troca obrigatória da senha provisória no primeiro acesso;
  - bloqueio de 15 minutos após 5 senhas erradas e limite de tentativas por IP;
  - usuário desativado ou com perfil alterado tem a sessão encerrada na hora.
- **Trilha de auditoria imutável:** um trigger no PostgreSQL bloqueia `UPDATE` e `DELETE` na tabela `auditoria`. Cada evento registra quem fez, o que fez e quando, com o "antes → depois" das alterações.
- **CSRF:** gravações exigem o cabeçalho `X-Requested-With` enviado pela própria página.
- **CSP restritiva:** só os scripts da própria aplicação rodam, liberados por hash.
- **Evidências:**
  - guardadas no PostgreSQL (`ARMAZENAMENTO=banco`, padrão) ou em disco (`disco`);
  - formatos aceitos: PDF, imagens, CSV, TXT, MD e JSON, até 20 MB;
  - os arquivos ficam fora da pasta pública e só são servidos a usuários autenticados, com `nosniff` e sandbox;
  - arquivos enviados e nunca vinculados a uma ação são apagados após 1 dia.
- **Banco:** use um usuário próprio da aplicação, sem privilégio de superusuário. Com o banco gerenciado pelo time de DBA, o usuário precisa apenas de `CREATE` no schema (para a migração inicial) e de `SELECT/INSERT/UPDATE/DELETE` nas tabelas.
- **Avaliação de terceiros e nuvem:** o sistema roda dentro da infraestrutura da instituição. A única dependência externa é o Entra ID, além das consultas de leitura aos sites públicos dos reguladores.

## 11. Backup e operação

- **Banco:** `pg_dump` diário, por exemplo `docker compose exec db pg_dump -U controle_normativo controle_normativo > backup.sql`.
- **Evidências:** com `ARMAZENAMENTO=banco`, já estão no `pg_dump`. Com `disco`, copie também a pasta `UPLOAD_DIR`.
- **Saúde:** `GET /saude` responde `{"ok":true}` quando a aplicação e o banco estão de pé.
- **Logs:** saem no stdout (`docker compose logs app`). A captura registra uma linha `[captura]` com o resumo.
- **Atualizar a aplicação:** `git pull && docker compose up -d --build`. As migrações são idempotentes e rodam na inicialização.

## 12. Teste local sem Entra ID

**Jeito mais rápido (com Docker Desktop aberto):**
- **Windows:** clique duas vezes em `iniciar-teste.bat`.
- **Mac/Linux:** rode `./iniciar-teste.sh`.

O script cria um `.env` de teste, sem senha, sobe o sistema, carrega as normas do piloto e abre `http://localhost:3000`. Para desligar, use `docker compose down`. Antes de ir para produção, apague esse `.env` de teste e configure o real (seção 4).

**Sem Docker:**

```bash
cp .env.example .env
# no .env: AUTH_MODE=dev, BASE_URL=http://localhost:3000, DATABASE_URL apontando para um Postgres local,
#          SESSION_SECRET com 32+ caracteres, CAPTURA_ATIVA=false
npm ci && npm run migrar && npm run importar -- dados/backup-claude-2026-11-03.json
npm start
```

Abra `http://localhost:3000`. Para testar outros perfis, use `http://localhost:3000/auth/login?perfil=Analista` ou `?perfil=Leitura`. O modo `dev` é recusado com `NODE_ENV=production`.

## 13. Estrutura do projeto

```
db/schema.sql            Tabelas, índices e trigger da auditoria
src/server.js            Servidor, rotas da API, evidências, CSP e agendamentos
src/auth.js              Login Entra ID / modo dev e perfis
src/contas.js            Login próprio (e-mail e senha) e tela de usuários
src/colecoes.js          Acesso a dados: normas, ações, obrigações, auditoria
src/captura/             Captura diária (bcb.js, cvm.js, anbima.js, index.js)
public/index.html        Tela do sistema
public/js/api.js         Ligação da tela com a API
scripts/                 migrar, importar backup e rodar captura pela linha de comando
railway.json             Configuração para publicar no Railway (ver PUBLICAR-NO-RAILWAY.md)
dados/                   Backup exportado do piloto
test/                    Testes dos leitores das fontes (npm test)
```
