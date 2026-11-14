-- Controle Normativo — esquema PostgreSQL (14 ou superior)
-- Idempotente: pode ser executado várias vezes (npm run migrar).

CREATE TABLE IF NOT EXISTS usuarios (
  id             text PRIMARY KEY,              -- oid do Microsoft Entra ID
  nome           text NOT NULL,
  email          text,
  perfil         text NOT NULL CHECK (perfil IN ('Admin','Analista','Leitura','Área responsável')),
  ultimo_acesso  timestamptz NOT NULL DEFAULT now()
);

-- Login próprio (AUTH_MODE=local)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha_hash text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo boolean NOT NULL DEFAULT true;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS trocar_senha boolean NOT NULL DEFAULT false;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tentativas integer NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_ate timestamptz;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS criado_em timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_local_idx ON usuarios (lower(email)) WHERE senha_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS normas (
  id               text PRIMARY KEY,
  orgao            text NOT NULL CHECK (orgao IN ('BACEN','CMN','CVM','ANBIMA','Outro')),
  tipo             text NOT NULL,
  numero           text NOT NULL,
  chave            text NOT NULL UNIQUE,         -- órgão|tipo|número normalizados (evita duplicidade)
  data_publicacao  date,
  vigencia         date,
  prazo_adequacao  date,
  ementa           text NOT NULL,
  tema             text,
  link             text,
  status           text NOT NULL DEFAULT 'Nova'
                   CHECK (status IN ('Nova','Em análise','Aplicável','Não aplicável','Adequada','Revogada')),
  criticidade      text NOT NULL DEFAULT 'Média' CHECK (criticidade IN ('Alta','Média','Baixa')),
  responsavel      text,
  area             text,
  observacoes      text,
  origem           text,
  triada_em        date,                          -- quando saiu de "Nova"
  analisada_em     date,                          -- quando recebeu parecer de aplicabilidade
  criado_em        timestamptz NOT NULL DEFAULT now(),
  criado_por       text,
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  atualizado_por   text
);
CREATE INDEX IF NOT EXISTS normas_status_idx ON normas (status);
CREATE INDEX IF NOT EXISTS normas_orgao_idx ON normas (orgao);
CREATE INDEX IF NOT EXISTS normas_publicacao_idx ON normas (data_publicacao DESC);

CREATE TABLE IF NOT EXISTS acoes (
  id              text PRIMARY KEY,
  norma_id        text REFERENCES normas(id) ON DELETE SET NULL,
  descricao       text NOT NULL,
  gap             text,
  responsavel     text,
  area            text,
  prazo           date,
  status          text NOT NULL DEFAULT 'Aberta' CHECK (status IN ('Aberta','Em andamento','Concluída','Cancelada')),
  observacoes     text,
  concluida_em    date,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  criado_por      text,
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  atualizado_por  text
);
CREATE INDEX IF NOT EXISTS acoes_norma_idx ON acoes (norma_id);

CREATE TABLE IF NOT EXISTS evidencias (
  id            text PRIMARY KEY,
  acao_id       text REFERENCES acoes(id) ON DELETE CASCADE,  -- nulo enquanto o arquivo não foi vinculado
  nome          text NOT NULL,
  tipo          text NOT NULL,
  tamanho       integer NOT NULL,
  enviado_em    timestamptz NOT NULL DEFAULT now(),
  enviado_por   text
);
CREATE INDEX IF NOT EXISTS evidencias_acao_idx ON evidencias (acao_id);
-- Conteúdo do arquivo quando ARMAZENAMENTO=banco (padrão)
ALTER TABLE evidencias ADD COLUMN IF NOT EXISTS conteudo bytea;

CREATE TABLE IF NOT EXISTS obrigacoes (
  id                  text PRIMARY KEY,
  titulo              text NOT NULL,
  orgao               text NOT NULL,
  periodicidade       text NOT NULL CHECK (periodicidade IN ('Mensal','Bimestral','Trimestral','Semestral','Anual','Eventual')),
  proximo_vencimento  date,
  canal               text,
  norma_id            text REFERENCES normas(id) ON DELETE SET NULL,
  responsavel         text,
  area                text,
  descricao           text,
  ultimo_envio        date,
  concluida           boolean NOT NULL DEFAULT false,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  criado_por          text,
  atualizado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_por      text
);

