---
name: whatsapp-baileys
description: Integra WhatsApp en una aplicacion Node.js usando la libreria Baileys (@whiskeysockets/baileys) con autenticacion por codigo QR y sesion persistente en disco. Cubre instalacion, conexion con reconexion automatica, envio y recepcion de mensajes (texto, imagen, documento, audio), integracion con apps Express/servidores existentes, y errores comunes. Usa esta skill SIEMPRE que el usuario mencione WhatsApp, Baileys, "bot de WhatsApp", "conectar WhatsApp", "escanear QR de WhatsApp", "enviar mensajes de WhatsApp desde codigo", "recibir mensajes de WhatsApp", "@whiskeysockets/baileys", "integra WhatsApp en mi app", "haz un bot de WhatsApp" o cualquier variacion, incluso si no menciona explicitamente "Baileys". Tambien aplica cuando el usuario pregunta como automatizar WhatsApp sin usar la API oficial de Meta/Twilio.
---

# Integracion de WhatsApp con Baileys via QR

Guia de referencia para integrar WhatsApp en una app Node.js usando **Baileys** (`@whiskeysockets/baileys`), una libreria WebSocket no oficial que implementa el protocolo de WhatsApp Web sin navegadores ni Selenium. La autenticacion se hace escaneando un codigo **QR** desde WhatsApp > Dispositivos vinculados, y la sesion se persiste en disco para no tener que re-escanear en cada arranque.

Repositorio oficial: <https://github.com/WhiskeySockets/Baileys> — Documentacion: <https://baileys.wiki/>.

## Advertencia importante

Baileys **no es una libreria oficial de WhatsApp/Meta**. El uso automatizado puede derivar en el baneo del numero. Recomienda al usuario:

- Usar un numero de prueba, no el personal/principal.
- No enviar spam ni cargas masivas desde numeros nuevos (WhatsApp los banea rapido).
- Para casos de produccion con garantias, sugerir la WhatsApp Business Cloud API oficial de Meta (pero es de pago y requiere verificacion). Baileys es ideal para prototipos, herramientas internas y proyectos personales.

## Prerequisitos

- Node.js >= 20 (Baileys v7+ usa features modernas de Node).
- Un gestor de paquetes: `npm`, `pnpm` o `yarn`.
- Un numero de WhatsApp activo en un telefono para escanear el QR la primera vez.

## Instalacion

Desde la raiz del proyecto del usuario:

```bash
npm install @whiskeysockets/baileys @hapi/boom qrcode-terminal pino
```

Notas sobre las dependencias:

- `@whiskeysockets/baileys`: la libreria principal.
- `@hapi/boom`: necesario para hacer type-cast del error en `lastDisconnect` y leer `output.statusCode`. Es una peer dependency de facto.
- `qrcode-terminal`: renderiza el QR en la terminal. Desde Baileys v7 la opcion `printQRInTerminal` del socket esta deprecada, asi que renderizamos el QR manualmente desde el evento `connection.update`.
- `pino`: logger que Baileys usa internamente. Aunque es opcional, conviene pasar una instancia con nivel `silent` o `warn` para no inundar la consola.

## Estructura minima recomendada

```
mi-app/
├── whatsapp.js            # modulo de conexion (lo que crea esta skill)
├── auth_info_baileys/     # se crea automaticamente, contiene credenciales
├── .gitignore             # debe incluir auth_info_baileys/
└── package.json
```

Importante: **agrega `auth_info_baileys/` al `.gitignore`**. Esa carpeta contiene las claves de la sesion; si se filtra a un repo publico, cualquiera podria impersonar la cuenta de WhatsApp.

```
# .gitignore
node_modules/
auth_info_baileys/
.env
```

## Codigo de referencia: conexion con QR y reconexion automatica

Crea `whatsapp.js` con el siguiente contenido. Este snippet esta basado en el README oficial de Baileys y cubre: persistencia multi-archivo, render del QR en terminal, reconexion cuando la conexion se cae, y deteccion de logout para detener el loop.

