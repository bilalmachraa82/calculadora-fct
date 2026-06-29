import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function extractRequired(pattern, label) {
  const match = html.match(pattern);
  assert.ok(match, `Nao foi possivel extrair ${label} de public/index.html`);
  return match[0];
}

const setoresSnippet = extractRequired(/var SETORES = \{[\s\S]*?\n  \};/, 'SETORES');
const taxaSnippet = extractRequired(/var TAXA = [0-9.]+;/, 'TAXA');
const mesesMaxSnippet = extractRequired(/var MESES_MAX = [0-9]+;/, 'MESES_MAX');
const mesesFnSnippet = extractRequired(/function mesesContribuicao\(ano\)\{[\s\S]*?\n  \}/, 'mesesContribuicao');

const sandbox = {};
vm.runInNewContext(`
  ${setoresSnippet}
  ${taxaSnippet}
  ${mesesMaxSnippet}
  ${mesesFnSnippet}
  this.SETORES = SETORES;
  this.TAXA = TAXA;
  this.MESES_MAX = MESES_MAX;
  this.mesesContribuicao = mesesContribuicao;
`, sandbox);

function calcularEstimativa({ setorKey, nTrab, anoConst, salario }) {
  const setor = sandbox.SETORES[setorKey];
  assert.ok(setor, `Setor desconhecido: ${setorKey}`);
  const meses = sandbox.mesesContribuicao(anoConst);

  const salCons = salario ? salario * 0.90 : setor.salario[0];
  const salBase = salario || setor.salario[1];
  const salOtim = salario ? salario * 1.12 : setor.salario[2];

  const saldoPorTrab = (sal, factor) => sal * sandbox.TAXA * meses * factor;
  return {
    meses,
    saldoCons: Math.round(saldoPorTrab(salCons, setor.factor[0]) * nTrab),
    saldoBase: Math.round(saldoPorTrab(salBase, setor.factor[1]) * nTrab),
    saldoOtim: Math.round(saldoPorTrab(salOtim, setor.factor[2]) * nTrab),
  };
}

assert.equal(sandbox.MESES_MAX, 116);
assert.equal(sandbox.mesesContribuicao(2013), 116, 'ano <= 2013 deve usar periodo completo');
assert.equal(sandbox.mesesContribuicao(2014), 113, '2014 deve remover 3 meses do periodo completo');
assert.equal(sandbox.mesesContribuicao(2023), 5, '2023 deve contar jan-mai');
assert.equal(sandbox.mesesContribuicao(2024), 0, 'ano >= 2024 nao tem contribuicoes FCT');

assert.deepEqual(
  calcularEstimativa({ setorKey: 'contabilidade', nTrab: 15, anoConst: 2010 }),
  { meses: 116, saldoCons: 11508, saldoBase: 14968, saldoOtim: 18831 },
  'cenario setorial contabilidade deve manter valores deterministas',
);

assert.deepEqual(
  calcularEstimativa({ setorKey: 'contabilidade', nTrab: 10, anoConst: 2013, salario: 2000 }),
  { meses: 116, saldoCons: 10623, saldoBase: 12876, saldoOtim: 15623 },
  'salario manual deve ancorar os tres cenarios',
);

assert.deepEqual(
  calcularEstimativa({ setorKey: 'retalho', nTrab: 25, anoConst: 2024 }),
  { meses: 0, saldoCons: 0, saldoBase: 0, saldoOtim: 0 },
  'empresa constituida em 2024+ deve devolver saldo zero',
);

console.log('calculo.test.mjs: ok');
