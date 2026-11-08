import React, { useEffect, useRef, useState } from 'react';
import {
  collection,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  Monitor,
  Maximize2,
  Minimize2,
  Volume2,
  VolumeX,
  StopCircle,
  Loader2,
  Eye,
  AlertCircle,
  PictureInPicture,
  MousePointer2,
  Hand,
  Check,
  X,
  ShieldAlert,
  Sparkles,
  Info,
} from 'lucide-react';
import { db } from '../firebase.ts';
import {
  RTC_CONFIG,
  sendSignal,
  requestRemoteControl,
  respondToRemoteControl,
  releaseRemoteControl,
} from '../screenShareService.ts';
import {
  RemotePointerEvent,
  ScreenShareState,
  WebRTCSignal,
} from '../types.ts';

interface ScreenShareStageProps {
  roomId: string;
  screenShare: ScreenShareState;
  myToken: string;
  myRole: string;
  localStream: MediaStream | null;
  onStopShare: () => void;
}

interface ActiveClickRipple {
  id: string;
  x: number;
  y: number;
  role: string;
}

export const ScreenShareStage: React.FC<ScreenShareStageProps> = ({
  roomId,
  screenShare,
  myToken,
  myRole,
  localStream,
  onStopShare,
}) => {
  const isPresenter = screenShare.presenterToken === myToken;
  const isController = screenShare.remoteControl?.controllerToken === myToken;
  const hasPendingRequestFromMe =
    screenShare.pendingControlRequest?.requesterToken === myToken;

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(isPresenter);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'failed'>(
    isPresenter ? 'connected' : 'connecting'
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showSandboxInfo, setShowSandboxInfo] = useState<boolean>(false);

  // Live remote pointer coordinates (0-100%)
  const [remotePointer, setRemotePointer] = useState<RemotePointerEvent | null>(null);
  const [clickRipples, setClickRipples] = useState<ActiveClickRipple[]>([]);

  // WebRTC data channels and peer connections
  const presenterPeerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const presenterDataChannels = useRef<Map<string, RTCDataChannel>>(new Map());
  const viewerPeerConnection = useRef<RTCPeerConnection | null>(null);
  const viewerDataChannel = useRef<RTCDataChannel | null>(null);

  // Throttle timer for pointer moves
  const lastMoveSentRef = useRef<number>(0);

  // 1. PRESENTERS: Attach local stream to video preview
  useEffect(() => {
    if (isPresenter && localStream && videoRef.current) {
      videoRef.current.srcObject = localStream;
      videoRef.current.play().catch((e) => console.warn('Local preview autoplay blocked:', e));
    }
  }, [isPresenter, localStream]);

  // Handle incoming remote pointer events
  const handleRemotePointerEvent = (evt: RemotePointerEvent) => {
    setRemotePointer(evt);

    if (evt.type === 'click') {
      const newRipple: ActiveClickRipple = {
        id: `${Date.now()}_${Math.random()}`,
        x: evt.x,
        y: evt.y,
        role: evt.role,
      };
      setClickRipples((prev) => [...prev, newRipple]);
      setTimeout(() => {
        setClickRipples((prev) => prev.filter((r) => r.id !== newRipple.id));
      }, 1200);
    }
  };

  // 2. PRESENTERS: WebRTC signaling & data channels
  useEffect(() => {
    if (!isPresenter || !localStream) return;

    const signalsRef = collection(db, 'rooms', roomId, 'signals');
    const q = query(signalsRef, where('targetToken', 'in', [myToken, 'all']));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== 'added') return;
        const sig = change.doc.data() as WebRTCSignal;
        if (sig.senderToken === myToken) return;

        // Fallback Firestore pointer events
        if (sig.type === 'pointer_event' && sig.payload) {
          try {
            const evt = JSON.parse(sig.payload) as RemotePointerEvent;
            handleRemotePointerEvent(evt);
          } catch (e) {}
        }

        // Viewer announces readiness
        if (sig.type === 'viewer_ready') {
          const viewerToken = sig.senderToken;

          if (presenterPeerConnections.current.has(viewerToken)) {
            presenterPeerConnections.current.get(viewerToken)?.close();
            presenterPeerConnections.current.delete(viewerToken);
          }

          const pc = new RTCPeerConnection(RTC_CONFIG);
          presenterPeerConnections.current.set(viewerToken, pc);

          // Create DataChannel for high-frequency low-latency remote pointer control
          try {
            const dc = pc.createDataChannel('pointer-control');
            presenterDataChannels.current.set(viewerToken, dc);
            dc.onmessage = (event) => {
              try {
                const evt = JSON.parse(event.data) as RemotePointerEvent;
                handleRemotePointerEvent(evt);
              } catch (e) {}
            };
          } catch (err) {
            console.warn('DataChannel creation fallback to Firestore:', err);
          }

          // Add presenter's stream tracks
          localStream.getTracks().forEach((track) => {
            pc.addTrack(track, localStream);
          });

          pc.onicecandidate = (event) => {
            if (event.candidate) {
              sendSignal(roomId, {
                type: 'candidate',
                senderToken: myToken,
                targetToken: viewerToken,
                payload: JSON.stringify(event.candidate),
              }).catch(console.error);
            }
          };

          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            await sendSignal(roomId, {
              type: 'offer',
              senderToken: myToken,
              targetToken: viewerToken,
              payload: JSON.stringify(offer),
            });
          } catch (err) {
            console.error('Error creating offer for viewer:', err);
          }
        }

        if (sig.type === 'answer') {
          const pc = presenterPeerConnections.current.get(sig.senderToken);
          if (pc && pc.signalingState !== 'closed') {
            try {
              const remoteDesc = new RTCSessionDescription(JSON.parse(sig.payload));
              await pc.setRemoteDescription(remoteDesc);
            } catch (err) {
              console.error('Error setting remote description on presenter:', err);
            }
          }
        }

        if (sig.type === 'candidate') {
          const pc = presenterPeerConnections.current.get(sig.senderToken);
          if (pc && pc.signalingState !== 'closed') {
            try {
              const candidate = new RTCIceCandidate(JSON.parse(sig.payload));
              await pc.addIceCandidate(candidate);
            } catch (err) {
              console.error('Error adding ICE candidate on presenter:', err);
            }
          }
        }
      });
    });

    return () => {
      unsubscribe();
      presenterPeerConnections.current.forEach((pc) => pc.close());
      presenterPeerConnections.current.clear();
      presenterDataChannels.current.clear();
    };
  }, [isPresenter, localStream, myToken, roomId]);

  // 3. VIEWERS: WebRTC stream & data channel
  useEffect(() => {
    if (isPresenter) return;

    setConnectionStatus('connecting');
    setErrorMessage(null);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    viewerPeerConnection.current = pc;

    // Receive data channel from presenter
    pc.ondatachannel = (e) => {
      viewerDataChannel.current = e.channel;
      e.channel.onmessage = (event) => {
        try {
          const evt = JSON.parse(event.data) as RemotePointerEvent;
          handleRemotePointerEvent(evt);
        } catch (err) {}
      };
    };

    pc.ontrack = (event) => {
      if (videoRef.current && event.streams[0]) {
        videoRef.current.srcObject = event.streams[0];
        videoRef.current
          .play()
          .then(() => {
            setConnectionStatus('connected');
          })
          .catch((err) => {
            console.warn('Viewer autoplay muted fallback:', err);
            setIsMuted(true);
            setConnectionStatus('connected');
          });
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(roomId, {
          type: 'candidate',
          senderToken: myToken,
          targetToken: screenShare.presenterToken,
          payload: JSON.stringify(event.candidate),
        }).catch(console.error);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setConnectionStatus('connected');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setConnectionStatus('failed');
      }
    };

    sendSignal(roomId, {
      type: 'viewer_ready',
      senderToken: myToken,
      targetToken: screenShare.presenterToken,
    }).catch(console.error);

    const signalsRef = collection(db, 'rooms', roomId, 'signals');
    const q = query(signalsRef, where('targetToken', 'in', [myToken, 'all']));

    const unsubscribe = onSnapshot(signalsRef, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== 'added') return;
        const sig = change.doc.data() as WebRTCSignal;
        if (sig.senderToken === myToken) return;

        if (sig.type === 'pointer_event' && sig.payload) {
          try {
            const evt = JSON.parse(sig.payload) as RemotePointerEvent;
            handleRemotePointerEvent(evt);
          } catch (e) {}
        }

        if (sig.type === 'offer' && sig.targetToken === myToken) {
          try {
            const offerDesc = new RTCSessionDescription(JSON.parse(sig.payload));
            await pc.setRemoteDescription(offerDesc);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            await sendSignal(roomId, {
              type: 'answer',
              senderToken: myToken,
              targetToken: sig.senderToken,
              payload: JSON.stringify(answer),
            });
          } catch (err) {
            console.error('Error handling offer on viewer:', err);
            setErrorMessage('Could not establish screen share stream.');
          }
        }

        if (sig.type === 'candidate' && sig.targetToken === myToken) {
          try {
            const candidate = new RTCIceCandidate(JSON.parse(sig.payload));
            await pc.addIceCandidate(candidate);
          } catch (err) {
            console.error('Error handling candidate on viewer:', err);
          }
        }
      });
    });

    return () => {
      unsubscribe();
      pc.close();
      viewerPeerConnection.current = null;
      viewerDataChannel.current = null;
    };
  }, [isPresenter, myToken, roomId, screenShare.presenterToken]);

  // Fullscreen change listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen toggle failed:', err);
    }
  };

  const togglePictureInPicture = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (err) {
      console.warn('Picture in picture failed:', err);
    }
  };

  // Transmit interactive pointer event to presenter & peers
  const transmitPointerEvent = (xPct: number, yPct: number, type: 'move' | 'click' | 'laser') => {
    const evt: RemotePointerEvent = {
      x: xPct,
      y: yPct,
      type,
      role: myRole,
      timestamp: Date.now(),
    };

    // Update locally immediately
    handleRemotePointerEvent(evt);

    // 1. Try sending over WebRTC DataChannel for instant (<20ms) transmission
    if (viewerDataChannel.current && viewerDataChannel.current.readyState === 'open') {
      try {
        viewerDataChannel.current.send(JSON.stringify(evt));
        return;
      } catch (e) {}
    }

    // 2. Fallback via Firestore signal
    sendSignal(roomId, {
      type: 'pointer_event',
      senderToken: myToken,
      targetToken: 'all',
      payload: JSON.stringify(evt),
    }).catch(console.error);
  };

  // Controller moves mouse over video stage
  const handleVideoMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isController) return;

    const now = Date.now();
    // Throttle moves to 30fps
    if (now - lastMoveSentRef.current < 32) return;
    lastMoveSentRef.current = now;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));

    transmitPointerEvent(x, y, 'move');
  };

  // Controller clicks on video stage
  const handleVideoClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isController) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));

    transmitPointerEvent(x, y, 'click');
  };

  return (
    <div
      ref={containerRef}
      className={`border-b border-zinc-200 bg-zinc-950 text-white transition-all overflow-hidden relative ${
        isMinimized
          ? 'h-12'
          : isFullscreen
          ? 'h-screen w-screen p-4 flex flex-col justify-center'
          : 'max-h-[520px]'
      }`}
    >
      {/* Top Header Bar of Screen Share */}
      <div className="px-4 py-2 bg-zinc-900/90 backdrop-blur-md flex items-center justify-between text-xs z-20 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <span className="flex h-2.5 w-2.5 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>

          <span className="font-semibold tracking-wide flex items-center gap-1.5">
            <Monitor className="w-3.5 h-3.5 text-zinc-400" />
            {isPresenter ? (
              <span className="text-emerald-400">You are sharing your screen</span>
            ) : (
              <span>
                <strong className="text-white font-bold">{screenShare.presenterRole}</strong>'s Screen
              </span>
            )}
          </span>

          {/* Active Controller Pill */}
          {screenShare.remoteControl && (
            <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[11px] font-semibold">
              <Hand className="w-3 h-3" />
              <span>
                {screenShare.remoteControl.controllerToken === myToken
                  ? 'You are in Control'
                  : `${screenShare.remoteControl.controllerRole} has Control`}
              </span>
            </span>
          )}

          {!isPresenter && connectionStatus === 'connecting' && (
            <span className="text-zinc-400 flex items-center gap-1 text-[11px]">
              <Loader2 className="w-3 h-3 animate-spin" /> Connecting...
            </span>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5">
          {/* Info on browser sandbox */}
          <button
            onClick={() => setShowSandboxInfo(true)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Remote Control Info"
          >
            <Info className="w-4 h-4" />
          </button>

          {/* Viewer: Request Control or Release Control */}
          {!isPresenter && (
            <>
              {isController ? (
                <button
                  onClick={() => releaseRemoteControl(roomId)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-zinc-950 transition-colors active:scale-95 shadow-sm"
                  title="Release remote control"
                >
                  <Hand className="w-3 h-3" />
                  <span>Release Control</span>
                </button>
              ) : hasPendingRequestFromMe ? (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-white/10 text-zinc-300 border border-white/10 animate-pulse">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Requested...</span>
                </span>
              ) : (
                <button
                  onClick={() => requestRemoteControl(roomId, myToken, myRole)}
                  disabled={!!screenShare.remoteControl}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-white/15 hover:bg-white/25 disabled:opacity-40 disabled:cursor-not-allowed text-white border border-white/20 transition-colors active:scale-95"
                  title="Request interactive remote control to guide presenter"
                >
                  <Hand className="w-3.5 h-3.5 text-amber-400" />
                  <span>Take Control</span>
                </button>
              )}
            </>
          )}

          {/* Presenter: Revoke Control button */}
          {isPresenter && screenShare.remoteControl && (
            <button
              onClick={() => releaseRemoteControl(roomId)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-zinc-950 transition-colors active:scale-95 shadow-sm"
              title="Revoke remote control from viewer"
            >
              <X className="w-3 h-3" />
              <span>Revoke Control</span>
            </button>
          )}

          {/* Audio toggle (viewers only) */}
          {!isPresenter && (
            <button
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.muted = !videoRef.current.muted;
                  setIsMuted(videoRef.current.muted);
                }
              }}
              className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX className="w-4 h-4 text-zinc-400" /> : <Volume2 className="w-4 h-4 text-emerald-400" />}
            </button>
          )}

          {/* Picture in picture */}
          <button
            onClick={togglePictureInPicture}
            className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
            title="Picture-in-Picture"
          >
            <PictureInPicture className="w-4 h-4" />
          </button>

          {/* Fullscreen toggle */}
          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          >
            <Maximize2 className="w-4 h-4" />
          </button>

          {/* Minimize / Expand */}
          <button
            onClick={() => setIsMinimized(!isMinimized)}
            className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
            title={isMinimized ? 'Expand screen view' : 'Minimize screen view'}
          >
            {isMinimized ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
          </button>

          {/* Presenter: Stop Sharing button */}
          {isPresenter && (
            <button
              onClick={onStopShare}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors ml-1 shadow-sm active:scale-95"
            >
              <StopCircle className="w-3.5 h-3.5" />
              <span>Stop Sharing</span>
            </button>
          )}
        </div>
      </div>

      {/* PRESENTER INCOMING CONTROL REQUEST BANNER */}
      {isPresenter && screenShare.pendingControlRequest && (
        <div className="bg-amber-500 text-zinc-950 px-4 py-2 flex items-center justify-between text-xs z-30 animate-in slide-in-from-top duration-200">
          <div className="flex items-center gap-2 font-semibold">
            <Hand className="w-4 h-4 text-zinc-950" />
            <span>
              <strong>{screenShare.pendingControlRequest.requesterRole}</strong> requested remote control to guide on your screen.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                respondToRemoteControl(
                  roomId,
                  true,
                  screenShare.pendingControlRequest?.requesterToken,
                  screenShare.pendingControlRequest?.requesterRole
                )
              }
              className="px-3 py-1 rounded-md bg-zinc-950 hover:bg-zinc-800 text-white font-bold text-xs flex items-center gap-1 shadow-sm active:scale-95 transition-all"
            >
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span>Allow Control</span>
            </button>
            <button
              onClick={() => respondToRemoteControl(roomId, false)}
              className="px-2.5 py-1 rounded-md bg-black/15 hover:bg-black/25 text-zinc-900 font-semibold text-xs transition-colors"
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {/* CONTROLLER ACTIVE GUIDANCE NOTICE */}
      {isController && !isMinimized && (
        <div className="bg-amber-400/90 text-zinc-950 px-4 py-1.5 text-xs flex items-center justify-between font-medium z-20">
          <span className="flex items-center gap-1.5">
            <MousePointer2 className="w-3.5 h-3.5" />
            <span>You have remote control. Click anywhere on the screen below to guide the presenter.</span>
          </span>
          <button
            onClick={() => releaseRemoteControl(roomId)}
            className="underline font-bold text-[11px] hover:text-zinc-800 ml-2"
          >
            Release Control
          </button>
        </div>
      )}

      {/* Main Video Stage with Collaborative Remote Pointer Overlay */}
      {!isMinimized && (
        <div
          onMouseMove={handleVideoMouseMove}
          onClick={handleVideoClick}
          className={`relative flex-1 bg-black flex items-center justify-center min-h-[240px] max-h-[420px] overflow-hidden ${
            isController ? 'cursor-crosshair' : 'cursor-default'
          }`}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={isPresenter || isMuted}
            className="w-full h-full max-h-[420px] object-contain pointer-events-none select-none"
          />

          {/* LIVE REMOTE POINTER BADGE (Shown to Presenter & Viewers) */}
          {remotePointer && (
            <div
              className="absolute pointer-events-none transition-all duration-75 ease-out z-20"
              style={{
                left: `${remotePointer.x}%`,
                top: `${remotePointer.y}%`,
                transform: 'translate(-6px, -6px)',
              }}
            >
              {/* Laser / Pointer dot */}
              <div className="relative">
                <div className="w-4 h-4 rounded-full bg-amber-400 border-2 border-white shadow-lg flex items-center justify-center animate-pulse">
                  <div className="w-1.5 h-1.5 rounded-full bg-zinc-950"></div>
                </div>

                {/* Controller name tag */}
                <div className="absolute left-4 top-0 bg-zinc-900/90 backdrop-blur-xs text-white border border-amber-400/40 text-[10px] font-bold px-1.5 py-0.5 rounded shadow-md whitespace-nowrap">
                  {remotePointer.role}
                </div>
              </div>
            </div>
          )}

          {/* CLICK RIPPLE ANIMATIONS (When Controller taps/clicks on screen) */}
          {clickRipples.map((ripple) => (
            <div
              key={ripple.id}
              className="absolute pointer-events-none z-10"
              style={{
                left: `${ripple.x}%`,
                top: `${ripple.y}%`,
                transform: 'translate(-50%, -50%)',
              }}
            >
              <div className="w-14 h-14 rounded-full border-2 border-amber-400 bg-amber-400/30 animate-ping"></div>
              <div className="w-8 h-8 rounded-full border border-white bg-amber-300/40 absolute inset-0 m-auto animate-pulse"></div>
            </div>
          ))}

          {/* Connection failure overlay */}
          {!isPresenter && connectionStatus === 'failed' && (
            <div className="absolute inset-0 bg-zinc-950/90 flex flex-col items-center justify-center p-4 text-center z-20">
              <AlertCircle className="w-8 h-8 text-amber-500 mb-2" />
              <p className="text-sm font-semibold text-white">Stream connection interrupted</p>
              <p className="text-xs text-zinc-400 mt-1 max-w-sm">
                Could not connect to presenter peer stream. Please check network or ask presenter to re-share.
              </p>
            </div>
          )}

          {/* Presenter indicator watermark */}
          {isPresenter && (
            <div className="absolute bottom-3 left-3 px-2.5 py-1 rounded-lg bg-black/70 backdrop-blur-xs text-[11px] text-zinc-300 border border-white/10 flex items-center gap-1.5 pointer-events-none z-10">
              <Eye className="w-3.5 h-3.5 text-emerald-400" />
              <span>Live stream active</span>
            </div>
          )}
        </div>
      )}

      {/* REMOTE CONTROL & BROWSER SECURITY EXPLANATION MODAL */}
      {showSandboxInfo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs animate-in fade-in duration-150"
          onClick={() => setShowSandboxInfo(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-2xl max-w-md w-full p-6 text-white shadow-2xl relative"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-amber-400" />
                <h3 className="text-base font-bold text-white">How Remote Control Works</h3>
              </div>
              <button
                onClick={() => setShowSandboxInfo(false)}
                className="text-zinc-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-xs text-zinc-300 space-y-3 leading-relaxed">
              <p>
                <strong>Collaborative Laser &amp; Pointer Control:</strong> When control is requested and granted, the controller can click and point anywhere on the shared screen in real time. Remote cursors, laser trails, and click ripple animations appear directly on the presenter's screen so you can guide them step-by-step.
              </p>
              <div className="p-3 bg-zinc-800/80 rounded-xl border border-zinc-700/80 text-[11px] text-zinc-300">
                <span className="font-semibold text-amber-400 block mb-1">
                  Why not direct OS-level mouse hardware injection?
                </span>
                Standard web browsers (Chrome, Safari, Edge, Android, iOS) enforce a strict security sandbox that intentionally prohibits websites from injecting raw OS-level hardware mouse clicks or keystrokes into other apps or native mobile screens. Collaborative pointer &amp; click overlay provides safe, interactive remote guidance.
              </div>
            </div>

            <button
              onClick={() => setShowSandboxInfo(false)}
              className="mt-5 w-full py-2.5 rounded-xl bg-zinc-100 hover:bg-white text-zinc-900 font-semibold text-xs transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
