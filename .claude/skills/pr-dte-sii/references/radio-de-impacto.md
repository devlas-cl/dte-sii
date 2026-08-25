# Radio de impacto: a dónde llega lo que tocaste

Un valor que entra a esta librería no sale por un lugar. Sale por siete, y cada
salida lo trata distinto. Un cambio que se ve correcto en una puede romper otra sin
que ningún test lo note.

Este es el mapa. Úsalo así: encuentra tu cambio en "Por dónde entra", sigue las
salidas que le corresponden, y revisa cada una. En el PR declara cuáles revisaste,
incluidas las que descartaste y por qué.

## Las siete salidas

Ordenadas por cuánto duele equivocarse.

### 1. El XML del documento

El cuerpo del DTE. Lo valida el XSD del SII, con topes de largo por campo.

Un valor mal puesto acá produce un documento que el SII rechaza por esquema, o
peor, uno que acepta y que dice algo distinto de lo que correspondía.

Los topes de largo son la trampa más fácil. Verificados contra
`docs/schema_envio_bol/EnvioBOLETA_v11.xsd`, que está en el repo:

| Campo | maxLength |
|---|---|
| `RznSocRecep` | 100 |
| `RazonRef` | 90 |
| `NmbItem` | 80 |
| `DirRecep` | 70 |
| `DscItem` | 1000 |

Ese XSD está en ISO-8859-1, así que `grep` directo no encuentra nada. Conviértelo
antes: `iconv -f ISO-8859-1 -t UTF-8 <archivo>`.

Los campos que no aparecen ahí (los giros, entre otros) viven en el esquema de DTE,
que no está en el repo. Búscalos en la documentación del SII antes de asumir un
largo. Nunca calcules contra tu intuición: si compones un valor a partir de otros
campos, calcula el largo con cada uno en su máximo.

### 2. La firma del documento (DSIG)

`DTE.js:_c14nDocumento` construye la forma canónica, `utils/c14n.js:escapeText`
escapa el texto, `Signer.js` firma.

Regla dura: **canonical XML escapa en nodos de texto SOLO `&`, `<`, `>` y el
retorno de carro.** El apóstrofe y la comilla doble quedan literales. Si el código
escapa uno de esos dos, el digest que firmas deja de ser el que el SII recalcula, y
el SII rechaza el **envío completo** con `RFR`, sin decir cuál documento ni por qué.
Ya pasó una vez. El aviso está en `utils/c14n.js`, arriba de `serializeNode`.

### 3. La firma del sobre (SetDTE)

`Signer.js:_c14nSetDTE`. Mismas reglas que la anterior, sobre el `SetDTE` completo.
Lo cubre `test/c14n-apostrofe.test.js`.

### 4. El TED firmado

**La salida que más se olvida.** El camino completo:

```
NmbItem / RznSocRecep
  -> sanitizeSiiText          (utils/sanitize.js)   pliega a Latin-1
  -> sanitizeTedText          (utils/sanitize.js)   pliega acentos a ASCII
  -> substring(0, 40)         (DTE.js)              tope del TED
  -> _escapeXmlText           (DTE.js:308)          escapa & < > " '
  -> string <DD>              (DTE.js:_buildDDString)
  -> CAF.sign(ddString)       (CAF.js:134)          firma con latin1
  -> <FRMT> dentro del <TED>  (DTE.js:296)
```

Tres cosas que hay que saber de este camino:

- `_escapeXmlText` escapa `"` y `'`, a diferencia de `escapeText` de c14n. Si un
  valor con esos caracteres llega hasta acá, entra al `<DD>` como `&quot;` y
  `&apos;`. Si el SII recalcula el FRMT sobre la forma resuelta y no sobre los
  bytes recibidos, ese digest no calza. **No está verificado contra el SII.**
  Cualquier cambio que deje pasar `'` o `"` hasta el TED necesita evidencia de
  nivel 3.
- El truncado a 40 va **después** de plegar, no antes. Plegar puede alargar el
  texto (ß a ss, Æ a AE), y cortar antes desbordaba `<RSR>` e `<IT1>`.
- `RE` sale de `Encabezado.Emisor.RUTEmisor` (`DTE.js:283`) y se compara contra el
  `RE` del CAF embebido, que el SII emite siempre canónico. Si el tuyo lleva ceros
  de relleno y el del CAF no, esos dos valores divergen dentro del mismo `<DD>`
  firmado.

### 5. El PDF417 de la muestra impresa

`cert/MuestrasImpresas.js:301` y `:656` codifican el `tedXml` **textualmente** con
`Buffer.from(tedXml, 'latin1')`.

