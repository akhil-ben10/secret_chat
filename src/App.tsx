/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore';
import {
  Send,
  Lock,
  Users,
  Copy,
  Check,
  LogOut,
  ArrowRight,
  AlertCircle,
  Clock,
  RefreshCw,
  Paperclip,
  X,
  FileText,
  Image as ImageIcon,
  Film,
  UploadCloud,
  Share2,
  Monitor,
  Sun,
  Moon,
  Sparkles,
  Mic,
  Volume2,
  VolumeX,
  Edit2,
  Shuffle,
  Trash2,
} from 'lucide-react';
import {
  db,
  getOrCreateSessionToken,
  handleFirestoreError,
  OperationType,
  testConnection,
} from './firebase.ts';
import {
  joinRoom,
  sendChatMessage,
  leaveRoom,
  touchParticipantPresence,
  sweepInactiveParticipants,
  updateParticipantName,
  SOUTH_INDIAN_FEMALE_NAMES,
  MAX_FILE_SIZE_BYTES,
} from './roomService.ts';
import {
  startScreenShareInRoom,
  stopScreenShareInRoom,
  isScreenShareSupported,
} from './screenShareService.ts';
import {
  playNotificationChime,
  playSentSound,
  VoiceRecorder,
} from './audioUtils.ts';
import { AttachmentView } from './components/AttachmentView.tsx';
import { ScreenShareStage } from './components/ScreenShareStage.tsx';
import { ChatMessage, Participant, RoomData, ViewState } from './types.ts';

