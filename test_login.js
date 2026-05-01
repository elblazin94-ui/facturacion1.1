import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function testLogin() {
  const email = 'admin@danisolutions.com';
  const password = 'danisolutions2026';

  console.log(`Probando inicio de sesión para: ${email}...`);

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    console.error('❌ Error al iniciar sesión:', error.message);
    if (error.message.includes('Email not confirmed')) {
      console.log('⚠️ El usuario existe pero requiere confirmación por email.');
    }
  } else {
    console.log('✅ ¡Inicio de sesión exitoso!');
    console.log('JWT Token:', data.session.access_token.substring(0, 20) + '...');
    
    // Ahora intentar ver el perfil
    const { data: profile } = await supabase.from('profiles').select('*').single();
    console.log('Perfil recuperado:', JSON.stringify(profile, null, 2));
  }
}

testLogin();
