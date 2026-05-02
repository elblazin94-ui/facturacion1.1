// db.js — Almacén persistente: Supabase
import { supabase } from './auth.js'

// ─── Funciones de Facturas ────────────────────────────────────────────────────

export async function obtenerFacturas(empresa_id) {
  if (!supabase) return []
  
  let query = supabase.from('facturas').select('*').order('created_at', { ascending: false })
  
  if (empresa_id) {
    query = query.eq('empresa_id', empresa_id)
  }
  
  const { data, error } = await query
  if (error) {
    console.error('[DB] Error al obtener facturas:', error.message)
    return []
  }
  return data
}

export async function obtenerNombreEmpresa(empresa_id) {
  if (!supabase) return `Empresa ${empresa_id}`
  const { data, error } = await supabase
    .from('profiles')
    .select('empresa_nombre')
    .eq('empresa_id', empresa_id)
    .limit(1)

  if (error || !data?.length || !data[0]?.empresa_nombre) {
    return `Empresa ${empresa_id}`
  }
  return data[0].empresa_nombre
}

export async function agregarFactura(facturaData) {
  if (!supabase) return false
  
  const { data, error } = await supabase
    .from('facturas')
    .insert([facturaData])
    .select()
    .single()
    
  if (error) {
    console.error('[DB] Error al agregar factura:', error.message)
    return false
  }
  return data // Devuelve la factura agregada con el id nuevo
}

export async function esFacturaDuplicada(f) {
  if (!supabase) return false
  
  // Usamos un query buscando por proveedor y importe total similar (ya que en Supabase podemos tener pequeñas variaciones en los décimales, aunque lo normal es igual)
  const { data, error } = await supabase
    .from('facturas')
    .select('id')
    .eq('proveedor', f.proveedor)
    .eq('importe_total', f.importe_total)
    .limit(1)
    
  if (error) {
    console.error('[DB] Error comprobando duplicados:', error.message)
    return false
  }
  
  return data && data.length > 0
}

export async function actualizarEstadoFactura(id, nuevoEstado, empresa_id) {
  if (!supabase) return false
  
  let query = supabase
    .from('facturas')
    .update({ estado: nuevoEstado })
    .eq('id', id)
    
  if (empresa_id) {
    query = query.eq('empresa_id', empresa_id)
  }
  
  const { error } = await query
    
  if (error) {
    console.error('[DB] Error al actualizar estado de factura:', error.message)
    return false
  }
  return true
}

// ─── Funciones de Usuarios (Fallback / Legacy API) ──────────────────────────

export async function listarUsuariosLocal(empresa_id = null) {
  if (!supabase) return []
  
  let query = supabase.from('profiles').select('*').order('created_at', { ascending: false })
  
  if (empresa_id) {
    query = query.eq('empresa_id', empresa_id)
  }
  
  const { data, error } = await query
  if (error) {
    console.error('[DB] Error al listar usuarios:', error.message)
    return []
  }
  return data
}

export async function buscarUsuarioLocal(correo) {
  console.warn('[DB] buscarUsuarioLocal no debería usarse, delegar en Supabase Auth.')
  return null
}

export async function agregarUsuarioLocal(u) {
  console.warn('[DB] agregarUsuarioLocal no está soportado. Usar Supabase Auth + Profiles.')
  return false
}

export async function actualizarUsuarioLocal(id, campos) {
  if (!supabase) return false
  const { error } = await supabase.from('profiles').update(campos).eq('id', id)
  if (error) {
    console.error('[DB] Error actualizando usuario local:', error.message)
    return false
  }
  return true
}

export async function toggleUsuarioActivo(id, activo) {
  console.warn('[DB] toggleUsuarioActivo: debes gestionar activos desde auth.users en Supabase si es estricto.')
  return false
}
