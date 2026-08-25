<!--
Esta librería emite documentos tributarios reales. Un bug acá produce un documento
que el SII rechaza, o uno que acepta y que dice algo distinto de lo que debía.
Por eso pedimos más evidencia de lo habitual.

Antes de llenar esto lee CONTRIBUTING.md. Si trabajas con un agente, el repo trae
la skill .claude/skills/pr-dte-sii/ con las reglas completas.

Borra las secciones que no apliquen. Borra estos comentarios.
-->

## El problema

<!-- Qué está mal hoy y dónde se ve (archivo:línea). Si tienes un caso concreto,
     ponlo con el dato exacto. Datos inventados: este repo es público. -->

## Lo que trae el PR

<!-- Archivo por archivo: qué cambia y por qué ahí y no en otro lado. -->

## Evidencia

<!-- Marca el nivel de cada afirmación. No presentes una de nivel bajo como alta.

     Nivel 0  lectura del código
     Nivel 1  test unitario de la función
     Nivel 2  artefacto generado y adjunto (XML, digest, TED, PNG del PDF417, PDF
              de la muestra impresa) que se pueda abrir sin correr tu código
     Nivel 3  respuesta del SII en maullín, con track ID y estado

     Si no alcanzaste el nivel que tu cambio pedía, dilo acá. Un PR que declara lo
     que quedó sin probar se puede mergear con esa condición. Uno que insinúa una
     cobertura que no tiene, no. -->

- [ ] `npm test` pasa y mi test aparece en la salida
- [ ] Probé el caso adversarial (topes de largo, valores en su máximo), no solo el cómodo

## Radio de impacto

<!-- Ver .claude/skills/pr-dte-sii/references/radio-de-impacto.md
     Declara las siete, incluidas las que descartaste y por qué. -->

```
1. XML del documento
2. Firma del documento (DSIG)
3. Firma del sobre (SetDTE)
4. TED firmado
5. PDF417 de la muestra impresa
6. Texto visible de la muestra impresa
7. Formularios del portal del SII
```

## Lo que deliberadamente no trae

<!-- Alcance que dejaste fuera a propósito. -->

---

- [ ] Un solo cambio (si arregla dos cosas, son dos PRs)
- [ ] README y `dte-sii.d.ts` actualizados si cambié la API pública
- [ ] Entrada de CHANGELOG bajo `## [Unreleased]`, sin elegir número de versión
- [ ] Sin tocar la versión de `package.json` ni `package-lock.json`
- [ ] Cero datos reales (RUT, razones sociales, certificados, CAF, tokens) en
      código, tests y adjuntos. Ver la tabla de CLAUDE.md
- [ ] Si hay cambio de contrato en API pública, está declarado como breaking
