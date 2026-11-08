import {
  doc,
  collection,
  addDoc,
  getDocs,
  runTransaction,
  writeBatch,
  query,
  orderBy,
} from 'firebase/firestore';
import { db, getOrCreateSessionToken, handleFirestoreError, OperationType } from './firebase.ts';
import { ChatMessage, FileAttachment, Participant, RoomData, ViewState } from './types.ts';

// 24 hours max expiry, or 2 hours of inactivity
export const ROOM_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const INACTIVITY_EXPIRY_MS = 2 * 60 * 60 * 1000;

// Heartbeat interval and presence timeout
export const HEARTBEAT_INTERVAL_MS = 5000; // ping presence every 5 seconds
export const PRESENCE_TIMEOUT_MS = 15000;  // 15 seconds without heartbeat = closed tab / gone

// Maximum allowed file size for ephemeral room transfer: 15 MB
export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
// Threshold for inlining file in message doc (350KB base64 string length)
const INLINE_CHUNK_LIMIT = 450000;
// Chunk size for Firestore subdocuments (350,000 characters base64 ~ 260KB)
const CHUNK_CHAR_SIZE = 350000;

export function sanitizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

// Curated list of South Indian female names for anonymous participants
export const SOUTH_INDIAN_FEMALE_NAMES = [
  'Ananya',
  'Keerthy',
  'Samantha',
  'Divya',
  'Meenakshi',
  'Priya',
  'Lakshmi',
  'Deepa',
  'Bhavana',
  'Sneha',
  'Harini',
  'Nithya',
  'Shreya',
  'Ramya',
  'Shruti',
  'Revathi',
  'Pavithra',
  'Kavya',
  'Soundarya',
  'Malavika',
  'Swathi',
  'Anupama',
  'Trisha',
  'Nayanthara',
  'Rashmika',
  'Pooja',
  'Sai Pallavi',
  'Aishwarya',
  'Sowmya',
  'Kalyani',
  'Gayathri',
  'Abhirami',
  'Vasundhara',
  'Mridula',
  'Mythili',
  'Varsha',
  'Nandhini',
  'Yamuna',
  'Preethi',
  'Sandhya',
  'Vidya',
  'Padma',
  'Manju',
  'Saranya',
  'Subhashini',
  'Tejaswini',
  'Hema',
  'Charulatha',
  'Rohini',
  'Vennela',
  'Lavanya',
  'Deepika',
  'Chandana',
  'Madhavi',
  'Anusha',
  'Bhargavi',
  'Sravani',
  'Aparna',
  'Radhika',
  'Sahithi',
];

/**
 * Determine the next South Indian female name for a participant
 */
export function getNextRole(existingRoles: string[]): string {
  // 1. Try curated names first
  for (const name of SOUTH_INDIAN_FEMALE_NAMES) {
    if (!existingRoles.includes(name)) {
      return name;
    }
  }

  // 2. If all curated names are already in use in this room, append index
  for (let i = 2; i <= 1000; i++) {
    for (const name of SOUTH_INDIAN_FEMALE_NAMES) {
      const candidate = `${name} ${i}`;
      if (!existingRoles.includes(candidate)) {
        return candidate;
      }
    }
  }

  return `User ${existingRoles.length + 1}`;
}

/**
 * In-memory cache for loaded large attachment data URLs
 */
const attachmentCache = new Map<string, string>();

/**
 * Fetch and reassemble a chunked attachment from Firestore
 */
export async function fetchMessageAttachment(
  roomId: string,
  messageId: string,
  chunkCount: number
): Promise<string> {
  const cacheKey = `${roomId}_${messageId}`;
  if (attachmentCache.has(cacheKey)) {
    return attachmentCache.get(cacheKey)!;
  }

  try {
    const chunksRef = collection(db, 'rooms', roomId, 'messages', messageId, 'chunks');
    const q = query(chunksRef, orderBy('chunkIndex', 'asc'));
    const snap = await getDocs(q);

    if (snap.empty) {
      throw new Error('Attachment chunks not found or deleted.');
    }

    const chunkPieces: string[] = [];
    snap.docs.forEach((d) => {
      const data = d.data();
      chunkPieces.push(data.data || '');
    });

    const fullDataUrl = chunkPieces.join('');
    attachmentCache.set(cacheKey, fullDataUrl);
    return fullDataUrl;
  } catch (error) {
    console.error('Error reassembling file attachment:', error);
    throw error;
  }
}

