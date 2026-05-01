// index.js — Servidor principal optimizado para Railway
import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { obtenerFacturas, actualizarEstadoFactura, toggleUsuarioActivo } from './db.js'
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

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.warn('[Auth] SUPABASE_URL o SUPABASE_KEY no configurados.')
  console.warn('[Auth] Usando credenciales locales AUTH_USER / AUTH_PASSWORD como fallback.')
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
app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '10mb' }))

// ─── 3. Login page (pública) ─────────────────────────────────────────────────
app.get('/login', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'login.html'))
})

// ─── 4. Endpoint de autenticación (público) ───────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
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

// Proteger el resto de rutas (API) con requireAuth
app.use('/api', requireAuth)

// Vistas protegidas por SSR no son necesarias si usamos redirección en el cliente
app.get('/usuarios', (req, res) => res.sendFile(join(__dirname, 'public', 'usuarios.html')))
app.get('/dashboard', (req, res) => res.redirect('/'))

app.get('/api/estado', (_req, res) => {
  res.json({
    estado: getEstadoConexion(),
    qr: getQrBase64(),
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
app.put('/api/facturas/:id/estado', async (req, res) => {
  try {
    const { estado } = req.body
    if (!estado) return res.status(400).json({ error: 'Estado requerido' })
    const isAdminOrContador = req.user.rol === 'admin' || req.user.rol === 'contador'
    const filterEmpresa = isAdminOrContador ? null : req.user.empresa_id
    const exito = await actualizarEstadoFactura(req.params.id, estado, filterEmpresa)
    if (!exito) return res.status(404).json({ error: 'Factura no encontrada o no autorizada' })
    broadcast({ event: 'nueva_factura' }) // reutilizamos para forzar recarga
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Listar usuarios (Híbrido: Supabase + Local)
// Listar usuarios (desde la tabla profiles de Supabase)
app.get('/api/usuarios', async (req, res) => {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Prohibido' })
  const { supabase } = await import('./auth.js')
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, role, empresa_id, nombre, created_at')
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Crear usuario (vía Supabase Auth Admin)
app.post('/api/usuarios', async (req, res) => {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Prohibido' })
  const { correo, password, nombre, rol, empresa_id } = req.body
  if (!correo || !password || !nombre) return res.status(400).json({ error: 'Correo, contraseña y nombre son requeridos.' })
  
  const { supabase } = await import('./auth.js')
  
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email: correo,
      password: password,
      email_confirm: true,
      user_metadata: { 
        nombre: nombre,
        role: rol || 'auxiliar',
        empresa_id: empresa_id || '1',
        telefono: req.body.telefono || null,
        empresa_nombre: req.body.empresa_nombre || null,
        nit: req.body.nit || null,
        direccion: req.body.direccion || null,
        ciudad: req.body.ciudad || null,
        departamento: req.body.departamento || null
      }
    })

    if (error) throw error
    res.json({ success: true, user: data.user })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Crear Empresa (Genera Contador y Auxiliar)
app.post('/api/empresas', async (req, res) => {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Prohibido' })
  const { empresa_nombre, empresa_id, correo_contador, correo_auxiliar, password } = req.body
  if (!empresa_nombre || !empresa_id || !correo_contador || !correo_auxiliar || !password) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para registrar la empresa.' })
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


app.post('/api/logout', async (_req, res) => {
  await logoutWhatsApp()
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
        estado: getEstadoConexion(),
        qr: getQrBase64()
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

// ─── 5. Seed: Crear usuario de prueba si no existe ───────────────────────────
async function seedTestUser() {
  const { buscarUsuarioLocal, agregarUsuarioLocal } = await import('./db.js')
  
  const testUsers = [
    {
      correo: 'demo@empresa.com',
      contrasena: hashPassword('Demo2026!'),
      nombre: 'Carlos Mendoza',
      telefono: '+57 315 123 4567',
      empresa_nombre: 'Distribuciones El Progreso S.A.S',
      nit: '901.234.567-8',
      direccion: 'Cra 15 #45-30 Oficina 201',
      ciudad: 'Pereira',
      departamento: 'Risaralda',
      rol: 'auxiliar',
      empresa_id: 'emp-001',
    },
    {
      correo: 'admin@danisolutions.com',
      contrasena: hashPassword('danisolutions2026'),
      nombre: 'Admin DaniSolutions',
      telefono: '+57 300 000 0000',
      empresa_nombre: 'DaniSolutions',
      nit: '900.000.000-0',
      direccion: 'Sede Principal',
      ciudad: 'Pereira',
      departamento: 'Risaralda',
      rol: 'admin',
      empresa_id: '1',
    }
  ]

  for (const user of testUsers) {
    try {
      const existe = await buscarUsuarioLocal(user.correo)
      if (!existe) {
        await agregarUsuarioLocal(user)
        console.log(`[Seed] Usuario creado: ${user.correo} (${user.rol})`)
      }
    } catch (err) {
      // Ignorar si ya existe
      if (!err.message.includes('UNIQUE')) {
        console.warn(`[Seed] Error creando ${user.correo}:`, err.message)
      }
    }
  }
}

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
  
  // Crear usuarios de prueba
  await seedTestUser()
  
  // Iniciar WhatsApp en segundo plano (no bloqueante)
  setTimeout(() => {
    console.log('[WhatsApp] Iniciando conexión...')
    connectToWhatsApp().catch(err => {
      console.error('[WhatsApp] Error al conectar:', err.message)
    })
  }, 1000)
})