```js
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import pino from 'pino'

export async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'warn' }),
    // printQRInTerminal esta deprecado en v7+; renderizamos el QR manualmente
    // desde el evento connection.update mas abajo.
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // Primera conexion o sesion invalidada: muestra el QR en terminal.
      // El usuario debe abrir WhatsApp > Dispositivos vinculados > Vincular
      // un dispositivo y escanearlo en menos de ~20 segundos.
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log('Conexion cerrada. Reconectar:', shouldReconnect)

      if (shouldReconnect) {
        connectToWhatsApp()
      } else {
        // logout explicito: borra auth_info_baileys/ si quieres forzar un re-pair.
        console.log('Sesion cerrada. Elimina auth_info_baileys/ y reinicia.')
      }
    } else if (connection === 'open') {
      console.log('Conexion a WhatsApp establecida.')
    }
  })

  // Guarda las credenciales actualizadas (IMPRESCINDIBLE para persistir la sesion).
  sock.ev.on('creds.update', saveCreds)

  return sock
}
```

Nota: si el proyecto no usa TypeScript, reemplaza `(lastDisconnect?.error as Boom)` por `/** @type {Boom} */ (lastDisconnect?.error)` o simplemente accede con optional chaining sin el cast: `lastDisconnect?.error?.output?.statusCode`.

Para arrancar el cliente, en el entrypoint de la app:

```js
import { connectToWhatsApp } from './whatsapp.js'

connectToWhatsApp().catch(console.error)
```

La primera vez imprime el QR. Tras escanearlo, `auth_info_baileys/` queda poblada y los siguientes arranques se conectan solos sin QR.

## Enviar mensajes

El metodo principal es `sock.sendMessage(jid, content)`. El `jid` tiene estos formatos:

- **Individual**: `<numero_internacional_sin_+>@s.whatsapp.net` → por ejemplo `5215512345678@s.whatsapp.net` (Mexico).
- **Grupo**: `<group_id>@g.us` → lo obtienes del evento `messages.upsert` o de `sock.groupFetchAllParticipating()`.
- **Broadcast/Status**: rara vez se usa.

### Texto

```js
await sock.sendMessage('5215512345678@s.whatsapp.net', { text: 'Hola 👋' })
```

### Imagen, documento, audio

```js
// Imagen desde URL o Buffer
await sock.sendMessage(jid, {
  image: { url: 'https://example.com/foto.jpg' },
  caption: 'Mira esto',
})

// Documento (PDF, etc.)
await sock.sendMessage(jid, {
  document: { url: './reporte.pdf' },
  mimetype: 'application/pdf',
  fileName: 'reporte.pdf',
})

// Audio (nota de voz: ptt: true)
await sock.sendMessage(jid, {
  audio: { url: './voz.ogg' },
  mimetype: 'audio/ogg; codecs=opus',
  ptt: true,
})
```

Tambien puedes enviar `video`, `sticker`, `location`, `contacts`, reacciones (`react`), y responder en hilo con `{ quoted: msg }` como tercer parametro.

## Recibir mensajes

Engancha un listener al evento `messages.upsert`. Recibe un paquete con `type` y un array `messages`. Filtra los que mandaste tu (`m.key.fromMe`) para evitar eco.

```js
sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return

  for (const m of messages) {
    if (m.key.fromMe) continue

    const from = m.key.remoteJid
    const text =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      ''

    console.log(`[${from}] ${text}`)

    // Echo simple
    if (text) {
      await sock.sendMessage(from, { text: `Recibi: ${text}` })
    }
  }
})
```

Los tipos de mensaje mas comunes dentro de `m.message`:

- `conversation` → texto plano corto.
- `extendedTextMessage.text` → texto largo o con formato/quote.
- `imageMessage`, `videoMessage`, `audioMessage`, `documentMessage` → media (descarga con `downloadMediaMessage` de `@whiskeysockets/baileys`).
- `stickerMessage`, `locationMessage`, `contactMessage`.

## Integracion en una app existente (Express)

