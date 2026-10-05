# Parqué Relámpago

Juego multijugador de navegador: partidas de 5 minutos en las que hasta 8 jugadores compran y venden una acción inventada (NOVA). Las velas son de 5 segundos, el volumen de compra y venta es visible y **las órdenes de cada jugador mueven el precio para todos**. Gana quien tenga más patrimonio al cierre.

## Arrancarlo

Necesitas Node.js 20 o superior.

```bash
npm install
npm start
```

Abre <http://localhost:3000>. Para jugar con alguien de tu misma red, que abra `http://<IP-de-tu-PC>:3000`.

Para probar una sala sin amigos, conecta jugadores falsos que operan al azar:

```bash
npm run bots -- 3            # 3 jugadores entran en partida rápida
npm run bots -- 2 KQBT       # 2 jugadores entran en la sala privada KQBT
```

## Cómo se juega

- **Partida rápida**: entras en una sala pública. La campana suena 30 s después de que entre el primer jugador, o a los 3 s si todos marcan «Estoy listo».
- **Sala privada**: recibes un código de 4 letras y un enlace para compartir. El anfitrión elige la duración (1, 3 o 5 min) y decide cuándo empezar.
- Los huecos libres hasta 8 los ocupan bots con estrategias distintas: ballena, seguidores de tendencia, contrarians y ruido.
- Teclas: `C` comprar, `V` vender, `X` cerrar posición, `1`/`2`/`3` tamaño (25/50/100 % del patrimonio).
- Vender sin acciones abre un corto. No hay apalancamiento: la posición máxima es el 100 % del patrimonio.
- El cierre se liquida al precio medio de los últimos 30 s, para que no se pueda manipular el último segundo.

## Arquitectura

```
server/market.js   Simulación del mercado (pura, sin red): precio, velas, impacto, noticias, bots
server/room.js     Una sala: jugadores, fases (lobby → live → ended), reloj de 200 ms, mensajes
server/index.js    HTTP (sirve public/) + WebSocket en /ws, emparejamiento, límites
public/index.html  Cliente: pinta lo que manda el servidor y envía órdenes
scripts/fake-players.js  Jugadores falsos para pruebas
prototype/         El prototipo de un jugador original (todo en el navegador)
```

**El servidor es la única autoridad.** El cliente nunca calcula precios ni saldos, solo envía «comprar 50 %» y recibe el resultado. Las órdenes se ejecutan al llegar, en orden de llegada.

### Modelo de precio

`precio = 48 · exp(F + dev)`

- `F` (valor de fondo): paseo aleatorio, más la parte permanente del impacto de cada orden (55 %), más las noticias.
- `dev` (desviación temporal): el 45 % restante del impacto, que se desvanece en unos segundos (`decay = 0.962` por tick).
- Impacto de una orden de `q` acciones: `q · precio / liq`, con `liq = 220 000`. Se ejecuta al precio medio entre el de antes y el de después, más una comisión del 0,06 %. Por eso una orden grande paga su propio movimiento.
- Flujo anónimo de fondo con rachas «institucionales» de compra o venta que se pueden leer en el volumen.

Los parámetros están en `CFG`, en [server/market.js](server/market.js).

### Protocolo (JSON sobre WebSocket)

| Cliente → servidor | |
|---|---|
| `hello {name, token?, code?}` | Al conectar. Con `token`+`code` recupera el asiento tras una recarga |
| `quick {name}` · `create {name, mins}` · `join {name, code}` · `leave` | Salas |
| `ready {ready}` · `start` · `config {mins}` | Sala de espera (`start`/`config` solo el anfitrión) |
| `order {side: buy\|sell\|close, size: 0.25\|0.5\|1, seq}` | Operar |
| `ping {t}` | Latencia |

| Servidor → cliente | |
|---|---|
| `welcome {id, token, code}` · `state {...}` | Al entrar en una sala: identidad y foto completa |
| `tick {k, px, cs, pr, ph, left, ev, rk}` | Cada 200 ms: precio, velas nuevas o actualizadas, presión, fase, eventos de la cinta y clasificación |
| `room {...}` | Lista de jugadores |
| `start` · `end {results}` · `lobby` | Cambios de fase |
| `fill {seq, q, px, eid, me}` · `reject {seq, reason}` · `me {me}` | Tus órdenes y tu posición |

La cinta es anónima: nadie ve quién ha hecho cada orden grande. Tus propias órdenes te llegan por `fill`.

### Límites anti-abuso

- 20 mensajes/s por conexión, 5 órdenes/s por jugador y mensajes de 2 KB como máximo.
- Nombres saneados (18 caracteres, sin HTML) y escapados de nuevo en el cliente.
- Si te desconectas en mitad de una partida conservas el asiento y la posición hasta el final. En la sala de espera tienes 10 s para volver.

## Publicarlo gratis

Es un solo proceso Node que sirve la web y el WebSocket en el mismo puerto (lee `PORT` del entorno), así que funciona en cualquier servicio que admita WebSockets, por ejemplo Render, Fly.io o Railway. Revisa las condiciones de su plan gratuito: algunos duermen el servidor cuando no hay tráfico.

Las salas viven en memoria. Si el proceso se reinicia, se pierden las partidas en curso.

## Siguientes pasos posibles

- Varias acciones por partida o un evento especial a mitad de partida.
- Chat rápido o emotes en la sala.
- Ranking histórico con cuentas (exigiría base de datos).
- Ajustar `liq`, la volatilidad y los bots con datos de partidas reales.
