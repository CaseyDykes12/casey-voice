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
  const [ttsReady, setTtsReady] = useState(false);
  const [mode, setMode] = useState<'checking' | 'bridge' | 'standalone'>('checking');
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([]);

  const BRIDGE_URL = 'https://voice.dykesmotors.com';

  // Check if bridge (PC) is reachable on mount
  useEffect(() => {
    const checkBridge = async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          setMode('bridge');
          setStatus('Connected to PC — Opus 4.6');
        } else {
          setMode('standalone');
          setStatus('Standalone mode — tap mic to talk');
        }
      } catch {
        setMode('standalone');
        setStatus('Standalone mode — tap mic to talk');
      }
    };
    checkBridge();
  }, []);

  // Keep ref in sync with state for use in callbacks
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, transcript]);

  // Initialize TTS voices (they load async on mobile)
  useEffect(() => {
    const loadVoices = () => {
      const voices = window.speechSynthesis?.getVoices();
      if (voices && voices.length > 0) {
        setTtsReady(true);
      }
    };
    loadVoices();
    window.speechSynthesis?.addEventListener('voiceschanged', loadVoices);
    return () => {
      window.speechSynthesis?.removeEventListener('voiceschanged', loadVoices);
    };
  }, []);

  const speak = useCallback((text: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (!window.speechSynthesis) {
        resolve();
        return;
      }

      // Cancel any current speech
      window.speechSynthesis.cancel();

      // Clean text for speech
      let clean = text.replace(/```[\s\S]*?```/g, 'code block');
      clean = clean.replace(/`([^`]+)`/g, '$1');
      clean = clean.replace(/\*\*([^*]+)\*\*/g, '$1');
      clean = clean.replace(/\*([^*]+)\*/g, '$1');
      clean = clean.replace(/#{1,6}\s/g, '');
      clean = clean.replace(/https?:\/\/\S+/g, 'link');
      clean = clean.replace(/\n{2,}/g, '. ');
      clean = clean.replace(/\n/g, '. ');

      if (clean.length > 1500) {
        clean = clean.slice(0, 1500) + '. Check your screen for the full response.';
      }

      // Split into chunks — mobile Chrome cuts off long utterances
      const chunks = clean.match(/[^.!?]+[.!?]+/g) || [clean];
      let i = 0;

      const speakNext = () => {
        if (i >= chunks.length) {
          setIsSpeaking(false);
          setStatus('Tap the mic to talk');
          resolve();
          return;
        }

        const utterance = new SpeechSynthesisUtterance(chunks[i].trim());
        utterance.rate = 1.05;
        utterance.pitch = 1;

        // Pick a good voice
        const voices = window.speechSynthesis.getVoices();
        const preferred = voices.find(
          (v) =>
            v.name.includes('Google') ||
            v.name.includes('Natural') ||
            v.name.includes('David') ||
            v.name.includes('Enhanced')
        );
        if (preferred) utterance.voice = preferred;

        utterance.onend = () => {
          i++;
          speakNext();
        };
        utterance.onerror = (e) => {
          console.error('TTS error:', e);
          i++;
          speakNext();
        };

        window.speechSynthesis.speak(utterance);
      };

      setIsSpeaking(true);
      setStatus('Speaking...');
      speakNext();
    });
  }, []);

  const sendToApi = useCallback(
    async (text: string) => {
      const current = messagesRef.current;
      const newMessages: Message[] = [
        ...current,
        { role: 'user', content: text },
      ];
      setMessages(newMessages);
      setIsThinking(true);
      setStatus('Thinking...');

      try {
        let data;

        // Try bridge first (Opus 4.6 on PC)
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
            // Bridge died mid-conversation — fall back
            setMode('standalone');
          }
        }

        // Standalone fallback
        if (!data || data.error) {
          const apiRes = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: newMessages.slice(-20) }),
          });
          data = await apiRes.json();
        }

        if (data.error) {
          setError(data.error);
          setIsThinking(false);
          setStatus('Error — tap mic to try again');
          return;
        }

        const reply = data.response;
        const updatedMessages: Message[] = [...newMessages, { role: 'assistant', content: reply }];
        setMessages(updatedMessages);
        setIsThinking(false);

        // Speak the response
        await speak(reply);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
        setIsThinking(false);
        setStatus('Error — tap mic to try again');
      }
    },
    [speak, mode]
  );

  const startListening = useCallback(() => {
    setError('');
    setTranscript('');

    // Prime TTS on user gesture (required on mobile)
    if (!ttsReady) {
      const primer = new SpeechSynthesisUtterance('');
      primer.volume = 0;
      window.speechSynthesis?.speak(primer);
      setTtsReady(true);
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setError('Speech recognition not supported. Use Chrome.');
      return;
    }

    // Stop any current speech
    window.speechSynthesis?.cancel();
    setIsSpeaking(false);

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';
    let silenceTimer: ReturnType<typeof setTimeout>;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript + ' ';
        } else {
          interim += result[0].transcript;
        }
      }
      setTranscript(finalTranscript + interim);

      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        recognition.stop();
      }, 2500);
    };

    recognition.onend = () => {
      setIsListening(false);
      clearTimeout(silenceTimer);

      const text = finalTranscript.trim();
      setTranscript('');

      if (text.length > 1) {
        sendToApi(text);
      } else {
        setStatus('Tap the mic to talk');
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setIsListening(false);
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setError(`Mic error: ${event.error}`);
      }
      setStatus('Tap the mic to talk');
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    setStatus('Listening... speak now');
  }, [sendToApi, ttsReady]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  }, []);

  const handleMicClick = useCallback(() => {
    if (isSpeaking) {
      window.speechSynthesis?.cancel();
      setIsSpeaking(false);
      setStatus('Tap the mic to talk');
      return;
    }

    if (isListening) {
      stopListening();
    } else if (!isThinking) {
      startListening();
    }
  }, [isListening, isSpeaking, isThinking, startListening, stopListening]);

  // Replay last response on long press
  const handleReplay = useCallback(() => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (lastAssistant && !isSpeaking && !isListening && !isThinking) {
      speak(lastAssistant.content);
    }
  }, [messages, isSpeaking, isListening, isThinking, speak]);

  return (
    <div className="flex flex-col h-screen bg-black select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-white">Casey Voice</h1>
          {mode === 'bridge' && (
            <span className="text-[10px] text-green-500 font-medium">OPUS</span>
          )}
          {mode === 'standalone' && (
            <span className="text-[10px] text-yellow-500 font-medium">SONNET</span>
          )}
        </div>
        <button
          onClick={handleReplay}
          className="text-xs text-zinc-500 active:text-white px-2 py-1"
        >
          Replay last
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
      >
        {messages.length === 0 && !transcript && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-zinc-600">
              <div className="text-6xl mb-6">🎙️</div>
              <p className="text-xl font-medium">Tap the mic and talk</p>
              <p className="text-sm mt-2 text-zinc-700">
                Works with your Shokz headset
              </p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-800 text-zinc-100'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {transcript && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm bg-blue-600/50 text-blue-200 italic">
              {transcript}
            </div>
          </div>
        )}

        {isThinking && (
          <div className="flex justify-start">
            <div className="rounded-2xl px-4 py-3 text-sm bg-zinc-800 text-zinc-400">
              <span className="animate-pulse">Thinking...</span>
            </div>
          </div>
        )}
      </div>

      {/* Error bar */}
      {error && (
        <div className="px-4 py-2 bg-red-900/50 text-red-300 text-xs text-center">
          {error}
        </div>
      )}

      {/* Bottom controls */}
      <div className="flex flex-col items-center pb-10 pt-4 border-t border-zinc-800">
        <p className="text-xs text-zinc-500 mb-4">{status}</p>

        <button
          onClick={handleMicClick}
          disabled={isThinking}
          className={`w-24 h-24 rounded-full flex items-center justify-center transition-all duration-200 active:scale-90 ${
            isListening
              ? 'bg-red-500 shadow-lg shadow-red-500/50 animate-pulse'
              : isSpeaking
                ? 'bg-green-500 shadow-lg shadow-green-500/50'
                : isThinking
                  ? 'bg-zinc-700 cursor-not-allowed'
                  : 'bg-white shadow-lg shadow-white/20'
          }`}
        >
          {isListening ? (
            <MicOnIcon />
          ) : isSpeaking ? (
            <SpeakerIcon />
          ) : isThinking ? (
            <ThinkingIcon />
          ) : (
            <MicOffIcon />
          )}
        </button>

        <p className="text-[11px] text-zinc-600 mt-3">
          {isListening
            ? 'Tap to send now'
            : isSpeaking
              ? 'Tap to stop'
              : 'Tap to talk'}
        </p>
      </div>
    </div>
  );
}

function MicOffIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function MicOnIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="white" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function ThinkingIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
