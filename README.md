# Calculadora FCT — AiTiPro

Calculadora pública do saldo do **Fundo de Compensação do Trabalho (FCT)**. Uma empresa indica setor, nº de trabalhadores e ano de constituição; a app estima o saldo acumulado em três cenários e capta o contacto como lead da AiTiPro.

> **Contexto comercial:** o FCT pode ser resgatado para formação certificada DGERT até **31 dez 2026**. A AiTiPro é entidade formadora; esta ferramenta é o topo de funil que gera leads qualificados.

URL de produção pretendido: **https://calculadora-fct.aitipro.com**

---

## Arquitectura

```
public/index.html      Front-end single-file (HTML + CSS + JS vanilla). Cálculo 100% client-side.
api/lead.js            Serverless function (Vercel). POST /api/lead → grava na Neon + email Resend.
vercel.json            Headers CORS para /api.
package.json           Dependências do serverless (@neondatabase/serverless, resend).
```

Sem framework, sem build step. O front-end é estático; a única parte server-side é a captura de lead.

### Fluxo de lead (degradação graciosa)

1. Front-end faz `POST /api/lead` com os dados do formulário + a estimativa calculada.
2. `api/lead.js`:
   - Sem `DATABASE_URL` → devolve **503** → o front-end cai no **fallback `mailto:`** (abre o email do visitante). Nenhum lead se perde.
   - Com `DATABASE_URL` → `INSERT` na tabela Neon `leads_fct_calc`.
   - Com `RESEND_API_KEY` → envia também email de notificação (best-effort; não bloqueia o insert).
   - Rate-limit por IP anonimizado; se `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` existirem, o limite é durável entre instâncias.

---

## Modelo de cálculo do saldo FCT

Fórmula por trabalhador:

```
saldo_por_trabalhador = salario_base_medio × 0,00925 × meses_contribuicao × fator_permanencia
saldo_total = saldo_por_trabalhador × n_trabalhadores
```

- **Taxa:** 0,925% (contribuição obrigatória entre out/2013 e mai/2023).
- **meses_contribuicao:** máx. 116 (período completo). Empresas constituídas depois de 2013 usam `(2023 − ano) × 12 + 5`, com cap em 116. Constituídas em 2024+ → 0.
- **fator_permanencia:** ajuste por rotatividade do setor (rotativos baixos, estáveis altos).
- **Três cenários:** conservador / base / otimista variam salário e fator dentro da banda do setor. Se o utilizador indicar um salário, ancora os 3 cenários nele (±10% / base / +12%).

As bandas por setor estão na constante `SETORES` em `public/index.html` (fonte: knowledge base AiTiPro, abril 2026). Margem assumida ±30% — a app mostra sempre o disclaimer de verificação oficial em `fundoscompensacao.pt`.

> **Fonte da verdade dos números:** se actualizares as bandas salariais ou fatores, edita `public/index.html` (constante `SETORES`) e este README em conjunto.

---

## Base de dados (Neon Postgres)

Projecto Neon: `cool-bird-69912607` (`aitipro-ltx-fct`), db `neondb`. Partilhado com o projecto LTX (tabela `selections_ltx`, não tocada).

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
-- índices: submitted_at DESC, email
```

Ver leads: Neon Console → projecto `cool-bird-69912607` → SQL Editor →
`SELECT * FROM leads_fct_calc ORDER BY submitted_at DESC;`

---

## Variáveis de ambiente

Definidas no Vercel (Project → Settings → Environment Variables). **Nunca** no código nem no git.

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | sim (para gravar leads) | Connection string Postgres da Neon |
| `HUBSPOT_TOKEN` | não | Upsert best-effort do contacto no HubSpot CRM |
| `RESEND_API_KEY` | não | Notificação por email a cada lead |
| `LEAD_ALERT_EMAIL` | não | Destinatário(s), default `bilal.machraa@aitipro.com` |
| `LEAD_ALERT_FROM` | não | Remetente Resend, default `onboarding@resend.dev` |
| `LEAD_ALLOWED_ORIGINS` | não | Lista CORS separada por vírgulas; default inclui domínio de produção e localhost |
| `LEAD_RATE_LIMIT_MAX` | não | Máximo de submissões por IP anonimizado/janela, default `12` |
| `LEAD_RATE_LIMIT_WINDOW_SEC` | não | Janela do rate-limit em segundos, default `900` |
| `UPSTASH_REDIS_REST_URL` | não | Backend durável opcional para rate-limit |
| `UPSTASH_REDIS_REST_TOKEN` | não | Token Upstash REST; nunca commitar |
| `ANALYTICS_ALLOWED_ORIGINS` | não | Lista CORS do proxy Umami; se ausente usa `LEAD_ALLOWED_ORIGINS` |

Para desenvolvimento local, criar `.env.local` (já no `.gitignore`) com as mesmas chaves.

---

## Desenvolvimento e deploy

```bash
# testes determinísticos do cálculo
npm test

# checks de sintaxe das APIs + testes
npm run check

# correr localmente (com Vercel CLI)
vercel dev

# deploy para produção
vercel deploy --prod
```

Ver `DEPLOY.md` para o passo-a-passo completo (link ao team correcto, env vars, subdomínio).

---

## Estado e próximos passos

- [x] Calculadora + 3 cenários + secção informativa + 6 passos de resgate
- [x] Captura de lead com fallback mailto
- [x] Tabela Neon `leads_fct_calc`
- [x] SEO social card + robots/sitemap + JSON-LD
- [x] Testes determinísticos de cálculo (`npm test`)
- [ ] Deploy em produção no team AiTiPro + subdomínio `calculadora-fct.aitipro.com`
- [ ] (opcional) Página `/admin` protegida por token para listar leads sem entrar no Neon
- [ ] (opcional) Sugestão automática de mix de módulos de formação consoante o setor

## Notas

- O cálculo é determinístico e client-side: não há backend para o saldo, só para o lead.
- RGPD: a tabela guarda só o que o lead submete voluntariamente + a sua estimativa. Sem dados sensíveis.
- Identidade visual: design tokens AiTiPro embebidos no `<style>` de `index.html` (teal `#2ae5a0`, navy `#1e2d3d`, Inter).
