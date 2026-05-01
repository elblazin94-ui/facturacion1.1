// index.js — Servidor principal optimizado para Railway
import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { obtenerFacturas, actualizarEstadoFactura } from './db.js'
import {
  connectToWhatsApp,
  getQrBase64,
  getEstadoConexion,
  setOnNuevaFactura,
  logoutWhatsApp,
} from './whatsapp.js'
import { loginUsuario, requireAuth, hashPassword } from './auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

// Validación de variables de entorno
const REQUIRED_ENV = ['GEMINI_API_KEY']
const missing = REQUIRED_ENV.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error(`[CRÍTICO] Faltan variables de entorno: ${missing.join(', ')}`)
  console.error('El sistema NO funcionará correctamente hasta que se configuren.')
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('[CRÍTICO] SUPABASE_URL y SUPABASE_SERVICE_KEY son obligatorios. La autenticación NO funcionará.')
}

console.log('[Sistema] Iniciando en puerto:', PORT)

const app = express()

// ─── 1. Healthcheck (SIN AUTH) ────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.status(200).send('OK'))

// ─── 2. Middleware: Seguridad ─────────────────────────────────────────────────
// Confiar en proxy (Railway/Render) para obtener IP real
app.set('trust proxy', 1)
// Desactivar header X-Powered-By (fingerprinting)
app.disable('x-powered-by')

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "connect-src": ["'self'", "ws:", "wss:"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
}))

// CORS restrictivo: solo mismo origen por defecto. Definir ALLOWED_ORIGINS si se requieren clientes externos.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
  }
  next()
})

app.use(express.json({ limit: '1mb' }))

// ─── Rate Limiting (in-memory, sin dependencias externas) ─────────────────────
function createRateLimiter({ windowMs, max, keyFn = (req) => req.ip, message = 'Demasiadas solicitudes.' }) {
  const hits = new Map()
  setInterval(() => {
    const cutoff = Date.now() - windowMs
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k)
  }, windowMs).unref?.()
  return (req, res, next) => {
    const key = keyFn(req)
    const now = Date.now()
    let entry = hits.get(key)
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 }
      hits.set(key, entry)
    }
    entry.count++
    if (entry.count > max) {
      return res.status(429).json({ error: message })
    }
    next()
  }
}

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, max: 10,
  keyFn: (req) => `${req.ip}:${(req.body?.correo || '').toLowerCase()}`,
  message: 'Demasiados intentos de login. Espera 15 minutos.'
})
const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 })

// ─── 3. Login page (pública) ─────────────────────────────────────────────────
app.get('/login', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'login.html'))
})

// ─── 4. Endpoint de autenticación (público con rate limit) ───────────────────
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { correo, password } = req.body || {}
  if (!correo || !password) {
    return res.status(400).json({ error: 'Correo y contraseña son requeridos.' })
  }
  const result = await loginUsuario(correo, password)
  if (result.success) {
    console.log(`[Auth] Login exitoso: ${correo} (${result.user.rol})`)
    return res.json({ token: result.token, user: result.user })
  }
  console.warn(`[Auth] Intento fallido de login: ${correo}`)
  return res.status(401).json({ error: result.error })
})

// ─── 5. Archivos estáticos ──────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')))

// Proteger el resto de rutas (API) con requireAuth + rate limiter
app.use('/api', apiLimiter, requireAuth)

// Helper: respuesta de error genérica que no expone detalles internos
const sendError = (res, status, publicMsg, internalErr) => {
  if (internalErr) console.error(`[API] ${publicMsg}:`, internalErr.message || internalErr)
  return res.status(status).json({ error: publicMsg })
}
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.rol)) {
    return res.status(403).json({ error: 'Prohibido' })
  }
  next()
}

const getEmpId = (user) => user?.empresa_id || '1'

// Vistas protegidas por SSR no son necesarias si usamos redirección en el cliente
app.get('/usuarios', (_req, res) => res.sendFile(join(__dirname, 'public', 'usuarios.html')))
app.get('/dashboard', (req, res) => res.redirect('/'))

app.get('/api/estado', (req, res) => {
  const empId = getEmpId(req.user)
  res.json({
    estado: getEstadoConexion(empId),
    qr: getQrBase64(empId),
  })
})

