---
name: pr-dte-sii
description: Reglas para proponer un cambio en dte-sii. Usar SIEMPRE antes de escribir código, abrir un PR, arreglar un bug o agregar una feature en esta librería. Define qué evidencia debe acompañar cada tipo de cambio y cómo trazar el radio de impacto hasta las salidas (XML, firma, TED, PDF417, muestra impresa, portal del SII).
---

# Cómo se propone un cambio en dte-sii

Esta librería emite documentos tributarios reales. Un bug acá no produce una
pantalla fea: produce un documento que el SII rechaza, o peor, uno que acepta y
que dice algo distinto de lo que debía decir. Por eso el estándar de evidencia es
más alto que en una librería común.

Lee esto completo antes de escribir la primera línea.

## La regla que resume todo

**Prueba la función que tocaste, y después traza a dónde llega lo que tocaste.**

El error más común en los PRs de esta librería no es escribir mal la función. Es
probar bien la función y no mirar qué pasa aguas abajo. Un cambio de una línea en
`utils/sanitize.js` puede terminar dentro de un código de barras firmado
criptográficamente, y el test de la función pasa igual.

Ver `references/radio-de-impacto.md` para el mapa completo de a dónde llega cada
cosa. Es lectura obligatoria si tu cambio toca texto, RUT, montos o referencias.

## Los cuatro niveles de evidencia

Cada afirmación de un PR tiene un nivel. El PR debe decir en qué nivel está cada
una, y no presentar una de nivel bajo como si fuera de nivel alto.

**Nivel 0. Lectura del código.**
"Miré `DTE.js:283` y el campo sale de ahí." Necesario siempre, suficiente nunca.
Sirve para explicar el mecanismo, no para probar que el arreglo funciona.

**Nivel 1. Test unitario de la función.**
Prueba que la función hace lo que dices. No prueba que el documento resultante sea
válido, ni que el SII lo acepte. Es el piso, no el techo.

**Nivel 2. Artefacto generado y adjunto.**
El XML del documento, el digest calculado, el TED extraído, el PNG del PDF417, la
muestra impresa en PDF. Algo que quien revisa pueda abrir y verificar sin volver a
correr tu código. **Este es el nivel que falta en casi todos los PRs y el que más
convence.**

**Nivel 3. Respuesta del SII en maullín.**
El track ID y el estado que devolvió el servicio. Es el único nivel que prueba que
el SII acepta. Nunca contra palena.

## Qué nivel exige cada cambio

| Tu cambio toca | Nivel mínimo | Por qué |
|---|---|---|
| Utilidad pura, sin efecto en el XML emitido | 1 | La función es el producto |
| Texto que va al documento (`NmbItem`, `RznSoc`, `DirRecep`, glosas) | 2 | Ese texto entra al TED firmado y al PDF417. Ver el mapa |
| RUT, folios, montos, fechas | 2 | Van al TED y se comparan contra el CAF |
| Referencias (`RazonRef`, `FolioRef`, `CodRef`) | 2 | Causa directa de rechazo, y el XSD tiene topes de largo |
| Canonicalización o firma (`c14n.js`, `Signer.js`, `_escapeXmlText`) | 3 | Un digest que no calza tumba el envío entero |
| Muestras impresas, PDF417, layout | 2 | Adjunta el PDF y el PNG del timbre |
| Flujo del portal (`CafSolicitor`, `BoletaCert`, libros) | 3 | No hay forma de probarlo sin el portal |
| Solo docs, comentarios o tipos | 0 | |

Si no puedes alcanzar el nivel que te toca, **dilo en el PR**. Un PR que dice "no
pude probar esto contra el SII, hace falta una emisión en maullín con X" es útil y
se puede mergear con esa condición. Un PR que insinúa una cobertura que no tiene,
no.

## Las cinco trampas de esta librería

Todas se han cobrado alguna víctima acá. Revísalas contra tu cambio antes de abrir
el PR.

**1. Un test existente no cubre tu cambio hasta que lo abriste y lo leíste.**
Los tests de este repo están nombrados por el síntoma que provocaron, no por el
alcance que tienen. Un nombre puede sugerir que cubre toda una zona cuando en
realidad cubre una función. Si vas a apoyarte en un test que ya existe para
sostener que tu cambio es seguro, léelo entero primero y cita qué assert
específico te respalda.

**2. Elige el caso adversarial, no el que tienes a mano.**
Cuando un campo tiene tope de largo, prueba en el tope. Cuando compones un valor a
partir de otros, prueba con cada componente en su máximo. Un test que usa un valor
corto y cómodo puede pasar mientras esconde un desbordamiento que en producción
aparece al primer cliente con un nombre largo.

**3. Confirma que tu test corre de verdad.**
`npm test` recorre `test/*.test.js` con un glob, así que basta con dejar el archivo
ahí y que termine en `.test.js`. Corre `npm test` y busca tu archivo en la salida
antes de dar el trabajo por hecho: un test que no corre no es cobertura, y no se
nota hasta que algo se rompe.

Haz también que falle a propósito una vez, antes de darlo por bueno. Un test que
pasa siempre, incluso con el bug presente, es peor que no tener test: da confianza
sin respaldarla.

