import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)?.[1];
assert.ok(script, 'inline script not found');

const start = script.indexOf('const SETORES_DIAG =');
const sectorsEnd = script.indexOf('const TOOL_LABEL =');
const helpersStart = script.indexOf('function finiteNumber');
const helpersEnd = script.indexOf('function diagnosticSectorKey()');
assert.ok(start > -1, 'SETORES_DIAG block not found');
assert.ok(sectorsEnd > start, 'SETORES_DIAG block end marker not found');
assert.ok(helpersStart > sectorsEnd, 'diagnose helper block not found');
assert.ok(helpersEnd > helpersStart, 'diagnose block end marker not found');

const sandbox = {};
vm.runInNewContext(`${script.slice(start, sectorsEnd)}
${script.slice(helpersStart, helpersEnd)}
result = {
  setores: Object.keys(SETORES_DIAG),
  contabilidade: diagnose({
    setorKey: 'contabilidade',
    horasRepetitivas: 22,
    existiaAntes2023: 'sim'
  }),
  fallback: diagnose({
    setorKey: 'inexistente',
    horasRepetitivas: 10,
    existiaAntes2023: 'nao'
  }, {
    custoHora: 30,
    recuperavel: 0.5
  })
};`, sandbox);

assert.ok(sandbox.result.setores.includes('contabilidade'));
assert.equal(sandbox.result.contabilidade.setorLabel, 'contabilidade / fiscalidade');
assert.equal(sandbox.result.contabilidade.custoHora, 26);
assert.equal(sandbox.result.contabilidade.fctElegivel, true);
assert.ok(sandbox.result.contabilidade.agentes.some((agent) => /faturas/i.test(agent.nome)));
assert.ok(sandbox.result.contabilidade.benchmark.includes('escritórios'));

assert.equal(sandbox.result.fallback.setorKey, 'outro');
assert.equal(sandbox.result.fallback.custoHora, 30);
assert.equal(sandbox.result.fallback.recuperavel, 0.5);
assert.equal(Math.round(sandbox.result.fallback.mensal), 650);
assert.equal(sandbox.result.fallback.fctElegivel, false);

console.log('diagnostico.test.mjs: ok');