app.get('/api/facturas', async (req, res) => {
  try {
    // Admin ve todas, clientes solo las suyas
    const empresaFilter = req.user.rol === 'admin' ? null : req.user.empresa_id
    const facturas = await obtenerFacturas(empresaFilter)
    res.json(facturas || [])
  } catch (err) {
    console.error('[API] Error obteniendo facturas:', err.message)
    res.json([]) // Devolver array vacío en lugar de error 500
  }
})

// Cambiar estado de factura
const ESTADOS_VALIDOS = new Set(['Nuevo', 'Revisado', 'Aprobado', 'Rechazado', 'Sincronizado'])
app.put('/api/facturas/:id/estado', requireRole('admin', 'contador', 'auxiliar'), async (req, res) => {
  try {
    const { estado } = req.body || {}
    if (!estado || !ESTADOS_VALIDOS.has(estado)) return res.status(400).json({ error: 'Estado inválido' })
    
    // Solo admin y contador pueden marcar como Sincronizado
    if (estado === 'Sincronizado' && req.user.rol === 'auxiliar') {
      return res.status(403).json({ error: 'Solo el contador puede sincronizar con el ERP' })
    }

    const isAdmin = req.user.rol === 'admin'
    const filterEmpresa = isAdmin ? null : req.user.empresa_id
    const exito = await actualizarEstadoFactura(req.params.id, estado, filterEmpresa)
    if (!exito) return res.status(404).json({ error: 'Factura no encontrada o no autorizada' })
    
    broadcast({ event: 'nueva_factura' })
    res.json({ success: true })
  } catch (err) {
    return sendError(res, 500, 'Error procesando la solicitud', err)
  }
})

// Listar usuarios (Híbrido: Supabase + Local)
// Listar usuarios (desde la tabla profiles de Supabase)
app.get('/api/usuarios', requireRole('admin'), async (req, res) => {
  const { supabase } = await import('./auth.js')
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, role, empresa_id, nombre, created_at')
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json(data)
  } catch (err) {
    return sendError(res, 500, 'Error obteniendo usuarios', err)
  }
})

// Crear usuario (vía Supabase Auth Admin)
// Validadores
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROLES_VALIDOS = new Set(['admin', 'contador', 'auxiliar'])
const validatePassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 128
const validateEmail = (e) => typeof e === 'string' && e.length <= 254 && EMAIL_RX.test(e)
const sanitizeStr = (s, max = 200) => (typeof s === 'string' ? s.trim().slice(0, max) : null)

app.post('/api/usuarios', requireRole('admin'), async (req, res) => {
  const { correo, password, nombre, rol, empresa_id } = req.body || {}
  if (!validateEmail(correo)) return res.status(400).json({ error: 'Correo inválido.' })
  if (!validatePassword(password)) return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres.' })
  if (!sanitizeStr(nombre)) return res.status(400).json({ error: 'Nombre requerido.' })
  if (rol && !ROLES_VALIDOS.has(rol)) return res.status(400).json({ error: 'Rol inválido.' })

  const { supabase } = await import('./auth.js')

  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email: correo,
      password: password,
      email_confirm: true,
      user_metadata: {
        nombre: sanitizeStr(nombre),
        role: rol || 'auxiliar',
        empresa_id: sanitizeStr(empresa_id) || '1',
        telefono: sanitizeStr(req.body.telefono, 32),
        empresa_nombre: sanitizeStr(req.body.empresa_nombre),
        nit: sanitizeStr(req.body.nit, 32),
        direccion: sanitizeStr(req.body.direccion),
        ciudad: sanitizeStr(req.body.ciudad, 80),
        departamento: sanitizeStr(req.body.departamento, 80)
      }
    })

    if (error) throw error
    res.json({ success: true, user: { id: data.user.id, email: data.user.email } })
  } catch (err) {
    return sendError(res, 500, 'No se pudo crear el usuario', err)
  }
})

