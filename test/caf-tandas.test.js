// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * `FolioService.solicitarCafPorTandas()`: juntar N folios en varios timbrajes cuando el
 * SII no autoriza tantos de una vez.
 *
 * El caso que lo motivó: el set de simulación necesita 4 folios de tipo 33, el SII
 * autoriza 3 y FOLIOS_DISP=0. Con folios disponibles en 0 no hay nada que anular ni que
 * reobtener (las dos operaciones trabajan sobre ese mismo conjunto), y el tope no se
 * mueve esperando: medido el 19/08/2026 contra maullin, idéntico 24 horas y tres
 * corridas después.
 *
 * Se ejecuta con `node test/caf-tandas.test.js`, sin red ni SII.
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const FolioService = require('../FolioService');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-tandas-'));
let seq = 0;

/** CAF mínimo: `_contarFoliosCaf` solo lee el rango, no parsea la llave. */
function cafDe(desde, hasta) {
  const p = path.join(raiz, `caf-${++seq}.xml`);
  fs.writeFileSync(p, `<AUTORIZACION><CAF><DA><RNG><D>${desde}</D><H>${hasta}</H></RNG></DA></CAF></AUTORIZACION>`);
  return p;
}

/**
 * @param {Array} guion - por tanda: el tope que ve y cuántos folios entrega el SII.
 */
function servicioFalso(guion) {
  const svc = Object.create(FolioService.prototype);
  const pedidos = [];
  let i = 0;
  let folio = 100;

  svc.consultarTope = async () => {
    const paso = guion[Math.min(i, guion.length - 1)];
    return paso.tope;
  };
  svc.cafSolicitor = {
    solicitar: async ({ cantidad }) => {
      const paso = guion[Math.min(i, guion.length - 1)];
      i++;
      pedidos.push(cantidad);
      if (!paso.entrega) return { success: false, errorCode: paso.errorCode || 'MAX_AUTOR_INSUFICIENTE', error: 'sin cupo' };
      const p = cafDe(folio, folio + paso.entrega - 1);
      folio += paso.entrega;
      return { success: true, cafPath: p };
    },
  };
  return { svc, pedidos };
}

