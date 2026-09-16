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
- **Predicción física por trayectoria**: simula el balón tick a tick (fricción **0.99**, rebotes y parada) y en vez de perseguirlo va al **primer punto de la trayectoria que puede alcanzar** (interceptación, no persecución).
- **Control de velocidad con freno**: mide su velocidad real y frena a tiempo → deja de "pasar de largo" la pelota (el defecto de la v1).
- **Máquina de estados**:
  - **Portero**: con el balón en zona de peligro se coloca en la recta gol→balón usando el punto donde la trayectoria **cruzaría la línea de gol**, con sesgo vertical aprendido según las esquinas que prefiere el rival.
  - **Sombra**: si el rival lleva el balón, se interpone entre balón y portería.
  - **Ataque/dribling**: con el balón, lo conduce con golpecitos hacia la esquina elegida; remata cuando queda alineado cerca del arco.
  - **Formación**: sin balón en juego ocupa su posición inicial.
- **Disparo con cooldown**: patea solo alineado (< `alignRadians` a la esquina), cooldown corto cerca del arco, despeje/robo automático en el área, y esquivón al rival en disputa.

### Aprendizaje (de verdad, heurístico)
- Aprende **qué esquina del arco le convierte más**: cada gol refuerza la esquina del último tiro y las preferencias decaen con el tiempo.
- Aprende **hacia qué esquina tira el rival** y ajusta su posición de portero (`saveBias`).
- Se adapta al marcador: perdiendo hunde la línea defensiva; ganando presiona más arriba (`goalDrift`).

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
| `predSteps` | `40` | Frames de predicción para interceptar |
| `maxSpeed` | `26` | Velocidad máxima estimada (px/tick) |
| `brakeAcc` | `3.2` | Deceleración estimada (px/tick²) |
| `reachSpeed` | `15` | Velocidad media para "alcanzo el punto" |
| `reachEps` | `30` | Margen de alcance de interceptación |
| `kickRange` | `50` | Rango máximo de patada |
| `kickCooldown` | `7` | Cooldown de patada (ticks) |
| `quickCooldown` | `3` | Cooldown cerca del arco (ticks) |
| `kickLock` | `90` | No patear en el arranque del kickoff |
| `alignRadians` | `0.75` | Tolerancia de alineación para rematar |
| `dribbleTol` | `1.05` | Tolerancia del golpecito de conducción |
| `finishRange` | `620` | Distancia desde la que remata |
| `touchRange` | `28` | Rango de toque (radio jug+balón) |
| `stickDist` | `12` | px "detrás" del balón al atacar |
| `leadScale` | `0.24` | Anticipación al punto futuro |
| `blockBase` | `130` | Línea de bloqueo defensivo |
| `dangerBase` | `480` | Radio de peligro en área propia |
| `goalHalf` | `180` | Media altura de la portería (Classic) |
| `avoidDist` | `150` | Rango para esquivar rival |
| `shadowSharp` | `0.5` | Agresividad de la línea defensiva sombra |
| `adminKey` | `neptunzinho` | Clave de `!admin <clave>` (invisible en el chat) |

---

## Modo Node.js (node-haxball) — el bot SÍ se mueve

La página oficial de HaxBall **no** permite controlar el input del bot. Para que el bot
juegue de verdad (moverse, tirar, defender) se usa **node-haxball** (`wxyz-abcd`), que
emula el host completo en Node y expone el control real de input de cada jugador
(`room.fakeSendPlayerInput(Utils.keyState(dirX, dirY, kick), id)`).

### Pasos

1. Instalación (una sola vez):

   ```bash
   npm install node-haxball
   ```

2. Obtené tu **token de headless** en <https://www.haxball.com/headlesstoken>
   (formato `thr1.XXXX....YYYY`).

3. Ponelo en `index.js` (constante `TOKEN`) o exportalo como variable de entorno
   (recomendado, así no se sube por error al repo):

   ```powershell
   $env:HAXBALL_TOKEN="thr1.TU.TOKEN"; node index.js
   ```

