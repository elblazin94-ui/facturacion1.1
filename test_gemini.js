import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI('AIzaSyAUx55V_iu1hrOU7-taLVqZZBrQ7ruiq2g'); 
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }); 

const PROMPT = `Eres un asistente contable especializado en análisis de facturas y tickets.
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
}`;

model.generateContent([PROMPT, {inlineData: {data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png'}}])
  .then(r => console.log('SUCCESS:', r.response.text()))
  .catch(e => console.error('ERROR:', e.message));
