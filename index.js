// index.js — Servidor principal optimizado para Railway
import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { obtenerFacturas } from './db.js'
import {
  connectToWhatsApp,
  getQrBase64,
  getEstadoConexion,
  setOnNuevaFactura,
  logoutWhatsApp,
} from './whatsapp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

// Validación de seguridad (Subagente de Seguridad)
const REQUIRED_ENV = ['GEMINI_API_KEY', 'AUTH_USER', 'AUTH_PASSWORD']
const missing = REQUIRED_ENV.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error(`[CRÍTICO] Faltan variables de entorno: ${missing.join(', ')}`)
  console.error('El sistema NO funcionará correctamente hasta que se configuren en Railway.')
  // No salimos (process.exit) para permitir que el healthcheck pase y podamos ver logs
}

const AUTH_USER = process.env.AUTH_USER
const AUTH_PASSWORD = process.env.AUTH_PASSWORD

if (!AUTH_USER || !AUTH_PASSWORD) {
  console.error('[Seguridad] ADVERTENCIA CRÍTICA: Faltan credenciales de acceso. El sistema no estará protegido correctamente.')
}

console.log('[Sistema] Iniciando en puerto:', PORT)

const app = express()

// ─── 1. Healthcheck (SIN AUTH) ────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.status(200).send('OK'))

// Bypass de salud para Railway (evita el error 1/1 replicas never became healthy)
app.get('/', (req, res, next) => {
  const ua = req.headers['user-agent'] || ''
  if (ua.toLowerCase().includes('railway') || ua.toLowerCase().includes('health')) {
    return res.status(200).send('OK')
  }
  next()
})

// ─── 2. Middleware: Seguridad ─────────────────────────────────────────────────
const basicAuth = (req, res, next) => {
  // Ignorar auth para el healthcheck ya manejado arriba
  const authHeader = req.headers.authorization || ''
  const [scheme, credentials] = authHeader.split(' ')

  if (scheme === 'Basic' && credentials) {
    try {
      const buffer = Buffer.from(credentials, 'base64')
      const [user, pass] = buffer.toString().split(':')
      if (user === AUTH_USER && pass === AUTH_PASSWORD) return next()
    } catch (e) {
      console.error('[Auth] Error decodificando credenciales')
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Acceso Protegido"')
  res.status(401).send('Autenticación requerida.')
}

app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '10mb' }))

// ─── 3. Rutas Protegidas ──────────────────────────────────────────────────────
app.use(basicAuth)
app.use(express.static(join(__dirname, 'public')))

app.get('/api/estado', (_req, res) => {
  res.json({
    estado: getEstadoConexion(),
    qr: getQrBase64(),
  })
})

app.get('/api/facturas', async (_req, res) => {
  try {
    res.json(await obtenerFacturas())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/logout', async (_req, res) => {
  await logoutWhatsApp()
  res.json({ success: true })
})

// ─── 4. Servidores ────────────────────────────────────────────────────────────
const server = createServer(app)
const wss = new WebSocketServer({ server })
const clientes = new Set()

wss.on('connection', async (ws) => {
  clientes.add(ws)
  try {
    ws.send(JSON.stringify({
      event: 'estado_inicial',
      data: {
        estado: getEstadoConexion(),
        qr: getQrBase64(),
        facturas: await obtenerFacturas(),
      },
    }))
  } catch (err) {
    console.error('[WS] Error en estado inicial:', err.message)
  }

  ws.on('close', () => clientes.delete(ws))
})

function broadcast(evento) {
  const mensaje = JSON.stringify(evento)
  for (const ws of clientes) {
    if (ws.readyState === 1) ws.send(mensaje)
  }
}

setOnNuevaFactura((factura) => {
  console.log(`[Sistema] Nueva factura: ${factura.proveedor}`)
  broadcast({ event: 'nueva_factura', data: factura })
})

// ─── 5. Arranque ──────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRÍTICO] Promesa no manejada:', promise, 'Razón:', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[CRÍTICO] Excepción no capturada:', err)
  // No salimos para intentar que Railway no mate la instancia de inmediato
})

server.on('error', (err) => {
  console.error('[Servidor] Error en el servidor HTTP:', err)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('=========================================')
  console.log(`🚀 SERVIDOR LISTO EN 0.0.0.0:${PORT}`)
  console.log(`📡 Healthcheck: http://0.0.0.0:${PORT}/healthz`)
  console.log('=========================================')
  
  // Iniciar WhatsApp en segundo plano (no bloqueante)
  setTimeout(() => {
    console.log('[WhatsApp] Iniciando conexión...')
    connectToWhatsApp().catch(err => {
      console.error('[WhatsApp] Error al conectar:', err.message)
    })
  }, 1000)
})
