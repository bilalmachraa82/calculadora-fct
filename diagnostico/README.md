# Diagnóstico de Agentes de IA — AiTiPro

Página única para converter visitantes em leads qualificados para formação e implementação de agentes de IA. Mantém a mesma filosofia da calculadora FCT: HTML/CSS/JS vanilla, sem build step, com API Vercel a gravar na Neon.

## Ficheiros principais

- `index.html` — experiência completa: diagnóstico, formulário RGPD, resultado ajustável e CTA por email.
- `api/lead.js` — função serverless Vercel. Valida, limita abuso básico e grava em `diagnostico_leads`.
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
```

Notas:

- `DATABASE_URL` vive apenas no Vercel/ambiente local. Nunca no código.
- A API usa query parametrizada via `@neondatabase/serverless`.
- O rate limit em memória é uma mitigação leve por instância serverless; para quota distribuída, usar Upstash/Vercel KV ou WAF.
- Não alterar a tabela `diagnostico_leads` sem migração explícita.

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

- 6 perguntas do diagnóstico.
- Validação de nome, email, empresa e consentimento.
- Resultado ajustável com sliders.
- Fallback por email se `/api/lead` não estiver disponível localmente.

Para testar a API com Vercel:

```bash
vercel dev
```

Com `DATABASE_URL` ausente, o endpoint deve devolver indisponibilidade controlada e a página deve manter o resultado visível.
