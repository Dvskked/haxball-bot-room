# Bot IA Competitivo para HaxBall Headless

Bot de fútbol con Inteligencia Artificial avanzada, escrito en **JavaScript Vanilla (nativo)**, diseñado para ejecutarse **exclusivamente** en el entorno Headless de [haxball.com/headless](https://haxball.com/headless).

- Sin Node.js
- Sin librerías de terceros (no usa `haxball.js`)
- Sin servidores externos
- Solo la API nativa `HBInit()` del navegador

---

## Cómo usar

1. Abre en tu navegador: [https://haxball.com/headless](https://haxball.com/headless)
2. Pulsa `F12` para abrir la consola del navegador.
3. Copia el contenido de [`haxball-bot-ia.js`](./haxball-bot-ia.js) y pégalo en la consola.
4. Pulsa `Enter`. La sala se crea y el bot empieza a jugar automáticamente.

> Para publicar la sala en la lista de HaxBall necesitas un `token` de sala pública
> (obtenlo en https://www.haxball.com/headlesstoken). Añádelo en `ROOM_CONFIG.token`.
> Con `token: ''` la sala solo funciona con invitación directa por link.

---

## Características

### Inicialización de la sala
- Se crea con `HBInit({ ... })` usando únicamente la API nativa.
- `noPlayer: false`: la entidad de la sala controla y mueve un jugador físico real dentro del campo (el Bot).
- Gestión de eventos básica y robusta:
  - `onPlayerJoin`: asignación de bot, admins y balanceo de equipos.
  - `onPlayerLeave`: reasignación del avatar del bot y rebalanceo.
  - `onTeamVictory`: auto-reset de la partida (`stopGame` → `startGame`).

### IA avanzada en `onGameTick` (60 FPS)
- **Predicción de trayectoria de la pelota**: no persigue la posición actual de la bola. Simula paso a paso su posición futura usando `ball.vx` / `ball.vy`, el vector de **fricción** (`ballFriction = 0.5`) aplicado en tiempo real, y los **rebotes contra las paredes** del campo (800x400).
- **Posicionamiento táctico**:
  - Modo defensivo: se intercala exactamente sobre la línea entre la pelota y su propia portería para bloquear tiros (con esquive lateral dinámico).
  - Modo ofensivo: busca el ángulo de aproximación alineado *detrás* de la pelota respecto de la portería rival, listo para empujarla al gol.
- **Control de disparo (`kick: true` via `room.setPlayerInputs`)**:
  - Solo patea dentro del rango óptimo (`kickRange`) y cuando su alineación relativa pelota→arco supera el umbral angular.
  - Tolerancia más estricta en disparos lejanos (tiros de precisión), más laxa en el área (toques de control).
  - **Tiros con rebote**: un planificador de tiro evalúa trayectorias directas y trayectorias "bank shot" contra los bordes del mapa (paredes superior/inferior), validando por simulación si la bola entra realmente en la portería rival antes de elegir el objetivo.
- **Despejes peligrosos**: cuando la bola está en el área propia (`dangerClear`), despeja hacia la mitad rival teniendo en cuenta la banda por la que escapa.
- Control de físicas con cooldown de patada para evitar "stuttering" del bot.

### Extras
- Chat: escribe `!bot` para **activar/desactivar** la IA (útil para jugar tú manualmente).
- `window.HAXBOT` expone `{ room, cfg, bot }` para depurar desde consola.
- Todos los jugadores son admin por defecto (`CFG.allAdmins`).

---

## Tabla de configuración (`CFG`)

| Clave | Valor | Descripción |
|---|---|---|
| `botEnabled` | `true` | Activa/desactiva la IA del bot |
| `allAdmins` | `true` | Otorga admin a todos los que entran |
| `ballLookAhead` | `2.0` | Segundos de predicción de trayectoria |
| `kickRange` | `34` | Distancia máxima para poder patear |
| `kickCooldown` | `0.08` | Segundos entre patadas |
| `alignCosClose` | `0.92` | Umbral de alineación en juego corto |
| `alignCosFar` | `0.97` | Umbral de alineación en disparo lejano |
| `stickDist` | `24` | Distancia a la que el bot se coloca "detrás" de la bola |
| `longDist` | `140` | Distancia a partir de la cual se persigue el punto predicho |
| `dangerClear` | `120` | Radio de peligro sobre la propia portería |
| `blockDist` | `85` | Distancia de la línea de bloqueo respecto a la portería |
| `goalHalf` | `6` | Semialto de la boca de gol (para simular tiros) |
| `ballSpeed` | `0.3` | Impulso simulado de la patada (`ballKickSpeed`) |
| `restartDelay` | `4000` | ms hasta `stopGame` tras un gol |
| `restartGap` | `1000` | ms entre `stopGame` y `startGame` |

---

## Cómo funciona la IA (resumen técnico)

1. **`simulateBall`**: integra la posición futura de la bola en pasos de `1/60s` aplicando `factor = (1 - friction)^dt` y reflejando la velocidad en los bordes del campo.
2. **Toma de decisión**: si la bola está más cerca de mi portería que de la rival → **defensa**; si no → **ataque**.
3. **Defensa**:
   - Bola lejos → posición de bloqueo sobre la bisectriz pelota→portería (`blockPoint`).
   - Bola en el área → perseguir la bola predicha y despejar (`pickClearAim`).
4. **Ataque**:
   - Lejos de la bola → correr al punto predicho con ventaja de llegada (`leadPoint`).
   - Cerca → colocarse detrás de la bola respecto al arco rival (`behindBall`).
   - `planShot` busca el mejor objetivo (centro, palos o rebote en pared) validando la trayectoria con `bouncesIntoGoal`.
5. **Patada**: `wantKick` comprueba rango y alineación `dot(bot→bola, bola→objetivo)` y `room.setPlayerInputs(id, { ..., kick: true })` ejecuta el disparo.

---

## Requisitos

- Navegador (Chrome, Firefox, Edge) con acceso a `https://haxball.com/headless`.
- Conexión estable a los servidores de HaxBall.

## Licencia

MIT