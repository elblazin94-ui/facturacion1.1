-- ============================================================================
-- SCRIPT DE RESET: Ejecutar en SQL Editor de Supabase
-- Este script limpia TODAS las facturas de prueba y corrige el constraint
-- de estados para que sea compatible con el frontend v1.
-- ============================================================================

-- 1. Eliminar TODAS las facturas de prueba
DELETE FROM public.facturas;

-- 2. Eliminar el constraint de estados v2 (incompatible con el frontend)
ALTER TABLE public.facturas DROP CONSTRAINT IF EXISTS facturas_estado_check;

-- 3. Crear constraint con estados v1 (compatible con frontend)
ALTER TABLE public.facturas ADD CONSTRAINT facturas_estado_check
  CHECK (estado IN ('Nuevo', 'Revisado', 'Aprobado', 'Rechazado', 'Sincronizado'));

-- 4. Verificar que la columna url_archivo existe
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS url_archivo text;

-- 5. Verificar que las columnas de scoring existen
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS score integer DEFAULT 0;
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS clasificacion text DEFAULT 'MEDIA';
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS duplicado boolean DEFAULT false;
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS tercero_id uuid;
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS nit_emisor text;
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS razon_social_emisor text;
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS iva numeric;
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS total numeric;

-- 6. Crear Storage bucket para fotos de facturas (si no existe)
-- NOTA: Esto se hace desde el panel de Supabase → Storage → New Bucket
-- Nombre: facturas_adjuntos
-- Público: SÍ (para que las URLs sean accesibles desde el dashboard)

-- ¡Listo! Ahora solo aparecerán las facturas que se procesen de aquí en adelante.
