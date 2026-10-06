# Parqué Relámpago

Juego multijugador de navegador: partidas de 5 minutos en las que hasta 8 jugadores compran y venden una acción inventada (NOVA). Las velas son de 5 segundos, el volumen de compra y venta es visible y **las órdenes de cada jugador mueven el precio para todos**. Gana quien tenga más patrimonio al cierre.

No hay servidor de juego: es una web estática y los jugadores se conectan entre sí por WebRTC (P2P). El navegador de quien abre la sala hace de servidor.

## Arrancarlo

Basta con servir la carpeta `public/` con cualquier servidor de ficheros estáticos. Con Node.js 20 o superior:

```bash
npm start
```

Abre <http://localhost:3000>. Para jugar con alguien de tu misma red, que abra `http://<IP-de-tu-PC>:3000`. Para jugar por internet, publica la web (ver más abajo).

Hace falta servirla por HTTP: abrir `index.html` con doble clic no funciona, porque los navegadores no cargan módulos JavaScript desde `file://`.

Para probar una sala sin amigos, abre varias pestañas: cada pestaña es un jugador distinto.

## Cómo se juega

- **Partida rápida**: entras en una sala pública que esté esperando jugadores. Si no hay ninguna, abres tú una y haces de anfitrión. La campana suena 30 s después de abrirse la sala, o a los 3 s si todos marcan «Estoy listo».
- **Sala privada**: recibes un código de 4 letras y un enlace para compartir. Quien la crea es el anfitrión: elige la duración (1, 3 o 5 min) y decide cuándo empezar.
- Los huecos libres hasta 8 los ocupan bots con estrategias distintas: ballena, seguidores de tendencia, contrarians y ruido.
- Teclas: `C` comprar, `V` vender, `X` cerrar posición, `1`/`2`/`3` tamaño (25/50/100 % del patrimonio).
- Vender sin acciones abre un corto. No hay apalancamiento: la posición máxima es el 100 % del patrimonio.
- El cierre se liquida al precio medio de los últimos 30 s, para que no se pueda manipular el último segundo.

## Arquitectura

```
public/index.html   Cliente: pinta lo que manda la sala y envía órdenes
public/js/p2p.js    Red P2P (PeerJS): abrir sala, unirse, partida rápida, reconexión
public/js/room.js   Una sala: jugadores, fases (lobby → live → ended), reloj de 200 ms, mensajes
public/js/market.js Simulación del mercado (pura, sin red): precio, velas, impacto, noticias, bots
scripts/serve.js    Servidor de ficheros estáticos para jugar en local
prototype/          El prototipo de un jugador original (todo en el navegador)
```

**El anfitrión es la única autoridad.** Su navegador ejecuta `room.js` y `market.js`. Los demás abren un canal de datos WebRTC directo con él, envían «comprar 50 %» y reciben el resultado. Las órdenes se ejecutan al llegar, en orden de llegada. El propio anfitrión juega con el mismo protocolo, sin pasar por la red.

Como la simulación corre en el navegador del anfitrión, en teoría él podría hacer trampas modificando el código. El resto no puede. Jugad con gente de confianza.

### Conexión entre jugadores

- [PeerJS](https://peerjs.com/) (cargado desde jsDelivr, versión fija con SRI) gestiona WebRTC. Su servidor de señalización público y gratuito solo sirve para que los navegadores se encuentren: el tráfico de la partida va directo entre ellos.
- Cada sala tiene una dirección fija en ese servidor: `parque-relampago-v1-` más el código (`KQBT`) en las privadas, o `pub-1` … `pub-12` en las públicas. La partida rápida recorre los huecos públicos: si uno está libre lo abre, y si está ocupado prueba a unirse.
- PeerJS incluye servidores STUN y TURN por defecto, así que suele conectar incluso detrás de routers estrictos. Si en alguna red no conecta, puedes usar tu propio servidor PeerJS o TURN definiendo `window.PR_PEER` antes de cargar el juego (ver `public/js/p2p.js`).

### Desconexiones

- **Si un jugador recarga o pierde la conexión**, vuelve a conectarse solo y conserva su asiento y su posición. En la sala de espera tiene 10 s para volver.
- **Si el anfitrión recarga la página**, reabre la sala con el mismo código y los demás vuelven a entrar solos, pero la partida en curso se pierde y empezáis desde la sala de espera. Si hay más jugadores en mitad de una partida, el navegador le pide confirmación antes de salir.
- **Si el anfitrión cierra la pestaña o pulsa «Cerrar la sala»**, la sala desaparece y los demás vuelven al menú.
- El reloj del anfitrión corre en un Web Worker, así que la partida sigue a buen ritmo aunque cambie de pestaña.

### Protocolo (JSON por el canal de datos)

| Jugador → sala | |
|---|---|
| `join {name, token?, quick?}` | Al conectar. Con `token` recupera el asiento tras una reconexión. `quick` solo entra si la sala es pública y está esperando |
| `leave` | Salir de la sala |
| `ready {ready}` · `start` · `config {mins}` | Sala de espera (`start`/`config` solo el anfitrión de una sala privada) |
| `order {side: buy\|sell\|close, size: 0.25\|0.5\|1, seq}` | Operar |
| `ping {t}` | Latencia |

| Sala → jugador | |
|---|---|
| `welcome {id, token, code, host}` · `state {...}` | Al entrar en una sala: identidad y foto completa |
| `error {code, text}` | No se puede entrar: `full` (llena) o `busy` (no admite partida rápida) |
| `tick {k, px, cs, pr, ph, left, ev, rk}` | Cada 200 ms: precio, velas nuevas o actualizadas, presión, fase, eventos de la cinta y clasificación |
| `room {...}` | Lista de jugadores |
| `start` · `end {results}` · `lobby` · `closed` | Cambios de fase. `closed`: el anfitrión ha cerrado la sala |
| `replaced` | Tu asiento se ha abierto en otra pestaña; esta deja de reconectar |
| `fill {seq, q, px, eid, me}` · `reject {seq, reason}` · `me {me}` | Tus órdenes y tu posición |

La cinta es anónima: nadie ve quién ha hecho cada orden grande. Tus propias órdenes te llegan por `fill`.

### Límites anti-abuso (los aplica el anfitrión)

- 20 mensajes/s por conexión, 5 órdenes/s por jugador y mensajes de 2 KB como máximo.
- Nombres saneados (18 caracteres, sin HTML) y escapados de nuevo en el cliente.
- Un jugador del que no llega nada en 15 s se da por desconectado.

## Publicarlo gratis

Es una web estática: sube la carpeta `public/` a cualquier alojamiento de ficheros estáticos (GitHub Pages, Netlify, Cloudflare Pages…). No hay que mantener ningún proceso encendido.

Con GitHub Pages ya está preparado: el flujo [.github/workflows/pages.yml](.github/workflows/pages.yml) publica `public/` en cada push a `main`. Solo tienes que activarlo una vez en *Settings → Pages → Build and deployment → Source: GitHub Actions*. La web quedará en `https://<usuario>.github.io/<repositorio>/`.

## Siguientes pasos posibles

- Que otro jugador tome el relevo como anfitrión si el anfitrión se va.
- Varias acciones por partida o un evento especial a mitad de partida.
- Chat rápido o emotes en la sala.
- Ranking histórico con cuentas (exigiría un servicio externo con base de datos).
- Ajustar `liq`, la volatilidad y los bots con datos de partidas reales.