// Crear Empresa (Genera Contador y Auxiliar)
app.post('/api/empresas', requireRole('admin'), async (req, res) => {
  const { empresa_nombre, empresa_id, correo_contador, correo_auxiliar, password } = req.body || {}
  if (!sanitizeStr(empresa_nombre) || !sanitizeStr(empresa_id) ||
      !validateEmail(correo_contador) || !validateEmail(correo_auxiliar) ||
      !validatePassword(password)) {
    return res.status(400).json({ error: 'Datos inválidos o faltantes para registrar la empresa.' })
  }
  
  const { supabase } = await import('./auth.js')
  
  try {
    // 1. Crear Contador
    const { error: err1 } = await supabase.auth.admin.createUser({
      email: correo_contador,
      password: password,
      email_confirm: true,
      user_metadata: { 
        nombre: 'Contador - ' + empresa_nombre,
        role: 'contador',
        empresa_id: empresa_id,
        empresa_nombre: empresa_nombre
      }
    })
    if (err1) throw err1;

    // 2. Crear Auxiliar
    const { error: err2 } = await supabase.auth.admin.createUser({
      email: correo_auxiliar,
      password: password,
      email_confirm: true,
      user_metadata: { 
        nombre: 'Auxiliar - ' + empresa_nombre,
        role: 'auxiliar',
        empresa_id: empresa_id,
        empresa_nombre: empresa_nombre
      }
    })
    if (err2) throw err2;

    res.json({ success: true, message: 'Empresa y usuarios creados con éxito.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Eliminar usuario
app.delete('/api/usuarios/:id', async (req, res) => {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Prohibido' })
  const { supabase } = await import('./auth.js')
  try {
    const { error } = await supabase.auth.admin.deleteUser(req.params.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Cambiar contraseña de un usuario (Admin)
app.put('/api/usuarios/:id/password', async (req, res) => {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Prohibido' })
  const { newPassword } = req.body
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' })

  const { supabase } = await import('./auth.js')
  try {
    const { error } = await supabase.auth.admin.updateUserById(req.params.id, {
      password: newPassword
    })
    if (error) throw error
    res.json({ success: true, message: 'Contraseña actualizada correctamente.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// El usuario cambia su PROPIA contraseña
app.put('/api/perfil/password', async (req, res) => {
  const { newPassword } = req.body
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres.' })

  const { supabase } = await import('./auth.js')
  try {
    const { error } = await supabase.auth.admin.updateUserById(req.user.id, {
      password: newPassword
    })
    if (error) throw error
    res.json({ success: true, message: 'Tu contraseña ha sido actualizada.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
// ─── API Clientes (CRUD en Supabase) ───────────────────────────────────────
app.get('/api/clientes', async (req, res) => {
  const { supabase } = await import('./auth.js')
  if (!supabase) return res.status(500).json({ error: 'Supabase no configurado' })

  try {
    const { data, error } = await supabase
      .from('clientes')
      .select('*')
      .eq('empresa_id', req.user.empresa_id)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/clientes', async (req, res) => {
  const { supabase } = await import('./auth.js')
  if (!supabase) return res.status(500).json({ error: 'Supabase no configurado' })

  const { nombre, identificacion, email, telefono, direccion } = req.body
  if (!nombre) return res.status(400).json({ error: 'El nombre es requerido' })

  try {
    const { data, error } = await supabase
      .from('clientes')
      .insert([{ 
        nombre, 
        identificacion, 
        email, 
        telefono, 
        direccion, 
        empresa_id: req.user.empresa_id 
      }])
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, cliente: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/clientes/:id', async (req, res) => {
  const { supabase } = await import('./auth.js')
  if (!supabase) return res.status(500).json({ error: 'Supabase no configurado' })

  const { nombre, identificacion, email, telefono, direccion } = req.body

  try {
    const { data, error } = await supabase
      .from('clientes')
      .update({ nombre, identificacion, email, telefono, direccion })
      .eq('id', req.params.id)
      .eq('empresa_id', req.user.empresa_id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, cliente: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/clientes/:id', async (req, res) => {
  const { supabase } = await import('./auth.js')
  if (!supabase) return res.status(500).json({ error: 'Supabase no configurado' })

  try {
    const { error } = await supabase
      .from('clientes')
      .delete()
      .eq('id', req.params.id)
      .eq('empresa_id', req.user.empresa_id)

    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


app.post('/api/logout', async (req, res) => {
  await logoutWhatsApp(getEmpId(req.user))
  res.json({ success: true })
})

app.get('/api/me', (req, res) => {
  res.json({ user: req.user })
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
        estado: getEstadoConexion('1'),
        qr: getQrBase64('1')
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

// seedTestUser eliminado: buscarUsuarioLocal / agregarUsuarioLocal son stubs no-op
// que delegan en Supabase Auth. Los usuarios de prueba deben crearse directamente
// desde el panel de Supabase o mediante el endpoint POST /api/empresas.

// ─── 6. Arranque ──────────────────────────────────────────────────────────────
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

server.listen(PORT, '0.0.0.0', async () => {
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
