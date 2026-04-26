// db.js — Almacén persistente: SQLite
import sqlite3 from 'sqlite3'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')

// Crear carpeta de datos si no existe (importante para el volumen de Railway)
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const dbPath = path.join(DATA_DIR, 'gastos.sqlite')
let db
try {
  db = new sqlite3.Database(dbPath)
  console.log(`[DB] Conectado a SQLite en: ${dbPath}`)
} catch (err) {
  console.error('[DB] ERROR al abrir base de datos en disco. Usando :memory: temporal.', err.message)
  db = new sqlite3.Database(':memory:')
}

// Inicializar tabla
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS facturas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proveedor TEXT,
      numero_factura TEXT,
      fecha_factura TEXT,
      concepto TEXT,
      categoria TEXT,
      importe_total REAL,
      impuestos REAL,
      subtotal REAL,
      moneda TEXT,
      metodo_pago TEXT,
      tipo_impuesto TEXT,
      remitente TEXT,
      archivo TEXT,
      fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
})

export async function obtenerFacturas() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM facturas ORDER BY fecha_registro DESC', [], (err, rows) => {
      if (err) return reject(err)
      resolve(rows)
    })
  })
}

export async function esFacturaDuplicada(f) {
  return new Promise((resolve, reject) => {
    // Definimos duplicado como mismo proveedor, fecha, categoría e importe
    const query = `
      SELECT id FROM facturas 
      WHERE proveedor = ? 
      AND fecha_factura = ? 
      AND categoria = ?
      AND ABS(importe_total - ?) < 0.01
      LIMIT 1
    `
    const params = [f.proveedor, f.fecha_factura, f.categoria, f.importe_total]
    
    db.get(query, params, (err, row) => {
      if (err) return reject(err)
      resolve(!!row)
    })
  })
}

export async function agregarFactura(f) {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO facturas (
        proveedor, numero_factura, fecha_factura, concepto, categoria,
        importe_total, impuestos, subtotal, moneda, metodo_pago,
        tipo_impuesto, remitente, archivo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    const params = [
      f.proveedor, f.numero_factura, f.fecha_factura, f.concepto, f.categoria,
      f.importe_total, f.impuestos, f.subtotal, f.moneda, f.metodo_pago,
      f.tipo_impuesto, f.remitente, f.archivo
    ]

    db.run(query, params, function(err) {
      if (err) return reject(err)
      resolve({ id: this.lastID, ...f, fecha_registro: new Date().toISOString() })
    })
  })
}
