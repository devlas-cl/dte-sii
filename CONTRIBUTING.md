# Cómo contribuir

Gracias por el interés. Los PRs son bienvenidos.

Esta librería emite documentos tributarios reales. Un bug acá no produce una
pantalla fea: produce un documento que el SII rechaza, o peor, uno que acepta y que
dice algo distinto de lo que debía decir. Por eso el estándar de evidencia es más
alto que en una librería común, y por eso vale la pena leer esto antes de escribir
código.

## Lo esencial

**Un PR, un cambio.** Si tu rama arregla dos cosas, son dos PRs. Uno que empaqueta
varias no se puede revisar ni revertir por partes, y obliga a aceptar todo o nada.

**Prueba la función que tocaste, y después traza a dónde llega.** Este es el error
más común acá. Un cambio de una línea en el saneamiento de texto puede terminar
dentro de un código de barras firmado criptográficamente, y el test de la función
pasa igual. El mapa completo de las siete salidas de la librería está en
[`radio-de-impacto.md`](.claude/skills/pr-dte-sii/references/radio-de-impacto.md).

**Trae evidencia, y di de qué tipo es.** Leer el código, un test unitario, un
artefacto generado y una respuesta del SII son cuatro cosas distintas y prueban
cosas distintas. El PR debe decir en cuál está cada afirmación. Si algo quedó sin
probar, declararlo es perfectamente válido y hasta útil. Insinuar una cobertura que
no se tiene, no.

**Prueba el caso adversarial.** Cuando un campo tiene tope de largo, prueba en el
tope. Un test con un valor corto y cómodo puede pasar mientras esconde un
desbordamiento.

**Confirma que tu test corre.** `npm test` recorre `test/*.test.js` con un glob, así
que basta con dejarlo ahí. Búscalo en la salida antes de darlo por hecho, y hazlo
fallar a propósito una vez: un test que pasa incluso con el bug presente da
confianza sin respaldarla.

## Qué va en tu PR y qué no

La línea que separa el cambio del release:

> Si alguien que instala esta versión lo notaría, va en tu PR.
> Si solo lo notaría alguien mirando la lista de versiones, es del release.

**Va en tu PR:** el código, los tests (en `test/`, terminados en `.test.js`), el `README.md`
si cambiaste API pública o comportamiento visible, el `dte-sii.d.ts` si cambiaste
algo exportado, los comentarios que quedaron desactualizados, y la entrada del
`CHANGELOG.md` bajo `## [Unreleased]`.

**No va en tu PR:** el número de versión, mover `Unreleased` a una sección numerada,
`package-lock.json` (salvo que agregues una dependencia), el tag y el publish. Eso
lo hace quien mantiene el repo al publicar.

**Nunca elijas un número de versión**, aunque tengas claro que tu cambio es
breaking. Hay otros PRs abiertos y dos que se autoasignan versión chocan entre sí.
Escribe bajo `Unreleased` y, si crees que es breaking, dilo con esas palabras.

## Reglas duras

**Este repositorio es público.** Nunca incluyas RUTs reales, razones sociales
reales, certificados, CAFs, tokens ni rutas locales, ni en el código, ni en los
tests, ni en los artefactos que adjuntes. Usa datos inventados con formato válido:
`76543210-K`, `77111222-3`, `EMPRESA EJEMPLO SPA`. La tabla completa de qué está
prohibido y qué usar en su lugar está en [`CLAUDE.md`](CLAUDE.md). Si adjuntas un
XML generado, anonimízalo antes.

Ten presente que limpiar un archivo no limpia el historial. La revisión va antes del
push, no después.

**Toda prueba contra el SII va a maullín, nunca a palena.** Un documento emitido por
error contra producción es un documento tributario real.

**No inventes valores de negocio.** Si una corrección necesita el valor corregido,
recíbelo como parámetro. Componer algo plausible produce documentos que pasan el
esquema y dicen mentiras.

## Si trabajas con un agente

El repo trae la skill [`pr-dte-sii`](.claude/skills/pr-dte-sii/) con estas reglas en
formato ejecutable, incluido el mapa de radio de impacto y los niveles de evidencia.
Claude Code y compatibles la cargan solos al detectar que estás preparando un
cambio. Vale la pena que la leas tú también: está escrita para que un agente no
pueda saltarse los pasos que acá cuestan caro.

El [`CLAUDE.md`](CLAUDE.md) de la raíz describe la arquitectura, el formato de
módulos y las reglas del repo.

## El cuerpo del PR

Usa la plantilla, que aparece sola al abrir el PR. Es corta y sigue el mismo orden:
el problema, lo que trae, la evidencia con su nivel, el radio de impacto, y lo que
deliberadamente dejaste fuera.

## Antes de abrir

```bash
npm test        # suite completa, sin red ni SII
npm run scan    # barrido de datos reales
npm run types   # verificación de dte-sii.d.ts
```

Las tres corren también en CI sobre cada PR, en Node 18, 20 y 22. El barrido de
datos reales es bloqueante: si encuentra un RUT real, una ruta local de tu máquina
o un certificado versionado, el PR queda en rojo. Correrlas antes te ahorra el
viaje de ida y vuelta.

## Reportar un problema de seguridad

No abras un issue público. Ver [`SECURITY.md`](SECURITY.md).
