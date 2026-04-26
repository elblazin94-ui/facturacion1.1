// gemini.js — Extracción de datos contables de facturas con Gemini Vision
import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// Modelos a intentar en orden de preferencia (si uno falla por cuota, intenta el siguiente)
const MODELOS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest']

const PROMPT_EXTRACCION = `
Eres un asistente contable especializado en análisis de facturas y tickets.
Analiza la imagen o documento adjunto y extrae TODOS los datos contables disponibles.

Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta (sin markdown, sin explicaciones):
{
  "proveedor": "nombre del emisor de la factura",
  "nif_proveedor": "NIF/CIF/RUT del proveedor o null",
  "numero_factura": "número de factura o null",
  "fecha_factura": "fecha en formato YYYY-MM-DD o null",
  "concepto": "descripción breve del concepto o servicio",
  "subtotal": número o null,
  "impuestos": número o null,
  "tipo_impuesto": "IVA / IVA 19% / etc o null",
  "importe_total": número (obligatorio, extrae el total final. IMPORTANTE: NO uses separadores de miles. Usa el punto solo para decimales. En COP suelen ser enteros grandes),
  "moneda": "EUR o COP o USD u otra según la factura",
  "categoria": "clasifica en: Alimentación / Transporte / Suministros / Servicios profesionales / Software / Material oficina / Restauración / Otro",
  "metodo_pago": "Efectivo / Tarjeta / Transferencia / null",
  "notas": "cualquier dato relevante adicional o null"
}

Si no puedes leer algún campo, usa null. El campo importe_total es OBLIGATORIO; si no está claro, estima a partir de los datos disponibles.
Si la imagen no es una factura o ticket, devuelve: {"error": "No es una factura válida"}
`.trim()

/**
 * Analiza una factura (imagen o PDF) y devuelve los datos estructurados.
 * Intenta varios modelos y reintentos si hay rate limiting.
 */
export async function extraerDatosFactura(buffer, mimeType) {
  const imagePart = {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType,
    },
  }

  let lastError = null

  for (const modelo of MODELOS) {
    for (let intento = 0; intento < 3; intento++) {
      try {
        console.log(`[Gemini] Intentando con ${modelo} (intento ${intento + 1})...`)
        const model = genAI.getGenerativeModel({ model: modelo })
        const result = await model.generateContent([PROMPT_EXTRACCION, imagePart])
        const texto = result.response.text().trim()

        // Limpiar posibles bloques markdown
        const jsonLimpio = texto
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim()

        let datos
        try {
          datos = JSON.parse(jsonLimpio)
        } catch (parseErr) {
          console.error(`[Gemini] Error al parsear JSON de ${modelo}:`, texto)
          throw new Error('La respuesta de la IA no es un JSON válido')
        }

        if (datos.error) {
          throw new Error(datos.error)
        }

        console.log(`[Gemini] Factura procesada OK con ${modelo}`)
        return datos
      } catch (err) {
        lastError = err
        const esRetriable = err.message?.includes('429') || err.message?.includes('quota') || err.message?.includes('503') || err.message?.includes('500')

        if (esRetriable && intento < 2) {
          // Esperar antes de reintentar (backoff exponencial)
          const espera = (intento + 1) * 5000 // Reduje a 5s para no hacer esperar tanto
          console.log(`[Gemini] Error temporal en ${modelo}, esperando ${espera / 1000}s...`)
          await new Promise(r => setTimeout(r, espera))
          continue
        }

        if (esRetriable) {
          console.log(`[Gemini] ${modelo} falló por carga/cuota, probando siguiente modelo...`)
          break // pasar al siguiente modelo
        }

        // Error no relacionado con cuota/servidor, lanzar directamente
        throw err
      }
    }
  }

  throw lastError || new Error('No se pudo procesar la factura con ningún modelo')
}
