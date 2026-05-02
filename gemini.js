// gemini.js — Extracción de datos contables de facturas con Gemini Vision y parsing de DIAN
import { GoogleGenAI } from '@google/genai'
import * as cheerio from 'cheerio'

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

const MODELOS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash'
]

const PROMPT_QR_URL = `
Analiza la imagen adjunta, que contiene una factura electrónica con un código QR.
Extrae y devuelve ÚNICAMENTE la URL incrustada en el código QR. No incluyas explicaciones, ni etiquetas de markdown, solamente el texto de la URL directa que comienza con http o https.
Si no puedes encontrar o decodificar un QR con URL, devuelve "ERROR: NO_QR_FOUND".
`.trim()

const PROMPT_DIAN = `
Eres un asistente contable especializado en procesar comprobantes de la DIAN en Colombia.
A continuación te proporcionaré el texto extraído del portal oficial de la DIAN para una factura electrónica.
Analiza el texto y extrae TODOS los datos contables disponibles.

Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta (sin markdown, sin explicaciones):
{
  "proveedor": "nombre o razón social del emisor",
  "nif_proveedor": "NIT del emisor o null",
  "numero_factura": "número de factura o prefijo y número o null",
  "fecha_factura": "fecha en formato YYYY-MM-DD o null",
  "concepto": "descripción breve del concepto, bienes o servicios o 'Factura Electrónica'",
  "subtotal": número o null,
  "impuestos": número o null,
  "tipo_impuesto": "IVA / IVA 19% / etc o null",
  "importe_total": número (obligatorio, total a pagar),
  "moneda": "COP o USD u otra",
  "categoria": "clasifica en: Alimentación / Transporte / Suministros / Servicios profesionales / Software / Material oficina / Restauración / Otro",
  "metodo_pago": "Efectivo / Tarjeta / Transferencia / null",
  "cufe": "Código Único de Factura Electrónica completo (cadena larga alfanumérica) o null",
  "notas": "cualquier dato relevante adicional o null"
}

Si no puedes leer algún campo, usa null. El campo importe_total es OBLIGATORIO.
`.trim()

async function llamarGemini(prompt, parts) {
  let lastError = null
  for (const modelo of MODELOS) {
    for (let intento = 0; intento < 2; intento++) {
      try {
        console.log(`[Gemini] Intentando con ${modelo} (intento ${intento + 1})...`)
        const contents = [{
          role: 'user',
          parts: [{ text: prompt }, ...parts],
        }]
        
        // El SDK @google/genai usa este formato para generar contenido
        const response = await genAI.models.generateContent({ 
          model: modelo, 
          contents 
        })

        // Extraer texto de forma segura según el SDK
        let texto = ''
        if (response.text) {
          texto = response.text()
        } else if (response.candidates && response.candidates[0]) {
          texto = response.candidates[0].content.parts[0].text
        } else {
          throw new Error('Formato de respuesta inesperado de Gemini')
        }

        console.log(`[Gemini] ✅ Procesado OK con ${modelo}`)
        return texto.trim()

      } catch (err) {
        lastError = err
        const msg = err.message || String(err)
        console.error(`[Gemini] Error con ${modelo}: ${msg.substring(0, 150)}`)

        // 404 o 400 (modelo no soportado/encontrado) -> siguiente modelo
        if (msg.includes('404') || msg.includes('not found') || msg.includes('not supported') || msg.includes('400')) {
          break 
        }

        // 429 (Cuota) -> esperar y reintentar una vez, luego siguiente modelo
        if (msg.includes('429') || msg.includes('quota')) {
          if (intento === 0) {
            console.warn(`[Gemini] Cuota agotada en ${modelo}, esperando 5s...`)
            await new Promise(r => setTimeout(r, 5000))
            continue
          }
          break // Siguiente modelo
        }

        // Otros errores -> siguiente modelo
        break
      }
    }
  }
  throw lastError || new Error('No se pudo procesar con ningún modelo de Gemini')
}

export async function extraerURLDeQR(buffer, mimeType) {
  const imagePart = {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType,
    },
  }
  const respuesta = await llamarGemini(PROMPT_QR_URL, [imagePart])
  const url = respuesta.trim()
  console.log('[Gemini] Respuesta raw de extraerURLDeQR:', url)
  if (url.includes('ERROR: NO_QR_FOUND') || !url.startsWith('http')) {
    throw new Error('No se pudo extraer una URL válida del QR en la imagen.')
  }
  return url
}

export async function extraerDatosFacturaDIAN(urlDian) {
  try {
    console.log(`[DIAN] Descargando contenido de URL DIAN: ${urlDian}`)

    const response = await fetch(urlDian, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml'
      }
    })

    if (!response.ok) {
      throw new Error(`Error HTTP al consultar la DIAN: ${response.status}`)
    }

    const html = await response.text()

    const $ = cheerio.load(html)
    $('script, style, noscript, svg, img').remove()
    const textoLimpio = $('body').text().replace(/\s+/g, ' ').trim()

    console.log(`[DIAN] HTML descargado y limpiado, procesando con Gemini... (${textoLimpio.substring(0, 100)}...)`)

    const textoRespuesta = await llamarGemini(PROMPT_DIAN, [{ text: `\n\nTexto de la DIAN:\n${textoLimpio}` }])

    const jsonLimpio = textoRespuesta
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim()

    const datos = JSON.parse(jsonLimpio)

    if (!datos.cufe && urlDian.includes('documentkey=')) {
        const queryParams = new URL(urlDian).searchParams
        datos.cufe = queryParams.get('documentkey')
    }

    return datos

  } catch (err) {
    console.error('[DIAN/Gemini] Error al extraer datos:', err.message)
    throw new Error(`No se pudo extraer la información de la DIAN: ${err.message}`)
  }
}

// Fallback: Si no hay QR o la DIAN falla, intentar leer los datos contables directamente de la imagen
const PROMPT_EXTRACCION_DIRECTA = `
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
  "importe_total": número (obligatorio),
  "moneda": "COP o USD u otra",
  "categoria": "clasifica en: Alimentación / Transporte / Suministros / Servicios profesionales / Software / Material oficina / Restauración / Otro",
  "metodo_pago": "Efectivo / Tarjeta / Transferencia / null",
  "notas": "cualquier dato relevante adicional o null"
}
`.trim()

export async function extraerDatosFactura(buffer, mimeType) {
  const imagePart = {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType,
    },
  }

  const respuesta = await llamarGemini(PROMPT_EXTRACCION_DIRECTA, [imagePart])

  try {
    console.log('[Gemini] Respuesta raw de extracción directa:', respuesta)
    const jsonLimpio = respuesta
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()

    return JSON.parse(jsonLimpio)
  } catch (err) {
    console.error('[Gemini] Error parseando JSON de extracción directa:', err.message)
    throw new Error('La IA no devolvió un formato de datos válido.')
  }
}