/**
 * Compress an image file to reduce transfer latency while maintaining clarity
 */
export async function processImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }

    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;

    img.onload = () => {
      const maxDimension = 1600;
      let width = img.width;
      let height = img.height;

      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(img.src);
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      const compressedData = canvas.toDataURL('image/jpeg', 0.82);
      resolve(compressedData);
    };

    img.onerror = () => {
      const fallbackReader = new FileReader();
      fallbackReader.onload = () => resolve(fallbackReader.result as string);
      fallbackReader.onerror = reject;
      fallbackReader.readAsDataURL(file);
    };

    reader.readAsDataURL(file);
  });
}

/**
 * Convert any file to a Base64 Data URL
 */
export async function fileToDataUrl(file: File): Promise<string> {
  if (file.type.startsWith('image/')) {
    try {
      return await processImageFile(file);
    } catch {
      // fallback
    }
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Clean up messages, chunks, and signals inside a room
 */
export async function deleteRoomMessages(roomId: string): Promise<void> {
  try {
    const messagesRef = collection(db, 'rooms', roomId, 'messages');
    const snapshot = await getDocs(messagesRef);
    if (!snapshot.empty) {
      for (const mDoc of snapshot.docs) {
        const chunksRef = collection(db, 'rooms', roomId, 'messages', mDoc.id, 'chunks');
        const chunkSnap = await getDocs(chunksRef);
        if (!chunkSnap.empty) {
          const chunkBatch = writeBatch(db);
          chunkSnap.docs.forEach((c) => chunkBatch.delete(c.ref));
          await chunkBatch.commit();
        }
      }
      const batch = writeBatch(db);
      snapshot.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    // Also delete any WebRTC signals
    const signalsRef = collection(db, 'rooms', roomId, 'signals');
    const signalSnap = await getDocs(signalsRef);
    if (!signalSnap.empty) {
      const sBatch = writeBatch(db);
      signalSnap.docs.forEach((s) => sBatch.delete(s.ref));
      await sBatch.commit();
    }
  } catch (err) {
    console.warn('Failed to clean up room messages and signals:', err);
  }
}

/**
 * Touch presence timestamp for active participant
 */
export async function touchParticipantPresence(roomId: string, token: string): Promise<void> {
  const roomRef = doc(db, 'rooms', roomId);
  try {
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(roomRef);
      if (!snap.exists()) return;
      const data = snap.data() as RoomData;
      if (data.status === 'closed') return;

      const participants = data.participants || {};
      if (participants[token]) {
        participants[token].lastSeenAt = Date.now();
        transaction.update(roomRef, {
          participants,
          lastActiveAt: Date.now(),
        });
      }
    });
  } catch (err) {
    // transient
  }
}

/**
 * Prune inactive participants who closed their tabs or disconnected.
 * If everyone has left or closed their tab, immediately closes the room!
 */
export async function sweepInactiveParticipants(roomId: string): Promise<boolean> {
  const roomRef = doc(db, 'rooms', roomId);
  let roomClosed = false;

  try {
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(roomRef);
      if (!snap.exists()) return;
      const data = snap.data() as RoomData;
      if (data.status === 'closed') {
        roomClosed = true;
        return;
      }

      const now = Date.now();
      const participants: Record<string, Participant> = data.participants || {};
      let changed = false;

      // Check each participant for inactivity timeout
      for (const [token, p] of Object.entries(participants)) {
        const lastSeen = p.lastSeenAt || p.joinedAt;
        if (now - lastSeen > PRESENCE_TIMEOUT_MS) {
          delete participants[token];
          changed = true;
        }
      }

      const remainingCount = Object.keys(participants).length;

      // If everyone left or closed tab, immediately close room!
      if (remainingCount === 0) {
        transaction.update(roomRef, {
          participants: {},
          participantCount: 0,
          status: 'closed',
          lastActiveAt: now,
          screenShare: null,
        });
        roomClosed = true;
      } else if (changed) {
        transaction.update(roomRef, {
          participants,
          participantCount: remainingCount,
          lastActiveAt: now,
        });
      }
    });

    if (roomClosed) {
      deleteRoomMessages(roomId).catch(() => {});
    }
  } catch (err) {
    console.warn('Sweep inactive participants failed:', err);
  }

  return roomClosed;
}

/**
 * Join or create a room without participant limit
 */
