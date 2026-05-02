// whatsapp.js — Módulo Baileys multi-empresa
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys'
import qrcodeLib from 'qrcode'
import pino from 'pino'
import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { extraerURLDeQR, extraerDatosFacturaDIAN, extraerDatosFactura } from './gemini.js'
import { agregarFactura, esFacturaDuplicada, obtenerNombreEmpresa } from './db.js'
import { supabase } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const AUTH_BASE_DIR = path.join(DATA_DIR, 'auth_info')
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads')

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })
if (!fs.existsSync(AUTH_BASE_DIR)) fs.mkdirSync(AUTH_BASE_DIR, { recursive: true })

// Almacenamiento multi-sesión (indexed by empresa_id)
const sesiones = {} 
// Estructura de cada sesión: { sock, qr, estado, refreshTimer }

let onNuevaFactura = null
let onEstadoCambio = null
let waVersion = null  // cached — fetched once, reused on reconnects

export function getSock(empresaId = '1') {
  return sesiones[empresaId]?.sock
}

export function getQrBase64(empresaId = '1') {
  return sesiones[empresaId]?.qr
}

export function getEstadoConexion(empresaId = '1') {
  return sesiones[empresaId]?.estado || 'desconectado'
}

export function setOnNuevaFactura(callback) {
  onNuevaFactura = callback
}

export function setOnEstadoCambio(callback) {
  onEstadoCambio = callback
}

export async function logoutWhatsApp(empresaId = '1') {
  console.log(`[WhatsApp] Logout solicitado para empresa: ${empresaId}`)
  const s = sesiones[empresaId]

  // Marcar como desconectado ANTES de cerrar el socket para que el handler
  // de connection.update no intente reconectar ni acceder a la sesión borrada
  if (sesiones[empresaId]) {
    sesiones[empresaId].estado = 'desconectado'
    sesiones[empresaId].qr = null
  }

  if (s && s.sock) {
    try {
      s.sock.ev.removeAllListeners()
      await s.sock.logout()
    } catch (_) {}
    try { s.sock.end() } catch (_) {}
  }

  if (sesiones[empresaId]) delete sesiones[empresaId]

  const authDir = path.join(AUTH_BASE_DIR, `emp_${empresaId}`)
  try {
    await fsPromises.rm(authDir, { recursive: true, force: true })
  } catch (_) {}

  setTimeout(() => connectToWhatsApp(empresaId).catch(console.error), 2000)
}

