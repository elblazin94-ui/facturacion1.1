// firestore-auth.js — Almacenamiento persistente de sesión Baileys en Firestore
import { getFirestore } from 'firebase-admin/firestore'
import { proto } from '@whiskeysockets/baileys'
import { BufferJSON } from '@whiskeysockets/baileys'

const db = getFirestore()
const COLLECTION = 'wa_session'

export async function useFirestoreAuthState(sessionId) {
  const readData = async (type, id) => {
    const doc = await db.collection(COLLECTION).doc(`${sessionId}_${type}_${id}`).get()
    if (!doc.exists) return null
    return JSON.parse(JSON.stringify(doc.data()), BufferJSON.reviver)
  }

  const writeData = async (data, type, id) => {
    const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer))
    await db.collection(COLLECTION).doc(`${sessionId}_${type}_${id}`).set(value)
  }

  const removeData = async (type, id) => {
    await db.collection(COLLECTION).doc(`${sessionId}_${type}_${id}`).delete()
  }

  const credsDoc = await db.collection(COLLECTION).doc(`${sessionId}_creds`).get()
  let creds = credsDoc.exists 
    ? JSON.parse(JSON.stringify(credsDoc.data()), BufferJSON.reviver)
    : (await import('@whiskeysockets/baileys')).initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(type, id)
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value)
              }
              data[id] = value
            })
          )
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const sCategory = category
              if (value) {
                tasks.push(writeData(value, sCategory, id))
              } else {
                tasks.push(removeData(sCategory, id))
              }
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: async () => {
      await db.collection(COLLECTION).doc(`${sessionId}_creds`).set(
        JSON.parse(JSON.stringify(creds, BufferJSON.replacer))
      )
    },
  }
}
