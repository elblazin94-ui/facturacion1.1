import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

// Usar la SERVICE KEY para confirmar al admin manualmente
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function confirmAdmin() {
  const email = 'admin@danisolutions.com';
  
  console.log(`Buscando usuario: ${email}...`);
  
  const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
  
  if (listError) {
    console.error('Error listando usuarios:', listError.message);
    return;
  }
  
  const user = users.find(u => u.email === email);
  
  if (!user) {
    console.error('No se encontró el usuario admin.');
    return;
  }
  
  console.log(`Confirmando usuario ID: ${user.id}...`);
  
  const { data, error } = await supabase.auth.admin.updateUserById(user.id, {
    email_confirm: true
  });
  
  if (error) {
    console.error('Error al confirmar:', error.message);
  } else {
    console.log('✅ ¡Usuario admin confirmado exitosamente con la Service Key!');
  }
}

confirmAdmin();