// El cuerpo va dentro de una async: `require` y top-level await no conviven en CJS.
async function main() {
  // ── 1. 3 + 1 cubre un plan de 4 ─────────────────────────────────────────────────
  {
    const { svc, pedidos } = servicioFalso([
      { tope: { sinTope: false, maxAutor: 3, foliosDisp: 0 }, entrega: 3 },
      { tope: { sinTope: false, maxAutor: 1, foliosDisp: 3 }, entrega: 1 },
    ]);

    const r = await svc.solicitarCafPorTandas({ tipoDte: 33, cantidad: 4 });

    assert.strictEqual(r.ok, true, 'dos tandas cubren los 4 folios');
    assert.strictEqual(r.otorgados, 4);
    assert.strictEqual(r.cafPaths.length, 2, 'se devuelven los dos CAF, no solo el último');
    assert.deepStrictEqual(pedidos, [3, 1],
      'cada tanda pide el mínimo entre el tope del SII y lo que falta, nunca más');
    console.log('✓ Tandas: 3 + 1 cubre un plan de 4 sin pedir de más');
  }

  // ── 2. Sin cupo en la segunda tanda: falla, pero conserva lo timbrado ────────────
  //
  // Los folios de la primera tanda NO se pierden: quedan en disco y `_cafReusable` los
  // suma en el próximo intento. Devolverlos acá es lo que hace que el corte sea seguro.
  {
    const { svc, pedidos } = servicioFalso([
      { tope: { sinTope: false, maxAutor: 3, foliosDisp: 0 }, entrega: 3 },
      { tope: { sinTope: false, maxAutor: 0, foliosDisp: 3 }, entrega: 0 },
    ]);

    const r = await svc.solicitarCafPorTandas({ tipoDte: 33, cantidad: 4 });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorCode, 'TOPE_SII_INSUFICIENTE');
    assert.strictEqual(r.otorgados, 3, 'informa cuánto alcanzó a cubrir');
    assert.strictEqual(r.cafPaths.length, 1, 'y devuelve el CAF ya timbrado en vez de descartarlo');
    assert.deepStrictEqual(pedidos, [3], 'con MAX_AUTOR=0 no se hace el request: se corta antes');
    assert.match(r.error, /FOLIOS_DISP=3/, 'el mensaje trae los números del SII para poder auditarlo');
    console.log('✓ Tandas: sin cupo corta y conserva lo timbrado, sin insistir');
  }

  // ── 3. Una tanda que no entrega nada corta el ciclo ─────────────────────────────
  //
  // Insistir sería gratis en apariencia y caro de verdad: cada timbraje parcial sube
  // FOLIOS_DISP y puede bajar el tope de la siguiente.
  {
    const { svc, pedidos } = servicioFalso([
      { tope: { sinTope: false, maxAutor: 2, foliosDisp: 0 }, entrega: 0, errorCode: 'MAX_AUTOR_EXCEEDED' },
    ]);

    const r = await svc.solicitarCafPorTandas({ tipoDte: 33, cantidad: 4 });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.otorgados, 0);
    assert.strictEqual(pedidos.length, 1, 'no se reintenta lo que el SII acaba de negar');
    console.log('✓ Tandas: una tanda vacía corta, no entra en bucle');
  }

  // ── 4. Sin racionamiento se pide todo de una ───────────────────────────────────
  {
    const { svc, pedidos } = servicioFalso([
      { tope: { sinTope: true, maxAutor: null, foliosDisp: null }, entrega: 7 },
    ]);

    const r = await svc.solicitarCafPorTandas({ tipoDte: 61, cantidad: 7 });

    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(pedidos, [7],
      'sin MAX_AUTOR publicado el SII no está limitando: partir el pedido sería gastar viajes');
    console.log('✓ Tandas: sin tope publicado se pide el rango completo de una vez');
  }

  // ── 5. `maxTandas` acota el peor caso ──────────────────────────────────────────
  {
    const { svc, pedidos } = servicioFalso([
      { tope: { sinTope: false, maxAutor: 1, foliosDisp: 0 }, entrega: 1 },
    ]);

    const r = await svc.solicitarCafPorTandas({ tipoDte: 33, cantidad: 10, maxTandas: 3 });

    assert.strictEqual(r.ok, false, 'de a 1 folio no llega a 10 en 3 tandas');
    assert.strictEqual(pedidos.length, 3, 'y no sigue pidiendo indefinidamente');
    console.log('✓ Tandas: maxTandas acota los viajes al portal');
  }

  // ── 6. El tope ya consultado no se vuelve a sondear ────────────────────────────
  //
  // `consultarTope` cuesta ~3 requests al portal y `CertRunner` ya lo hizo antes de decidir
  // la estrategia. Repetirlo era gasto puro.
  {
    const { svc } = servicioFalso([
      { tope: { sinTope: false, maxAutor: 4, foliosDisp: 0 }, entrega: 4 },
    ]);
    let sondeos = 0;
    const original = svc.consultarTope;
    svc.consultarTope = async (...args) => { sondeos++; return original(...args); };

    const r = await svc.solicitarCafPorTandas({
      tipoDte: 33, cantidad: 4,
      topeInicial: { sinTope: false, maxAutor: 4, foliosDisp: 0 },
    });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(sondeos, 0, 'con topeInicial la primera tanda no sondea de nuevo');
    console.log('✓ Tandas: el tope ya consultado se reusa en la primera tanda');
  }

  fs.rmSync(raiz, { recursive: true, force: true });
  console.log('\nTodos los checks de tandas de CAF pasaron.');
}

main().catch((err) => { console.error(err); process.exit(1); });
