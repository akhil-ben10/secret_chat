import React, { useState, useEffect, useRef } from 'react';
import {
  FileText,
  FileArchive,
  FileCode,
  File,
  Download,
  Maximize2,
  X,
  Loader2,
  Play,
  Pause,
  Mic,
  Volume2,
} from 'lucide-react';
import { FileAttachment } from '../types.ts';
import { fetchMessageAttachment } from '../roomService.ts';

interface AttachmentViewProps {
  attachment: FileAttachment;
  roomId: string;
  messageId: string;
  isMyMessage: boolean;
}

export const AttachmentView: React.FC<AttachmentViewProps> = ({
  attachment,
  roomId,
  messageId,
  isMyMessage,
}) => {
  const [dataUrl, setDataUrl] = useState<string | null>(attachment.dataUrl || null);
  const [isLoading, setIsLoading] = useState<boolean>(!attachment.dataUrl && !!attachment.hasChunks);
  const [error, setError] = useState<string | null>(null);
  const [showFullImage, setShowFullImage] = useState<boolean>(false);

  // Custom Audio Player State
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);

  useEffect(() => {
    if (attachment.dataUrl) {
      setDataUrl(attachment.dataUrl);
      return;
    }

    if (attachment.hasChunks) {
      let isMounted = true;
      setIsLoading(true);
      setError(null);

      fetchMessageAttachment(roomId, messageId, attachment.chunkCount || 1)
        .then((url) => {
          if (isMounted) {
            setDataUrl(url);
            setIsLoading(false);
          }
        })
        .catch(() => {
          if (isMounted) {
            setError('Could not load file');
            setIsLoading(false);
          }
        });

      return () => {
        isMounted = false;
      };
    }
  }, [attachment, roomId, messageId]);

  const formatFileSize = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatAudioTime = (seconds: number) => {
    if (isNaN(seconds) || seconds <= 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const isImage = attachment.type.startsWith('image/');
  const isVideo = attachment.type.startsWith('video/');
  const isAudio = attachment.type.startsWith('audio/');
  const isVoiceNote = isAudio && (attachment.name?.toLowerCase().includes('voice-note') || attachment.name?.toLowerCase().includes('audio'));

  const getFileIcon = () => {
    if (attachment.type.includes('pdf')) return <FileText className="w-5 h-5 text-red-500" />;
    if (attachment.type.includes('zip') || attachment.type.includes('tar') || attachment.type.includes('rar')) {
      return <FileArchive className="w-5 h-5 text-amber-500" />;
    }
    if (attachment.type.includes('json') || attachment.type.includes('javascript') || attachment.type.includes('html')) {
      return <FileCode className="w-5 h-5 text-blue-500" />;
    }
    return <File className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />;
  };

  const handleDownload = () => {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = attachment.name || 'file';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const toggleAudioPlay = () => {
    if (!audioRef.current) return;
    if (isPlayingAudio) {
      audioRef.current.pause();
      setIsPlayingAudio(false);
    } else {
      audioRef.current.play().then(() => {
        setIsPlayingAudio(true);
      }).catch(console.warn);
    }
  };

  const handleSpeedChange = () => {
    if (!audioRef.current) return;
    const speeds = [1, 1.5, 2];
    const nextIndex = (speeds.indexOf(playbackSpeed) + 1) % speeds.length;
    const newSpeed = speeds[nextIndex];
    setPlaybackSpeed(newSpeed);
    audioRef.current.playbackRate = newSpeed;
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!audioRef.current) return;
    const time = parseFloat(e.target.value);
    audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-xl bg-black/5 dark:bg-white/5 text-xs text-zinc-600 dark:text-zinc-400 my-1">
        <Loader2 className="w-4 h-4 animate-spin text-zinc-500 dark:text-zinc-400" />
        <span>Loading {attachment.name} ({formatFileSize(attachment.size)})...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 p-2.5 rounded-xl bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 text-xs my-1 border border-red-200 dark:border-red-900/50">
        <span>{error}</span>
      </div>
    );
  }

  // 1. IMAGE DISPLAY
  if (isImage && dataUrl) {
    return (
      <div className="my-1.5 space-y-1.5">
        <div className="relative group rounded-xl overflow-hidden bg-black/5 dark:bg-black/30 max-w-sm max-h-80 border border-black/10 dark:border-white/10">
          <img
            src={dataUrl}
            alt={attachment.name}
            className="w-full h-auto max-h-80 object-cover cursor-pointer hover:opacity-95 transition-opacity"
            onClick={() => setShowFullImage(true)}
            loading="lazy"
          />
          <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5 bg-black/70 backdrop-blur-xs p-1 rounded-lg">
            <button
              onClick={() => setShowFullImage(true)}
              className="p-1 text-white hover:text-zinc-200 transition-colors"
              title="Expand image"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleDownload}
              className="p-1 text-white hover:text-zinc-200 transition-colors"
              title="Download image"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Fullscreen modal */}
        {showFullImage && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-in fade-in duration-150"
            onClick={() => setShowFullImage(false)}
          >
            <div className="relative max-w-4xl max-h-[90vh] flex flex-col items-center">
              <button
                onClick={() => setShowFullImage(false)}
                className="absolute -top-10 right-0 text-white/80 hover:text-white p-1.5 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
              <img
                src={dataUrl}
                alt={attachment.name}
                className="max-w-full max-h-[82vh] rounded-xl object-contain shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              />
              <div className="mt-3 flex items-center gap-3 text-white text-xs bg-zinc-900/80 px-4 py-2 rounded-xl border border-white/10">
                <span className="font-medium">{attachment.name}</span>
                <span>&bull;</span>
                <span className="text-zinc-400">{formatFileSize(attachment.size)}</span>
                <button
                  onClick={handleDownload}
                  className="ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/20 hover:bg-white/30 text-white font-medium transition-colors"
                >
                  <Download className="w-3.5 h-3.5" /> Download
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // 2. VIDEO DISPLAY
  if (isVideo && dataUrl) {
    return (
      <div className="my-1.5 max-w-sm rounded-xl overflow-hidden border border-black/10 dark:border-white/10 bg-black/5 dark:bg-black/40 space-y-1">
        <video
          src={dataUrl}
          controls
          playsInline
          className="w-full max-h-72 rounded-t-xl bg-black"
        />
        <div className="px-2.5 py-1.5 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
          <span className="truncate max-w-[200px]">{attachment.name}</span>
          <button
            onClick={handleDownload}
            className="hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors p-1 flex items-center gap-1 font-medium"
            title="Download video"
          >
            <Download className="w-3 h-3" />
            <span>{formatFileSize(attachment.size)}</span>
          </button>
        </div>
      </div>
    );
  }

  // 3. AUDIO / VOICE NOTE DISPLAY WITH RICH PLAYER CONTROLS
  if (isAudio && dataUrl) {
    return (
      <div
        className={`my-1.5 p-3 rounded-2xl border transition-all max-w-sm ${
          isMyMessage
            ? 'bg-white/15 border-white/25 text-white'
            : 'bg-zinc-100/90 dark:bg-zinc-800/90 border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100'
        }`}
      >
        <audio
          ref={audioRef}
          src={dataUrl}
          onTimeUpdate={() => {
            if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
          }}
          onLoadedMetadata={() => {
            if (audioRef.current) setDuration(audioRef.current.duration);
          }}
          onEnded={() => {
            setIsPlayingAudio(false);
            setCurrentTime(0);
          }}
          className="hidden"
        />

        {/* Voice Note Header */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 text-xs font-bold truncate">
            {isVoiceNote ? (
              <>
                <Mic className="w-3.5 h-3.5 text-rose-500 animate-pulse" />
                <span>Voice Note</span>
              </>
            ) : (
              <>
                <Volume2 className="w-3.5 h-3.5 text-indigo-400" />
                <span className="truncate max-w-[170px]">{attachment.name}</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Playback speed toggle */}
            <button
              onClick={handleSpeedChange}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold transition-colors ${
                isMyMessage
                  ? 'bg-white/20 hover:bg-white/30 text-white'
                  : 'bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-650 text-zinc-700 dark:text-zinc-300'
              }`}
              title="Playback speed"
            >
              {playbackSpeed}x
            </button>

            {/* Download audio */}
            <button
              onClick={handleDownload}
              className={`p-1 rounded transition-colors ${
                isMyMessage ? 'hover:bg-white/20 text-white' : 'hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500 dark:text-zinc-400'
              }`}
              title="Download audio"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Waveform / Scrubber Bar & Controls */}
        <div className="flex items-center gap-3">
          {/* Play/Pause Button */}
          <button
            onClick={toggleAudioPlay}
            className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 shadow-sm transition-transform active:scale-95 ${
              isMyMessage
                ? 'bg-white text-zinc-900 hover:bg-zinc-100'
                : 'bg-zinc-900 dark:bg-indigo-600 text-white hover:bg-zinc-800 dark:hover:bg-indigo-500'
            }`}
          >
            {isPlayingAudio ? (
              <Pause className="w-4 h-4 fill-current" />
            ) : (
              <Play className="w-4 h-4 fill-current ml-0.5" />
            )}
          </button>

          {/* Progress Slider */}
          <div className="flex-1 min-w-0">
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              className="w-full h-1.5 bg-black/15 dark:bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <div
              className={`flex justify-between text-[10px] font-mono mt-1 ${
                isMyMessage ? 'text-white/80' : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              <span>{formatAudioTime(currentTime)}</span>
              <span>{formatAudioTime(duration || 0)}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 4. ARBITRARY FILE CARD
  return (
    <div
      className={`my-1.5 flex items-center gap-3 p-3 rounded-xl border transition-all ${
        isMyMessage
          ? 'bg-white/15 border-white/20 text-white'
          : 'bg-zinc-50 dark:bg-zinc-800/80 border-zinc-200/80 dark:border-zinc-700/80 text-zinc-900 dark:text-zinc-100 hover:bg-zinc-100/80 dark:hover:bg-zinc-750/80'
      }`}
    >
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
          isMyMessage
            ? 'bg-white/20'
            : 'bg-white dark:bg-zinc-700 shadow-2xs border border-black/5 dark:border-white/10'
        }`}
      >
        {getFileIcon()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold truncate leading-tight">
          {attachment.name}
        </div>
        <div
          className={`text-[10px] mt-0.5 ${
            isMyMessage ? 'text-white/70' : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          {formatFileSize(attachment.size)}
        </div>
      </div>

      <button
        onClick={handleDownload}
        disabled={!dataUrl}
        className={`p-2 rounded-lg transition-colors shrink-0 ${
          isMyMessage
            ? 'hover:bg-white/20 text-white'
            : 'hover:bg-zinc-200/80 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300'
        }`}
        title="Download file"
      >
        <Download className="w-4 h-4" />
      </button>
    </div>
  );
};
