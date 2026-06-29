# Deploy · Calculadora FCT pública → calculadora-fct.aitipro.com

Subdomínio escolhido: **`calculadora-fct.aitipro.com`** (descritivo, partilhável em outreach e LinkedIn).

**Já feito por mim:**
- Tabela `leads_fct_calc` criada no projecto Neon **`cool-bird-69912607`** (`aitipro-ltx-fct`), na db `neondb`. Coexiste com a `selections_ltx` da LTX — não foi tocada.
- `api/lead.js` reescrito para INSERT na tabela + email Resend best-effort.
- `package.json` com `@neondatabase/serverless` + `resend`.

**Falta isto (5 comandos teus no Terminal, ~5 min):**

---

## 1. Montar a pasta de deploy

```bash
cd "/Users/bilal/Documents/Claude/Projects/Fundo de compensaçao do Trabalho/deploy-vercel-calculadora"
mkdir -p public
cp "../Calculadora_FCT_AiTiPro.html" public/index.html
```

## 2. Linkar projecto Vercel

```bash
vercel link
# Conta: tua (team aitipro)
# Link to existing project? N → criar novo
# Nome sugerido: aitipro-calculadora-fct
```

> Se ainda não tens a CLI: `npm i -g vercel`

## 3. Configurar env vars

```bash
# (a) ligação à Neon — usa a MESMA connection string da LTX
vercel env add DATABASE_URL production
# Copia a connection string a partir do Neon Console (NUNCA commitar em git):
#   Neon Console → projecto cool-bird-69912607 → Dashboard → Connection string
# Formato esperado:
#   postgresql://<user>:<pass>@<host>/<db>?channel_binding=require&sslmode=require
#
# ⚠ Se este ficheiro alguma vez teve uma connection string em texto claro
#   (versões anteriores), considera essa credencial COMPROMETIDA:
#   1) Rotar a password no Neon Console.
#   2) Actualizar DATABASE_URL no Vercel (production + preview).
#   3) Reescrever histórico Git (`git filter-repo`) e force-push.

# (b) Resend para receberes email a cada lead (opcional mas recomendado)
vercel env add RESEND_API_KEY production
# cola a tua chave Resend que já tens

# (c) opcional, se quiseres receber noutro email além do default
vercel env add LEAD_ALERT_EMAIL production
# ex.: bilal.machraa@aitipro.com,fernando@aitipro.com

# (d) opcional, mas recomendado se houver tráfego pago/outreach em escala:
# rate-limit durável para /api/lead sem alterar a tabela Neon
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production

# (e) opcional: restringir origem de lead/analytics se mudares domínio ou porta local
vercel env add LEAD_ALLOWED_ORIGINS production
vercel env add ANALYTICS_ALLOWED_ORIGINS production
```

## 4. Deploy

```bash
vercel deploy --prod
```

Recebes o URL temporário `https://aitipro-calculadora-fct.vercel.app` — já está activo.

## 5. Apontar o subdomínio aitipro.com

```bash
vercel domains add calculadora-fct.aitipro.com aitipro-calculadora-fct
```

URL final: **https://calculadora-fct.aitipro.com**

Como o `aitipro.com` já é gerido pela tua conta Vercel (o `formacao-ai-ltx.aitipro.com` já lá vive), o HTTPS fica activo em segundos. Se a CLI pedir um CNAME, segue as instruções.

---

## Comportamento do site

- **Sem `DATABASE_URL`:** o `/api/lead` devolve 503 → o front-end cai automaticamente no mailto. Não perdes leads — o visitante envia por email.
- **Com `DATABASE_URL` só:** lead grava no Neon, sem email automático. Vês os leads em `SELECT * FROM leads_fct_calc ORDER BY submitted_at DESC` no Neon Console.
- **Com `DATABASE_URL` + `RESEND_API_KEY`:** lead grava no Neon **e** recebes email formatado (com a estimativa que a pessoa calculou) em `LEAD_ALERT_EMAIL`.
- **Com `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`:** o rate-limit de leads fica durável entre instâncias Vercel. Sem Upstash, há fallback em memória por instância.

## Ver os leads recebidos

**Neon Console (SQL editor):**
```
https://console.neon.tech/app/projects/cool-bird-69912607
→ SQL Editor → SELECT id, submitted_at, nome, empresa, email, telefone, setor, n_trab, saldo_base FROM leads_fct_calc ORDER BY submitted_at DESC;
```

Também posso consultar daqui via MCP — basta pedires "vê os leads novos da calculadora".

---

## Estrutura da pasta

```
deploy-vercel-calculadora/
├── public/index.html      ← calculadora (copiada no passo 1)
├── api/lead.js            ← grava no Neon + email Resend
├── package.json           ← @neondatabase/serverless + resend
├── vercel.json            ← headers CORS para /api
└── DEPLOY.md              ← este ficheiro
```

## Esquema da tabela

```sql
CREATE TABLE leads_fct_calc (
  id            BIGSERIAL PRIMARY KEY,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  nome          TEXT NOT NULL,
  empresa       TEXT NOT NULL,
  email         TEXT NOT NULL,
  telefone      TEXT,
  setor         TEXT,
  n_trab        INTEGER,
  ano_const     INTEGER,
  saldo_base    INTEGER,
  saldo_cons    INTEGER,
  saldo_otim    INTEGER,
  meses         INTEGER,
  user_agent    TEXT,
  referer       TEXT
);
-- + índice em submitted_at DESC e em email
```

## Custos

- **Neon Free Tier:** já tens. 0,5 GB storage, autosuspend. Para leads (texto puro), é virtualmente ilimitado em escala razoável.
- **Vercel Hobby:** chega para esta calculadora pública.
- **Resend Free:** 3.000 emails/mês — mais do que suficiente.
- **Total:** 0 €/mês.

## Segurança / RGPD

- A connection string do Neon e a chave Resend vivem **só** nas env vars do Vercel — nunca no código fonte nem no git.
- A tabela guarda apenas o que o lead **voluntariamente** submeteu + a sua estimativa. Os campos técnicos `user_agent` e `referer` existem no schema legado, mas a API envia `NULL` por minimização RGPD.
- Pode pedir-se a eliminação ao Bilal — `DELETE FROM leads_fct_calc WHERE email = '…'`.
- Nenhum dado sensível (NIF, IBAN, salários de trabalhadores reais) é capturado.
