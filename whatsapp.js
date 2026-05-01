// whatsapp.js — Módulo Baileys: conexión, QR como PNG, recepción de facturas
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcodeLib from 'qrcode'
import pino from 'pino'
import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { extraerURLDeQR, extraerDatosFacturaDIAN, extraerDatosFactura } from './gemini.js'
import { agregarFactura, esFacturaDuplicada } from './db.js'
import { supabase } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const AUTH_DIR = path.join(DATA_DIR, 'auth_info')
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads')

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// Estado compartido del módulo
let sockInstance = null
let qrImageBase64 = null      // QR como imagen PNG en base64
let estadoConexion = 'desconectado' // 'desconectado' | 'esperando_qr' | 'conectado'
let onNuevaFactura = null     // callback inyectado desde index.js
let qrRefreshTimer = null     // Timer para refrescar QR si expira

const TIPOS_PERMITIDOS = new Set([
  'imageMessage',
  'documentMessage',
  'documentWithCaptionMessage',
])

const MIME_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MIME_PDF = new Set(['application/pdf'])

export function getSock() {
  return sockInstance
}

export function getQrBase64() {
  return qrImageBase64
}

export function getEstadoConexion() {
  return estadoConexion
}

export function setOnNuevaFactura(callback) {
  onNuevaFactura = callback
}

export async function logoutWhatsApp() {
  console.log('[WhatsApp] Cerrando sesión solicitada por usuario...')
  if (sockInstance) {
    try {
      await sockInstance.logout()
      sockInstance.end()
    } catch (err) {
      console.log('Error al hacer logout:', err)
    }
  }
  
  sockInstance = null
  estadoConexion = 'desconectado'
  qrImageBase64 = null
  console.log('[WhatsApp] Sesión cerrada. Reiniciando en 2s...')
  setTimeout(() => connectToWhatsApp().catch(console.error), 2000)
}