4. Ejecutá:

   ```bash
   node index.js
   ```

5. La consola imprime el **link de la sala** (`onAfterRoomLink`). Entrá por ahí y
   quedás automáticamente en el equipo contrario del bot (1v1).

### Arquitectura de `index.js`

| Elemento browser (haxball-bot-ia.js) | Equivalente en node-haxball |
|---|---|
| `HBInit({...})` | `Room.create({ name, token, noPlayer, ... }, { config: new NeptunBot(api), storage, onOpen, onClose })` |
| `room.onGameTick` | `NeptunBot.onGameTick` (subclase de `RoomConfig`) |
| `room.getBallPosition()` / `getDiscProperties(0)` | `room.gameStateExt.physicsState.discs[0]` (`.pos`, `.speed`) |
| `player.position` | `player.disc.ext.pos` (tras `room.extrapolate()`) |
| `room.startGame()` / `setTeam` / `setScoreLimit` | los mismos métodos del host |
| ❌ no existe (input) | `room.fakeSendPlayerInput(Utils.keyState(dirX, dirY, kick), id)` |

El bot se crea "en memoria" con `room.fakePlayerJoin(65535, ...)` para que no haga
falta que nadie entre a ocupar su nombre; `65535` es su id.

### Detalles importantes del input

- `Utils.keyState(dirX, dirY, kick)` devuelve un int: `kick*16 + right*8 + left*4 + up*2 + down*1`
  (`dirX`/`dirY` ∈ {-1, 0, 1}). El jugador se mueve a velocidad máxima en 8 direcciones
  (no hay control proporcional, por eso la IA convierte el vector a 3x3 con `deadzone`).
- Solo se envía input cuando cambia (`runAfterGameTick`), y para repetir kick primero
  se "suelta" el bit con `desired & -17` (patrón oficial del repo, evita desync).
- Física idéntica a la página: fricción `0.99`/tick, mapa Classic (campo 3760×2080,
  arco a ±1860). La misma predicción 30 pasos ya funciona.

### Comandos de chat (dentro de la sala)

- `!ia` — estadísticas de la IA (goles, esquinas aprendidas y hacia dónde prefiere tirar el rival).
- `!admin neptunzinho` — te da admin (clave secreta; la podés cambiar en `CONFIG.adminKey`).
- `!rojo` / `!azul` — cambiá de lado al bot.

> Ningún comando `!` se publica en el chat: `onPlayerChat` devuelve `false` y
> node-haxball filtra el mensaje (no lo ven los otros jugadores, así la clave no
> se delata). Solo te llega a vos un aviso privado con el resultado.

## Archivos

- `haxball-bot-ia.js` — el script completo para la página (IIFE; el bot NO puede moverse ahí).
- `index.js` — el bot IA con movimiento real usando node-haxball (la alternativa recomendada).
- `package.json` / `package-lock.json` — dependencias (`node-haxball`).
- Este `README.md` — documentación.

## Solución de problemas

- **"El bot no se mueve"** → mirá la consola: si aparece la advertencia roja de
  `MOVIMIENTO DEL BOT IMPOSIBLE`, estás en la página oficial (sin parche). Usá un host parcheado.
- **"`room.setPlayerInputs is not a function`"** → mismo caso: la página no tiene el método.
  El script ya no crashea por esto: lo detecta y avisa.
- **Sala que "colapsa"** → el script envuelve `onGameTick` en `try/catch`; ningún error
  puntual tumba el servidor.

## Requisitos

- **Para `index.js` (bot con movimiento):** Node.js ≥ 16.9 y un token de
  <https://www.haxball.com/headlesstoken>.
- **Para `haxball-bot-ia.js` (página):** navegador (Chrome, Firefox, Edge) con acceso a
  un host headless de HaxBall; para ver moverse al bot, host con API parcheada (ver tabla).

## Licencia

MIT