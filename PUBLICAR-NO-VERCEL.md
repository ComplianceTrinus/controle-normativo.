# Publicar o Controle Normativo no Vercel (grátis)

Resultado: um endereço como `https://controle-normativo.vercel.app`, com login por e-mail e senha. O banco de dados (Neon) é criado dentro do próprio Vercel, e a busca de normas do Banco Central e da CVM roda uma vez por dia, pela manhã.

**Atenção:** pelos termos do Vercel, o plano gratuito (Hobby) é para uso pessoal e não comercial. Use para validar o sistema. Para uso oficial pela instituição, o caminho é o plano pago ou a hospedagem pelo TI (veja o `README.md`).

## 1. Atualizar o GitHub
Envie todo o conteúdo desta pasta para o repositório (*Add file → Upload files*, arraste tudo e clique em *Commit changes*). Os arquivos com o mesmo nome são substituídos.

## 2. Criar o projeto no Vercel
1. Entre em vercel.com/login → **Continue with GitHub**.
2. **Add New… → Project**. Na lista, clique em **Import** ao lado do repositório. Se ele não aparecer, use **Adjust GitHub App Permissions** e libere o repositório.
3. **Project Name:** `controle-normativo`. Deixe o **Framework Preset** como está.
4. Abra **Environment Variables** e crie:

| Nome | Valor |
|---|---|
| `ADMIN_EMAIL` | seu e-mail (login de administrador) |
| `ADMIN_SENHA_INICIAL` | senha provisória, 10+ caracteres, com letras e números |
| `ADMIN_NOME` | seu nome |
| `IMPORTAR_DADOS_PILOTO` | `true` |
| `CRON_SECRET` | uma sequência qualquer de 20+ letras e números (protege a busca diária) |

5. Clique em **Deploy**. Ainda falta o banco, então o site só funciona depois do passo 3.

## 3. Criar o banco
1. No projeto, abra a aba **Storage** → **Create Database** → **Neon** (Serverless Postgres) → **Continue**.
2. Plano **Free**. Em região, escolha São Paulo se aparecer; senão, Washington, D.C. (US East). Clique em **Create**.
3. Na tela de conexão, deixe todos os ambientes marcados e clique em **Connect**.
4. Aba **Deployments** → no deploy mais recente, menu **⋯** → **Redeploy**.

## 4. Primeiro acesso
1. Na página do projeto, clique em **Visit** (o endereço também está em *Settings → Domains*).
2. Entre com o `ADMIN_EMAIL` e a `ADMIN_SENHA_INICIAL`. O sistema pede a senha definitiva.
3. Em *Settings → Environment Variables*, apague a `ADMIN_SENHA_INICIAL` (e, se quiser, a `IMPORTAR_DADOS_PILOTO`).
4. Cadastre o time em **Usuários**.

## Diferenças em relação ao servidor próprio
- **ANBIMA:** a leitura do site da ANBIMA precisa de um navegador (Chromium), que não roda no Vercel. Banco Central e CVM funcionam. A ANBIMA pode ser ligada depois pelo GitHub Actions.
- **Horário da busca:** no plano gratuito, o Vercel roda a busca uma vez por dia em algum momento entre 07:00 e 07:59 (horário de Brasília).
- **Evidências:** arquivos de até 4 MB cada.
- **Botão "Atualizar agora":** a tela espera a busca terminar (até 1 ou 2 minutos) antes de responder.
