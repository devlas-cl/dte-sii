# Política de seguridad

## Versiones con soporte

Se da soporte a la última versión publicada en npm. Los arreglos de seguridad
salen sobre esa, no se respaldan a versiones anteriores.

## Cómo reportar

**No abras un issue público para un problema de seguridad.** Un issue es visible
para todo el mundo desde el momento en que lo creas, incluidas las personas que
podrían aprovecharlo.

Escribe a **ti@devlas.cl** con el asunto `[seguridad] dte-sii`. Si prefieres el
canal de GitHub, usa el aviso privado de vulnerabilidad en la pestaña Security del
repositorio.

Incluye lo que tengas: qué encontraste, cómo reproducirlo, qué versión afecta y
qué se puede lograr con ello. Un caso reproducible acelera mucho el arreglo.

**No incluyas datos reales en el reporte.** Ni RUTs de contribuyentes, ni
certificados, ni CAFs, ni tokens de sesión del SII. Si el problema solo se
manifiesta con un dato real, descríbelo en vez de pegarlo.

## Qué esperar

Se acusa recibo dentro de unos días hábiles. Si el reporte se confirma, se avisa
cuándo saldrá el arreglo y en qué versión. Se da crédito a quien reporta, salvo
que prefiera lo contrario.

## Alcance

Cuenta como problema de seguridad de esta librería, entre otros:

- Un defecto que produzca una firma inválida, o peor, una que valide algo que no
  corresponde
- Filtración de material de la clave privada, del PFX o del CAF hacia logs,
  mensajes de error o archivos temporales
- Persistencia insegura de sesiones o cookies del SII
- Una dependencia vulnerable que esta librería exponga

No cuenta: el comportamiento del propio SII, la configuración de quien consume la
librería, ni un certificado mal emitido por su proveedor.

## Lo que esta librería nunca hace

Ayuda saberlo para acotar el alcance de un reporte:

- No envía nada a servidores de Devlas. Todas sus peticiones de red van a hosts
  del SII. Las URLs de `w3.org` y `xmlsoap.org` que aparecen en el código son
  identificadores de namespace XML, no direcciones a las que se conecte.
- No incluye telemetría ni analítica de ningún tipo.
- No persiste certificados. El PFX lo entrega quien la consume, en cada uso.
- Sí persiste en disco las cookies de sesión del SII, para evitar el error de
  "máximo de sesiones autenticadas". La ruta la controla quien la consume, con
  `DATADIR` o `SII_SESSION_PATH`. Ver CLAUDE.md.