CREATE TABLE IF NOT EXISTS obrigacao_envios (
  id             bigserial PRIMARY KEY,
  obrigacao_id   text NOT NULL REFERENCES obrigacoes(id) ON DELETE CASCADE,
  data           date NOT NULL,
  vencimento     date,
  obs            text,
  por            text,
  registrado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS envios_obrigacao_idx ON obrigacao_envios (obrigacao_id, data DESC);

-- Trilha de auditoria: somente inclusão. UPDATE e DELETE são bloqueados por trigger.
CREATE TABLE IF NOT EXISTS auditoria (
  id       text PRIMARY KEY,
  em       timestamptz NOT NULL DEFAULT now(),
  por      text,                                   -- id do usuário; nulo = captura automática
  acao     text NOT NULL,
  tipo     text NOT NULL,
  ref      text,
  detalhe  text
);
CREATE INDEX IF NOT EXISTS auditoria_em_idx ON auditoria (em DESC);

CREATE OR REPLACE FUNCTION auditoria_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A trilha de auditoria não pode ser alterada nem excluída';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auditoria_somente_inclusao ON auditoria;
CREATE TRIGGER auditoria_somente_inclusao BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_imutavel();

-- Estado da captura automática e configurações gerais
CREATE TABLE IF NOT EXISTS sistema (
  id             text PRIMARY KEY,
  dados          jsonb NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

-- Perfil "Área responsável": comenta e anexa evidências, sem alterar normas e itens
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_perfil_check'
                 AND pg_get_constraintdef(oid) LIKE '%Área responsável%') THEN
    ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_perfil_check
      CHECK (perfil IN ('Admin','Analista','Leitura','Área responsável'));
  END IF;
END $$;

-- Comentários em normas e ações: somente inclusão (não há edição nem exclusão pela tela)
CREATE TABLE IF NOT EXISTS comentarios (
  id        text PRIMARY KEY,
  norma_id  text REFERENCES normas(id) ON DELETE CASCADE,
  acao_id   text REFERENCES acoes(id) ON DELETE CASCADE,
  texto     text NOT NULL,
  por       text,
  em        timestamptz NOT NULL DEFAULT now(),
  CHECK (norma_id IS NOT NULL OR acao_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS comentarios_norma_idx ON comentarios (norma_id, em);
CREATE INDEX IF NOT EXISTS comentarios_acao_idx ON comentarios (acao_id, em);

-- Áreas de cada usuário do perfil "Área responsável" (vê só ações e obrigações dessas áreas)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS areas text[] NOT NULL DEFAULT '{}';

-- Acesso às obrigações regulatórias (perfil Área responsável): só quem o Admin marcar
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ver_obrigacoes boolean NOT NULL DEFAULT false;

-- Normas encaminhadas pelo Compliance para as áreas (aviso por e-mail; a área vê em "Normas recebidas")
CREATE TABLE IF NOT EXISTS encaminhamentos (
  id        text PRIMARY KEY,
  norma_id  text NOT NULL REFERENCES normas(id) ON DELETE CASCADE,
  area      text NOT NULL,
  mensagem  text,
  por       text,
  em        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS encaminhamentos_norma_idx ON encaminhamentos (norma_id, em DESC);
-- Prazo de 10 dias corridos para a área avaliar e o retorno dela (uma resposta por encaminhamento)
ALTER TABLE encaminhamentos ADD COLUMN IF NOT EXISTS prazo date;
ALTER TABLE encaminhamentos ADD COLUMN IF NOT EXISTS resposta text;
ALTER TABLE encaminhamentos ADD COLUMN IF NOT EXISTS respondido_em timestamptz;
ALTER TABLE encaminhamentos ADD COLUMN IF NOT EXISTS respondido_por text;

-- Critérios marcados na matriz de classificação de risco jurídico-regulatório (ids separados por ;)
ALTER TABLE normas ADD COLUMN IF NOT EXISTS criterios_risco text;
-- Retorno estruturado da área: aplicável ou não, plano de ação e data sugeridos
ALTER TABLE encaminhamentos ADD COLUMN IF NOT EXISTS aplicavel boolean;
ALTER TABLE encaminhamentos ADD COLUMN IF NOT EXISTS plano_sugerido text;
ALTER TABLE encaminhamentos ADD COLUMN IF NOT EXISTS data_sugerida date;
-- Tipo de impacto quando aplicável: 'plano' (requer plano de ação) ou 'ajuste' (só ajustes pontuais)
ALTER TABLE encaminhamentos ADD COLUMN IF NOT EXISTS impacto text;
-- Segregação de funções: quem validou a conclusão da ação
ALTER TABLE acoes ADD COLUMN IF NOT EXISTS concluida_por text;
-- Lixeira: nada é apagado de vez (normas, ações, obrigações e evidências)
ALTER TABLE normas ADD COLUMN IF NOT EXISTS excluido_em timestamptz;
ALTER TABLE normas ADD COLUMN IF NOT EXISTS excluido_por text;
ALTER TABLE acoes ADD COLUMN IF NOT EXISTS excluido_em timestamptz;
ALTER TABLE acoes ADD COLUMN IF NOT EXISTS excluido_por text;
ALTER TABLE obrigacoes ADD COLUMN IF NOT EXISTS excluido_em timestamptz;
ALTER TABLE obrigacoes ADD COLUMN IF NOT EXISTS excluido_por text;
ALTER TABLE evidencias ADD COLUMN IF NOT EXISTS excluida_em timestamptz;
ALTER TABLE evidencias ADD COLUMN IF NOT EXISTS excluida_por text;
-- Impressão digital (SHA-256) do arquivo de evidência, gravada no envio
ALTER TABLE evidencias ADD COLUMN IF NOT EXISTS hash text;
