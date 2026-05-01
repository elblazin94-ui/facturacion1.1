import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function createAdmin() {
  const email = 'admin@danisolutions.com';
  const password = 'danisolutions2026';

  console.log(`Intentando registrar admin: ${email}...`);

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        nombre: 'Administrador Principal',
        role: 'admin',
        empresa_id: '1'
      }
    }
  });

  if (error) {
    if (error.message.includes('already registered')) {
      console.log('El usuario ya estaba registrado en Auth.');
    } else {
      console.error('Error al registrar:', error.message);
    }
  } else {
    console.log('✅ Usuario registrado exitosamente en Supabase Auth.');
    console.log('Nota: Si tienes activada la confirmación por email, revisa tu bandeja de entrada.');
  }
}

createAdmin();
