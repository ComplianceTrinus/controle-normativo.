#!/usr/bin/env bash
# Controle Normativo — teste no seu computador (Mac ou Linux).  Uso: ./iniciar-teste.sh
set -e
cd "$(dirname "$0")"

echo
echo "=== Controle Normativo - teste no seu computador ==="
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "O Docker Desktop não foi encontrado."
  echo "Instale em https://www.docker.com/products/docker-desktop/ , abra o Docker Desktop e rode este arquivo de novo."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "O Docker Desktop está instalado, mas não está aberto. Abra-o e rode este arquivo de novo."
  exit 1
fi

if [ ! -f .env ]; then
  echo "Criando configuração de TESTE (sem senha, apenas para este computador)..."
  cat > .env <<'EOF'
AUTH_MODE=dev
NODE_ENV=development
BASE_URL=http://localhost:3000
SESSION_SECRET=teste-local-somente-neste-computador-0123456789
POSTGRES_PASSWORD=teste-local-123
CAPTURA_ATIVA=true
DEV_USUARIO_NOME=Teste
DEV_USUARIO_PERFIL=Admin
EOF
fi

echo "Montando e iniciando o sistema. Na primeira vez leva alguns minutos..."
docker compose up -d --build

echo "Aguardando o sistema responder..."
for i in $(seq 1 60); do
  if curl -s http://localhost:3000/saude | grep -q true; then break; fi
  if [ "$i" = 60 ]; then echo "O sistema demorou para responder. Veja: docker compose logs app"; exit 1; fi
  sleep 3
done

echo "Carregando as normas do piloto..."
docker compose exec -T app node scripts/importar.js dados/backup-claude-2026-11-03.json

echo
echo "Pronto! Abra http://localhost:3000"
echo "Para buscar normas novas agora, use o botão \"Atualizar agora\" no Painel."
echo "Para desligar: docker compose down   (os dados ficam guardados)"
(command -v open >/dev/null && open http://localhost:3000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:3000) || true
