const token = 'FO36A6NNJoJOgIBGWb0GbV2tfaNnczUh';
const tableId = '708009';

async function createField(name, type) {
    const res = await fetch(`https://api.baserow.io/api/database/fields/table/${tableId}/`, {
        method: 'POST',
        headers: { 'Authorization': `Token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type })
    });
    const data = await res.json();
    console.log('Created:', name, data.id || data.detail || data.error || data);
}

async function main() {
    await createField('correo', 'email');
    await createField('contraseña', 'text');
    await createField('nombre', 'text');
    await createField('rol', 'text');
    await createField('activo', 'boolean');
    await createField('empresa_id', 'text');
}
main();
