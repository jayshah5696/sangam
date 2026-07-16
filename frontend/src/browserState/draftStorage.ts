export type DraftRecord = {
  documentId: string
  content: string
  baseRevisionId?: string
  updatedAt: number
}

export interface DraftStorage {
  get(documentId: string): Promise<DraftRecord | undefined>
  set(draft: DraftRecord): Promise<void>
  delete(documentId: string): Promise<void>
}

const databaseName = 'sangam-browser-state'
const storeName = 'document-drafts'

export class IndexedDbDraftStorage implements DraftStorage {
  async get(documentId: string) {
    return this.request<DraftRecord | undefined>('readonly', (store) => store.get(documentId))
  }

  async set(draft: DraftRecord) {
    await this.request('readwrite', (store) => store.put(draft))
  }

  async delete(documentId: string) {
    await this.request('readwrite', (store) => store.delete(documentId))
  }

  private async request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
    const database = await openDraftDatabase()
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode)
      const request = operation(transaction.objectStore(storeName))
      request.onerror = () => reject(request.error ?? new Error('Browser draft storage failed.'))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error ?? new Error('Browser draft transaction failed.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser draft transaction aborted.'))
    })
  }
}

let databasePromise: Promise<IDBDatabase> | undefined

function openDraftDatabase() {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: 'documentId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Browser draft storage could not be opened.'))
  })
  return databasePromise
}