O sea: lo que quede en el TED, incluidas las entidades `&apos;` y `&quot;`, queda
dentro del código de barras. El SII escanea ese timbre y verifica la firma. **Es
una verificación distinta de la del envío XML y puede dar un resultado distinto.**
Un documento puede pasar el envío y fallar en la muestra impresa.

Los bytes del barcode tienen que ser exactamente los que se firmaron. No toques la
conversión latin1 sin evidencia de nivel 3.

### 6. El texto visible de la muestra impresa

Dos rutas independientes que hay que revisar por separado:

- **HTML.** `safeText()` (`cert/MuestrasImpresas.js:44`) solo hace `trim()`, no
  escapa nada, y se interpola directo en el template. Un `&` o un `<` en un nombre
  de producto rompe el markup. Si el valor cae dentro de un atributo, la comilla
  doble también.
- **pdf-lib.** `generarPDFBuffer` usa `StandardFonts.Helvetica`, que es
  WinAnsiEncoding y **lanza excepción** con caracteres que no puede codificar. Todo
  lo que sobreviva a `sanitizeSiiText` tiene que caber ahí.

Adjunta el PDF generado. Es la única forma de ver esto.

### 7. Los formularios del portal del SII

`CafSolicitor.js:391` y `:479`, `cert/BoletaCert.js:641` y `:771`, más los libros y
el consumo de folios.

Estos mandan campos como `RUT_EMP`, `DV_EMP`, `RUT_EMPRESA` a formularios HTML del
portal. No hay forma de probarlos sin el portal. Cualquier cambio que altere lo que
llega a esos campos necesita una corrida real en maullín.

## Por dónde entra

### Texto libre (nombres de producto, razones sociales, direcciones, glosas)

Entra por `sanitizeSiiText` (`utils/emisor.js`, `utils/receptor.js`, `DTE.js`).

**Salidas a revisar: 1, 2, 3, 4, 5, 6.** Prácticamente todas. El texto es el valor
con el radio más amplio de la librería, porque es el único que llega hasta el
código de barras y hasta el papel.

Ojo especial si tu cambio deja pasar un carácter que antes se eliminaba: estás
activando por primera vez las ramas de `_escapeXmlText` que lo manejan.

### RUT

Entra por `utils/rut.js` (`cleanRut`, `splitRut`, `formatRutSii`) y por
`Certificado.js` desde el PFX.

**Salidas a revisar: 1, 4, 7.** Además de la comparación contra el `RE` del CAF,
que es la que muerde en silencio.

### Folios, montos, fechas

**Salidas a revisar: 1, 4.** Van al `<DD>` firmado. Un folio o monto que no calza
entre el cuerpo y el TED invalida el timbre.

### Referencias (`RazonRef`, `FolioRef`, `CodRef`, `TpoDocRef`)

`utils/referencia.js`, consumidas por los sets de `cert/`.

**Salidas a revisar: 1.** No entran al TED. Pero son causa directa de rechazo por
contenido, no solo por esquema: hay códigos que exigen literales específicos en la
razón, y `RazonRef` tope en 90 caracteres. Si compones una razón a partir de otros
campos, calcula el largo con los valores en su máximo.

### Canonicalización y firma

`utils/c14n.js`, `Signer.js`, `DTE.js:_c14nDocumento`, `DTE.js:_escapeXmlText`.

**Salidas a revisar: 2, 3, 4, 5.** Zona crítica. Nada entra acá sin evidencia de
nivel 3, y el PR tiene que explicar por qué el digest sigue siendo el que el SII
recalcula.

## Cómo se ve una revisión de radio de impacto en el PR

No es una lista de checkboxes vacía. Es esto:

```
Radio de impacto

  1. XML del documento     revisado, campo bajo su tope, el caso más largo da 62
  2. Firma del documento   revisado, escapeText no cambia, digest idéntico (adjunto)
  3. Firma del sobre       no aplica, no toqué el SetDTE
  4. TED firmado           AFECTADO. El valor ahora llega hasta _escapeXmlText.
                           Sin verificar contra el SII. Hace falta una emisión en
                           maullín. Ver sección Evidencia.
  5. PDF417                AFECTADO por lo mismo que 4, el TED va textual al barcode
  6. Texto visible         revisado, PDF adjunto, se ve correcto
  7. Portal del SII        no aplica, no toqué campos de formulario
```

Un PR que dice "AFECTADO, sin verificar, hace falta X" es un buen PR. Uno que dice
"revisado" en las siete sin haber mirado, no.
