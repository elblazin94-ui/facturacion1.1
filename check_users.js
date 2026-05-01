import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function checkUser() {
  const email = 'admin@danisolutions.com';
  console.log(`Verificando correo: ${email}...`);

  // 1. Verificar en tabla 'profiles'
  const { data: profile, error: pError } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email);

  if (pError) {
    console.warn('Nota: Error consultando perfiles (posible RLS):', pError.message);
  } else {
    console.log('Resultado en Perfiles:', profile.length > 0 ? 'EXISTE' : 'NO EXISTE');
    if (profile.length > 0) console.log(profile[0]);
  }

  // 2. Verificar en tabla 'usuarios' (antigua)
  const { data: legacy, error: lError } = await supabase
    .from('usuarios')
    .select('*')
    .eq('correo', email);

  if (!lError) {
    console.log('Resultado en Usuarios (Legacy):', legacy.length > 0 ? 'EXISTE' : 'NO EXISTE');
    if (legacy.length > 0) console.log(legacy[0]);
  }
}

checkUser();
