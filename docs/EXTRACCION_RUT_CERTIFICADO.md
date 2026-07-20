# Extracción de RUT desde certificados PFX — hallazgos y propuesta

## Contexto

`utils/pfx.js` (`extractRutFromCertificate`) necesita el RUT del titular del certificado
para construir la carátula de varios documentos SII (`RutEnvia` en `BoletaCert.js`,
`LibroCompras.js`, `LibroGuias.js`, `LibroVentas.js`, `Simulacion.js`, `SetBase.js`).

Hasta ahora esa extracción probaba, en orden:
1. `subject.serialNumber`
2. Regex de RUT (`\d{7,8}-[\dK]`) sobre `subject.CN`

## Bug encontrado (2026-07-16)

Cliente con certificado emitido por la CA **Signapis** no tenía `serialNumber` en el
subject, y su `CN` era solo el nombre de la persona (sin dígitos) — ninguna de las dos
estrategias encontraba el RUT. `BoletaCert.js` no tenía fallback al RUT de la empresa
(a diferencia de los otros módulos cert/*, que sí usan `this.certificado.rut ||
this.emisor.rut`), así que el XML de la Boleta Electrónica se generaba con
`RutEnvia` vacío → SII/parser rechazaba con "No se pudo extraer RutEmisor o RutEnvia
del XML".

**Importante**: usar el RUT de la empresa como fallback para `RutEnvia` es conceptualmente
incorrecto — en Chile los certificados de firma electrónica siempre se emiten a una
persona natural (representante legal o mandatario), nunca al RUT de la empresa. `RutEnvia`
debe ser el RUT de quien firma (el certificado), no el de quien emite el documento
(`RutEmisor`, ese sí es el RUT de la empresa). Mezclar ambos puede causar rechazo del SII
por inconsistencia entre el RUT declarado y el RUT real de la firma digital del XML.

### Fix aplicado (mínimo, ya en el repo)

Se agregó `subject.OU` como fuente adicional en `extractRutFromCertificate` — Signapis
codifica el RUN ahí. Orden actual: `serialNumber` → `OU` → `CN`.

## Análisis de certificados en producción (2026-07-16)

Se analizaron los 5 certificados PFX cargados en producción a esa fecha:

| empresa | CA emisora | dónde está el RUT | SAN OID `1.3.6.1.4.1.8321.1` | extractor viejo |
|---|---|---|---|---|
| 5  | Acepta.com Autoridad Certificadora Clase 3 Persona Natural | `serialNumber` | coincide | ✅ funcionaba |
| 10 | IDOK Firma Electrónica V4 | `serialNumber` | coincide | ✅ funcionaba |
| 14 | Autoridad Firma Digital Signapis | `OU` (no serialNumber) | coincide | ❌ fallaba (bug de arriba) |
| 17 | Acepta.com Autoridad Certificadora Clase 3 Persona Natural | `serialNumber` | coincide | ✅ funcionaba |
| 13 | — | — | — | n/a — `sii_pfx_pass` vacío en BD, problema de datos no relacionado (avisar al cliente que resuba el certificado) |

**Hallazgo:** en las 3 CAs distintas observadas (Acepta, IDOK, Signapis), el valor del
**Subject Alternative Name con OID `1.3.6.1.4.1.8321.1`** siempre coincide exactamente
con el RUT correcto del titular. Este OID está reservado bajo el marco regulatorio
chileno de firma electrónica (Ley 19.799 y normativa técnica asociada) — a diferencia
de `serialNumber`/`OU`/`CN`, que son convención de cada CA (por eso ya hay 3 formatos
distintos observados con solo 3 CAs).

## Implementado (2026-07-20)

La propuesta de abajo se implementó tal como estaba documentada, más dos fixes
adicionales encontrados al revisar todos los consumidores de `certificado.rut`
dentro de este repo (`devlas-cloud-api-node` ya tenía fallback en los 6 puntos
donde lo usa, así que no requirió cambios):

- **`cert/BoletaCert.js`** (líneas 217, 231, 294, 361): `RutEnvia` no tenía
  fallback a `this.emisor.rut`, a diferencia de `LibroVentas.js`,
  `LibroCompras.js`, `LibroGuias.js` y `Simulacion.js`. Es justamente lo que
  causó el bug de la CA Signapis. Se agregó `|| this.emisor.rut` en los 4
  puntos.
- **`EnviadorSII.js:1177`** (`enviarConsumoFolios`, envío de RCOF): hacía
  `this.certificado.rut.split('-')` sin chequear null — con un RUT no
  extraíble esto no da RutEnvia vacío, **lanza un `TypeError`** no controlado.
  Se agregó fallback a `rutEmisor` (ya extraído y validado del XML unas
  líneas antes).
- Test de regresión en `test/pfx.test.js` (ejecutar con `npm test`), con
  certs sintéticos que cubren: SAN+serialNumber coincidentes (caso
  Acepta/IDOK), solo OU sin SAN (caso Signapis histórico), sin ningún campo
  (debe devolver `null`, no reventar), y SAN vs. serialNumber en conflicto
  (el SAN debe ganar por ser la fuente primaria).

No se requirió migración: `certificado.rut` nunca se persiste en BD, se
recalcula en cada carga del PFX.

## Propuesta (ya implementada — ver sección de arriba)

Reordenar `extractRutFromCertificate` para que el SAN OID sea la fuente **primaria**,
dejando `serialNumber` → `OU` → `CN` como fallback heurístico si el SAN no está presente:

```js
function extractRutFromCertificate(cert) {
  const sanRut = extractRutFromSan(cert)          // NUEVO — ver más abajo
  if (sanRut) return sanRut

  const subject = extractSubjectFields(cert)
  // ... resto igual (serialNumber -> OU -> CN)
}

function extractRutFromSan(cert) {
  const san = cert.getExtension('subjectAltName')
  if (!san?.altNames) return null
  for (const alt of san.altNames) {
    if (alt.type !== 0) continue // 0 = otherName
    try {
      const oid = forge.asn1.derToOid(alt.value[0].value)
      if (oid === '1.3.6.1.4.1.8321.1') {
        const inner = alt.value[1]?.value?.[0]
        if (inner?.value) return inner.value.toUpperCase()
      }
    } catch { /* ignorar, cae al fallback */ }
  }
  return null
}
```

### Por qué es seguro (verificado, no solo teórico)

- Probado contra los 4 certificados válidos reales en producción: el SAN OID coincide
  exactamente con lo que el extractor actual ya devuelve en los 4 casos → **cero cambio
  de comportamiento** para certificados que ya funcionan hoy.
- Es aditivo: si una CA no incluye el SAN (poco probable, es obligatorio por norma, pero
  no imposible en certificados antiguos o de otros países), simplemente cae al mismo
  fallback que existe hoy — nunca puede quedar peor que el comportamiento actual.
- Solo afecta el momento de **extracción al cargar un PFX nuevo** — no toca firma de
  DTEs ya generados ni certificaciones ya completadas (esas ya tienen el RUT persistido
  en `empresa.sii_emisor`/`rut`, no se re-extraen del certificado).

### Pendiente si se implementa

- Mismo cambio aplicaría a considerar en cualquier lugar que dependa de
  `certificado.rut` para casos edge, aunque el resto de `cert/*.js` ya tiene fallback a
  `emisor.rut` y no se ha visto que fallen con las CAs observadas.
- Agregar un test con al menos un PFX de cada CA observada (o un fixture sintético) para
  no regresionar si se reordena la extracción.
