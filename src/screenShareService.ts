import {
  collection,
  doc,
  addDoc,
  getDocs,
  writeBatch,
  updateDoc,
} from 'firebase/firestore';
import { db } from './firebase.ts';
import {
  RemoteControlRequest,
  RemoteControlState,
  ScreenShareState,
  WebRTCSignal,
} from './types.ts';

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ],
};

/**
 * Start screen sharing in Firestore for a room
 */
export async function startScreenShareInRoom(
  roomId: string,
  presenterToken: string,
  presenterRole: string
): Promise<void> {
  const roomRef = doc(db, 'rooms', roomId);
  const screenShare: ScreenShareState = {
    active: true,
    presenterToken,
    presenterRole,
    startedAt: Date.now(),
    remoteControl: null,
    pendingControlRequest: null,
  };

  await updateDoc(roomRef, {
    screenShare,
    lastActiveAt: Date.now(),
  });
}

/**
 * Stop screen sharing in Firestore for a room
 */
export async function stopScreenShareInRoom(roomId: string): Promise<void> {
  const roomRef = doc(db, 'rooms', roomId);
  await updateDoc(roomRef, {
    screenShare: null,
    lastActiveAt: Date.now(),
  });

  // Clean up any lingering signaling docs
  try {
    const signalsRef = collection(db, 'rooms', roomId, 'signals');
    const snap = await getDocs(signalsRef);
    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (err) {
    console.warn('Could not clean up signaling documents:', err);
  }
}

/**
 * Request remote control of the shared screen
 */
export async function requestRemoteControl(
  roomId: string,
  requesterToken: string,
  requesterRole: string
): Promise<void> {
  const roomRef = doc(db, 'rooms', roomId);
  const pendingControlRequest: RemoteControlRequest = {
    requesterToken,
    requesterRole,
    requestedAt: Date.now(),
  };

  await updateDoc(roomRef, {
    'screenShare.pendingControlRequest': pendingControlRequest,
    lastActiveAt: Date.now(),
  });
}

/**
 * Presenter responds to remote control request (Approve or Decline)
 */
export async function respondToRemoteControl(
  roomId: string,
  approve: boolean,
  requesterToken?: string,
  requesterRole?: string
): Promise<void> {
  const roomRef = doc(db, 'rooms', roomId);

  if (approve && requesterToken && requesterRole) {
    const remoteControl: RemoteControlState = {
      controllerToken: requesterToken,
      controllerRole: requesterRole,
      grantedAt: Date.now(),
    };
    await updateDoc(roomRef, {
      'screenShare.remoteControl': remoteControl,
      'screenShare.pendingControlRequest': null,
      lastActiveAt: Date.now(),
    });
  } else {
    await updateDoc(roomRef, {
      'screenShare.pendingControlRequest': null,
      lastActiveAt: Date.now(),
    });
  }
}

/**
 * Revoke or release remote control of screen
 */
export async function releaseRemoteControl(roomId: string): Promise<void> {
  const roomRef = doc(db, 'rooms', roomId);
  await updateDoc(roomRef, {
    'screenShare.remoteControl': null,
    'screenShare.pendingControlRequest': null,
    lastActiveAt: Date.now(),
  });
}

/**
 * Send a WebRTC signaling message or pointer event
 */
export async function sendSignal(
  roomId: string,
  signal: Omit<WebRTCSignal, 'id' | 'createdAt'>
): Promise<void> {
  const signalsRef = collection(db, 'rooms', roomId, 'signals');
  await addDoc(signalsRef, {
    ...signal,
    createdAt: Date.now(),
  });
}

/**
 * Check if the browser supports getDisplayMedia
 */
export function isScreenShareSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function'
  );
}