export async function joinRoom(rawCode: string): Promise<{
  roomId: string;
  role: string;
  status: ViewState;
  token: string;
}> {
  const roomId = sanitizeRoomCode(rawCode);
  if (!roomId || roomId.length > 64) {
    throw new Error('Please enter a valid room code (up to 64 characters).');
  }

  const token = getOrCreateSessionToken();
  const roomRef = doc(db, 'rooms', roomId);

  try {
    const result = await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(roomRef);
      const now = Date.now();

      if (snap.exists()) {
        const data = snap.data() as RoomData;
        const isExpired =
          (data.expiresAt && now > data.expiresAt) ||
          (data.lastActiveAt && now - data.lastActiveAt > INACTIVITY_EXPIRY_MS);
        const isClosed = data.status === 'closed';

        // Normalize participants map
        const participants: Record<string, Participant> = data.participants || {};
        if (data.participantA && !participants[data.participantA.token]) {
          participants[data.participantA.token] = data.participantA;
        }
        if (data.participantB && !participants[data.participantB.token]) {
          participants[data.participantB.token] = data.participantB;
        }

        // Filter out stale participants who closed tab or timed out
        for (const [pToken, p] of Object.entries(participants)) {
          const lastSeen = p.lastSeenAt || p.joinedAt;
          if (now - lastSeen > PRESENCE_TIMEOUT_MS) {
            delete participants[pToken];
          }
        }

        const activeCount = Object.keys(participants).length;

        // If the room was closed, expired, or all previous users left/closed tab:
        // Reset fresh immediately with a crazy alias!
        if (isExpired || isClosed || activeCount === 0) {
          const initialRole = getNextRole([]);
          const freshRoom: RoomData = {
            roomId,
            status: 'waiting',
            createdAt: now,
            lastActiveAt: now,
            expiresAt: now + ROOM_EXPIRY_MS,
            participants: {
              [token]: {
                token,
                role: initialRole,
                joinedAt: now,
                lastSeenAt: now,
              },
            },
            participantCount: 1,
            screenShare: null,
          };
          transaction.set(roomRef, freshRoom);
          deleteRoomMessages(roomId).catch(() => {});
          return {
            roomId,
            role: initialRole,
            status: 'waiting' as ViewState,
            token,
          };
        }

        // Case: Existing participant reconnecting
        if (participants[token]) {
          participants[token].lastSeenAt = now;
          transaction.update(roomRef, {
            participants,
            lastActiveAt: now,
          });
          const currentRole = participants[token].role;
          return {
            roomId,
            role: currentRole,
            status: (activeCount >= 2 ? 'chat' : 'waiting') as ViewState,
            token,
          };
        }

        // Case: New participant joining (unlimited capacity!)
        const existingRoles = Object.values(participants).map((p) => p.role);
        const newRole = getNextRole(existingRoles);

        participants[token] = {
          token,
          role: newRole,
          joinedAt: now,
          lastSeenAt: now,
        };

        const updatedCount = Object.keys(participants).length;
        const nextStatus = updatedCount >= 2 ? 'active' : 'waiting';

        transaction.update(roomRef, {
          participants,
          participantCount: updatedCount,
          status: nextStatus,
          lastActiveAt: now,
        });

        return {
          roomId,
          role: newRole,
          status: (updatedCount >= 2 ? 'chat' : 'waiting') as ViewState,
          token,
        };
      } else {
        // Room does not exist -> Create new room with a random crazy alias!
        const initialRole = getNextRole([]);
        const newRoom: RoomData = {
          roomId,
          status: 'waiting',
          createdAt: now,
          lastActiveAt: now,
          expiresAt: now + ROOM_EXPIRY_MS,
          participants: {
            [token]: {
              token,
              role: initialRole,
              joinedAt: now,
              lastSeenAt: now,
            },
          },
          participantCount: 1,
          screenShare: null,
        };
        transaction.set(roomRef, newRoom);

        return {
          roomId,
          role: initialRole,
          status: 'waiting' as ViewState,
          token,
        };
      }
    });

    return result;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `rooms/${roomId}`);
    throw error;
  }
}

/**
 * Send a chat message with optional media/file attachment
 */