export async function connectToWhatsApp(empresaId = '1') {
  const estadoActual = getEstadoConexion(empresaId)
  if (estadoActual !== 'desconectado' && estadoActual !== 'reconectando') {
    return sesiones[empresaId]?.sock
  }

  if (!sesiones[empresaId]) {
    sesiones[empresaId] = { sock: null, qr: null, estado: 'desconectado', retries: 0 }
  }

  // Set synchronously before any await so polls never see a stale 'desconectado'
  sesiones[empresaId].estado = 'conectando'
  sesiones[empresaId].qr = null

  const authDir = path.join(AUTH_BASE_DIR, `emp_${empresaId}`)

  try {
    await fsPromises.mkdir(authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(authDir)

    if (!waVersion) {
      try {
        const { version } = await fetchLatestBaileysVersion()
        waVersion = version
        console.log(`[WhatsApp] Versión WA: ${version.join('.')}`)
      } catch (_) {
        waVersion = [2, 3000, 1023079571]
        console.log('[WhatsApp] No se pudo obtener versión, usando fallback')
      }
    }

    // Clean up old socket listeners before replacing
    const oldSock = sesiones[empresaId].sock
    if (oldSock) {
      try { oldSock.ev.removeAllListeners(); oldSock.end() } catch (_) {}
    }

    const sock = makeWASocket({
      version: waVersion,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
    })

    sesiones[empresaId].sock = sock

    sock.ev.on('connection.update', async (update) => {
      // La sesión puede haber sido eliminada por logoutWhatsApp mientras el evento estaba en vuelo
      if (!sesiones[empresaId]) return

      const { connection, lastDisconnect, qr } = update

      if (qr) {
        sesiones[empresaId].estado = 'esperando_qr'
        sesiones[empresaId].qr = await qrcodeLib.toDataURL(qr, {
          errorCorrectionLevel: 'H',
          margin: 2,
          color: { dark: '#111111', light: '#FBFBFA' },
          width: 300,
        })
        console.log(`[WhatsApp] QR listo para empresa ${empresaId}`)
        onEstadoCambio?.(empresaId, 'esperando_qr', sesiones[empresaId].qr)
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        sesiones[empresaId].qr = null
        console.log(`[WhatsApp] Conexión cerrada (${empresaId}) código: ${statusCode}`)

        if (shouldReconnect) {
          const retries = (sesiones[empresaId].retries || 0) + 1
          sesiones[empresaId].retries = retries

          if (retries >= 5) {
            // Likely corrupted creds — wipe auth and start fresh
            console.log(`[WhatsApp] ${retries} fallos seguidos en ${empresaId}, limpiando auth...`)
            sesiones[empresaId].retries = 0
            sesiones[empresaId].estado = 'reconectando'
            try { await fsPromises.rm(authDir, { recursive: true, force: true }) } catch (_) {}
          } else {
            sesiones[empresaId].estado = 'reconectando'
          }
          onEstadoCambio?.(empresaId, sesiones[empresaId].estado, null)
          setTimeout(() => connectToWhatsApp(empresaId), 3000)
        } else {
          sesiones[empresaId].estado = 'desconectado'
          sesiones[empresaId].retries = 0
          onEstadoCambio?.(empresaId, 'desconectado', null)
          try { await fsPromises.rm(authDir, { recursive: true, force: true }) } catch (_) {}
          setTimeout(() => connectToWhatsApp(empresaId), 2000)
        }
      }

      if (connection === 'open') {
        sesiones[empresaId].estado = 'conectado'
        sesiones[empresaId].qr = null
        sesiones[empresaId].retries = 0
        const nombreEmpresa = await obtenerNombreEmpresa(empresaId) || `Empresa ${empresaId}`
        console.log(`[WhatsApp] ✅ ${nombreEmpresa} conectada`)
        onEstadoCambio?.(empresaId, 'conectado', null)
      }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        if (msg.key.fromMe) continue
        await procesarMensajeWhatsApp(sock, msg, empresaId)
      }
    })

    return sock

  } catch (err) {
    console.error(`[WhatsApp] Error al iniciar (${empresaId}):`, err.message)
    if (sesiones[empresaId]) sesiones[empresaId].estado = 'desconectado'
    setTimeout(() => connectToWhatsApp(empresaId), 5000)
  }
}

const TIPOS_PERMITIDOS = new Set(['imageMessage', 'documentMessage', 'documentWithCaptionMessage'])
const MIME_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MIME_PDF = new Set(['application/pdf'])