Patron recomendado: exporta un singleton del socket y exponlo via un modulo, para que rutas HTTP puedan enviar mensajes bajo demanda.

```js
// whatsapp.js
let sockInstance = null

export async function connectToWhatsApp() {
  // ...codigo de conexion de arriba...
  sockInstance = sock
  return sock
}

export function getSock() {
  if (!sockInstance) throw new Error('WhatsApp no esta conectado todavia')
  return sockInstance
}
```

```js
// server.js
import express from 'express'
import { connectToWhatsApp, getSock } from './whatsapp.js'

const app = express()
app.use(express.json())

app.post('/send', async (req, res) => {
  const { to, text } = req.body
  const jid = `${to}@s.whatsapp.net`
  await getSock().sendMessage(jid, { text })
  res.json({ ok: true })
})

await connectToWhatsApp()
app.listen(3000, () => console.log('API lista en :3000'))
```

Para apps con multiples sesiones (multi-tenant), crea una carpeta `auth_info_<tenantId>/` por tenant y mantelos en un `Map<tenantId, sock>`.

## Errores comunes y como resolverlos

| Sintoma | Causa | Solucion |
|---|---|---|
| El QR se regenera cada ~20 s | Comportamiento normal: WhatsApp expira el QR | Escanealo rapido; si no alcanzas, espera al siguiente |
| `Connection Failure (401)` al reconectar | Sesion invalidada por WhatsApp (logout remoto, cambio de telefono, mucho tiempo desconectado) | Borra `auth_info_baileys/` y vuelve a correr para escanear un QR nuevo |
| `Stream Errored (restart required)` | Reinicio esperado del protocolo WhatsApp Web | La reconexion automatica del snippet lo maneja; no hagas nada |
| `Precondition Required (428)` | Desincronia de credenciales | Borra `auth_info_baileys/` y re-escanea |
| Mensajes enviados no llegan | `jid` mal formado (ej. llevaba el `+`, espacios o guiones) | Normaliza a solo digitos + `@s.whatsapp.net` |
| La cuenta fue baneada | Uso automatizado desde numero nuevo, envio masivo, o patron spammy | No hay recuperacion via Baileys. Usa otro numero y reduce el volumen |
| `Cannot find module '@whiskeysockets/baileys'` | Instalacion incompleta | `npm install @whiskeysockets/baileys` de nuevo; verifica Node >= 20 |
| Import ESM falla en CommonJS | El proyecto usa `require` | Anade `"type": "module"` al `package.json`, o usa `const { default: makeWASocket, ... } = require('@whiskeysockets/baileys')` |

## Migracion a v7+

Desde la version 7.0.0 hay cambios rompedores importantes (entre ellos, la deprecacion de `printQRInTerminal` que ya manejamos arriba). Si el usuario viene de una version anterior, consulta la guia oficial en <https://whiskey.so/migrate-latest>.

## Referencias

- Repositorio oficial: <https://github.com/WhiskeySockets/Baileys>
- Documentacion: <https://baileys.wiki/>
- Guia de migracion: <https://whiskey.so/migrate-latest>

## Notas para Claude al aplicar esta skill

- **Antes de escribir codigo, verifica que el proyecto del usuario sea Node.js** (`package.json` existe). Si no, ayudalo primero con `npm init -y`.
- **Pregunta si prefiere JavaScript o TypeScript** antes de generar el archivo `whatsapp.js` / `whatsapp.ts`. El snippet de arriba es ESM; adaptalo a CommonJS o TS segun el caso.
- **Confirma que `.gitignore` excluye `auth_info_baileys/`** antes de terminar. Si no existe `.gitignore`, crealo.
- **No escanees QR tu mismo**: el QR es interactivo y solo el usuario puede escanearlo desde su telefono. Explicale el paso (WhatsApp > Ajustes > Dispositivos vinculados > Vincular un dispositivo).
- **No asumas el numero del usuario**: cuando muestres ejemplos de `sendMessage`, usa placeholders claros como `<numero>@s.whatsapp.net` y pidele que lo reemplace.