export async function sendChatMessage(
  roomId: string,
  text: string,
  role: string,
  token: string,
  file?: File | null,
  onProgress?: (progressPct: number) => void
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed && !file) return;

  const messagesRef = collection(db, 'rooms', roomId, 'messages');
  const roomRef = doc(db, 'rooms', roomId);

  try {
    let attachment: FileAttachment | undefined = undefined;

    if (file) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `File size exceeds the ${(MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB limit.`
        );
      }

      onProgress?.(15);
      const dataUrl = await fileToDataUrl(file);
      onProgress?.(40);

      if (dataUrl.length <= INLINE_CHUNK_LIMIT) {
        attachment = {
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          dataUrl,
          hasChunks: false,
          chunkCount: 1,
        };
      } else {
        const totalChunks = Math.ceil(dataUrl.length / CHUNK_CHAR_SIZE);
        attachment = {
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          hasChunks: true,
          chunkCount: totalChunks,
        };

        const messageDoc = await addDoc(messagesRef, {
          text: trimmed,
          senderRole: role,
          senderToken: token,
          createdAt: Date.now(),
          attachment,
        });

        attachmentCache.set(`${roomId}_${messageDoc.id}`, dataUrl);

        const chunksRef = collection(db, 'rooms', roomId, 'messages', messageDoc.id, 'chunks');
        for (let i = 0; i < totalChunks; i++) {
          const chunkStr = dataUrl.substring(i * CHUNK_CHAR_SIZE, (i + 1) * CHUNK_CHAR_SIZE);
          await addDoc(chunksRef, {
            chunkIndex: i,
            data: chunkStr,
          });
          onProgress?.(40 + Math.round(((i + 1) / totalChunks) * 55));
        }

        await runTransaction(db, async (t) => {
          const snap = await t.get(roomRef);
          if (snap.exists()) {
            t.update(roomRef, { lastActiveAt: Date.now() });
          }
        });

        onProgress?.(100);
        return;
      }
    }

    onProgress?.(70);
    const msgData: Partial<ChatMessage> = {
      text: trimmed,
      senderRole: role,
      senderToken: token,
      createdAt: Date.now(),
    };
    if (attachment) {
      msgData.attachment = attachment;
    }

    const docRef = await addDoc(messagesRef, msgData);
    if (attachment?.dataUrl) {
      attachmentCache.set(`${roomId}_${docRef.id}`, attachment.dataUrl);
    }

    await runTransaction(db, async (t) => {
      const snap = await t.get(roomRef);
      if (snap.exists()) {
        t.update(roomRef, { lastActiveAt: Date.now() });
      }
    });

    onProgress?.(100);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `rooms/${roomId}/messages`);
  }
}

/**
 * Leave a room: removes this participant. If everyone left or closed the tab, immediately closes room and cleans up!
 */
export async function leaveRoom(roomId: string, token: string): Promise<void> {
  const roomRef = doc(db, 'rooms', roomId);

  try {
    let shouldCleanMessages = false;

    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(roomRef);
      if (!snap.exists()) return;

      const data = snap.data() as RoomData;
      const participants: Record<string, Participant> = data.participants || {};

      if (data.participantA && !participants[data.participantA.token]) {
        participants[data.participantA.token] = data.participantA;
      }
      if (data.participantB && !participants[data.participantB.token]) {
        participants[data.participantB.token] = data.participantB;
      }

      delete participants[token];
      const remainingCount = Object.keys(participants).length;

      // If everyone left the room or closed the tab, IMMEDIATELY close that room!
      if (remainingCount === 0) {
        transaction.update(roomRef, {
          participants: {},
          participantCount: 0,
          status: 'closed',
          lastActiveAt: Date.now(),
          screenShare: null,
        });
        shouldCleanMessages = true;
      } else {
        transaction.update(roomRef, {
          participants,
          participantCount: remainingCount,
          lastActiveAt: Date.now(),
        });
      }
    });

    if (shouldCleanMessages) {
      await deleteRoomMessages(roomId);
    }
  } catch (error) {
    console.warn('Error while leaving room:', error);
  }
}

/**
 * Update a participant's display name / alias in the room
 */
export async function updateParticipantName(
  roomId: string,
  token: string,
  newName: string
): Promise<string> {
  const trimmed = newName.trim();
  if (!trimmed || trimmed.length > 32) {
    throw new Error('Name must be between 1 and 32 characters.');
  }

  const roomRef = doc(db, 'rooms', roomId);
  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(roomRef);
    if (!snap.exists()) return;

    const data = snap.data() as RoomData;
    const participants = data.participants || {};

    if (participants[token]) {
      participants[token].role = trimmed;
      transaction.update(roomRef, {
        participants,
        lastActiveAt: Date.now(),
      });
    }
  });

  return trimmed;
}
