-- Ejecuta este script en el SQL Editor de tu panel de Supabase

-- 1. Crear tabla perfiles (extendiendo auth.users de Supabase)
create table if not exists public.profiles (
  id uuid references auth.users not null primary key,
  email text,
  role text check (role in ('admin', 'auxiliar', 'contador')) default 'auxiliar',
  empresa_id text not null,
  nombre text,
  telefono text,
  empresa_nombre text,
  nit text,
  direccion text,
  ciudad text,
  departamento text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Asegurar que las columnas existan si la tabla ya fue creada previamente
alter table public.profiles add column if not exists telefono text;
alter table public.profiles add column if not exists empresa_nombre text;
alter table public.profiles add column if not exists nit text;
alter table public.profiles add column if not exists direccion text;
alter table public.profiles add column if not exists ciudad text;
alter table public.profiles add column if not exists departamento text;

-- Habilitar RLS en profiles
alter table public.profiles enable row level security;

-- Políticas para profiles (Eliminamos antes de crear para evitar errores de duplicado)
drop policy if exists "Usuarios pueden ver su propio perfil" on public.profiles;
create policy "Usuarios pueden ver su propio perfil" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "Admins pueden ver todos los perfiles" on public.profiles;
-- Función para verificar si es admin sin recursión
create or replace function public.is_admin()
returns boolean as $$
begin
  return exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
end;
$$ language plpgsql security definer;

create policy "Admins pueden ver todos los perfiles" on public.profiles
  for select using (public.is_admin());

-- 2. Crear tabla facturas
create table if not exists public.facturas (
  id uuid default gen_random_uuid() primary key,
  proveedor text,
  nif_proveedor text,
  numero_factura text,
  fecha_factura date,
  concepto text,
  subtotal numeric,
  impuestos numeric,
  tipo_impuesto text,
  importe_total numeric,
  moneda text,
  categoria text,
  metodo_pago text,
  notas text,
  cufe text,
  url_archivo text,
  empresa_id text not null,
  estado text default 'Nuevo' check (estado in ('Nuevo', 'Revisado', 'Aprobado', 'Rechazado', 'Sincronizado')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Habilitar RLS en facturas
alter table public.facturas enable row level security;

-- Políticas para facturas:
drop policy if exists "Usuarios ven facturas de su empresa" on public.facturas;
create policy "Usuarios ven facturas de su empresa" on public.facturas
  for select using (
    empresa_id = (select empresa_id from public.profiles where id = auth.uid())
  );

drop policy if exists "Usuarios insertan facturas en su empresa" on public.facturas;
create policy "Usuarios insertan facturas en su empresa" on public.facturas
  for insert with check (
    empresa_id = (select empresa_id from public.profiles where id = auth.uid())
  );

drop policy if exists "Usuarios actualizan facturas de su empresa" on public.facturas;
create policy "Usuarios actualizan facturas de su empresa" on public.facturas
  for update using (
    empresa_id = (select empresa_id from public.profiles where id = auth.uid())
  );

-- 4. Trigger para crear perfil automáticamente al registrarse en Auth
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (
    id, email, role, empresa_id, nombre, 
    telefono, empresa_nombre, nit, direccion, ciudad, departamento
  )
  values (
    new.id, 
    new.email, 
    coalesce(new.raw_user_meta_data->>'role', 'auxiliar'), 
    coalesce(new.raw_user_meta_data->>'empresa_id', '1'),
    coalesce(new.raw_user_meta_data->>'nombre', new.email),
    new.raw_user_meta_data->>'telefono',
    new.raw_user_meta_data->>'empresa_nombre',
    new.raw_user_meta_data->>'nit',
    new.raw_user_meta_data->>'direccion',
    new.raw_user_meta_data->>'ciudad',
    new.raw_user_meta_data->>'departamento'
  )
  on conflict (id) do update set
    email = excluded.email,
    role = excluded.role,
    empresa_id = excluded.empresa_id,
    nombre = excluded.nombre,
    telefono = excluded.telefono,
    empresa_nombre = excluded.empresa_nombre,
    nit = excluded.nit,
    direccion = excluded.direccion,
    ciudad = excluded.ciudad,
    departamento = excluded.departamento;
  return new;
end;
$$ language plpgsql security definer;

-- Borrar trigger si existe para evitar duplicados
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 5. Crear tabla clientes
create table if not exists public.clientes (
  id uuid default gen_random_uuid() primary key,
  empresa_id text not null,
  nombre text not null,
  identificacion text,
  email text,
  telefono text,
  direccion text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Habilitar RLS en clientes
alter table public.clientes enable row level security;

-- Políticas para clientes:
drop policy if exists "Usuarios ven clientes de su empresa" on public.clientes;
create policy "Usuarios ven clientes de su empresa" on public.clientes
  for select using (
    empresa_id = (select empresa_id from public.profiles where id = auth.uid())
  );

drop policy if exists "Usuarios insertan clientes en su empresa" on public.clientes;
create policy "Usuarios insertan clientes en su empresa" on public.clientes
  for insert with check (
    empresa_id = (select empresa_id from public.profiles where id = auth.uid())
  );

drop policy if exists "Usuarios actualizan clientes de su empresa" on public.clientes;
create policy "Usuarios actualizan clientes de su empresa" on public.clientes
  for update using (
    empresa_id = (select empresa_id from public.profiles where id = auth.uid())
  );

drop policy if exists "Usuarios eliminan clientes de su empresa" on public.clientes;
create policy "Usuarios eliminan clientes de su empresa" on public.clientes
  for delete using (
    empresa_id = (select empresa_id from public.profiles where id = auth.uid())
  );
