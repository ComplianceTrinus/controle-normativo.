# Publicar o Controle Normativo no Railway

Este guia coloca o sistema na internet num servidor externo, sem precisar instalar nada no seu computador. O processo leva uns 20 minutos e é feito todo pelo navegador.

**Resultado:** um endereço como `https://controle-normativo-production.up.railway.app`. O time entra nele com e-mail e senha, e a busca de normas roda todo dia às 07:35.

**Custo estimado:** o plano Hobby do Railway custa US$ 5/mês com US$ 5 de uso incluídos. Com o banco de dados, a conta tende a ficar entre US$ 5 e 20/mês. Na seção 4 você define um limite de gasto.

---

## 1. Colocar o código no GitHub (5 min)

O Railway publica a partir de um repositório do GitHub.

1. Crie uma conta gratuita em **github.com**, se ainda não tiver.
2. Clique em **New** (ou no **+** no canto superior → *New repository*):
   - **Repository name:** `controle-normativo`
   - marque **Private** (os dados de configuração não ficam públicos);
   - clique em **Create repository**.
3. Na página do repositório vazio, clique no link **uploading an existing file**.
4. Descompacte o `controle-normativo.zip` no computador e abra a pasta `controle-normativo`.
5. **Selecione tudo o que está dentro dela**, pastas e arquivos, e arraste para a página do GitHub. Use Chrome ou Edge, que aceitam arrastar pastas.
6. Espere a lista de arquivos carregar. Confira se aparecem `Dockerfile`, `railway.json`, `package.json` e as pastas `src`, `public`, `db`, `dados`, `scripts`.
7. Clique em **Commit changes**.

## 2. Criar o projeto no Railway (5 min)

1. Entre em **railway.com** e clique em **Login** → **Login with GitHub**. Autorize o acesso.
2. Ative o plano **Hobby** em *Account → Plans*. O teste gratuito também funciona para começar, mas o Hobby garante que o sistema fique ligado todo dia.
3. Clique em **New Project** → **Deploy from GitHub repo**.
   - Se pedir, clique em **Configure GitHub App** e libere o repositório `controle-normativo`.
   - Escolha **controle-normativo**. O Railway começa a montar o sistema. Na primeira vez a montagem vai falhar, porque ainda falta o banco de dados. É normal.
4. Dentro do projeto, clique em **+ Create** (ou **New**) → **Database** → **Add PostgreSQL**. Aparece um segundo bloco chamado **Postgres**.

## 3. Configurar (5 min)

1. Clique no bloco **controle-normativo** → aba **Variables** → **+ New Variable**. Crie uma por uma:

   | Nome | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (digite exatamente assim, com as chaves) |
   | `ADMIN_EMAIL` | seu e-mail, que será o login de administrador |
   | `ADMIN_SENHA_INICIAL` | uma senha provisória com 10+ caracteres, letras e números (você troca no primeiro acesso) |
   | `ADMIN_NOME` | seu nome |
   | `IMPORTAR_DADOS_PILOTO` | `true` (carrega as 36 normas que já estão no piloto) |
   | `PORT` | `3000` |

2. Clique em **Deploy** (ou **Apply changes**) para aplicar.
3. Ainda no bloco **controle-normativo**, vá em **Settings** → **Networking** → **Generate Domain**. Se perguntar a porta, informe **3000**. Anote o endereço gerado.
4. Acompanhe na aba **Deployments**. A primeira montagem leva de 5 a 10 minutos, porque instala o navegador usado para ler o site da ANBIMA. Quando aparecer **Active** (ou *Success*), está no ar.

## 4. Primeiro acesso (2 min)

1. Abra o endereço gerado. Aparece a tela **Entrar**.
2. Entre com o `ADMIN_EMAIL` e a `ADMIN_SENHA_INICIAL`. O sistema pede uma senha nova: crie a definitiva.
3. Confira o Painel: as normas do piloto devem estar lá.
4. **Segurança:** volte em **Variables** e **apague** a `ADMIN_SENHA_INICIAL`. Ela só serve para criar o primeiro administrador. Pode apagar também a `IMPORTAR_DADOS_PILOTO`.
5. **Limite de gasto:** em *Account → Usage*, defina um limite mensal, por exemplo US$ 20, para não ter surpresa na fatura.

## 5. Cadastrar o time

No canto inferior esquerdo do sistema, clique em **Usuários**:
1. Informe nome, e-mail e perfil (**Admin**, **Analista** ou **Leitura**) e clique em **Cadastrar**.
2. O sistema mostra uma **senha provisória**, que aparece uma única vez. Envie para a pessoa por um canal seguro, junto com o endereço do sistema.
3. A pessoa entra e troca a senha no primeiro acesso.

Na mesma tela, o Admin também gera uma nova senha para quem esqueceu, muda o perfil e desativa quem saiu do time.

## 6. Confirmar a busca automática de normas

1. No **Painel**, clique em **Atualizar agora**, na faixa "Atualização automática diária".
2. Espere 1 ou 2 minutos e recarregue a página. A faixa deve mostrar "Banco Central, CVM e ANBIMA" e quantas normas novas entraram.
3. Daí em diante, a busca roda sozinha todo dia às **07:35**.

Se alguma fonte aparecer com erro, veja os detalhes em **Deployments → View logs**: procure as linhas que começam com `[captura]`.

## 7. Depois de publicado

- **Desligue a busca diária que roda no Claude.** Ela continua alimentando o piloto antigo, e manter as duas não tem utilidade. Basta me pedir.
- **Atualizações do sistema:** quando receber uma versão nova, envie os arquivos para o mesmo repositório do GitHub (*Add file → Upload files*). O Railway publica sozinho, e os dados ficam preservados no banco.
- **Cópia de segurança:** exporte as planilhas pelo próprio sistema (Normas e Indicadores → *Exportar*) periodicamente. Veja também a aba **Backups** do bloco Postgres no Railway.

## Quando levar para a empresa

Esta publicação é para validar o sistema. Para uso oficial pela instituição:
- o TI hospeda internamente, com o guia do `README.md`;
- o login passa a ser o corporativo (`AUTH_MODE=entra`);
- os dados migram com o backup.

Até lá, evite colocar aqui informações sigilosas da instituição. Os servidores do Railway ficam fora do Brasil e fora do controle do TI, o que importa para a LGPD e para a política de contratação de nuvem (Resolução CMN 4.893).
