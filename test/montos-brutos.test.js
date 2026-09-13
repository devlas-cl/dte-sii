'use strict';

/**
 * Indicador Montos Brutos (MntBruto=1) en facturas, guías y notas con precioConIva.
 *
 * Antes, con precioConIva, la factura convertía cada línea a neto redondeando por unidad:
 * 2 x $1.000 quedaban en 2 x $840 = $1.680, IVA $319, total $1.999 por una venta de
 * $2.000. Repartir la diferencia entre líneas tampoco sirve: las líneas dejan de ser
 * cantidad x precio. El formato DTE del SII resuelve esto con el campo "Indicador Montos
 * Brutos": las líneas se declaran con IVA incluido y el Monto Neto es la suma dividida por
 * (1 + tasa). Probado en un ambiente de certificación: factura, nota de crédito, nota de
 * débito y guía aceptadas sin reparos, incluso cuando IVA = bruto - neto difiere en $1 de
 * neto x tasa.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const DTE = require('../DTE');
const MuestrasImpresas = require('../cert/MuestrasImpresas');

const EMISOR = { RUTEmisor: '76543210-K', RznSoc: 'EMPRESA EJEMPLO SPA', GiroEmis: 'Comercio', DirOrigen: 'Calle Falsa 123', CmnaOrigen: 'Santiago' };

function armar(tipo, items, extra = {}) {
  return new DTE({
    tipo, folio: 1, fechaEmision: '2026-09-13', emisor: EMISOR,
    receptor: { RUTRecep: '77111222-3', RznSocRecep: 'PROVEEDOR EJEMPLO SPA', GiroRecep: 'Comercio', DirRecep: 'Calle 1', CmnaRecep: 'Santiago' },
    items, precioConIva: true, ...extra,
  });
}
const enc = (dte) => dte.datos.Encabezado;
const sumaLineas = (dte) => dte.datos.Detalle.reduce((s, d) => s + d.MontoItem, 0);

test('factura con precioConIva: líneas iguales a lo cobrado, total = suma de líneas', () => {
  const dte = armar(33, [{ NmbItem: 'Producto', QtyItem: 2, PrcItem: 1000 }]);
  assert.equal(enc(dte).IdDoc.MntBruto, 1);
  assert.deepEqual(dte.datos.Detalle[0], { NroLinDet: 1, NmbItem: 'Producto', QtyItem: 2, PrcItem: 1000, MontoItem: 2000 });
  assert.deepEqual(enc(dte).Totales, { MntNeto: 1681, TasaIVA: 19, IVA: 319, MntTotal: 2000 });
});

test('el IVA se deriva del bruto aunque difiera en $1 de neto x tasa', () => {
  // 1018 / 1,19 = 855,46 -> 855; 855 x 0,19 = 162,45 -> 162, pero 1018 - 855 = 163.
  assert.deepEqual(enc(armar(33, [{ NmbItem: 'B', QtyItem: 1, PrcItem: 1018 }])).Totales,
    { MntNeto: 855, TasaIVA: 19, IVA: 163, MntTotal: 1018 });
  // 1005 / 1,19 = 844,54 -> 845; 845 x 0,19 = 160,55 -> 161, pero 1005 - 845 = 160.
  assert.deepEqual(enc(armar(33, [{ NmbItem: 'C', QtyItem: 1, PrcItem: 1005 }])).Totales,
    { MntNeto: 845, TasaIVA: 19, IVA: 160, MntTotal: 1005 });
});

test('afecto con exento: el exento no entra al neto y Totales respeta el orden del XSD', () => {
  const t = enc(armar(33, [
    { NmbItem: 'Afecto', QtyItem: 2, PrcItem: 1000 },
    { NmbItem: 'Exento', QtyItem: 1, PrcItem: 500, IndExe: 1 },
  ])).Totales;
  assert.deepEqual(Object.keys(t), ['MntNeto', 'MntExe', 'TasaIVA', 'IVA', 'MntTotal']);
  assert.deepEqual(t, { MntNeto: 1681, MntExe: 500, TasaIVA: 19, IVA: 319, MntTotal: 2500 });
});

test('nota de crédito, nota de débito y guía usan el mismo indicador', () => {
  for (const tipo of [52, 56, 61]) {
    const dte = armar(tipo, [{ NmbItem: 'X', QtyItem: 1, PrcItem: 1018 }]);
    assert.equal(enc(dte).IdDoc.MntBruto, 1, `tipo ${tipo}`);
    assert.equal(enc(dte).Totales.MntTotal, 1018, `tipo ${tipo}`);
  }
});

test('la boleta no cambia: brutos por defecto, sin MntBruto ni TasaIVA', () => {
  const e = enc(armar(39, [{ NmbItem: 'Producto', QtyItem: 2, PrcItem: 1000 }]));
  assert.equal(e.IdDoc.MntBruto, undefined);
  assert.deepEqual(e.Totales, { MntNeto: 1681, IVA: 319, MntTotal: 2000 });
});

test('sin precioConIva la factura sigue en neto y sin indicador', () => {
  const e = enc(armar(33, [{ NmbItem: 'Producto', QtyItem: 2, PrcItem: 840 }], { precioConIva: false }));
  assert.equal(e.IdDoc.MntBruto, undefined);
  assert.deepEqual(e.Totales, { MntNeto: 1680, TasaIVA: 19, IVA: 319, MntTotal: 1999 });
});

test('una factura solo con exentos no declara el indicador', () => {
  const e = enc(armar(33, [{ NmbItem: 'Exento', QtyItem: 1, PrcItem: 500, IndExe: 1 }]));
  assert.equal(e.IdDoc.MntBruto, undefined);
  assert.equal(e.Totales.IVA, undefined);
  assert.equal(e.Totales.MntTotal, 500);
});

test('MntBruto queda en IdDoc en la posición del XSD (después de IndServicio)', () => {
  const dte = armar(33, [{ NmbItem: 'Producto', QtyItem: 1, PrcItem: 1000 }], { indServicio: 3 });
  dte.generarXML();
  const claves = Object.keys(dte.documento.Documento.Encabezado.IdDoc);
  assert.deepEqual(claves, ['TipoDTE', 'Folio', 'FchEmis', 'IndServicio', 'MntBruto']);
});

test('granel y muchas líneas al azar: total = suma de líneas y neto + IVA = afecto', () => {
  let semilla = 7;
  const azar = (n) => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla % n; };
  for (let i = 0; i < 2000; i++) {
    const items = Array.from({ length: 1 + azar(8) }, (_, k) => ({
      NmbItem: `Item ${k}`,
      QtyItem: azar(4) === 0 ? (1 + azar(3000)) / 1000 : 1 + azar(5),
      PrcItem: 1 + azar(50000) + (azar(3) === 0 ? azar(10) / 10 : 0),
      ...(azar(5) === 0 ? { IndExe: 1 } : {}),
    }));
    const dte = armar(33, items);
    const t = enc(dte).Totales;
    assert.equal(t.MntTotal, sumaLineas(dte));
    const afecto = dte.datos.Detalle.filter(d => d.IndExe !== 1).reduce((s, d) => s + d.MontoItem, 0);
    if (afecto > 0) assert.equal(t.MntNeto + t.IVA, afecto);
  }
});

const xmlConIndicador = (mntBruto) => `<?xml version="1.0" encoding="ISO-8859-1"?>
<EnvioDTE><SetDTE><DTE><Documento>
  <Encabezado>
    <IdDoc><TipoDTE>33</TipoDTE><Folio>1</Folio><FchEmis>2026-09-13</FchEmis>${mntBruto ? '<MntBruto>1</MntBruto>' : ''}</IdDoc>
    <Emisor><RUTEmisor>76543210-K</RUTEmisor><RznSoc>EMPRESA EJEMPLO SPA</RznSoc></Emisor>
    <Receptor><RUTRecep>77111222-3</RUTRecep><RznSocRecep>PROVEEDOR EJEMPLO SPA</RznSocRecep></Receptor>
    <Totales><MntNeto>1681</MntNeto><TasaIVA>19</TasaIVA><IVA>319</IVA><MntTotal>2000</MntTotal></Totales>
  </Encabezado>
  <Detalle><NroLinDet>1</NroLinDet><NmbItem>Producto</NmbItem><QtyItem>2</QtyItem><PrcItem>1000</PrcItem><MontoItem>2000</MontoItem></Detalle>
</Documento></DTE></SetDTE></EnvioDTE>`;

test('parseEnvioDTE detecta MntBruto y el impreso rotula los precios con IVA', () => {
  const m = new MuestrasImpresas({ emisor: { rut: '76543210-K', razonSocial: 'EMPRESA EJEMPLO SPA' } });
  const [bruto] = m.parseEnvioDTE(xmlConIndicador(true));
  const [neto] = m.parseEnvioDTE(xmlConIndicador(false));
  assert.equal(bruto.mntBruto, true);
  assert.equal(neto.mntBruto, false);
  const htmlBruto = m._buildHtml({ doc: bruto, esCedible: false, tedDataUri: '' });
  const htmlNeto = m._buildHtml({ doc: neto, esCedible: false, tedDataUri: '' });
  assert.match(htmlBruto, />P\.Unit\. c\/IVA</);
  assert.match(htmlBruto, />Valor c\/IVA</);
  assert.doesNotMatch(htmlNeto, /c\/IVA/);
});
