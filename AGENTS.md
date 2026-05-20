# Guia para agentes (Codex / Claude Code / outros)

Lê primeiro o `README.md` — tem a arquitectura, o modelo de cálculo e o esquema da BD.

## Onde mexer

- **Front-end e lógica de cálculo:** `public/index.html` (ficheiro único, JS vanilla). A constante `SETORES` e a função `calcular()` são o núcleo. Não há build step.
- **Captura de lead:** `api/lead.js` (serverless Vercel, ESM). Validação + INSERT Neon + email Resend.
- **Config deploy:** `vercel.json`, `package.json`.

## Guardrails

- **Nunca** commitar segredos. `DATABASE_URL`, `RESEND_API_KEY` vivem só em env vars do Vercel / `.env.local` (gitignored).
- **Não** alterar o esquema da tabela `leads_fct_calc` sem migração explícita — é partilhada com o projecto LTX no mesmo Neon (`cool-bird-69912607`). A tabela `selections_ltx` é de outro projecto, não tocar.
- O cálculo do saldo é determinístico e client-side. Mantém-no testável: para um dado input, o output é fixo.
- Se mudares bandas salariais / fatores em `SETORES`, actualiza a secção correspondente do `README.md`.
- Português de Portugal no conteúdo visível. Jargão técnico em inglês é aceitável no código.

## Verificação antes de dar por concluído

- Abre `public/index.html` no browser e confirma que os 3 cenários calculam e que o formulário valida campos obrigatórios.
- Casos de fronteira do cálculo: ano ≤ 2013 → 116 meses; ano ≥ 2024 → 0; salário manual ancora os cenários.
- `vercel dev` e testar `POST /api/lead` (sem env → 503 + fallback; com env → 200 + insert).