**4. Un carácter que antes se borraba es un camino que nunca se ejercitó.**
Si tu cambio deja pasar algo que antes se eliminaba o se normalizaba, estás
activando código que nunca se usó. Busca todas las funciones que ese valor
atraviesa después y revisa si alguna lo trata distinto. Casi siempre hay una, y
suele estar del lado de la firma.

**5. Cambiar de "devuelve vacío" a "lanza" es un cambio de contrato.**
Estas funciones son API pública. Si haces que una lance donde antes degradaba,
decláralo en el PR como breaking, aunque te parezca obviamente mejor.

## Reglas del repo

**Un PR, un cambio.** Si tu rama arregla el RUT y además el texto y además agrega
una feature, son tres PRs. Un PR que empaqueta varias cosas no se puede revisar ni
revertir por partes, y obliga a aceptar todo o nada.

**El PR viene completo, pero no hace el release.** Son dos cosas distintas y se
confunden seguido. La línea que las separa:

> Si alguien que instala esta versión lo notaría, va en tu PR.
> Si solo lo notaría alguien mirando la lista de versiones, es del release.

**Va en tu PR, siempre, en el mismo commit:**

- El código
- Los tests, en `test/` y terminados en `.test.js` para que el glob los tome
- El `README.md`, si cambiaste API pública o comportamiento visible. Un cambio
  documentado en el PR pero no en el README es un cambio a medias: el PR lo lee
  una persona una vez, el README lo lee todo el mundo para siempre
- El `dte-sii.d.ts`, si agregaste, quitaste o cambiaste la firma de algo exportado
- Los comentarios del código que quedaron desactualizados por tu cambio
- La entrada del `CHANGELOG.md`, **bajo `## [Unreleased]` y nada más**

**No va en tu PR, es de quien mantiene el repo al publicar:**

- El número de versión, en `package.json` y en el `CHANGELOG.md`
- Mover `Unreleased` a una sección numerada con fecha
- `package-lock.json`, salvo que tu cambio agregue o suba una dependencia, y en
  ese caso explica cuál y por qué
- El tag de git y el `npm publish`

**Nunca elijas un número de versión**, aunque tengas clarísimo que tu cambio es
breaking y que toca un mayor. Hay otros PRs abiertos, el orden en que entran lo
decide quien mantiene el repo, y dos PRs que se autoasignan versión chocan entre
sí y con lo que ya se publicó. Escribe bajo `Unreleased` y describe el impacto; si
crees que es breaking, dilo con esas palabras en el texto de la entrada.

**Este repositorio es público.** Nunca incluyas RUTs reales, razones sociales
reales, certificados, CAFs, tokens ni rutas con nombres de clientes, ni en el
código, ni en los tests, ni en los artefactos que adjuntes. Usa datos inventados.
Si necesitas adjuntar un XML generado, anonimízalo antes.

**Toda prueba contra el SII va a maullín.** Nunca a palena. Un documento emitido
por error contra producción es un documento tributario real.

**No inventes valores de negocio.** Si una corrección necesita el valor corregido,
recíbelo como parámetro. Componer algo plausible (concatenar "CORREGIDO", asumir
un default) produce documentos que pasan el esquema y dicen mentiras.

## El cuerpo del PR

Usa `.github/pull_request_template.md`. La estructura es corta a propósito:

1. **El problema.** Qué está mal hoy, con la referencia al archivo y línea donde
   se ve. Si tienes un caso real, ponlo con el dato exacto y la fecha.
2. **Lo que trae el PR.** Archivo por archivo, qué cambia y por qué ahí.
3. **Evidencia.** El nivel de cada afirmación, y los artefactos adjuntos. Si algo
   quedó sin probar, esta sección lo dice.
4. **Radio de impacto.** Qué otras salidas toca este cambio, según el mapa.
   Incluyendo las que revisaste y descartaste, y por qué.
5. **Lo que deliberadamente no trae.** Alcance que dejaste fuera a propósito.

## Antes de abrir el PR

```bash
npm test        # suite completa, sin red
npm run scan    # barrido de datos reales
npm run types   # verificación de dte-sii.d.ts
```

Las tres corren también en CI sobre cada PR, en Node 18, 20 y 22. El barrido es
bloqueante: si encuentra un RUT real, una ruta local o un certificado versionado,
el PR queda rojo. Correrlas antes te ahorra el viaje de ida y vuelta.

- [ ] `npm test` pasa, y mi test nuevo aparece en la salida
- [ ] `npm run scan` sale limpio
- [ ] `npm run types` pasa, si toqué `dte-sii.d.ts`
- [ ] Seguí el mapa de `references/radio-de-impacto.md` para lo que toqué
- [ ] Cada afirmación del cuerpo dice en qué nivel de evidencia está
- [ ] Probé el caso adversarial, no solo el cómodo
- [ ] Un solo cambio
- [ ] README y `dte-sii.d.ts` actualizados si cambié la API pública
- [ ] Entrada de CHANGELOG bajo `Unreleased`, sin número de versión
- [ ] Sin tocar la versión de `package.json` ni `package-lock.json`
- [ ] Si hay cambio de contrato en API pública, está declarado
