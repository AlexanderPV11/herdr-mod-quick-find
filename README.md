# herdr-mod-quick-find

Buscador tipo Ctrl+P / Ctrl+Shift+F para [Herdr](https://herdr.dev). Una tecla abre un diálogo sobre la carpeta del pane enfocado:

- **Files:** busca archivos por nombre con coincidencia difusa (`perm ctrl` encuentra `permissions.controller.ts`).
- **Text:** busca texto dentro de los archivos. Al pasar el cursor (o moverte con `↑↓`) por un resultado, muestra a la derecha una **vista previa con colores** alrededor de la línea encontrada, con scroll horizontal.
- `Enter` o clic abre el archivo en una pestaña del visor `file-viewer`. Si ya estaba abierto, te lleva a esa pestaña.
- `Tab` cambia entre Files y Text, `Esc` cierra.

## Requisitos

| Requisito | Para qué | Obligatorio |
|---|---|---|
| Herdr app | el host de los mods | sí |
| Mod `file-viewer` (de [mchlkim/herdr-file-explorer](https://github.com/mchlkim/herdr-file-explorer)) | abre los resultados | sí, o ver "Qué modificar" |
| `git` | lista de archivos que respeta `.gitignore` y búsqueda de texto (`git grep`) | recomendado |
| [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`rg`) | búsqueda de texto más rápida y fuera de repos git | opcional |

Text elige su motor así: `rg` si está instalado; si no, `git grep` dentro de un repo git; si no, **en Windows una búsqueda con PowerShell** que recorre la carpeta y todas sus subcarpetas (ignora mayúsculas, omite `node_modules`, `.git`, `dist`, `build`, `.next`, `__pycache__`, `.venv`, `venv`, binarios comunes y archivos de más de 1 MB; máximo 200 resultados y 90 s). Es la más lenta: con `rg` va mucho más rápido. Files usa `git ls-files`, luego `rg --files` y, en Windows, PowerShell como último recurso.

## Instalación

```sh
cp -R mods/quick-find ~/.config/herdr-app/mods/
```

Agrega la tecla en `~/.config/herdr-app/keys.json`, dentro de `"global"`:

```json
"alt-p": "mod.open:quick-find"
```

Herdr aplica los cambios al instante. Comprueba con `herdr-app check ~/.config/herdr-app/mods/quick-find`.

## Qué modificar para que funcione en tu setup

1. **Visor de archivos.** El mod abre los resultados creando una pestaña con el mod `file-viewer` (`tab.new` con `props: { file, on }`) y la registra en `shared("file-viewer:open")`, igual que el panel `my-files` de herdr-file-explorer. Instala ese repo primero. Si usas otro visor, edita en `main.js` la constante `VIEWER` y el método `open()` para que use tu mod y sus props.
2. **Tecla.** `alt-p` es una elección propia. `ctrl-p` suele chocar con la terminal (historial del shell), y `ctrl-shift-f` ya lo usa Herdr para buscar dentro de la terminal. Cámbiala en `keys.json`; no uses una que ya esté en otra sección, porque Herdr no la deja pasar.
3. **Tamaño del diálogo.** `mods/quick-find/mod.json`, campo `overlay` (`width` 1040, `height` 560). La vista previa muestra 24 líneas (`17 px` cada una) en un contenedor de altura fija: si cambias el alto, revisa `previewPane()` en `main.js`.
4. **Límites.** `MAX_FILES` (100000 archivos; si se pasa, la barra de estado avisa que la lista se cortó), `SHOW` (60 resultados de nombre) y `MAX_HITS` (200 resultados de texto) están al inicio de `main.js`.
5. **Colores.** Salen de tu tema de Herdr (`theme()`); el mapa de tokens a colores es `palette()` en `main.js`.

## Limitaciones

- Al abrir un resultado de texto, el visor **no salta a la línea**: abre el archivo desde el inicio (el visor no lo soporta).
- La carpeta de búsqueda es la del pane enfocado (o la raíz de la que se abrió el archivo si estás en un visor).
- La vista previa lee el archivo completo una vez; archivos binarios o ilegibles muestran un aviso.
- Probado en Windows. En otras plataformas debería funcionar, pero no se probó.
- La vista previa con hover depende de `on_hover` en las filas; si no reacciona en tu versión de Herdr, usa `↑↓`.

## Créditos y licencia

`mods/quick-find/highlight.js` es una copia del resaltador de [mchlkim/herdr-file-explorer](https://github.com/mchlkim/herdr-file-explorer) (MIT, ver `LICENSE-THIRD-PARTY-herdr-file-explorer`). El resto del código es MIT (ver `LICENSE`).
