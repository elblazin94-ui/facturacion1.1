// auth.js — Autenticación via Supabase Auth
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
// Usar service_role key para operaciones administrativas en el backend
export const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null

// ─── Login principal ──────────────────────────────────────────────────────────
export async function loginUsuario(correo, password) {
  if (!supabase) {
    return { success: false, error: 'Supabase no está configurado.' }
  }

  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: correo,
      password: password
    })

    if (authError) {
      return { success: false, error: authError.message }
    }

    const userId = authData.user.id

    // Obtener perfil adicional (rol, empresa_id)
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('role, empresa_id, nombre')
      .eq('id', userId)
      .single()

    if (profileError) {
      console.warn('[Auth] No se encontró perfil para este usuario:', profileError.message)
    }

    const user = {
      id: userId,
      correo: authData.user.email,
      nombre: profileData?.nombre || authData.user.email,
      rol: profileData?.role || 'auxiliar',
      empresa_id: profileData?.empresa_id || 'DEFAULT_EMPRESA',
    }

    return { 
      success: true, 
      token: authData.session.access_token, 
      user 
    }
  } catch (err) {
    console.error('[Auth] Error en login:', err)
    return { success: false, error: 'Error del servidor al intentar login.' }
  }
}

// ─── Middleware de autenticación JWT de Supabase ──────────────────────────────
export async function requireAuth(req, res, next) {
  // Rutas públicas
  const publicPaths = ['/healthz', '/api/auth/login', '/login.html', '/login']
  if (publicPaths.some(p => req.path.startsWith(p))) return next()

  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    if (req.headers.accept && req.headers.accept.includes('text/html')) {
      return res.redirect('/login.html')
    }
    return res.status(401).json({ error: 'No autenticado.' })
  }

  // Verificar el token con Supabase Auth
  const { data, error } = await supabase.auth.getUser(token)

  if (error || !data.user) {
    if (req.headers.accept && req.headers.accept.includes('text/html')) {
      return res.redirect('/login.html')
    }
    return res.status(401).json({ error: 'Token inválido o expirado.' })
  }

  // Cargar el rol y empresa_id del usuario
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, empresa_id, nombre')
    .eq('id', data.user.id)
    .single()

  req.user = {
    id: data.user.id,
    correo: data.user.email,
    nombre: profile?.nombre || data.user.email,
    rol: profile?.role || 'auxiliar',
    empresa_id: profile?.empresa_id || 'DEFAULT_EMPRESA'
  }
  
  next()
}

// Para compatibilidad con usuarios locales
export function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex')
}
