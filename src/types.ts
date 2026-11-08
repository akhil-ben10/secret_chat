export interface Participant {
  token: string;
  role: string;
  joinedAt: number;
  lastSeenAt?: number;
}

export interface FileAttachment {
  name: string;
  type: string; // e.g. "image/jpeg", "video/mp4", "application/pdf"
  size: number;
  dataUrl?: string; // base64 data for inline small files / images
  hasChunks?: boolean;
  chunkCount?: number;
}

export interface RemoteControlState {
  controllerToken: string;
  controllerRole: string;
  grantedAt: number;
}

export interface RemoteControlRequest {
  requesterToken: string;
  requesterRole: string;
  requestedAt: number;
}

export interface ScreenShareState {
  active: boolean;
  presenterToken: string;
  presenterRole: string;
  startedAt: number;
  remoteControl?: RemoteControlState | null;
  pendingControlRequest?: RemoteControlRequest | null;
}

export interface RemotePointerEvent {
  x: number; // percentage 0 - 100
  y: number; // percentage 0 - 100
  type: 'move' | 'click' | 'laser';
  role: string;
  timestamp: number;
}

export interface WebRTCSignal {
  id?: string;
  type:
    | 'offer'
    | 'answer'
    | 'candidate'
    | 'viewer_ready'
    | 'end'
    | 'control_request'
    | 'control_grant'
    | 'control_deny'
    | 'control_release'
    | 'pointer_event';
  senderToken: string;
  targetToken: string;
  payload?: any;
  createdAt: number;
}

export interface RoomData {
  roomId: string;
  status: 'waiting' | 'active' | 'closed';
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  participants: Record<string, Participant>;
  participantCount: number;
  screenShare?: ScreenShareState | null;
  // Legacy fields for backwards compatibility with any open rooms
  participantA?: Participant;
  participantB?: Participant | null;
}

export interface ChatMessage {
  id: string;
  text: string;
  senderRole: string;
  senderToken: string;
  createdAt: number;
  attachment?: FileAttachment;
}

export type ViewState = 'entry' | 'waiting' | 'chat' | 'closed';
