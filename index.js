// index.js — Servidor principal optimizado para Railway
import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { obtenerFacturas, actualizarEstadoFactura, agregarFactura } from './db.js'
import {
  connectToWhatsApp,
  getQrBase64,
  getEstadoConexion,
  setOnNuevaFactura,
  setOnEstadoCambio,
  logoutWhatsApp,
} from './whatsapp.js'
import { loginUsuario, requireAuth, hashPassword, supabase } from './auth.js'

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

// ── Scoring determinístico ────────────────────────────────────────────────────
function calculateScore(inv) {
  let score = 0
  if (inv.cufe) score += 20
  if (inv.cufe && inv.cufe.length > 30) score += 15
  const subtotal = Number(inv.subtotal)
  const iva = Number(inv.iva)
  const total = Number(inv.total)
  if (!isNaN(subtotal) && !isNaN(iva) && !isNaN(total) &&
      Math.abs((subtotal + iva) - total) <= 1) score += 20
  if (/^[0-9]{8,10}$/.test(inv.nit_emisor)) score += 15
  if (inv.fecha_emision) score += 10
  if (!inv.duplicado) score += 20
  return score
}

function classifyInvoice(score) {
  if (score >= 90) return 'ALTA'
  if (score >= 70) return 'MEDIA'
  return 'BAJA'
}

function statusByClassification(clasificacion) {
  if (clasificacion === 'ALTA') return 'lista'
  if (clasificacion === 'MEDIA') return 'pendiente_auxiliar'
  return 'pendiente_contador'
}

async function detectDuplicate(supabase, empresa_id, cufe, numero_factura, nit_emisor) {
  if (cufe) {
    const { data } = await supabase.from('facturas').select('id')
      .eq('empresa_id', empresa_id).eq('cufe', cufe).limit(1)
    if (data?.length > 0) return true
  }
  if (numero_factura && nit_emisor) {
    const { data } = await supabase.from('facturas').select('id')
      .eq('empresa_id', empresa_id)
      .eq('numero_factura', numero_factura)
      .eq('nit_emisor', nit_emisor)
      .limit(1)
    if (data?.length > 0) return true
  }
  return false
}

async function upsertTercero(empresaId, nit, nombre) {
  if (!nit) return null
  const { data: existing } = await supabase
    .from('terceros')
    .select('id')
    .eq('empresa_id', empresaId)
    .eq('identificacion', nit)
    .limit(1)

  if (existing && existing.length > 0) return existing[0].id

  const { data: nuevo, error } = await supabase
    .from('terceros')
    .insert([{
      empresa_id: empresaId,
      tipo: 'proveedor',
      nombre: nombre || 'Sin nombre',
      identificacion: nit,
      verificado: false
    }])
    .select('id')
    .single()

  if (error) {
    console.error('[Terceros] Error al crear:', error.message)
    return null
  }
  return nuevo?.id
}

// Vistas protegidas
app.get('/usuarios', (_req, res) => res.sendFile(join(__dirname, 'public', 'usuarios.html')))
app.get('/terceros', (_req, res) => res.sendFile(join(__dirname, 'public', 'terceros.html')))
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
    let query = supabase.from('facturas').select('*')

    // Admin ve todas, el resto solo las de su empresa
    if (req.user.rol !== 'admin') {
      query = query.eq('empresa_id', req.user.empresa_id)
    }

    // Filtrado por rol
    if (req.user.rol === 'auxiliar') {
      query = query.in('clasificacion', ['ALTA', 'MEDIA'])
    } else if (req.user.rol === 'contador') {
      query = query.in('clasificacion', ['MEDIA', 'BAJA'])
    }

    query = query.order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    console.error('[API] Error obteniendo facturas:', err.message)
    res.json([])
  }
})

