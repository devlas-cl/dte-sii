/**
 * `CertRunner.precargarPlanDeCorrida()`: arma el plan de timbraje desde los sets cargados,
 * para que el consumidor no duplique los `cafRequired` de cada set.
 *
 * Lo que de verdad protege este archivo es el caso de los modos de set aislado: `_estructuras`
 * se rehidrata desde disco y puede traer los cuatro sets aunque la corrida ejecute uno solo.
 * Si se precargaran todos, se timbrarían folios de sets que nadie va a emitir y quedarían
 * autorizados sin usar, que es exactamente el gatillo del racionamiento del SII que este
 * método viene a evitar. Por eso recibe qué sets se van a ejecutar.
 */
const assert = require('assert');
const CertRunner = require('../cert/CertRunner');

/** Runner sin red: solo interesa qué planes arma antes de delegar en precargarCafsDeSets. */
function runnerCon(estructuras) {
  const runner = Object.create(CertRunner.prototype);
  runner._estructuras = estructuras;
  runner.planesRecibidos = null;
  runner.precargarCafsDeSets = async (planes) => {
    runner.planesRecibidos = planes;
    return { fake: true };
  };
  return runner;
}

/** Las cuatro estructuras presentes, como quedan tras rehidratar desde disco. */
const LAS_CUATRO = {
  setBasico:        { cafRequired: { 33: 4, 56: 1, 61: 3 } },
  setGuiaDespacho:  { cafRequired: { 52: 3 } },
  setFacturaExenta: { cafRequired: { 34: 3, 56: 1, 61: 4 } },
  setFacturaCompra: { cafRequired: { 46: 1, 56: 1, 61: 1 } },
};

async function main() {
  // ── Corrida completa: el default toma los cuatro ──────────────────────────
  {
    const runner = runnerCon(LAS_CUATRO);
    await runner.precargarPlanDeCorrida();
    assert.strictEqual(runner.planesRecibidos.length, 4, 'la corrida completa arma 4 planes');
  }

  // ── Set aislado: NO puede colarse el resto aunque estén en _estructuras ────
  {
    const runner = runnerCon(LAS_CUATRO);
    await runner.precargarPlanDeCorrida(['basico']);
    assert.deepStrictEqual(
      runner.planesRecibidos,
      [{ 33: 4, 56: 1, 61: 3 }],
      'con un solo set pedido no se timbran folios de los otros tres'
    );
  }

  // ── Set opcional ausente: se salta sin romper ─────────────────────────────
  {
    const sinGuia = { ...LAS_CUATRO };
    delete sinGuia.setGuiaDespacho;
    const runner = runnerCon(sinGuia);
    await runner.precargarPlanDeCorrida();
    assert.strictEqual(runner.planesRecibidos.length, 3, 'un set ausente no aporta plan');
  }

  // ── Sin cafRequired: cae al fallback de CAF_POR_SET ───────────────────────
  // El de guía depende de los casos; el default de 3 sale de tráfico real (17 corridas).
  {
    const runner = runnerCon({ setGuiaDespacho: { casos: [1, 2, 3, 4, 5] } });
    await runner.precargarPlanDeCorrida(['guia']);
    assert.deepStrictEqual(runner.planesRecibidos, [{ 52: 5 }], 'usa la cantidad real de casos');
  }
  {
    const runner = runnerCon({ setGuiaDespacho: {} });
    await runner.precargarPlanDeCorrida(['guia']);
    assert.deepStrictEqual(runner.planesRecibidos, [{ 52: 3 }], 'sin casos, el fallback es 3');
  }

  // ── Ningún set pedido presente: no llama a precargarCafsDeSets ────────────
  {
    const runner = runnerCon({ setBasico: { cafRequired: { 33: 4 } } });
    const r = await runner.precargarPlanDeCorrida(['compra']);
    assert.strictEqual(runner.planesRecibidos, null, 'no timbra nada si no hay sets pedidos');
    assert.deepStrictEqual(r, {}, 'devuelve objeto vacío');
  }

  // ── Sin obtenerSets(): error explícito, no un timbraje vacío silencioso ────
  {
    const runner = Object.create(CertRunner.prototype);
    runner._estructuras = null;
    await assert.rejects(
      () => runner.precargarPlanDeCorrida(),
      /obtenerSets\(\) antes de precargarPlanDeCorrida/,
      'sin estructuras avisa qué falta'
    );
  }

  console.log('precargar-plan-corrida: 7 casos OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
