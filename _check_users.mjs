import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
)

// 1. Listar usuarios existentes
const { data: listData, error: listError } = await supabase.auth.admin.listUsers()
if (listError) { console.error('ERROR listando:', listError.message); process.exit(1) }

console.log('\n=== USUARIOS EN SUPABASE AUTH ===')
listData.users.forEach(u => {
  console.log(`  - ${u.email} | ID: ${u.id} | Confirmado: ${u.email_confirmed_at ? 'SI' : 'NO'}`)
})

// 2. Definir cuentas que deben existir
const cuentas = [
  { email: 'admin@danisolutions.com',        password: 'danisolutions2026', rol: 'admin',    empresa_id: 'danisolutions',  nombre: 'Admin Principal' },
  { email: 'daservicioscot@danisolutions.com', password: 'Temporal2026*',    rol: 'contador', empresa_id: 'da-servicios',   nombre: 'Contador DA Servicios' },
  { email: 'daserviciosaux@danisolutions.com', password: 'Temporal2026*',    rol: 'auxiliar', empresa_id: 'da-servicios',   nombre: 'Auxiliar DA Servicios' },
]

console.log('\n=== VERIFICANDO / CREANDO CUENTAS ===')
for (const cuenta of cuentas) {
  const existe = listData.users.find(u => u.email === cuenta.email)

  if (existe) {
    // Actualizar contraseña y confirmar email
    const { error: upErr } = await supabase.auth.admin.updateUserById(existe.id, {
      password: cuenta.password,
      email_confirm: true
    })
    if (upErr) {
      console.error(`  ❌ Error actualizando ${cuenta.email}:`, upErr.message)
    } else {
      console.log(`  ✅ Actualizado (contraseña + confirmación): ${cuenta.email}`)
    }
  } else {
    // Crear usuario nuevo
    const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
      email: cuenta.email,
      password: cuenta.password,
      email_confirm: true,
    })
    if (createErr) {
      console.error(`  ❌ Error creando ${cuenta.email}:`, createErr.message)
      continue
    }
    console.log(`  ✅ Creado: ${cuenta.email} | ID: ${newUser.user.id}`)
    existe.id = newUser.user.id  // para el upsert de perfil abajo
  }

  // Upsert perfil en tabla profiles
  const userId = existe?.id || listData.users.find(u => u.email === cuenta.email)?.id
  if (userId) {
    const { error: profErr } = await supabase.from('profiles').upsert({
      id: userId,
      email: cuenta.email,
      nombre: cuenta.nombre,
      role: cuenta.rol,
      empresa_id: cuenta.empresa_id,
    }, { onConflict: 'id' })
    if (profErr) {
      console.error(`  ❌ Error en perfil de ${cuenta.email}:`, profErr.message)
    } else {
      console.log(`  ✅ Perfil upserted: ${cuenta.email} (${cuenta.rol})`)
    }
  }
}

console.log('\n=== LISTO ===')
console.log('Prueba iniciar sesión con:')
cuentas.forEach(c => console.log(`  ${c.email} / ${c.password}`))
