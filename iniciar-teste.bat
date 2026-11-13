@echo off
chcp 65001 >nul
title Controle Normativo - teste local
cd /d "%~dp0"

echo.
echo === Controle Normativo - teste no seu computador ===
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo O Docker Desktop nao foi encontrado.
  echo Instale em https://www.docker.com/products/docker-desktop/ , abra o Docker Desktop e rode este arquivo de novo.
  pause
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo O Docker Desktop esta instalado, mas nao esta aberto.
  echo Abra o Docker Desktop, espere aparecer "Engine running" e rode este arquivo de novo.
  pause
  exit /b 1
)

if not exist .env (
  echo Criando configuracao de TESTE ^(sem senha, apenas para este computador^)...
  > .env (
    echo AUTH_MODE=dev
    echo NODE_ENV=development
    echo BASE_URL=http://localhost:3000
    echo SESSION_SECRET=teste-local-somente-neste-computador-0123456789
    echo POSTGRES_PASSWORD=teste-local-123
    echo CAPTURA_ATIVA=true
    echo DEV_USUARIO_NOME=Teste
    echo DEV_USUARIO_PERFIL=Admin
  )
)

echo Montando e iniciando o sistema. Na primeira vez leva alguns minutos...
docker compose up -d --build
if errorlevel 1 (
  echo Nao foi possivel iniciar. Veja a mensagem acima.
  pause
  exit /b 1
)

echo Aguardando o sistema responder...
set /a tentativas=0
:espera
set /a tentativas+=1
curl -s http://localhost:3000/saude | find "true" >nul
if not errorlevel 1 goto pronto
if %tentativas% geq 60 (
  echo O sistema demorou para responder. Veja os detalhes com: docker compose logs app
  pause
  exit /b 1
)
timeout /t 3 >nul
goto espera

:pronto
echo Carregando as normas do piloto...
docker compose exec -T app node scripts/importar.js dados/backup-claude-2026-11-03.json

echo.
echo Pronto! Abrindo http://localhost:3000
echo Para buscar normas novas agora, use o botao "Atualizar agora" no Painel.
echo Para desligar: docker compose down   ^(os dados ficam guardados^)
start http://localhost:3000
echo.
pause