export async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log(`[WhatsApp] Usando protocolo WA v${version.join('.')} (latest: ${isLatest})`)

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    // Usar Chrome genérico para evitar el error 'error al vincular'
    browser: ['Expensify Hub', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    printQRInTerminal: false,
  })

  sockInstance = sock

  // ─── Gestión de conexión y QR ───────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      estadoConexion = 'esperando_qr'
      // Convertir el string QR a imagen PNG en base64 para servir al panel
      qrImageBase64 = await qrcodeLib.toDataURL(qr, {
        errorCorrectionLevel: 'H',
        margin: 2,
        color: { dark: '#111111', light: '#FBFBFA' },
        width: 300,
      })
      console.log('[WhatsApp] QR generado — escanea desde el panel web')
      
      // Cancelar timer anterior si existía
      if (qrRefreshTimer) clearTimeout(qrRefreshTimer)
      // El QR de WhatsApp expira en ~20s. Si en 19s no se escaneó, reiniciamos la conexión
      qrRefreshTimer = setTimeout(async () => {
        if (estadoConexion === 'esperando_qr') {
          console.log('[WhatsApp] QR expirado — regenerando...')
          try { sock.end() } catch(e) {}
        }
      }, 19000)
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      estadoConexion = 'desconectado'
      qrImageBase64 = null
      console.log('[WhatsApp] Conexión cerrada. Código:', statusCode, '| Reconectar:', shouldReconnect)

      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 3000)
      } else {
        console.log('[WhatsApp] Sesión finalizada o logout. Limpiando y reiniciando...')
        // Limpiar carpeta de auth si fue un logout manual para asegurar nuevo QR
        try {
            await fsPromises.rm(AUTH_DIR, { recursive: true, force: true })
            console.log('[WhatsApp] Carpeta auth_info eliminada.')
        } catch (e) {
            console.error('[WhatsApp] No se pudo eliminar auth_info:', e.message)
        }
        setTimeout(() => connectToWhatsApp(), 2000)
      }
    }

    if (connection === 'open') {
      estadoConexion = 'conectado'
      qrImageBase64 = null // ya no necesitamos el QR
      console.log('[WhatsApp] ✅ Conectado correctamente')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ─── Recepción de mensajes ───────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue

      const from = msg.key.remoteJid
      const tipoMensaje = Object.keys(msg.message || {})[0]

      // Solo procesamos imágenes y documentos
      if (!TIPOS_PERMITIDOS.has(tipoMensaje)) {
        // Si mandan texto, orientamos al usuario
        const texto =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text || ''
        if (texto) {
          await sock.sendMessage(from, {
            text: `👋 Hola! Soy tu asistente de gestión de gastos.\n\nEnvíame una *foto o PDF de tu factura* y extraeré todos los datos contables automáticamente.`,
          })
        }
        continue
      }

      // Notificar que estamos procesando
      await sock.sendMessage(from, {
        text: `⏳ Procesando tu factura con IA... Un momento.`,
      })

      try {
        // Descargar el adjunto
        let mimeType
        if (tipoMensaje === 'imageMessage') {
          mimeType = msg.message.imageMessage.mimetype || 'image/jpeg'
        } else {
          // documentMessage o documentWithCaptionMessage
          const docMsg =
            msg.message.documentMessage ||
            msg.message.documentWithCaptionMessage?.message?.documentMessage
          mimeType = docMsg?.mimetype || 'application/pdf'
        }

        const buffer = await downloadMediaMessage(msg, 'buffer', {})

        // Validar tipo de archivo
        if (!MIME_IMAGEN.has(mimeType) && !MIME_PDF.has(mimeType)) {
          await sock.sendMessage(from, {
            text: `❌ Formato no compatible. Envía la factura como *imagen (JPG/PNG)* o *PDF*.`,
          })
          continue
        }

        let datos;
        let qrUrl = null;
        try {
          qrUrl = await extraerURLDeQR(buffer, mimeType);
          console.log('[WhatsApp] URL de QR extraída:', qrUrl);
          // Consultar a la DIAN con esa URL
          datos = await extraerDatosFacturaDIAN(qrUrl);
        } catch (qrErr) {
          console.warn('[WhatsApp] Fallo extracción QR/DIAN, intentando OCR directo:', qrErr.message);
          // Fallback a extraer directamente de la imagen
          datos = await extraerDatosFactura(buffer, mimeType);
        }

        // Subir a Supabase Storage en lugar de local (o además de local)
        const ext = mimeType === 'application/pdf' ? 'pdf' : (mimeType.split('/')[1] || 'jpg')
        const filename = `factura_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`
        
        let url_archivo = '';
        if (supabase) {
          const { data, error } = await supabase.storage.from('facturas_adjuntos').upload(filename, buffer, { contentType: mimeType })
          if (error) {
            console.error('[WhatsApp] Error subiendo a Supabase Storage:', error.message)
            url_archivo = `/uploads/${filename}` // Fallback local
            const filepath = path.join(UPLOADS_DIR, filename)
            await fsPromises.writeFile(filepath, buffer)
          } else {
            const { data: pubData } = supabase.storage.from('facturas_adjuntos').getPublicUrl(filename)
            url_archivo = pubData.publicUrl
          }
        } else {
           const filepath = path.join(UPLOADS_DIR, filename)
           await fsPromises.writeFile(filepath, buffer)
           url_archivo = `/uploads/${filename}`
        }

        datos.url_archivo = url_archivo;

        // Asegurar que los números sean puros para evitar recortes
        const sanitizeNum = (v) => {
          if (v == null || v === '') return null
          if (typeof v === 'number') return v
          let limpio = String(v).replace(/[^0-9.,-]/g, '').trim()
          
          if (limpio.endsWith(',00')) limpio = limpio.slice(0, -3)
          if (limpio.endsWith('.00')) limpio = limpio.slice(0, -3)

          const hasDot = limpio.includes('.')
          const hasComma = limpio.includes(',')

          if (hasDot && !hasComma) {
            const parts = limpio.split('.')
            if (parts.length > 2 || parts[parts.length-1].length === 3) {
              limpio = limpio.replace(/\./g, '') // miles
            }
          } else if (hasComma && !hasDot) {
            const parts = limpio.split(',')
            if (parts.length > 2 || parts[parts.length-1].length === 3) {
              limpio = limpio.replace(/,/g, '') // miles
            } else {
              limpio = limpio.replace(',', '.') // decimal
            }
          } else if (hasDot && hasComma) {
            const esFormatoEU = limpio.lastIndexOf(',') > limpio.lastIndexOf('.')
            if (esFormatoEU) {
              limpio = limpio.replace(/\./g, '').replace(',', '.')
            } else {
              limpio = limpio.replace(/,/g, '')
            }
          }

          return parseFloat(limpio)
        }

        datos.importe_total = sanitizeNum(datos.importe_total)
        datos.impuestos = sanitizeNum(datos.impuestos)
        datos.subtotal = sanitizeNum(datos.subtotal)

        // Si es COP, redondeamos para evitar decimales por errores de lectura de miles
        if (datos.moneda === 'COP') {
          if (datos.importe_total) datos.importe_total = Math.round(datos.importe_total)
          if (datos.impuestos) datos.impuestos = Math.round(datos.impuestos)
          if (datos.subtotal) datos.subtotal = Math.round(datos.subtotal)
        }

        // Comprobar duplicados antes de guardar
        const esDuplicada = await esFacturaDuplicada(datos)
        if (esDuplicada) {
          console.log(`[WhatsApp] Factura duplicada detectada de ${datos.proveedor}. Ignorando.`)
          await sock.sendMessage(from, { 
            text: `⚠️ *Factura Duplicada:* Esta factura de *${datos.proveedor}* por *${Number(datos.importe_total).toLocaleString('es-CO')}* ya ha sido procesada anteriormente. No se ha duplicado en el sistema.` 
          })
          continue
        }

        // Guardar en DB (asignamos empresa_id por defecto si es multi-empresa)
        const facturaPayload = { ...datos, empresa_id: 'da-servicios-sas' }
        const factura = await agregarFactura(facturaPayload)

        if (!factura) {
          throw new Error('Error al guardar la factura en la base de datos (posible fallo de Supabase).')
        }

        // Confirmar al usuario con resumen estructurado
        const resumen = formatearResumen(factura)
        await sock.sendMessage(from, { text: resumen })

        // Notificar al panel web en tiempo real
        if (onNuevaFactura) {
          onNuevaFactura(factura)
        }
      } catch (err) {
        console.error('[WhatsApp] Error procesando factura:', err.message)
        await sock.sendMessage(from, {
          text: `❌ No pude procesar la factura: ${err.message}\n\nAsegúrate de que la imagen sea legible y sea una factura válida.`,
        })
      }
    }
  })

  return sock
}

function formatearResumen(f) {
  const formatearMonto = (v) => v != null && !isNaN(v) ? `${Number(v).toLocaleString('es-CO')} ${f.moneda || ''}` : 'No detectado'
  
  const importe = formatearMonto(f.importe_total)
  const impuestos = formatearMonto(f.impuestos)
  const fecha = f.fecha_factura || 'No detectada'

  return `✅ *Factura procesada correctamente*

📋 *Proveedor:* ${f.proveedor || 'No detectado'}
🔢 *Nº Factura:* ${f.numero_factura || 'N/A'}
📅 *Fecha:* ${fecha}
📝 *Concepto:* ${f.concepto || 'No detectado'}
🏷️ *Categoría:* ${f.categoria || 'Otro'}
💰 *Importe total:* ${importe}
🧾 *Impuestos:* ${impuestos} (${f.tipo_impuesto || ''})
💳 *Método de pago:* ${f.metodo_pago || 'No detectado'}

_Los datos ya están disponibles en tu panel web._`.trim()
}
