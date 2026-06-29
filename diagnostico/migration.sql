-- Migração do Diagnóstico de Agentes de IA — AiTiPro
-- Projecto Neon: cool-bird-69912607 (db: neondb).
-- Tabela dedicada (NÃO toca em leads_fct_calc nem em selections_ltx).
--
-- CORRER UMA VEZ no Neon Console (SQL Editor) antes do primeiro deploy.
-- O INSERT em api/lead.js usa exatamente estas colunas; id/submitted_at têm defaults.

CREATE TABLE IF NOT EXISTS diagnostico_leads (
  id                         BIGSERIAL PRIMARY KEY,
  submitted_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  nome                       TEXT NOT NULL,
  email                      TEXT NOT NULL,
  telefone                   TEXT,
  empresa                    TEXT NOT NULL,
  cargo                      TEXT,
  objetivo                   TEXT,
  nif                        TEXT,
  nif_valido                 BOOLEAN,
  nif_tipo                   TEXT,
  cae                        TEXT,
  cae_divisao                INTEGER,
  cae_sector                 TEXT,
  website_empresa            TEXT,
  janela_contacto            TEXT,
  setor                      TEXT,
  colaboradores              TEXT,
  leads_semana               TEXT,
  tempo_resposta             TEXT,
  horas_repetitivas          TEXT,
  dor_prioritaria            TEXT,
  prazo_decisao              TEXT,
  existia_antes_2023         TEXT,
  ferramentas                TEXT[],
  perda_estimada_mensal      INTEGER,
  assuncao_custo_hora        INTEGER,
  assuncao_pct_recuperavel   INTEGER,
  assuncao_valor_lead        INTEGER,
  agentes_sugeridos          TEXT[],
  lead_score                 INTEGER,
  urgencia                   TEXT,
  enriquecimento_estado      TEXT,
  enriquecimento_empresa     TEXT[],
  relatorio_executivo        TEXT[],
  cenarios_impacto           TEXT[],
  matriz_prioridade          TEXT[],
  plano_14_dias              TEXT[],
  roadmap_90_dias            TEXT[],
  riscos_governanca          TEXT[],
  metricas_sucesso           TEXT[],
  agenda_reuniao             TEXT[],
  consentimento_rgpd         BOOLEAN NOT NULL,
  origem                     TEXT
);

ALTER TABLE diagnostico_leads
  ADD COLUMN IF NOT EXISTS cargo TEXT,
  ADD COLUMN IF NOT EXISTS objetivo TEXT,
  ADD COLUMN IF NOT EXISTS nif TEXT,
  ADD COLUMN IF NOT EXISTS nif_valido BOOLEAN,
  ADD COLUMN IF NOT EXISTS nif_tipo TEXT,
  ADD COLUMN IF NOT EXISTS cae TEXT,
  ADD COLUMN IF NOT EXISTS cae_divisao INTEGER,
  ADD COLUMN IF NOT EXISTS cae_sector TEXT,
  ADD COLUMN IF NOT EXISTS website_empresa TEXT,
  ADD COLUMN IF NOT EXISTS janela_contacto TEXT,
  ADD COLUMN IF NOT EXISTS dor_prioritaria TEXT,
  ADD COLUMN IF NOT EXISTS prazo_decisao TEXT,
  ADD COLUMN IF NOT EXISTS existia_antes_2023 TEXT,
  ADD COLUMN IF NOT EXISTS lead_score INTEGER,
  ADD COLUMN IF NOT EXISTS urgencia TEXT,
  ADD COLUMN IF NOT EXISTS enriquecimento_estado TEXT,
  ADD COLUMN IF NOT EXISTS enriquecimento_empresa TEXT[],
  ADD COLUMN IF NOT EXISTS relatorio_executivo TEXT[],
  ADD COLUMN IF NOT EXISTS cenarios_impacto TEXT[],
  ADD COLUMN IF NOT EXISTS matriz_prioridade TEXT[],
  ADD COLUMN IF NOT EXISTS plano_14_dias TEXT[],
  ADD COLUMN IF NOT EXISTS roadmap_90_dias TEXT[],
  ADD COLUMN IF NOT EXISTS riscos_governanca TEXT[],
  ADD COLUMN IF NOT EXISTS metricas_sucesso TEXT[],
  ADD COLUMN IF NOT EXISTS agenda_reuniao TEXT[];

CREATE INDEX IF NOT EXISTS diagnostico_leads_submitted_at_idx
  ON diagnostico_leads (submitted_at DESC);
CREATE INDEX IF NOT EXISTS diagnostico_leads_email_idx
  ON diagnostico_leads (email);
CREATE INDEX IF NOT EXISTS diagnostico_leads_urgencia_idx
  ON diagnostico_leads (urgencia, lead_score DESC);

-- Ver leads:
-- SELECT id, submitted_at, nome, empresa, email, urgencia, lead_score, perda_estimada_mensal
-- FROM diagnostico_leads ORDER BY submitted_at DESC;
