'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [status, setStatus] = useState('Tap the mic to talk');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'checking' | 'bridge' | 'standalone'>('checking');
  const [handsFree, setHandsFree] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([]);
  const handsFreeRef = useRef(false);
  const stoppedRef = useRef(false);
  const emptyListenCountRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);
  const premiumTtsRef = useRef<boolean | null>(null); // null = unknown, true/false = detected
  const startListeningRef = useRef<() => void>(() => {});
  const restoredRef = useRef(false);

  // Permanent Cloudflare tunnel to the PC bridge (runs the full Claude Code session).
  const BRIDGE_URL = process.env.NEXT_PUBLIC_BRIDGE_URL || 'https://voice.dykesmotors.com';

  // Check if the PC bridge is reachable on mount
  useEffect(() => {
    const checkBridge = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          setMode('bridge');
          setStatus('Connected to PC — full Claude');
          // Recover a reply that landed while the app was backgrounded (the
          // in-flight fetch dies on app switch, but the bridge keeps history).
          try {
            const h = await fetch(`${BRIDGE_URL}/history`, { signal: AbortSignal.timeout(3000) });
            if (h.ok) {
              const { exchanges } = await h.json();
              const last = exchanges?.[exchanges.length - 1];
              if (last?.assistant) {
                setMessages((prev) => {
                  const tail = prev[prev.length - 1];
                  if (tail?.role === 'user' && tail.content === last.user) {
                    return [...prev, { role: 'assistant', content: last.assistant }];
                  }
                  return prev;
                });
              }
            }
          } catch {
            // history is best-effort
          }
          return;
        }
      } catch {
        // fall through to standalone
      }
      setMode('standalone');
      setStatus('Tap the mic to talk');
    };
    checkBridge();
  }, [BRIDGE_URL]);

  // Restore hands-free preference
  useEffect(() => {
    const saved = typeof window !== 'undefined' && window.localStorage.getItem('handsFree') === '1';
    setHandsFree(saved);
    handsFreeRef.current = saved;
  }, []);

  // Restore the conversation so app switches / reloads don't wipe the chat
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('voiceMessages');
      if (saved) {
        const parsed = JSON.parse(saved) as Message[];
        if (Array.isArray(parsed) && parsed.length) setMessages(parsed);
      }
    } catch {
      // corrupt store — start fresh
    }
    restoredRef.current = true;
  }, []);

  // Persist the conversation (bounded), but never before restore has run
  useEffect(() => {
    if (!restoredRef.current) return;
    try {
      window.localStorage.setItem('voiceMessages', JSON.stringify(messages.slice(-40)));
    } catch {
      // storage full/unavailable — non-fatal
    }
  }, [messages]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, transcript]);

  // Prime audio + speech on a user gesture so hands-free playback isn't blocked later.
  const unlockAudio = useCallback(() => {
    if (audioUnlockedRef.current) return;
    audioUnlockedRef.current = true;

    // Prime browser speech synthesis
    try {
      const primer = new SpeechSynthesisUtterance('');
      primer.volume = 0;
      window.speechSynthesis?.speak(primer);
    } catch {
      /* ignore */
    }

    // Prime the <audio> element with a silent clip inside the gesture
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.setAttribute('playsinline', 'true');
    }
    const el = audioRef.current;
    el.muted = true;
    el.src =
      'data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////////////////////////////////////////////////////////////8AAAA5TEFNRTMuMTAwAZYAAAAAAAAAABSAJAJAQgAAgAAAAnGMHkkYAAAAAAAAAAAAAAAAAAAAAA=';
    el.play().then(() => { el.pause(); el.muted = false; el.currentTime = 0; }).catch(() => { el.muted = false; });
  }, []);

  const cleanForSpeech = (text: string): string => {
    let clean = text.replace(/```[\s\S]*?```/g, 'code block');
    clean = clean.replace(/`([^`]+)`/g, '$1');
    clean = clean.replace(/\*\*([^*]+)\*\*/g, '$1');
    clean = clean.replace(/\*([^*]+)\*/g, '$1');
    clean = clean.replace(/#{1,6}\s/g, '');
    clean = clean.replace(/https?:\/\/\S+/g, 'link');
    clean = clean.replace(/\n{2,}/g, '. ');
    clean = clean.replace(/\n/g, '. ');
    return clean.trim();
  };

  const stopAllSpeech = useCallback(() => {
    window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, []);

  // Speak using the premium neural voice when available, else the phone's built-in voice.
  const speak = useCallback(
    (text: string): Promise<void> => {
      return new Promise<void>(async (resolve) => {
        stopAllSpeech();
        setIsSpeaking(true);
        setStatus('Speaking...');
        const clean = cleanForSpeech(text);

        const done = () => {
          setIsSpeaking(false);
          resolve();
        };

        // 1) Try premium server voice (unless we've already learned it's unavailable)
        if (premiumTtsRef.current !== false) {
          try {
            const res = await fetch('/api/tts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: clean }),
              signal: AbortSignal.timeout(20000),
            });
            const ct = res.headers.get('content-type') || '';
            if (res.ok && ct.includes('audio')) {
              premiumTtsRef.current = true;
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              if (!audioRef.current) audioRef.current = new Audio();
              const el = audioRef.current;
              el.src = url;
              el.onended = () => { URL.revokeObjectURL(url); done(); };
              el.onerror = () => { URL.revokeObjectURL(url); premiumTtsRef.current = false; browserSpeak(clean, done); };
              try {
                await el.play();
              } catch {
                URL.revokeObjectURL(url);
                browserSpeak(clean, done);
              }
              return;
            }
            // 501 = not configured; remember and don't retry
            premiumTtsRef.current = false;
          } catch {
            premiumTtsRef.current = false;
          }
        }

        // 2) Fallback: browser speech synthesis
        browserSpeak(clean, done);
      });
    },
    [stopAllSpeech]
  );

  // Chunked browser TTS with the best available voice.
  const browserSpeak = (clean: string, done: () => void) => {
    if (!window.speechSynthesis) {
      done();
      return;
    }
    let text = clean;
    if (text.length > 1500) {
      text = text.slice(0, 1500) + '. Check your screen for the full response.';
    }
    const chunks = text.match(/[^.!?]+[.!?]+/g) || [text];
    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => /Natural|Neural|Google US English|Google UK English Male|Enhanced|Aaron|Siri/i.test(v.name)) ||
      voices.find((v) => v.name.includes('Google')) ||
      voices.find((v) => v.lang?.startsWith('en'));

    let i = 0;
    const next = () => {
      if (i >= chunks.length) {
        done();
        return;
      }
      const u = new SpeechSynthesisUtterance(chunks[i].trim());
      u.rate = 1.05;
      u.pitch = 1;
      if (preferred) u.voice = preferred;
      u.onend = () => { i++; next(); };
      u.onerror = () => { i++; next(); };
      window.speechSynthesis.speak(u);
    };
    next();
  };

  // After the assistant finishes talking, keep the conversation going in hands-free mode.
  const maybeAutoListen = useCallback(() => {
    if (handsFreeRef.current && !stoppedRef.current) {
      emptyListenCountRef.current = 0;
      setTimeout(() => startListeningRef.current(), 350);
    } else {
      setStatus('Tap the mic to talk');
    }
  }, []);

  const sendToApi = useCallback(
    async (text: string) => {
      const current = messagesRef.current;
      const newMessages: Message[] = [...current, { role: 'user', content: text }];
      setMessages(newMessages);
      setIsThinking(true);
      setStatus('Thinking...');

      try {
        let data: { response?: string; error?: string } | undefined;

        if (mode === 'bridge') {
          try {
            const bridgeRes = await fetch(`${BRIDGE_URL}/message`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text }),
              signal: AbortSignal.timeout(120000),
            });
            data = await bridgeRes.json();
          } catch {
            setMode('standalone');
          }
        }

        if (!data || data.error) {
          const apiRes = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: newMessages.slice(-20) }),
          });
          data = await apiRes.json();
        }

        if (!data || data.error) {
          setError(data?.error || 'No response');
          setIsThinking(false);
          setStatus('Error — tap mic to try again');
          maybeAutoListen();
          return;
        }

        const reply = data.response || '';
        setMessages([...newMessages, { role: 'assistant', content: reply }]);
        setIsThinking(false);

        await speak(reply);
        maybeAutoListen();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
        setIsThinking(false);
        setStatus('Error — tap mic to try again');
        maybeAutoListen();
      }
    },
    [speak, mode, BRIDGE_URL, maybeAutoListen]
  );

  const startListening = useCallback(() => {
    setError('');
    setTranscript('');
    stoppedRef.current = false;
    unlockAudio();
    stopAllSpeech();
    setIsSpeaking(false);

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('Speech recognition not supported. Open this in Chrome.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalTranscript += result[0].transcript + ' ';
        else interim = result[0].transcript;
      }
      setTranscript(finalTranscript || interim);
    };

    recognition.onend = () => {
      setIsListening(false);
      const text = finalTranscript.trim();
      setTranscript('');

      if (text.length > 1) {
        emptyListenCountRef.current = 0;
        sendToApi(text);
      } else if (handsFreeRef.current && !stoppedRef.current && emptyListenCountRef.current < 4) {
        // Heard nothing — keep listening a few rounds before going idle.
        emptyListenCountRef.current += 1;
        setStatus('Listening...');
        setTimeout(() => startListeningRef.current(), 300);
      } else {
        setStatus(handsFreeRef.current ? 'Hands-free paused — tap to resume' : 'Tap the mic to talk');
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setIsListening(false);
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setError(`Mic error: ${event.error}`);
        setStatus('Tap the mic to talk');
      } else if (handsFreeRef.current && !stoppedRef.current && event.error === 'no-speech' && emptyListenCountRef.current < 4) {
        emptyListenCountRef.current += 1;
        setTimeout(() => startListeningRef.current(), 300);
      } else {
        setStatus(handsFreeRef.current ? 'Hands-free paused — tap to resume' : 'Tap the mic to talk');
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
      setStatus('Listening... speak now');
    } catch {
      // start() throws if already running — ignore
    }
  }, [sendToApi, stopAllSpeech, unlockAudio]);

  // Keep a stable ref so timeouts/promises always call the latest version.
  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const stopListening = useCallback(() => {
    stoppedRef.current = true;
    recognitionRef.current?.stop();
  }, []);

  const handleMicClick = useCallback(() => {
    unlockAudio();
    if (isSpeaking) {
      stoppedRef.current = true;
      stopAllSpeech();
      setIsSpeaking(false);
      setStatus(handsFree ? 'Hands-free paused — tap to resume' : 'Tap the mic to talk');
      return;
    }
    if (isListening) {
      stopListening();
      setStatus(handsFree ? 'Hands-free paused — tap to resume' : 'Tap the mic to talk');
    } else if (!isThinking) {
      startListening();
    }
  }, [isListening, isSpeaking, isThinking, handsFree, startListening, stopListening, stopAllSpeech, unlockAudio]);

  const toggleHandsFree = useCallback(() => {
    const next = !handsFree;
    setHandsFree(next);
    handsFreeRef.current = next;
    if (typeof window !== 'undefined') window.localStorage.setItem('handsFree', next ? '1' : '0');
    if (!next) {
      stoppedRef.current = true;
    }
  }, [handsFree]);

  const handleReplay = useCallback(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant && !isSpeaking && !isListening && !isThinking) {
      speak(lastAssistant.content).then(() => setStatus('Tap the mic to talk'));
    }
  }, [messages, isSpeaking, isListening, isThinking, speak]);

  return (
    <div className="flex flex-col h-screen bg-black select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-white">Casey Voice</h1>
          {mode === 'bridge' && <span className="text-[10px] text-green-500 font-medium">PC</span>}
          {mode === 'standalone' && <span className="text-[10px] text-blue-400 font-medium">CLOUD</span>}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleHandsFree}
            className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${
              handsFree ? 'bg-green-600 text-white' : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'
            }`}
          >
            {handsFree ? 'Hands-free ON' : 'Hands-free'}
          </button>
          <button onClick={handleReplay} className="text-xs text-zinc-500 active:text-white px-1 py-1">
            Replay
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && !transcript && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-zinc-600">
              <div className="text-6xl mb-6">🎙️</div>
              <p className="text-xl font-medium">Tap the mic and talk</p>
              <p className="text-sm mt-2 text-zinc-700">
                Turn on Hands-free while driving —
                <br />
                it keeps the conversation going
              </p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-base leading-relaxed ${
                msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-100'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {transcript && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl px-4 py-3 text-base bg-blue-600/50 text-blue-200 italic">
              {transcript}
            </div>
          </div>
        )}

        {isThinking && (
          <div className="flex justify-start">
            <div className="rounded-2xl px-4 py-3 text-base bg-zinc-800 text-zinc-400">
              <span className="animate-pulse">Thinking...</span>
            </div>
          </div>
        )}
      </div>

      {/* Error bar */}
      {error && <div className="px-4 py-2 bg-red-900/50 text-red-300 text-xs text-center">{error}</div>}

      {/* Bottom controls */}
      <div className="flex flex-col items-center pb-10 pt-4 border-t border-zinc-800">
        <p className="text-sm text-zinc-400 mb-4">{status}</p>

        <button
          onClick={handleMicClick}
          disabled={isThinking}
          className={`w-28 h-28 rounded-full flex items-center justify-center transition-all duration-200 active:scale-90 ${
            isListening
              ? 'bg-red-500 shadow-lg shadow-red-500/50 animate-pulse'
              : isSpeaking
                ? 'bg-green-500 shadow-lg shadow-green-500/50'
                : isThinking
                  ? 'bg-zinc-700 cursor-not-allowed'
                  : 'bg-white shadow-lg shadow-white/20'
          }`}
        >
          {isListening ? <MicOnIcon /> : isSpeaking ? <SpeakerIcon /> : isThinking ? <ThinkingIcon /> : <MicOffIcon />}
        </button>

        <p className="text-[11px] text-zinc-600 mt-3">
          {isListening ? 'Tap to send now' : isSpeaking ? 'Tap to stop' : 'Tap to talk'}
        </p>
      </div>
    </div>
  );
}

function MicOffIcon() {
  return (
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function MicOnIcon() {
  return (
    <svg width="42" height="42" viewBox="0 0 24 24" fill="white" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function ThinkingIcon() {
  return (
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