async function procesarMensajeWhatsApp(sock, msg, empresaId) {
  const from = msg.key.remoteJid
  const tipoMensaje = Object.keys(msg.message || {})[0]

  if (!TIPOS_PERMITIDOS.has(tipoMensaje)) {
    const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    if (texto) {
      const nombreEmpresaMsg = await obtenerNombreEmpresa(empresaId) || `Empresa ${empresaId}`
      await sock.sendMessage(from, { text: `👋 Hola, soy *Expensify Hub*, tu asistente contable automático.\nEstoy listo para procesar facturas de *${nombreEmpresaMsg}*.\nEnvíame una *foto o PDF* y la dejaré lista para tu contador en segundos.` })
    }
    return
  }

  await sock.sendMessage(from, { text: `⏳ Procesando tu factura con IA... Un momento.` })

  try {
    let mimeType
    if (tipoMensaje === 'imageMessage') {
      mimeType = msg.message.imageMessage.mimetype || 'image/jpeg'
    } else {
      const docMsg = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage
      mimeType = docMsg?.mimetype || 'application/pdf'
    }

    const buffer = await downloadMediaMessage(msg, 'buffer', {})

    if (!MIME_IMAGEN.has(mimeType) && !MIME_PDF.has(mimeType)) {
      await sock.sendMessage(from, { text: `❌ Formato no compatible. Envía imagen o PDF.` })
      return
    }

    let datos;
    try {
      const qrUrl = await extraerURLDeQR(buffer, mimeType)
      datos = await extraerDatosFacturaDIAN(qrUrl)
    } catch (e) {
      datos = await extraerDatosFactura(buffer, mimeType)
    }

    const filename = `factura_${empresaId}_${Date.now()}.${mimeType === 'application/pdf' ? 'pdf' : 'jpg'}`
    let url_archivo = `/uploads/${filename}`
    await fsPromises.writeFile(path.join(UPLOADS_DIR, filename), buffer)

    // Subida opcional a Supabase Storage
    if (supabase) {
      try {
        const { error } = await supabase.storage.from('facturas_adjuntos').upload(filename, buffer, { contentType: mimeType })
        if (!error) {
          const { data: pubData } = supabase.storage.from('facturas_adjuntos').getPublicUrl(filename)
          url_archivo = pubData.publicUrl
        }
      } catch (err) {}
    }

    // Sanitización numérica
    const sanitizeNum = (v) => {
        if (v == null || v === '') return null
        if (typeof v === 'number') return v
        let limpio = String(v).replace(/[^0-9.,-]/g, '').trim()
        if (limpio.endsWith(',00') || limpio.endsWith('.00')) limpio = limpio.slice(0, -3)
        return parseFloat(limpio.replace(',', '.')) || null
    }

    const importeTotal = sanitizeNum(datos.importe_total)
    const subtotal = sanitizeNum(datos.subtotal)
    const impuestos = sanitizeNum(datos.impuestos)

    // Construir objeto de factura con mapeo explícito a columnas de la tabla
    const facturaData = {
      empresa_id: empresaId,
      proveedor: datos.proveedor || null,
      nif_proveedor: datos.nif_proveedor || null,
      nit_emisor: datos.nif_proveedor || null,
      razon_social_emisor: datos.proveedor || null,
      numero_factura: datos.numero_factura || null,
      fecha_factura: datos.fecha_factura || null,
      concepto: datos.concepto || null,
      subtotal: subtotal,
      impuestos: impuestos,
      iva: impuestos,
      tipo_impuesto: datos.tipo_impuesto || null,
      importe_total: (datos.moneda === 'COP' && importeTotal) ? Math.round(importeTotal) : importeTotal,
      total: (datos.moneda === 'COP' && importeTotal) ? Math.round(importeTotal) : importeTotal,
      moneda: datos.moneda || 'COP',
      categoria: datos.categoria || null,
      metodo_pago: datos.metodo_pago || null,
      notas: datos.notas || null,
      cufe: datos.cufe || null,
      url_archivo: url_archivo,
      estado: 'Nuevo',
      score: 0,
      clasificacion: 'MEDIA',
      duplicado: false,
    }

    if (await esFacturaDuplicada(facturaData)) {
      await sock.sendMessage(from, { text: `⚠️ Factura duplicada detectada.` })
      return
    }

    const factura = await agregarFactura(facturaData)
    if (factura && onNuevaFactura) onNuevaFactura(factura)

    await sock.sendMessage(from, { text: buildUserMessage(factura) })
  } catch (err) {
    console.error(`[WhatsApp] Error (${empresaId}):`, err.message)
    await sock.sendMessage(from, { text: `❌ Error: ${err.message}` })
  }
}

const ESTADO_MSG = {
  ALTA:  'Procesada correctamente, no se requiere nada adicional.',
  MEDIA: 'Procesada con observaciones menores. Podríamos requerir confirmación.',
  BAJA:  'Procesada con inconsistencias. Es posible que necesitemos información adicional.',
}

export function buildUserMessage(f) {
  const total = f.importe_total || f.total
  const importe = total ? `${Number(total).toLocaleString('es-CO')} ${f.moneda || 'COP'}` : '-'
  const proveedor = f.proveedor || f.razon_social_emisor || '-'
  const numero = f.numero_factura || '-'
  const fecha = f.fecha_factura || '-'
  const estadoMsg = ESTADO_MSG[f.clasificacion] || ESTADO_MSG.MEDIA

  return [
    `✅ *Factura recibida y procesada*`,
    ``,
    `📋 *Proveedor:* ${proveedor}`,
    `📄 *Factura:* ${numero}`,
    `💰 *Total:* ${importe}`,
    `📅 *Fecha:* ${fecha}`,
    ``,
    `🧾 *Estado:* ${estadoMsg}`,
    ``,
    `_Puedes consultarla en el panel. Si hace falta algo, te lo haremos saber._`,
  ].join('\n')
}