// Dynamic color palette generator for participant names in light and dark modes
const BADGE_PALETTES = [
  { light: 'bg-emerald-100 text-emerald-800 border-emerald-300', dark: 'bg-emerald-950/70 text-emerald-300 border-emerald-800/80' },
  { light: 'bg-blue-100 text-blue-800 border-blue-300', dark: 'bg-blue-950/70 text-blue-300 border-blue-800/80' },
  { light: 'bg-amber-100 text-amber-800 border-amber-300', dark: 'bg-amber-950/70 text-amber-300 border-amber-800/80' },
  { light: 'bg-purple-100 text-purple-800 border-purple-300', dark: 'bg-purple-950/70 text-purple-300 border-purple-800/80' },
  { light: 'bg-rose-100 text-rose-800 border-rose-300', dark: 'bg-rose-950/70 text-rose-300 border-rose-800/80' },
  { light: 'bg-teal-100 text-teal-800 border-teal-300', dark: 'bg-teal-950/70 text-teal-300 border-teal-800/80' },
  { light: 'bg-indigo-100 text-indigo-800 border-indigo-300', dark: 'bg-indigo-950/70 text-indigo-300 border-indigo-800/80' },
  { light: 'bg-cyan-100 text-cyan-800 border-cyan-300', dark: 'bg-cyan-950/70 text-cyan-300 border-cyan-800/80' },
  { light: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300', dark: 'bg-fuchsia-950/70 text-fuchsia-300 border-fuchsia-800/80' },
  { light: 'bg-lime-100 text-lime-800 border-lime-300', dark: 'bg-lime-950/70 text-lime-300 border-lime-800/80' },
  { light: 'bg-orange-100 text-orange-800 border-orange-300', dark: 'bg-orange-950/70 text-orange-300 border-orange-800/80' },
  { light: 'bg-violet-100 text-violet-800 border-violet-300', dark: 'bg-violet-950/70 text-violet-300 border-violet-800/80' },
];

function getRoleBadgeStyle(role: string, isDark: boolean): string {
  let hash = 0;
  for (let i = 0; i < role.length; i++) {
    hash = (hash << 5) - hash + role.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % BADGE_PALETTES.length;
  const palette = BADGE_PALETTES[index];
  return isDark ? palette.dark : palette.light;
}

export default function App() {
  const [viewState, setViewState] = useState<ViewState>('entry');
  const [roomCodeInput, setRoomCodeInput] = useState<string>('');
  const [activeRoomId, setActiveRoomId] = useState<string>('');
  const [myRole, setMyRole] = useState<string>('Ananya');
  const [myToken, setMyToken] = useState<string>('');
  const [roomData, setRoomData] = useState<RoomData | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [showLeaveModal, setShowLeaveModal] = useState<boolean>(false);
  const [showParticipantsDropdown, setShowParticipantsDropdown] = useState<boolean>(false);

  // Edit Name State
  const [showEditNameModal, setShowEditNameModal] = useState<boolean>(false);
  const [editedNameInput, setEditedNameInput] = useState<string>('');

  // Dark Theme State
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('anon_chat_theme');
    if (saved) return saved === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    localStorage.setItem('anon_chat_theme', isDarkMode ? 'dark' : 'light');
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // Audio / Sound Options State
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('anon_chat_sound');
    return saved !== 'false';
  });

  useEffect(() => {
    localStorage.setItem('anon_chat_sound', String(soundEnabled));
  }, [soundEnabled]);

  // Voice Note Recording State
  const [isRecordingVoice, setIsRecordingVoice] = useState<boolean>(false);
  const [recordingDuration, setRecordingDuration] = useState<number>(0);
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null);
  const recordingTimerRef = useRef<any>(null);

  // File Attachment State
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Live Screen Sharing State
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isInitialMessageLoadRef = useRef<boolean>(true);

  // Initialize session token and test connection
  useEffect(() => {
    const token = getOrCreateSessionToken();
    setMyToken(token);
    testConnection();

    // Check query params for shared room code
    const params = new URLSearchParams(window.location.search);
    const sharedRoom = params.get('room');
    if (sharedRoom) {
      setRoomCodeInput(sharedRoom.toUpperCase());
    }
  }, []);

  // Listen for Room changes
  useEffect(() => {
    if (!activeRoomId || viewState === 'entry') {
      return;
    }

    const roomRef = doc(db, 'rooms', activeRoomId);
    const unsubscribeRoom = onSnapshot(
      roomRef,
      (snap) => {
        if (!snap.exists()) {
          setViewState('entry');
          setActiveRoomId('');
          return;
        }

        const data = snap.data() as RoomData;
        setRoomData(data);

        // Normalize participants
        const participants: Record<string, Participant> = data.participants || {};
        if (data.participantA && !participants[data.participantA.token]) {
          participants[data.participantA.token] = data.participantA;
        }
        if (data.participantB && !participants[data.participantB.token]) {
          participants[data.participantB.token] = data.participantB;
        }

        // Keep local name in sync if updated
        if (participants[myToken] && participants[myToken].role !== myRole) {
          setMyRole(participants[myToken].role);
        }

        // Check if room was closed or everyone left
        if (data.status === 'closed') {
          setViewState('closed');
          return;
        }

        const participantCount = Object.keys(participants).length;
        if (participantCount === 0 && (Date.now() - (data.createdAt || 0) > 3000)) {
          setViewState('closed');
          return;
        }

        // If currently in waiting state and another person joined, automatically enter chat!
        if (viewState === 'waiting' && participantCount >= 2) {
          setViewState('chat');
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, `rooms/${activeRoomId}`);
      }
    );

    return () => {
      unsubscribeRoom();
    };
  }, [activeRoomId, viewState, myToken, myRole]);

  // Presence Heartbeat & Auto-Sweep (Detects closed tabs & empty rooms immediately)
  useEffect(() => {
    if (!activeRoomId || viewState === 'entry' || viewState === 'closed') {
      return;
    }

    touchParticipantPresence(activeRoomId, myToken).catch(() => {});

    const heartbeatTimer = setInterval(() => {
      touchParticipantPresence(activeRoomId, myToken).catch(() => {});
    }, 5000);

    const sweepTimer = setInterval(async () => {
      const roomClosed = await sweepInactiveParticipants(activeRoomId);
      if (roomClosed) {
        setViewState('closed');
      }
    }, 6000);

    const handleTabClose = () => {
      if (localScreenStream) {
        localScreenStream.getTracks().forEach((t) => t.stop());
      }
      leaveRoom(activeRoomId, myToken).catch(() => {});
    };

    window.addEventListener('pagehide', handleTabClose);
    window.addEventListener('beforeunload', handleTabClose);

    return () => {
      clearInterval(heartbeatTimer);
      clearInterval(sweepTimer);
      window.removeEventListener('pagehide', handleTabClose);
      window.removeEventListener('beforeunload', handleTabClose);
    };
  }, [activeRoomId, viewState, myToken, localScreenStream]);

  // Listen for Messages inside the room + Notification Audio Chime
  useEffect(() => {
    if (!activeRoomId || (viewState !== 'chat' && viewState !== 'waiting')) {
      return;
    }

    isInitialMessageLoadRef.current = true;
    const messagesRef = collection(db, 'rooms', activeRoomId, 'messages');
    const q = query(messagesRef, orderBy('createdAt', 'asc'));

    const unsubscribeMessages = onSnapshot(
      q,
      (snap) => {
        const list: ChatMessage[] = snap.docs.map((d) => {
          const val = d.data();
          return {
            id: d.id,
            text: val.text || '',
            senderRole: val.senderRole || 'Ananya',
            senderToken: val.senderToken || '',
            createdAt: val.createdAt || Date.now(),
            attachment: val.attachment || undefined,
          };
        });

        // Trigger gentle sound chime on newly arrived messages from others
        if (!isInitialMessageLoadRef.current && snap.docChanges().some(c => c.type === 'added')) {
          const newDoc = snap.docChanges().find(c => c.type === 'added')?.doc.data();
          if (newDoc && newDoc.senderToken !== myToken && soundEnabled) {
            playNotificationChime();
          }
        }

        isInitialMessageLoadRef.current = false;
        setMessages(list);
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, `rooms/${activeRoomId}/messages`);
      }
    );

    return () => {
      unsubscribeMessages();
    };
  }, [activeRoomId, viewState, myToken, soundEnabled]);

  // Auto-scroll to latest message
  useEffect(() => {
    if (viewState === 'chat') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, viewState, uploadProgress]);

  // Focus message input when entering chat
  useEffect(() => {
    if (viewState === 'chat') {
      inputRef.current?.focus();
    }
  }, [viewState]);

  // Handle file selection
  const handleFileSelect = (file: File | null) => {
    if (!file) return;

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setErrorMessage(
        `File is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Limit is 15MB.`
      );
      return;
    }

    setSelectedFile(file);
    setErrorMessage('');

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => setFilePreview(reader.result as string);
      reader.readAsDataURL(file);
    } else {
      setFilePreview(null);
    }
  };

  const removeSelectedFile = () => {
    setSelectedFile(null);
    setFilePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Join Chat handler
  const handleJoinChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanCode = roomCodeInput.trim().toUpperCase();
    if (!cleanCode) {
      setErrorMessage('Please enter a room code.');
      return;
    }

    setErrorMessage('');
    setIsLoading(true);

    try {
      const result = await joinRoom(cleanCode);
      setActiveRoomId(result.roomId);
      setMyRole(result.role);
      setViewState(result.status);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to join room. Please check your connection.');
    } finally {
      setIsLoading(false);
    }
  };

  // Edit / Change User Display Name
  const handleOpenEditName = () => {
    setEditedNameInput(myRole);
    setShowEditNameModal(true);
  };

  const handleSaveName = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = editedNameInput.trim();
    if (!trimmed) {
      setErrorMessage('Name cannot be empty.');
      return;
    }

    if (trimmed === myRole) {
      setShowEditNameModal(false);
      return;
    }

    try {
      setIsLoading(true);
      const oldRole = myRole;
      await updateParticipantName(activeRoomId, myToken, trimmed);
      setMyRole(trimmed);
      setShowEditNameModal(false);

      if (activeRoomId) {
        await sendChatMessage(
          activeRoomId,
          `✨ ${oldRole} is now known as ${trimmed}`,
          trimmed,
          myToken
        );
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to update name.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleShuffleName = () => {
    const available = SOUTH_INDIAN_FEMALE_NAMES.filter((n) => n !== editedNameInput);
    const random = available[Math.floor(Math.random() * available.length)];
    setEditedNameInput(random);
  };

  // Voice Note Recording
  const handleStartVoiceRecording = async () => {
    try {
      setErrorMessage('');
      const recorder = new VoiceRecorder();
      await recorder.start();
      voiceRecorderRef.current = recorder;
      setIsRecordingVoice(true);
      setRecordingDuration(0);

      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      console.error('Microphone access denied:', err);
      setErrorMessage('Microphone access was denied or is not supported.');
    }
  };

  const handleCancelVoiceRecording = () => {
    if (voiceRecorderRef.current) {
      voiceRecorderRef.current.cancel();
      voiceRecorderRef.current = null;
    }
    clearInterval(recordingTimerRef.current);
    setIsRecordingVoice(false);
    setRecordingDuration(0);
  };

  const handleSendVoiceRecording = async () => {
    if (!voiceRecorderRef.current || !activeRoomId) return;

    clearInterval(recordingTimerRef.current);
    setIsRecordingVoice(false);
    setUploadProgress(15);

    try {
      const audioFile = await voiceRecorderRef.current.stop();
      voiceRecorderRef.current = null;

      await sendChatMessage(
        activeRoomId,
        '',
        myRole,
        myToken,
        audioFile,
        (pct) => setUploadProgress(pct)
      );

      if (soundEnabled) playSentSound();
    } catch (err: any) {
      console.error('Failed to send voice recording:', err);
      setErrorMessage(err?.message || 'Failed to send voice recording.');
    } finally {
      setUploadProgress(null);
      setRecordingDuration(0);
    }
  };

  // Send Message handler
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = inputMessage.trim();
    if ((!text && !selectedFile) || !activeRoomId || uploadProgress !== null) return;

    const fileToSend = selectedFile;
    setInputMessage('');
    removeSelectedFile();
    setUploadProgress(fileToSend ? 10 : null);

    try {
      await sendChatMessage(
        activeRoomId,
        text,
        myRole,
        myToken,
        fileToSend,
        (pct) => setUploadProgress(pct)
      );
      if (soundEnabled) playSentSound();
    } catch (err: any) {
      console.error('Failed to send message:', err);
      setErrorMessage(err?.message || 'Failed to send message.');
      setInputMessage(text);
      setSelectedFile(fileToSend);
    } finally {
      setUploadProgress(null);
    }
  };

  // Start Screen Sharing
  const handleStartScreenShare = async () => {
    if (!activeRoomId) return;

    if (!isScreenShareSupported()) {
      setErrorMessage('Screen sharing is not supported in this browser.');
      return;
    }

    if (roomData?.screenShare?.active && roomData.screenShare.presenterToken !== myToken) {
      setErrorMessage(
        `${roomData.screenShare.presenterRole} is already sharing their screen.`
      );
      return;
    }

    try {
      setErrorMessage('');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
        } as any,
        audio: true,
      });

      setLocalScreenStream(stream);

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          handleStopScreenShare();
        };
      }

      await startScreenShareInRoom(activeRoomId, myToken, myRole);
      await sendChatMessage(
        activeRoomId,
        '🖥️ Started live screen sharing',
        myRole,
        myToken
      );
    } catch (err: any) {
      if (err?.name === 'NotAllowedError' || err?.message?.includes('Permission denied')) {
        return;
      }
      console.error('Screen share request error:', err);
      setErrorMessage(err?.message || 'Could not start screen share.');
    }
  };

  // Stop Screen Sharing
  const handleStopScreenShare = async () => {
    if (localScreenStream) {
      localScreenStream.getTracks().forEach((track) => track.stop());
      setLocalScreenStream(null);
    }

    if (activeRoomId && roomData?.screenShare?.presenterToken === myToken) {
      try {
        await stopScreenShareInRoom(activeRoomId);
        await sendChatMessage(
          activeRoomId,
          '🖥️ Stopped live screen sharing',
          myRole,
          myToken
        );
      } catch (err) {
        console.warn('Error closing screen share:', err);
      }
    }
  };

  // Leave Room handler
  const handleLeaveRoom = async () => {
    setShowLeaveModal(false);
    setIsLoading(true);

    if (isRecordingVoice) {
      handleCancelVoiceRecording();
    }

    if (localScreenStream || roomData?.screenShare?.presenterToken === myToken) {
      await handleStopScreenShare();
    }

    if (activeRoomId) {
      try {
        await leaveRoom(activeRoomId, myToken);
      } catch (err) {
        console.warn('Error during leave room:', err);
      }
    }

    setActiveRoomId('');
    setRoomData(null);
    setMessages([]);
    removeSelectedFile();
    setViewState('entry');
    setIsLoading(false);
  };

  const copyRoomCode = () => {
    if (!activeRoomId) return;
    navigator.clipboard.writeText(activeRoomId);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const copyInviteLink = () => {
    if (!activeRoomId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('room', activeRoomId);
    navigator.clipboard.writeText(url.toString());
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const formatTime = (timestamp: number) => {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatSeconds = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = sec % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const participantsList = roomData?.participants
    ? Object.values(roomData.participants)
    : [];
  const participantCount = participantsList.length || roomData?.participantCount || 1;
  const isMePresenting = roomData?.screenShare?.presenterToken === myToken;
  const isScreenShareActive = !!roomData?.screenShare?.active;

  return (
    <div
      className={`min-h-screen ${
        isDarkMode ? 'dark bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-900'
      } flex flex-col justify-between selection:bg-indigo-500/20 transition-colors duration-200`}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        id="chat-file-input"
        type="file"
        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar,.tar,.gz,.json,.mp3,.wav,.ogg,.m4a,.webm"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileSelect(file);
        }}
      />

      {/* Top Navigation / Brand Header */}
      <header className="w-full border-b border-zinc-200/80 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md sticky top-0 z-30 transition-colors">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 flex items-center justify-center font-bold text-sm shadow-sm transition-colors">
              <Lock className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-base font-bold tracking-tight text-zinc-900 dark:text-white">
                  Anonymous Chat
                </h1>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-indigo-100 text-indigo-700 dark:bg-indigo-950/80 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/80">
                  Private
                </span>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {activeRoomId ? `Room: ${activeRoomId}` : 'Instant encrypted rooms'}
              </p>
            </div>
          </div>

          {/* Right Action Controls */}
          <div className="flex items-center gap-2 relative">
            {/* Sound Notification Chime Toggle */}
            <button
              id="sound-toggle-button"
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`p-2 rounded-xl border transition-colors ${
                soundEnabled
                  ? 'border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200/80 dark:hover:bg-zinc-750'
                  : 'border-zinc-200 dark:border-zinc-700 bg-zinc-100/50 dark:bg-zinc-850 text-zinc-400 dark:text-zinc-500'
              }`}
              title={soundEnabled ? 'Mute message sounds' : 'Enable message sounds'}
            >
              {soundEnabled ? (
                <Volume2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              ) : (
                <VolumeX className="w-4 h-4" />
              )}
            </button>

            {/* Dark/Light Theme Toggle */}
            <button
              id="theme-toggle-button"
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-700/80 bg-zinc-100 dark:bg-zinc-800/80 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200/80 dark:hover:bg-zinc-700 transition-colors"
              title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
              {isDarkMode ? (
                <Sun className="w-4 h-4 text-amber-400" />
              ) : (
                <Moon className="w-4 h-4 text-zinc-600" />
              )}
            </button>

            {/* Active Room Actions */}
            {activeRoomId && viewState !== 'entry' && (
              <>
                {/* Screen Share Header Button */}
                {viewState === 'chat' && (
                  <button
                    id="header-screen-share-button"
                    onClick={isMePresenting ? handleStopScreenShare : handleStartScreenShare}
                    disabled={isScreenShareActive && !isMePresenting}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                      isMePresenting
                        ? 'bg-red-50 text-red-600 border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-900/60 hover:bg-red-100'
                        : isScreenShareActive
                        ? 'bg-zinc-100 text-zinc-400 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-500 dark:border-zinc-700 cursor-not-allowed'
                        : 'bg-zinc-100 hover:bg-zinc-200/70 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 border-zinc-200 dark:border-zinc-700 active:scale-95'
                    }`}
                    title={
                      isMePresenting
                        ? 'Stop sharing your screen'
                        : isScreenShareActive
                        ? `${roomData?.screenShare?.presenterRole} is currently sharing`
                        : 'Share your screen'
                    }
                  >
                    <Monitor className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">
                      {isMePresenting
                        ? 'Stop Share'
                        : isScreenShareActive
                        ? 'Screen Live'
                        : 'Share Screen'}
                    </span>
                  </button>
                )}

                {/* Participants count pill */}
                <button
                  id="participants-badge-button"
                  onClick={() => setShowParticipantsDropdown(!showParticipantsDropdown)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200/70 dark:hover:bg-zinc-700 transition-colors text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700"
                  title="View participants"
                >
                  <Users className="w-3.5 h-3.5 text-zinc-600 dark:text-zinc-400" />
                  <span>{participantCount} in room</span>
                </button>

                {/* Share invite button */}
                <button
                  id="share-invite-button"
                  onClick={copyInviteLink}
                  className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200/70 dark:hover:bg-zinc-700 transition-colors text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700"
                  title="Copy share link"
                >
                  {copiedLink ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Share2 className="w-3.5 h-3.5" />
                  )}
                  <span>{copiedLink ? 'Copied' : 'Invite'}</span>
                </button>

                {/* Leave room button */}
                <button
                  id="leave-room-button"
                  onClick={() => setShowLeaveModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-950/70 transition-colors border border-red-200/60 dark:border-red-900/50 active:scale-95"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Leave</span>
                </button>

                {/* Participants dropdown */}
                {showParticipantsDropdown && (
                  <div className="absolute right-0 top-11 mt-1 w-64 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 shadow-2xl p-3.5 z-40 animate-in fade-in zoom-in-95 duration-150">
                    <div className="text-xs font-bold text-zinc-800 dark:text-zinc-100 mb-2 flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <Users className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                        <span>Participants ({participantCount})</span>
                      </span>
                      <button
                        onClick={() => setShowParticipantsDropdown(false)}
                        className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="space-y-1.5 max-h-52 overflow-y-auto">
                      {participantsList.length > 0 ? (
                        participantsList.map((p) => (
                          <div
                            key={p.token}
                            className="flex items-center justify-between text-xs py-1.5 px-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/70 border border-zinc-200/60 dark:border-zinc-750"
                          >
                            <span
                              className={`font-semibold px-2 py-0.5 rounded-md border text-[11px] ${getRoleBadgeStyle(
                                p.role,
                                isDarkMode
                              )}`}
                            >
                              {p.role}
                            </span>
                            {p.token === myToken ? (
                              <button
                                onClick={() => {
                                  setShowParticipantsDropdown(false);
                                  handleOpenEditName();
                                }}
                                className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/70 px-2 py-0.5 rounded-md border border-indigo-200 dark:border-indigo-800/80 hover:bg-indigo-100"
                              >
                                <span>Edit Name</span>
                                <Edit2 className="w-2.5 h-2.5" />
                              </button>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <div className="text-xs py-1.5 px-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/70 flex items-center justify-between">
                          <span
                            className={`font-semibold px-2 py-0.5 rounded-md border text-[11px] ${getRoleBadgeStyle(
                              myRole,
                              isDarkMode
                            )}`}
                          >
                            {myRole}
                          </span>
                          <button
                            onClick={handleOpenEditName}
                            className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/70 px-2 py-0.5 rounded-md border border-indigo-200 dark:border-indigo-800/80 hover:bg-indigo-100"
                          >
                            <span>Edit Name</span>
                            <Edit2 className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="mt-3 pt-2.5 border-t border-zinc-100 dark:border-zinc-800 text-[11px] text-zinc-400 dark:text-zinc-500">
                      ⚡ When everyone leaves or closes tabs, room wipes instantly.
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 py-4 flex flex-col justify-center">
        {/* ======================================================== */}
        {/* VIEW 1: ENTER ROOM CODE (Home)                          */}
        {/* ======================================================== */}
        {viewState === 'entry' && (
          <div className="w-full max-w-md mx-auto my-auto py-8 animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/90 dark:border-zinc-800 shadow-xl p-6 sm:p-8 transition-colors">
              <div className="text-center mb-6">
                <div className="w-14 h-14 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 mx-auto flex items-center justify-center mb-3 shadow-inner">
                  <Sparkles className="w-7 h-7 text-indigo-600 dark:text-indigo-400" />
                </div>
                <h2 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">
                  Join Secret Room
                </h2>
                <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 mt-1.5 leading-relaxed">
                  Enter any room code. You'll get an authentic South Indian female name (customizable anytime), real-time chat, voice notes &amp; audio options, file transfer, and live screen share.
                </p>
              </div>

              <form onSubmit={handleJoinChat} className="space-y-4">
                <div>
                  <label
                    htmlFor="room-code-input"
                    className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-2 text-center"
                  >
                    Enter Room Code
                  </label>
                  <div className="relative">
                    <input
                      id="room-code-input"
                      type="text"
                      value={roomCodeInput}
                      onChange={(e) => {
                        setRoomCodeInput(e.target.value.toUpperCase());
                        if (errorMessage) setErrorMessage('');
                      }}
                      placeholder="e.g. 77"
                      autoFocus
                      maxLength={32}
                      className="w-full px-4 py-3.5 rounded-2xl border border-zinc-300 dark:border-zinc-700 focus:border-zinc-900 dark:focus:border-indigo-500 focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-indigo-500/20 outline-none text-zinc-900 dark:text-white font-mono font-black tracking-widest placeholder:font-normal placeholder:tracking-normal placeholder:text-zinc-400 dark:placeholder:text-zinc-600 bg-zinc-50/70 dark:bg-zinc-800/80 text-center text-xl uppercase transition-all"
                    />
                  </div>
                  {errorMessage && (
                    <div className="mt-2.5 flex items-center justify-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{errorMessage}</span>
                    </div>
                  )}
                </div>

                <button
                  id="join-chat-button"
                  type="submit"
                  disabled={isLoading || !roomCodeInput.trim()}
                  className="w-full py-3.5 px-4 rounded-2xl font-bold text-sm text-white bg-zinc-900 dark:bg-indigo-600 hover:bg-zinc-800 dark:hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md flex items-center justify-center gap-2 active:scale-[0.99]"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Entering Room...</span>
                    </>
                  ) : (
                    <>
                      <span>Join Chat</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>

              <div className="mt-6 pt-6 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-center gap-2.5 text-xs text-zinc-500 dark:text-zinc-400 flex-wrap">
                <span className="flex items-center gap-1">
                  <Mic className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
                  Voice Notes &amp; Audio
                </span>
                <span className="w-1 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700"></span>
                <span className="flex items-center gap-1">
                  <Edit2 className="w-3.5 h-3.5 text-zinc-400" />
                  Editable Names
                </span>
                <span className="w-1 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700"></span>
                <span className="flex items-center gap-1">
                  <Monitor className="w-3.5 h-3.5 text-zinc-400" />
                  Screen Share
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* VIEW 2: WAITING FOR OTHERS (First joiner)                */}
        {/* ======================================================== */}
        {viewState === 'waiting' && (
          <div className="w-full max-w-md mx-auto my-auto py-8 animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/90 dark:border-zinc-800 shadow-xl p-6 sm:p-8 text-center transition-colors">
              <div className="relative w-16 h-16 mx-auto mb-4">
                <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center shadow-inner">
                  <Users className="w-8 h-8 text-zinc-800 dark:text-zinc-200" />
                </div>
                <span className="absolute -top-1 -right-1 flex h-4 w-4">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-4 w-4 bg-amber-500"></span>
                </span>
              </div>

              {/* Editable Name Badge in Waiting */}
              <div className="inline-flex items-center gap-1.5 mb-3">
                <span
                  className={`px-3 py-1 rounded-xl text-xs font-extrabold border ${getRoleBadgeStyle(
                    myRole,
                    isDarkMode
                  )}`}
                >
                  Your Name: {myRole}
                </span>
                <button
                  id="edit-name-waiting-button"
                  onClick={handleOpenEditName}
                  className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  title="Edit your display name"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <h2 className="text-xl font-bold text-zinc-900 dark:text-white tracking-tight mb-2">
                Waiting for someone to join...
              </h2>
              <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 mb-6 leading-relaxed">
                Give this code to a friend. The private chat starts instantly the moment they enter.
              </p>

              {/* Room Code Display Box */}
              <div className="bg-zinc-50 dark:bg-zinc-800/70 border border-zinc-200 dark:border-zinc-700/80 rounded-2xl p-4 mb-4">
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 font-medium">Room Code</div>
                <div className="text-3xl font-mono font-black tracking-widest text-zinc-900 dark:text-white select-all">
                  {activeRoomId}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <button
                  id="copy-code-button"
                  onClick={copyRoomCode}
                  className="py-2.5 px-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-750 text-xs font-semibold text-zinc-800 dark:text-zinc-200 transition-colors flex items-center justify-center gap-1.5"
                >
                  {copiedCode ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span className="text-emerald-700 dark:text-emerald-400">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                      <span>Copy Code</span>
                    </>
                  )}
                </button>

                <button
                  id="copy-link-button"
                  onClick={copyInviteLink}
                  className="py-2.5 px-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-750 text-xs font-semibold text-zinc-800 dark:text-zinc-200 transition-colors flex items-center justify-center gap-1.5"
                >
                  {copiedLink ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span className="text-emerald-700 dark:text-emerald-400">Link Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                      <span>Copy Link</span>
                    </>
                  )}
                </button>
              </div>

              {/* Enter chat room directly button */}
              <button
                id="enter-chat-now-button"
                onClick={() => setViewState('chat')}
                className="w-full py-3 px-4 rounded-xl font-semibold text-xs text-zinc-800 dark:text-zinc-200 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200/80 dark:hover:bg-zinc-700 transition-colors mb-4 flex items-center justify-center gap-1.5"
              >
                <span>Enter Chat Room Directly</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>

              <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
                <span className="text-xs text-zinc-400 dark:text-zinc-500 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" /> Instant sync
                </span>
                <button
                  id="cancel-waiting-button"
                  onClick={handleLeaveRoom}
                  className="text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                >
                  Cancel &amp; Exit
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* VIEW 3: ACTIVE PRIVATE CHAT WITH SCREEN SHARE & AUDIO    */}
        {/* ======================================================== */}
        {viewState === 'chat' && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) handleFileSelect(file);
            }}
            className={`flex-1 flex flex-col h-[calc(100vh-8rem)] max-h-[860px] bg-white dark:bg-zinc-900 rounded-3xl border ${
              isDragging
                ? 'border-indigo-500 ring-2 ring-indigo-500/20'
                : 'border-zinc-200/90 dark:border-zinc-800'
            } shadow-xl overflow-hidden relative transition-all`}
          >
            {/* Drag and Drop Overlay */}
            {isDragging && (
              <div className="absolute inset-0 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xs z-30 flex flex-col items-center justify-center p-6 border-2 border-dashed border-indigo-500 rounded-3xl">
                <UploadCloud className="w-12 h-12 text-indigo-600 dark:text-indigo-400 mb-2 animate-bounce" />
                <p className="text-base font-bold text-zinc-900 dark:text-white">Drop file to transmit</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Audio, images, videos, documents up to 15MB</p>
              </div>
            )}

            {/* Chat Room Top Bar */}
            <div className="px-4 py-2.5 sm:px-5 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-800/40 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                      Room
                    </span>
                    <span className="font-mono font-bold text-zinc-900 dark:text-white text-sm">
                      {activeRoomId}
                    </span>
                  </div>
                  <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
                    {participantCount} active {participantCount === 1 ? 'member' : 'members'}
                  </div>
                </div>
              </div>

              {/* Editable Name Badge */}
              <div className="flex items-center gap-1.5">
                <button
                  id="chat-edit-name-button"
                  onClick={handleOpenEditName}
                  className={`px-3 py-1 rounded-xl text-xs font-extrabold border transition-all flex items-center gap-1.5 hover:scale-105 active:scale-95 ${getRoleBadgeStyle(
                    myRole,
                    isDarkMode
                  )}`}
                  title="Click to edit your name"
                >
                  <span>{myRole} (You)</span>
                  <Edit2 className="w-3 h-3 opacity-70" />
                </button>
              </div>
            </div>

            {/* LIVE SCREEN SHARE STAGE (Shown when any participant is sharing) */}
            {roomData?.screenShare?.active && (
              <ScreenShareStage
                roomId={activeRoomId}
                screenShare={roomData.screenShare}
                myToken={myToken}
                myRole={myRole}
                localStream={localScreenStream}
                onStopShare={handleStopScreenShare}
              />
            )}

            {/* Message Bubbles Container */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 bg-zinc-50/40 dark:bg-zinc-950/40">
              {/* Ephemeral Privacy Notice */}
              <div className="flex justify-center">
                <div className="px-3.5 py-1 rounded-full text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800/80 text-zinc-500 dark:text-zinc-400 border border-zinc-200/60 dark:border-zinc-700/60 flex items-center gap-1.5 shadow-2xs">
                  <Lock className="w-3 h-3 text-zinc-400 dark:text-zinc-500" />
                  <span>Wipes immediately when participants leave or close tabs.</span>
                </div>
              </div>

              {messages.length === 0 ? (
                <div className="h-44 flex flex-col items-center justify-center text-center text-zinc-400 dark:text-zinc-600">
                  <Sparkles className="w-8 h-8 mb-2 opacity-50 text-indigo-500 dark:text-indigo-400" />
                  <p className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">Room Ready!</p>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1 max-w-xs">
                    Type a message, tap the mic for voice notes, drop audio or files, or share your screen.
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isMe = msg.senderToken === myToken || msg.senderRole === myRole;
                  const isSystemAnnouncement = msg.text?.startsWith('✨');

                  if (isSystemAnnouncement) {
                    return (
                      <div key={msg.id} className="flex justify-center my-2">
                        <span className="text-[11px] font-medium px-3 py-1 rounded-full bg-zinc-200/70 dark:bg-zinc-800/70 text-zinc-600 dark:text-zinc-300 border border-zinc-300/50 dark:border-zinc-700/50">
                          {msg.text}
                        </span>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
                    >
                      {/* Sender label */}
                      <div className="flex items-center gap-1.5 mb-1 px-1">
                        <span
                          className={`text-[11px] font-bold px-2 py-0.5 rounded-lg border ${getRoleBadgeStyle(
                            msg.senderRole,
                            isDarkMode
                          )}`}
                        >
                          {msg.senderRole} {isMe && <span className="font-normal">(You)</span>}
                        </span>
                        <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                          {formatTime(msg.createdAt)}
                        </span>
                      </div>

                      {/* Message Bubble */}
                      <div
                        className={`max-w-[85%] sm:max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed break-words shadow-2xs ${
                          isMe
                            ? 'bg-zinc-900 dark:bg-indigo-600 text-white rounded-tr-xs'
                            : 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-200/80 dark:border-zinc-700/80 rounded-tl-xs'
                        }`}
                      >
                        {/* File / Audio / Voice Attachment */}
                        {msg.attachment && (
                          <AttachmentView
                            attachment={msg.attachment}
                            roomId={activeRoomId}
                            messageId={msg.id}
                            isMyMessage={isMe}
                          />
                        )}

                        {/* Text Caption / Body */}
                        {msg.text && (
                          <div className={msg.attachment ? 'mt-1.5' : ''}>
                            {msg.text}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Upload Progress Bar */}
            {uploadProgress !== null && (
              <div className="px-4 py-2 bg-zinc-100 dark:bg-zinc-800 border-t border-zinc-200 dark:border-zinc-750 text-xs flex items-center justify-between text-zinc-700 dark:text-zinc-300">
                <span className="flex items-center gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-500" />
                  Transmitting audio / file...
                </span>
                <span className="font-bold">{uploadProgress}%</span>
              </div>
            )}

            {/* Error Message Toast */}
            {errorMessage && (
              <div className="px-4 py-2 bg-red-50 dark:bg-red-950/40 border-t border-red-200 dark:border-red-900/50 text-xs text-red-600 dark:text-red-400 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  {errorMessage}
                </span>
                <button
                  onClick={() => setErrorMessage('')}
                  className="text-red-400 hover:text-red-600 dark:hover:text-red-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Selected File Preview Box */}
            {selectedFile && (
              <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border-t border-zinc-200 dark:border-zinc-700 flex items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  {filePreview ? (
                    <img
                      src={filePreview}
                      alt="preview"
                      className="w-10 h-10 object-cover rounded-xl border border-zinc-200 dark:border-zinc-700"
                    />
                  ) : selectedFile.type.startsWith('audio/') ? (
                    <div className="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                      <Mic className="w-5 h-5" />
                    </div>
                  ) : selectedFile.type.startsWith('video/') ? (
                    <div className="w-10 h-10 rounded-xl bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-zinc-700 dark:text-zinc-200">
                      <Film className="w-5 h-5" />
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded-xl bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-zinc-700 dark:text-zinc-200">
                      <FileText className="w-5 h-5" />
                    </div>
                  )}

                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 truncate max-w-[200px] sm:max-w-xs">
                      {selectedFile.name}
                    </p>
                    <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
                      {(selectedFile.size / 1024).toFixed(0)} KB &bull;{' '}
                      {selectedFile.type || 'audio/file'}
                    </p>
                  </div>
                </div>

                <button
                  id="remove-selected-file-button"
                  onClick={removeSelectedFile}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-700 transition-colors"
                  title="Remove attachment"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Chat Input Bar & Live Voice Recording Mode */}
            {isRecordingVoice ? (
              /* ACTIVE VOICE RECORDING BAR */
              <div className="p-3 sm:p-4 border-t border-zinc-200/80 dark:border-zinc-800 bg-rose-50/70 dark:bg-rose-950/30 flex items-center justify-between gap-3 animate-in fade-in duration-150">
                <div className="flex items-center gap-2.5">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500"></span>
                  </span>
                  <span className="text-xs font-bold text-rose-700 dark:text-rose-400">
                    Recording Voice Note...
                  </span>
                  <span className="font-mono text-xs font-bold px-2 py-0.5 rounded-md bg-rose-200/80 dark:bg-rose-900/60 text-rose-900 dark:text-rose-200">
                    {formatSeconds(recordingDuration)}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    id="cancel-voice-recording-button"
                    type="button"
                    onClick={handleCancelVoiceRecording}
                    className="p-2 rounded-xl text-zinc-500 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-100/60 dark:hover:bg-red-950/60 transition-colors"
                    title="Cancel recording"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>

                  <button
                    id="send-voice-recording-button"
                    type="button"
                    onClick={handleSendVoiceRecording}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-sm active:scale-95 transition-all"
                    title="Send voice note"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Send Audio</span>
                  </button>
                </div>
              </div>
            ) : (
              /* STANDARD MESSAGE INPUT BAR */
              <form
                onSubmit={handleSendMessage}
                className="p-3 sm:p-4 border-t border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex items-center gap-2 transition-colors"
              >
                {/* Voice Note Recording Button */}
                <button
                  id="record-voice-button"
                  type="button"
                  onClick={handleStartVoiceRecording}
                  className="p-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:border-rose-300 dark:hover:border-rose-800 transition-colors shrink-0"
                  title="Record a voice note"
                >
                  <Mic className="w-4 h-4" />
                </button>

                {/* Attachment Picker Button */}
                <button
                  id="attach-file-button"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
                  title="Attach audio, image, video, or document (up to 15MB)"
                >
                  <Paperclip className="w-4 h-4" />
                </button>

                {/* Screen Share Action Button in Input */}
                <button
                  id="input-screen-share-button"
                  type="button"
                  onClick={isMePresenting ? handleStopScreenShare : handleStartScreenShare}
                  disabled={isScreenShareActive && !isMePresenting}
                  className={`p-2.5 rounded-xl border transition-colors shrink-0 ${
                    isMePresenting
                      ? 'border-red-300 text-red-600 dark:border-red-800 dark:text-red-400 bg-red-50 dark:bg-red-950/40 hover:bg-red-100'
                      : isScreenShareActive
                      ? 'border-zinc-200 dark:border-zinc-700 text-zinc-400 dark:text-zinc-600 bg-zinc-50 dark:bg-zinc-800 cursor-not-allowed'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                  title={
                    isMePresenting
                      ? 'Stop sharing screen'
                      : isScreenShareActive
                      ? `${roomData?.screenShare?.presenterRole} is currently sharing`
                      : 'Share screen'
                  }
                >
                  <Monitor className="w-4 h-4" />
                </button>

                <input
                  ref={inputRef}
                  id="message-input"
                  type="text"
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  placeholder={selectedFile ? 'Add a caption...' : `Chat as ${myRole}...`}
                  maxLength={2000}
                  className="flex-1 px-4 py-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-800/70 text-zinc-900 dark:text-white text-sm focus:border-zinc-900 dark:focus:border-indigo-500 focus:bg-white dark:focus:bg-zinc-800 focus:ring-1 focus:ring-zinc-900/10 dark:focus:ring-indigo-500/20 outline-none transition-all placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
                />

                <button
                  id="send-message-button"
                  type="submit"
                  disabled={(!inputMessage.trim() && !selectedFile) || uploadProgress !== null}
                  className="p-3 rounded-xl bg-zinc-900 dark:bg-indigo-600 hover:bg-zinc-800 dark:hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-all shadow-2xs active:scale-95 shrink-0"
                  title="Send message"
                >
                  {uploadProgress !== null ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </form>
            )}
          </div>
        )}

        {/* ======================================================== */}
        {/* VIEW 4: ROOM CLOSED                                      */}
        {/* ======================================================== */}
        {viewState === 'closed' && (
          <div className="w-full max-w-md mx-auto my-auto py-8 animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/90 dark:border-zinc-800 shadow-xl p-6 sm:p-8 text-center transition-colors">
              <div className="w-14 h-14 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 mx-auto flex items-center justify-center mb-4">
                <Lock className="w-7 h-7" />
              </div>

              <h2 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight mb-2">
                Room Wiped &amp; Closed
              </h2>
              <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 mb-6 leading-relaxed">
                All participants left or closed their tabs. All messages, voice notes, media, and streams have been permanently erased.
              </p>

              <button
                id="back-to-home-button"
                onClick={() => {
                  setViewState('entry');
                  setRoomCodeInput('');
                  setActiveRoomId('');
                }}
                className="w-full py-3.5 px-4 rounded-2xl font-bold text-sm text-white bg-zinc-900 dark:bg-indigo-600 hover:bg-zinc-800 dark:hover:bg-indigo-700 transition-all shadow-md"
              >
                Join or Create Another Room
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ======================================================== */}
      {/* MODAL: EDIT PARTICIPANT NAME                             */}
      {/* ======================================================== */}
      {showEditNameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="bg-white dark:bg-zinc-900 rounded-3xl max-w-sm w-full p-6 border border-zinc-200 dark:border-zinc-750 shadow-2xl transition-colors">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-zinc-900 dark:text-white">
                Edit Display Name
              </h3>
              <button
                onClick={() => setShowEditNameModal(false)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
              Choose any name or pick from authentic South Indian female names:
            </p>

            <form onSubmit={handleSaveName} className="space-y-4">
              <div className="relative">
                <input
                  type="text"
                  value={editedNameInput}
                  onChange={(e) => setEditedNameInput(e.target.value)}
                  placeholder="Enter your name..."
                  autoFocus
                  maxLength={32}
                  className="w-full px-4 py-3 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-white text-sm focus:border-indigo-500 outline-none pr-10"
                />
                <button
                  type="button"
                  onClick={handleShuffleName}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                  title="Shuffle South Indian Name"
                >
                  <Shuffle className="w-4 h-4" />
                </button>
              </div>

              {/* Quick Suggestion Chips */}
              <div>
                <span className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider block mb-1.5">
                  Popular Suggestions:
                </span>
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                  {['Ananya', 'Keerthy', 'Samantha', 'Divya', 'Meenakshi', 'Priya', 'Trisha', 'Nayanthara', 'Sai Pallavi', 'Kavya'].map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setEditedNameInput(name)}
                      className={`text-[11px] px-2.5 py-1 rounded-lg border transition-all ${
                        editedNameInput === name
                          ? 'bg-indigo-600 text-white border-indigo-600 font-bold'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setShowEditNameModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200/80 dark:hover:bg-zinc-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!editedNameInput.trim()}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50"
                >
                  Save Name
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Leaving Room */}
      {showLeaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="bg-white dark:bg-zinc-900 rounded-3xl max-w-sm w-full p-6 border border-zinc-200 dark:border-zinc-750 shadow-2xl transition-colors">
            <h3 className="text-base font-bold text-zinc-900 dark:text-white mb-2">
              Leave Chat Room?
            </h3>
            <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 mb-5 leading-relaxed">
              Are you sure you want to exit? If you are the last participant, this room and all its messages will be wiped immediately.
            </p>
            <div className="flex items-center justify-end gap-2.5">
              <button
                id="cancel-leave-modal-button"
                onClick={() => setShowLeaveModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-bold text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200/80 dark:hover:bg-zinc-700 transition-colors"
              >
                Stay
              </button>
              <button
                id="confirm-leave-modal-button"
                onClick={handleLeaveRoom}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-red-600 hover:bg-red-700 transition-colors shadow-sm"
              >
                Leave Room
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Subtle Footer */}
      <footer className="w-full py-3 text-center text-[11px] text-zinc-400 dark:text-zinc-600">
        Anonymous &bull; Voice Notes &bull; South Indian Names &bull; Dark Theme
      </footer>
    </div>
  );
}