// Cambiar estado de factura (compatible con estados v2)
const ESTADOS_VALIDOS = new Set(['Nuevo', 'pendiente_auxiliar', 'pendiente_contador', 'lista', 'lista_para_erp'])
app.put('/api/facturas/:id/estado', requireRole('admin', 'contador', 'auxiliar'), async (req, res) => {
  try {
    const { estado } = req.body || {}
    if (!estado || !ESTADOS_VALIDOS.has(estado)) return res.status(400).json({ error: 'Estado inválido' })

    if (estado === 'lista_para_erp' && req.user.rol === 'auxiliar') {
      return res.status(403).json({ error: 'Solo el contador puede aprobar para ERP' })
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

// ─── Procesar factura (flujo completo: duplicados → score → tercero → guardar) ─
app.post('/api/facturas/procesar', requireRole('admin', 'contador', 'auxiliar'), async (req, res) => {
  try {
    const f = req.body
    const empresaId = req.user.empresa_id || '1'
    const nit = f.nit_emisor || f.nif_proveedor
    const nombreTercero = f.razon_social_emisor || f.proveedor

    // 1. Detectar duplicado
    const duplicado = await detectDuplicate(supabase, empresaId, f.cufe, f.numero_factura, nit)

    // 2. Score y clasificación
    const facturaTemp = { ...f, duplicado }
    const score = calculateScore(facturaTemp)
    const clasificacion = classifyInvoice(score)
    const estado = statusByClassification(clasificacion)

    // 3. Upsert tercero automático
    const tercero_id = nit ? await upsertTercero(empresaId, nit, nombreTercero) : null

    // 4. Guardar factura
    const facturaData = {
      ...f,
      empresa_id: empresaId,
      score,
      clasificacion,
      estado: duplicado ? 'Nuevo' : estado,
      duplicado,
      tercero_id,
      nit_emisor: nit,
      razon_social_emisor: nombreTercero,
    }

    const resultado = await agregarFactura(facturaData)
    if (!resultado) return res.status(500).json({ error: 'No se pudo guardar la factura' })

    broadcast({ event: 'nueva_factura', data: resultado })
    res.json({ success: true, factura: resultado, score, clasificacion, duplicado })
  } catch (err) {
    return sendError(res, 500, 'Error procesando factura', err)
  }
})

// ─── Editar factura (campos permitidos) ────────────────────────────────────────
const CAMPOS_EDITABLES = new Set([
  'proveedor', 'nif_proveedor', 'numero_factura', 'fecha_factura',
  'concepto', 'subtotal', 'impuestos', 'importe_total', 'moneda',
  'categoria', 'metodo_pago', 'notas', 'cufe', 'nit_emisor',
  'razon_social_emisor', 'iva', 'total'
])
app.patch('/api/facturas/:id', requireRole('admin', 'contador', 'auxiliar'), async (req, res) => {
  try {
    const updates = {}
    for (const [k, v] of Object.entries(req.body)) {
      if (CAMPOS_EDITABLES.has(k)) updates[k] = v
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No hay campos válidos para editar' })

    const { data: facActual } = await supabase.from('facturas').select('*').eq('id', req.params.id).single()
    if (!facActual) return res.status(404).json({ error: 'Factura no encontrada' })

    const merged = { ...facActual, ...updates }
    updates.score = calculateScore(merged)
    updates.clasificacion = classifyInvoice(updates.score)

    let query = supabase.from('facturas').update(updates).eq('id', req.params.id)
    if (req.user.rol !== 'admin') query = query.eq('empresa_id', req.user.empresa_id)

    const { data, error } = await query.select().single()
    if (error) throw error
    broadcast({ event: 'nueva_factura' })
    res.json({ success: true, factura: data })
  } catch (err) {
    return sendError(res, 500, 'Error editando factura', err)
  }
})

// ─── Aprobar factura (solo contador → lista_para_erp) ─────────────────────────
app.post('/api/facturas/:id/aprobar', requireRole('admin', 'contador'), async (req, res) => {
  try {
    let query = supabase.from('facturas').update({ estado: 'lista_para_erp' }).eq('id', req.params.id)
    if (req.user.rol !== 'admin') query = query.eq('empresa_id', req.user.empresa_id)

    const { data, error } = await query.select().single()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Factura no encontrada' })

    broadcast({ event: 'nueva_factura' })
    res.json({ success: true, factura: data })
  } catch (err) {
    return sendError(res, 500, 'Error aprobando factura', err)
  }
})

// ─── API Terceros (CRUD completo) ─────────────────────────────────────────────
app.get('/api/terceros', async (req, res) => {
  try {
    const tipo = req.query.tipo
    let query = supabase.from('terceros').select('*').eq('empresa_id', req.user.empresa_id)
    if (tipo) query = query.eq('tipo', tipo)
    const { data, error } = await query.order('created_at', { ascending: false })
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    return sendError(res, 500, 'Error obteniendo terceros', err)
  }
})

app.post('/api/terceros', requireRole('admin', 'contador'), async (req, res) => {
  const { nombre, identificacion, tipo, email, telefono, direccion } = req.body
  if (!nombre || !tipo) return res.status(400).json({ error: 'Nombre y tipo son requeridos' })
  try {
    const { data, error } = await supabase
      .from('terceros')
      .insert([{ nombre, identificacion, tipo, email, telefono, direccion, empresa_id: req.user.empresa_id, verificado: true }])
      .select().single()
    if (error) throw error
    res.json({ success: true, tercero: data })
  } catch (err) {
    return sendError(res, 500, 'Error creando tercero', err)
  }
})

app.put('/api/terceros/:id', requireRole('admin', 'contador'), async (req, res) => {
  const { nombre, identificacion, tipo, email, telefono, direccion } = req.body
  try {
    const { data, error } = await supabase
      .from('terceros')
      .update({ nombre, identificacion, tipo, email, telefono, direccion })
      .eq('id', req.params.id).eq('empresa_id', req.user.empresa_id)
      .select().single()
    if (error) throw error
    res.json({ success: true, tercero: data })
  } catch (err) {
    return sendError(res, 500, 'Error actualizando tercero', err)
  }
})

app.delete('/api/terceros/:id', requireRole('admin', 'contador'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('terceros').delete()
      .eq('id', req.params.id).eq('empresa_id', req.user.empresa_id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    return sendError(res, 500, 'Error eliminando tercero', err)
  }
})

app.patch('/api/terceros/:id/aprobar', requireRole('admin', 'contador'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('terceros').update({ verificado: true })
      .eq('id', req.params.id).eq('empresa_id', req.user.empresa_id)
      .select().single()
    if (error) throw error
    res.json({ success: true, tercero: data })
  } catch (err) {
    return sendError(res, 500, 'Error aprobando tercero', err)
  }
})

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
// ─── API Facturas: procesar, editar, aprobar ──────────────────────────────────
app.post('/api/facturas/procesar', requireRole('contador', 'auxiliar'), async (req, res) => {
  const { supabase } = await import('./auth.js')
  const inv = req.body
  const empresa_id = req.user.empresa_id

  if (!inv.nit_emisor && !inv.razon_social_emisor)
    return res.status(400).json({ error: 'Se requiere al menos NIT o razón social del emisor' })

  const subtotal = Number(inv.subtotal)
  const iva = Number(inv.iva)
  const total = Number(inv.total)
  if ([subtotal, iva, total].some(isNaN))
    return res.status(400).json({ error: 'subtotal, iva y total deben ser numéricos' })

  try {
    const duplicado = await detectDuplicate(supabase, empresa_id, inv.cufe, inv.numero_factura, inv.nit_emisor)
    const score = calculateScore({ ...inv, subtotal, iva, total, duplicado })
    const clasificacion = classifyInvoice(score)
    const estado = statusByClassification(clasificacion)
    const tercero_id = await upsertTercero(supabase, empresa_id, inv.nit_emisor, inv.razon_social_emisor, inv.nit_emisor)

    const { data, error } = await supabase.from('facturas').insert({
      empresa_id,
      cufe: inv.cufe || null,
      numero_factura: inv.numero_factura || null,
      fecha_factura: inv.fecha_emision || null,
      nit_emisor: inv.nit_emisor || null,
      razon_social_emisor: inv.razon_social_emisor || null,
      nif_proveedor: inv.nit_emisor || null,
      proveedor: inv.razon_social_emisor || null,
      subtotal,
      iva,
      impuestos: iva,
      total,
      importe_total: total,
      moneda: inv.moneda || 'COP',
      concepto: inv.concepto || null,
      metodo_pago: inv.metodo_pago || null,
      score,
      clasificacion,
      estado,
      duplicado,
      tercero_id,
    }).select().single()

    if (error) throw error
    broadcast({ event: 'nueva_factura', data })
    res.json({ success: true, factura: data, score, clasificacion, estado, duplicado })
  } catch (err) {
    return sendError(res, 500, 'Error procesando factura', err)
  }
})

app.patch('/api/facturas/:id', requireRole('contador', 'auxiliar'), async (req, res) => {
  const { supabase } = await import('./auth.js')
  const EDITABLE = ['concepto', 'metodo_pago', 'notas', 'categoria', 'nit_emisor', 'razon_social_emisor']
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => EDITABLE.includes(k)))
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'Ningún campo editable enviado' })
  try {
    const { data, error } = await supabase.from('facturas')
      .update(updates)
      .eq('id', req.params.id)
      .eq('empresa_id', req.user.empresa_id)
      .select().single()
    if (error) throw error
    res.json({ success: true, factura: data })
  } catch (err) {
    return sendError(res, 500, 'Error actualizando factura', err)
  }
})

app.post('/api/facturas/:id/aprobar', async (req, res) => {
  if (req.user.rol !== 'contador') return res.status(403).json({ error: 'No autorizado' })
  const { supabase } = await import('./auth.js')
  try {
    const { data, error } = await supabase.from('facturas')
      .update({ estado: 'lista_para_erp' })
      .eq('id', req.params.id)
      .eq('empresa_id', req.user.empresa_id)
      .select().single()
    if (error) throw error
    broadcast({ event: 'nueva_factura' })
    res.json({ success: true, factura: data })
  } catch (err) {
    return sendError(res, 500, 'Error aprobando factura', err)
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

setOnEstadoCambio((empresaId, estado, qr) => {
  console.log(`[WhatsApp] Broadcast estado: ${estado} (empresa ${empresaId})`)
  broadcast({ event: 'qr_update', data: { estado, qr } })
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
