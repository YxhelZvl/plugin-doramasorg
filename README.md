# Doramas.org

Plugin de [Kino](https://github.com/kinotvapp/kino-plugin-archive) para
[doramas.org](https://www.doramas.org): doramas y películas asiáticas
subtituladas al español.

## Qué ofrece

- **Buscar** series por título.
- **Inicio**: últimos capítulos, doramas, películas, en emisión, finalizados
  y filas por género.
- **Explorar**: catálogo de series y películas, por estado y por género,
  con paginación.
- **Episodios** con portada de capítulo (varias temporadas donde aplique).
- **Varios servidores** por título, con copias perezosas
  etiquetadas: PDrive, Maru, Okru, Korii, Evo, Hiplay, VK
  y Dodo. Si el archivo de un servidor expiró, el plugin lo
  omite y ofrece uno que sí responda.

## Instalación

En Kino: ☰ ▸ **Plugins** ▸ **+** ▸ escribe `YxhelZvl/plugin-doramasorg`
▸ **Agregar** ▸ **Instalar**.

## Desarrollo

Requiere Node 18 o más nuevo:

```
node sdk/validate.mjs .
node sdk/run.mjs . search "bona"
node sdk/run.mjs --record test/fixtures-search.json . search "bona"
node --test test/plugin.test.mjs
```

Las cintas de `test/fixtures-*.json` son grabaciones locales (no se suben):
regenerarlas con `--record` antes de correr las pruebas offline.

## Notas

- La búsqueda del sitio solo cubre series; las películas se exploran por
  filtros.
- PDrive, Maru y Okru se resuelven con peticiones directas; Korii,
  Evo, VK y Dodo usan el navegador oculto de Kino (requiere
  Kino 0.9.50+ por `apiVersion` 6).
