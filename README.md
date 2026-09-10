# NeptunZinho · Host headless para HaxBall

Sala local (headless) de HaxBall en Node.js con comandos de administración y el
robot **NeptunZinho**, un jugador estilo futsal que corre, remata (rockets),
pasa contra la pared y defiende.

## Requisitos

- Node.js 14 o superior.
- Un token headless de HaxBall: https://www.haxball.com/headlesstoken

## Instalación

```bash
npm install
```

## Arrancar la sala

```bash
# Opción 1: token en un archivo
echo "TU_TOKEN_AQUI" > token.txt
node main.js

# Opción 2: token por variable de entorno
$env:HAXBALL_TOKEN="TU_TOKEN_AQUI"; node main.js   # PowerShell
```

Cuando la sala esté levantada, entra desde el cliente oficial de HaxBall. Para
convertirte en admin escribe en el chat:

```
!admin MI_CONTRASEÑA
```

La contraseña por defecto se puede cambiar con `--pw`.

## Argumentos de línea de comandos

| Argumento | Descripción | Por defecto |
| --- | --- | --- |
| `--pw <clave>` | Contraseña para `!admin` | `neptun` |
| `--name <nombre>` | Nombre de la sala | `NeptunZinho` |
| `--map <estadio>` | Estadio (Classic, Small, Big, Rounded, Hockey, Easy, Multi-goal) | `Classic` |
| `--score <n>` | Límite de goles | `5` |
| `--time <n>` | Tiempo máximo (minutos) | `3` |
| `--gk` | El bot juega solo como portero | (al campo) |
| `--no-bot` | No crea el bot | (bot activo) |
| `--no-auto` | Sin auto-inicio ni auto-reinicio de partidos | (auto) |

Ejemplos:

```bash
node main.js --pw miClave --name "Futsal Neptun" --map Rounded --gk
node main.js --no-bot --pw 1234
```

## Comandos en el chat

Comandos públicos:

| Comando | Efecto |
| --- | --- |
| `!admin <clave>` | Te nombra administrador (si la clave es correcta) |
| `!help` | Muestra la lista de comandos |
| `!red`, `!blue`, `!spec` | Te cambia de equipo |

Comandos de administrador (requieren ser admin):

| Comando | Efecto |
| --- | --- |
| `!logout` | Quita admin al jugador que lo escribe |
| `!kick [razón]` | Expulsa al último jugador en escribir |
| `!ban <id>` | Expulsa y banea a un jugador por id |
| `!clearbans` | Limpia las banlistas |
| `!lock` / `!unlock` | Cierra / abre la sala |
| `!start` / `!stop` | Inicia / detiene el partido |
| `!swap` | Cambia de equipo al bot |
| `!gk` | El bot pasa a portero |
| `!field` | El bot vuelve al campo |
| `!map <estadio>` | Cambia de estadio |
| `!score <n>` | Nuevo límite de goles |
| `!time <n>` | Nuevo límite de tiempo |
| `!password <clave>` | Cambia la contraseña de admin |
| `!auto` | Reintenta el auto-inicio manualmente |
| `!count`, `!tag` | Información de la sala |

## Estructura del proyecto

```
F:\hxb
├─ main.js               # Sala, comandos y conexión del bot
├─ neptunzinho.js        # Cerebro del bot (predicción, pases, defensa, portero)
├─ token.txt             # Tu token headless (una línea, sin comillas)
├─ test
│  └─ sandbox_tests.js   # Prueba offline en el sandbox de node-haxball
└─ package.json
```

## Prueba offline del bot

Sin necesidad de token ni de conexión, el bot se prueba contra un rival pasivo
en el sandbox físico incluido:

```bash
npm test
```

La prueba crea una sala virtual, deja que NeptunZinho (equipo rojo) tome el
balón y comprueba que avanza hacia el gol azul. Si el bot mete el balón en
zona de gol el test finaliza con `[OK]`.

## Sobre el bot

- **Física aprovechada:** el balón se golpea en la dirección del movimiento;
  rematar en carrera (sprint + kick) produce un "rocket" (~4.9 u/tick).
- **Decisiones:** el bot predice la trayectoria del balón (rebotes en paredes y
  porterías), elige entre rematar, pasar, o jugar contra la pared, y se
  coloca entre el balón y su portería en defensa.
- **Rol portero:** con `--gk` juega solo de portero sobre la línea del área.