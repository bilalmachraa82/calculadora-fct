# Diagnóstico de Agentes de IA — AiTiPro

Página única para converter visitantes em leads qualificados para formação e implementação de agentes de IA. Mantém a mesma filosofia da calculadora FCT: HTML/CSS/JS vanilla, sem build step, com API Vercel a gravar na Neon.

## Ficheiros principais

- `index.html` — experiência completa: diagnóstico, preview gratuito antes do gate, formulário RGPD, análise animada, análise NIF/CAE opcional, relatório premium ajustável e CTA de marcação.
- `api/lead.js` — função serverless Vercel. Valida, limita abuso básico e grava em `diagnostico_leads`.
- `api/company-enrichment.js` — consulta pontual a VIES para NIPC de empresa, com consentimento e fallback silencioso.
- `robots.txt` e `sitemap.xml` — indexação do subdomínio `diagnostico.aitipro.com`.
- `aitipro_logo_principal.png`, `favicon.svg`, `social-card.png` — assets usados pela página.

## Variáveis de ambiente

Obrigatória:

```bash
DATABASE_URL=postgres://...
```

Opcionais:

```bash
DIAGNOSTICO_ALLOWED_ORIGINS=https://diagnostico.aitipro.com,https://www.diagnostico.aitipro.com
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=12
RATE_LIMIT_SALT=valor_aleatorio
# Rate-limit durável (recomendado em produção — o limite em memória é por-instância serverless):
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...
# Notificação por email a cada lead (best-effort; não bloqueia o INSERT):
RESEND_API_KEY=re_...
LEAD_ALERT_EMAIL=bilal.machraa@aitipro.com
LEAD_ALERT_FROM=AiTiPro Diagnóstico <onboarding@resend.dev>
```

Notas:

- `DATABASE_URL` vive apenas no Vercel/ambiente local. Nunca no código.
- A API usa query parametrizada via `@neondatabase/serverless`.
- O rate limit usa Upstash quando configurado; sem `UPSTASH_*` recorre a um limite em memória (best-effort, por instância serverless).
- A notificação Resend é opcional: sem `RESEND_API_KEY` é ignorada; com ela envia um email formatado por lead.
- Não alterar a tabela `diagnostico_leads` sem migração explícita (ver `migration.sql`).
- `BOOKING_URL` está em `index.html` como URL Cal.com/Calendly de arranque. Trocar pelo link real antes de produção se o slug mudar.

## Enriquecimento por NIF/CAE

- O NIF é opcional. Se parecer NIPC de empresa (`5/6/7/9`) e houver consentimento, a página chama `/api/company-enrichment`.
- A função consulta VIES (`ec.europa.eu`) para validar número IVA/PT e, quando disponível, nome público. VIES não devolve CAE.
- O CAE é opcional e tratado localmente: valida divisão, identifica alguns códigos exactos e escolhe o setor de diagnóstico. O relatório mostra sempre que a recomendação é indicativa.
- Não há scraping no browser. Se no futuro houver provider/licença para CAE por NIPC, deve entrar pela função serverless e expor fonte, data e confiança.

## Base de dados (Neon)

Antes do primeiro deploy, executar `migration.sql` uma vez no Neon Console
(projecto `cool-bird-69912607`, db `neondb`). A tabela `diagnostico_leads` é
dedicada e não partilha dados com `leads_fct_calc` nem `selections_ltx`.

```sql
SELECT id, submitted_at, nome, empresa, email, urgencia, lead_score, perda_estimada_mensal
FROM diagnostico_leads ORDER BY submitted_at DESC;
```

## Deploy Vercel

```bash
cd "/Volumes/Crucial X9/Fundos compensaçao trabalho calculador/calculadora-fct/diagnostico"
npm install
vercel
vercel env add DATABASE_URL production
vercel --prod
```

Domínio esperado: `diagnostico.aitipro.com`.

## Verificação local

```bash
npm run check
npm run audit:deps
python3 -m http.server 4174
```

Depois abrir `http://127.0.0.1:4174` e testar:

- Preview gratuito antes do formulário: valor mensal, 1.º agente e benchmark aparecem antes de pedir email.
- 9 perguntas do diagnóstico.
- Validação de nome, email, empresa, consentimento, telefone opcional, NIF opcional e CAE opcional.
- Resultado ajustável com sliders.
- Estado animado de análise antes de revelar a resposta, incluindo tentativa de enriquecimento VIES quando aplicável.
- Relatório composto com sumário executivo, leitura NIF/CAE, cenários de impacto, matriz de prioridade, foco prioritário, urgência, plano de 14 dias, roadmap 30/60/90, riscos, métricas e agenda da sessão.
- Cross-sell FCT quando a empresa indica que já tinha trabalhadores antes de 2023, com link para a calculadora FCT.
- `npm test` valida o modelo `diagnose()` usado para agentes, custo/hora, % recuperável e FCT.
- Fallback por email se `/api/lead` não estiver disponível localmente.

Para testar a API com Vercel:

```bash
vercel dev
```

Com `DATABASE_URL` ausente, o endpoint deve devolver indisponibilidade controlada e a página deve manter o resultado visível.
