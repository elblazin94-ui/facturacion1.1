async function test() {
  try {
    const loginRes = await fetch('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correo: 'daservicioscot@danisolutions.com', password: 'Temporal2026*' })
    });
    const loginData = await loginRes.json();
    if (!loginRes.ok) throw new Error('Login failed: ' + JSON.stringify(loginData));
    
    const token = loginData.token;
    
    const postRes = await fetch('http://localhost:3000/api/terceros', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        tipo: 'cliente',
        nombre: 'Test Cliente from Script',
        identificacion: '88888888',
        email: 'cliente@test.com',
        telefono: '1234567',
        direccion: 'Calle 123'
      })
    });
    const postData = await postRes.text();
    console.log('Status:', postRes.status);
    console.log('Response:', postData);
  } catch(e) {
    console.error(e);
  }
}
test();
