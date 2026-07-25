const DB_NAME = "roomframe-tv-simulator";
const DB_VERSION = 1;
const REVISION_STORE = "revisions";
const META_STORE = "meta";

const requestValue = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error ?? new Error("Transaction IndexedDB annulée."));
});

export const openCache = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(REVISION_STORE)) database.createObjectStore(REVISION_STORE, { keyPath: "id" });
    if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: "key" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export const getActiveRevision = async (database) => {
  const transaction = database.transaction([META_STORE, REVISION_STORE], "readonly");
  const metaStore = transaction.objectStore(META_STORE);
  const revisionStore = transaction.objectStore(REVISION_STORE);
  const pointer = await requestValue(metaStore.get("activeRevision"));
  const revision = pointer?.value ? await requestValue(revisionStore.get(pointer.value)) : null;
  await transactionDone(transaction);
  return revision ?? null;
};

export const putStagingRevision = async (database, revision) => {
  const transaction = database.transaction(REVISION_STORE, "readwrite");
  transaction.objectStore(REVISION_STORE).put({ ...revision, status: "staging" });
  await transactionDone(transaction);
};

export const activateStagingRevision = async (database, revisionId) => {
  const transaction = database.transaction([META_STORE, REVISION_STORE], "readwrite");
  const metaStore = transaction.objectStore(META_STORE);
  const revisionStore = transaction.objectStore(REVISION_STORE);
  const activePointer = await requestValue(metaStore.get("activeRevision"));
  const staging = await requestValue(revisionStore.get(revisionId));
  if (!staging || staging.status !== "staging") {
    transaction.abort();
    throw new Error("Révision de staging absente.");
  }
  if (activePointer?.value && activePointer.value !== revisionId) {
    const previous = await requestValue(revisionStore.get(activePointer.value));
    if (previous) revisionStore.put({ ...previous, status: "previous" });
    metaStore.put({ key: "previousRevision", value: activePointer.value });
  }
  revisionStore.put({ ...staging, status: "active", activatedAt: new Date().toISOString() });
  metaStore.put({ key: "activeRevision", value: revisionId });
  await transactionDone(transaction);
};

export const seedBundledRevision = async (database, revision) => {
  const current = await getActiveRevision(database);
  if (current) return current;
  await putStagingRevision(database, revision);
  await activateStagingRevision(database, revision.id);
  return getActiveRevision(database);
};
