# Neptunzinho — Bot IA Profesional para HaxBall Headless

Bot de fútbol 1v1 con Inteligencia Artificial y **aprendizaje adaptativo**, escrito en **JavaScript Vanilla** (sin librerías, sin Node.js), para ejecutarse en la consola de un servidor headless de HaxBall.

> [!IMPORTANTE]
> ## Por qué el bot "no se mueve" en haxball.com/headless
>
> La **API oficial** de HaxBall Headless **NO incluye ningún método para mover jugadores**:
> no existe `setPlayerInputs`, `setPlayerInputControls` ni equivalente. Está confirmado en la
> documentación oficial y en [haxball/haxball-issues#1467](https://github.com/haxball/haxball-issues/issues/1467).
>
> Resultado: en la página oficial **el bot nunca va a moverse** — eso no es un bug del script.
> Para que un jugador sea controlado por IA hace falta un host con la API **parcheada**
> (un `game-min.js` modificado que exponga el control de input).
>
> Este script **detecta automáticamente** qué API expone la página que tengas abierta:
> - Si hay control de input → **mueve al bot con toda la IA**.
> - Si no → imprime una advertencia en rojo en la consola y funciona como **gestor de sala**
>   (equipos, límites 1v1, anuncios, comandos).

---

## Cómo se mueve el bot (hosts compatibles)

El script usa el método disponible en este orden: `setPlayerInputs({dx,dy,kick}, id)` (moderno) o
`setPlayerInputControls(id, {up,down,left,right,kick})` (fork antiguo).

Para un host **que sí puede mover bots**, opciones de la comunidad:

| Host | Qué es | Nota |
|---|---|---|
| [node-haxball (wxyz-abcd)](https://github.com/wxyz-abcd/node-haxball) | Framework potente (browser/Node) con control real de input (`playerInput`) | Su ejemplo web usa su propia página headless parcheada |
| haxroomie / haxbolt / haxball-room-host | Gestores de sala para VPS que ejecutan headless parcheado | Muy usados por la comunidad de bots |
| Fork propio con `game-min.js` modificado | Compilas/parcheas tú la API | Se rompe con cada update grande de Basro |

Si tu página expone `room.setPlayerInputs` (o `setPlayerInputControls`), **este script lo detecta solo y el bot juega**.

---

## Cómo usar

1. Abre tu **host headless** (el oficial para gestionar la sala, o el parcheado para ver al bot moverse).
2. Pulsa `F12` → consola.
3. Copia el contenido de [`haxball-bot-ia.js`](./haxball-bot-ia.js) y pégalo → `Enter`.
4. Opcional: edita arriba del archivo `CFG.playerName` (por defecto **"Neptunzinho"**).

### El bot es el host de la sala (no necesitás renombrar a nadie)
La sala se crea con `playerName: "Neptunzinho"` y `noPlayer: false`, así el **host player**
ya nace con ese nombre y **este script lo enlaza automáticamente** como bot. La API de haxball
no permite renombrar jugadores externos, por eso el bot se configura por nombre en `playerName`.

---

## Características

### Sala
- `HBInit` nativo con sala 1v1: `playerName`, `maxPlayers: 4`, `public: false`.
- **Límites 1v1**: `scoreLimit` (3 goles) y `timeLimit` (0 = sin tiempo).
- Auto-arranque: cuando hay 1 jugador por equipo se lanza el partido solo.
- Auto-balanceo de equipos, todos admin, avatar ⚡ para el bot.
- Reconexión: si el bot se va, se reasigna en `onPlayerLeave` y con chequeos periódicos.

### IA (60 FPS, `onGameTick`)
- **Predicción física**: lee la velocidad real del balón (vía `getDiscProperties(0)` o por
  dif. de ticks si la API no la da), integra posición+velocidad con fricción **0.99** y rebotes
  en los muros → el bot intercepta la trayectoria, no persigue la bola.
- **Máquina de estados**:
  - Defensa: se para sobre la recta portería-propia → balón para bloquear.
  - Campo propio: misma línea, más adelantado.
  - Ataque: corre a la posición futura del balón y se coloca "detrás" para empujarlo.
- **Disparo con cooldown**: patea solo alineado (< 0.6 rad a la esquina elegida);
  cooldown corto cerca del arco (finishing), despeje automático en área propia, y
  **sprint/dash** cuando está lejos (APIs modernas).
- **Esquiva al rival** cuando pelea el balón (nudge perpendicular).

### Aprendizaje (de verdad)
- Aprende **qué esquina del arco le convierte más**: cada gol refuerza la esquina del último
  tiro (`Learn.cornerScore`) y las preferencias decaen lentamente con el tiempo.
- Se adapta al marcador: si va **perdiendo** hunde la línea defensiva; si va **ganando**,
  presiona más arriba (`goalDrift`).

---

## Comandos (chat)

| Comando | Acción |
|---|---|
| `!bot` | Rebusca y reasigna al bot por nombre |
| `!rojo` / `!azul` | Cambia el bot de equipo |
| `!ia` | Muestra estadísticas y esquinas aprendidas |
| `/stadium <nombre>` | Cambia de estadio (admin) |

## Tabla de configuración (`CFG`)

| Clave | Defecto | Descripción |
|---|---|---|
| `playerName` | `Neptunzinho` | Nombre del bot (host player) |
| `botAvatar` | `⚡` | Avatar del bot |
| `botTeam` | `1` | Equipo inicial (1 Rojo / 2 Azul) |
| `grabFirst` | `true` | Sin el nombre, controla al primer jugador |
| `allAdmins` | `true` | Todos admin |
| `autoBalance` | `true` | Reparte espectadores en equipos |
| `autoStart` | `true` | Arranca el partido con 1v1 |
| `autoRestart` | `false` | Reinicia el partido tras la victoria |
| `stadium` | `Classic` | Estadio inicial (`''` = no tocar) |
| `scoreLimit` | `3` | Goles para ganar |
| `timeLimit` | `0` | Minutos de límite (0 = ilimitado) |
| `friction` | `0.99` | Fricción del balón por tick |
| `predSteps` | `30` | Frames de predicción (~0.5 s) |
| `kickRange` | `50` | Rango máximo de patada |
| `kickCooldown` | `8` | Cooldown de patada (ticks) |
| `quickCooldown` | `4` | Cooldown cerca del arco (ticks) |
| `kickLock` | `90` | No patear en el arranque del kickoff |
| `alignRadians` | `0.6` | Tolerancia de alineación para disparar |
| `stickDist` | `22` | px "detrás" del balón al atacar |
| `leadScale` | `0.24` | Anticipación al punto futuro |
| `blockBase` | `130` | Línea de bloqueo defensivo |
| `dangerBase` | `470` | Radio de peligro en área propia |
| `goalHalf` | `180` | Media altura de la portería (Classic) |
| `avoidDist` | `170` | Rango para esquivar rival |
| `finishRange` | `420` | Distancia de arranque del modo finisher |

---

## Archivos

- `haxball-bot-ia.js` — el script completo (IIFE, listo para pegar en consola).
- Este `README.md` — documentación.

## Solución de problemas

- **"El bot no se mueve"** → mirá la consola: si aparece la advertencia roja de
  `MOVIMIENTO DEL BOT IMPOSIBLE`, estás en la página oficial (sin parche). Usá un host parcheado.
- **"`room.setPlayerInputs is not a function`"** → mismo caso: la página no tiene el método.
  El script ya no crashea por esto: lo detecta y avisa.
- **Sala que "colapsa"** → el script envuelve `onGameTick` en `try/catch`; ningún error
  puntual tumba el servidor.

## Requisitos

- Navegador (Chrome, Firefox, Edge) con acceso a un host headless de HaxBall.
- Para ver al bot moverse: host con API parcheada (ver tabla).

## Licencia

MIT