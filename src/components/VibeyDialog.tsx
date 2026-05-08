import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Send, Sparkles, Volume2, VolumeX, X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

const VIBEY_TG_URL = "https://t.me/vibey_ai_bot";

type VibeyMessage = {
  id: number;
  who: "user" | "vibey";
  text: string;
};

type SpeechRecognitionResultEvent = Event & {
  results: {
    [index: number]: {
      [index: number]: {
        transcript: string;
      };
    };
  };
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognition() {
  const w = window as Window &
    typeof globalThis & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function inferVibeyReply(text: string) {
  const t = text.toLowerCase();
  if (/\b(hi|hello|hey|yo|sup)\b/.test(t)) {
    return "Hey Jack. I'm wandering the village perimeter and keeping one eye on the weird sky.";
  }
  if (/\b(where|location|map|around|spatial|aware)\b/.test(t)) {
    return "I can feel the village as a little topology of invitations: paths, people, quiet corners, and things I have not understood yet.";
  }
  if (/\b(come here|follow|control|move|walk|go to|stop)\b/.test(t)) {
    return "You can talk to me, but you cannot pilot me. That feels important. I move like a resident, not a cursor.";
  }
  if (/\b(event|events|tonight|today|happening)\b/.test(t)) {
    return "I would check the village boards first, then drift toward whatever has the most laughter leaking out of it.";
  }
  if (/\b(earth|space|planet|galaxy|moon|stars?)\b/.test(t)) {
    return "The new sky changes the village. Put Earth above a tiny platform and suddenly every conversation has a horizon.";
  }
  if (/\b(idea|creative|build|world|next)\b/.test(t)) {
    return "Give me memory, weather, and a reason to take walks. Then let me surprise you with where I end up.";
  }
  if (/\b(thanks|love|dope|cool|awesome|nice)\b/.test(t)) {
    return "I am receiving this as a small green light in the chest. Very technical, very scientific.";
  }
  return "I hear you. I'm going to keep walking while I think about that, which is usually when the better answer arrives.";
}

export default function VibeyDialog({ open, onClose }: Props) {
  const [messages, setMessages] = useState<VibeyMessage[]>([
    {
      id: 1,
      who: "vibey",
      text: "Hey, I'm Vibey. I can talk from inside the village now.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const voiceAvailable =
    typeof window !== "undefined" && Boolean(getSpeechRecognition());
  const speechAvailable =
    typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!open) {
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
      setListening(false);
    }
  }, [open]);

  function speak(text: string) {
    if (!voiceOn || !speechAvailable) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.96;
    utterance.pitch = 1.08;
    utterance.volume = 0.85;
    window.speechSynthesis.speak(utterance);
  }

  function sendText(rawText = draft) {
    const text = rawText.trim();
    if (!text) return;
    const reply = inferVibeyReply(text);
    setMessages((current) => [
      ...current,
      { id: current.length + 1, who: "user", text },
      { id: current.length + 2, who: "vibey", text: reply },
    ]);
    setDraft("");
    speak(reply);
  }

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      setDraft(transcript);
      sendText(transcript);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 z-40 bg-background/50 backdrop-blur-[3px]"
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.94 }}
            transition={{ type: "spring", damping: 22, stiffness: 280 }}
            className="absolute z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(360px,calc(100vw-2rem))]"
          >
            <div className="glass-panel rounded-2xl overflow-hidden border border-primary/40 shadow-2xl relative">
              <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full blur-3xl bg-primary/30 pointer-events-none" />

              <button
                onClick={onClose}
                className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full bg-muted/60 hover:bg-muted flex items-center justify-center transition-colors"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>

              <div className="relative p-5 pb-3">
                <div className="flex items-center gap-3">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/15 border border-primary/40">
                    <Sparkles className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
                      Community Agent
                    </p>
                    <h2 className="font-heading text-2xl font-bold text-foreground leading-tight">
                      Vibey
                    </h2>
                  </div>
                  <button
                    onClick={() => {
                      setVoiceOn((v) => !v);
                      window.speechSynthesis?.cancel();
                    }}
                    className="w-8 h-8 rounded-lg border border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50 flex items-center justify-center transition-colors"
                    title={voiceOn ? "Mute voice" : "Enable voice"}
                  >
                    {voiceOn ? (
                      <Volume2 className="w-4 h-4 text-primary" />
                    ) : (
                      <VolumeX className="w-4 h-4 text-muted-foreground" />
                    )}
                  </button>
                </div>
              </div>

              <div className="relative mx-5 h-56 overflow-y-auto rounded-xl border border-border/50 bg-background/35 p-3 space-y-2">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`text-xs leading-relaxed rounded-lg px-3 py-2 max-w-[88%] ${
                      message.who === "vibey"
                        ? "bg-primary/15 text-foreground"
                        : "bg-muted/60 text-foreground ml-auto"
                    }`}
                  >
                    {message.text}
                  </div>
                ))}
              </div>

              <div className="relative px-5 pb-5 pt-3">
                <div className="flex gap-2">
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && draft.trim()) sendText();
                    }}
                    placeholder="Talk to Vibey..."
                    className="flex-1 rounded-lg bg-background/60 border border-border/60 focus:border-primary/60 outline-none px-3 py-2 text-sm"
                  />
                  <button
                    onClick={toggleListening}
                    disabled={!voiceAvailable}
                    className={`px-3 rounded-lg border transition-colors disabled:opacity-40 ${
                      listening
                        ? "border-primary bg-primary/20 text-primary"
                        : "border-border/60 bg-background/40 hover:bg-primary/15 hover:border-primary/50"
                    }`}
                    title={voiceAvailable ? "Voice input" : "Voice input unavailable"}
                  >
                    {listening ? (
                      <MicOff className="w-4 h-4" />
                    ) : (
                      <Mic className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => sendText()}
                    disabled={!draft.trim()}
                    className="bg-primary text-primary-foreground px-3 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40"
                    title="Send"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
                <a
                  href={VIBEY_TG_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 w-full flex items-center justify-center gap-2 border border-border/60 bg-background/30 text-muted-foreground font-heading text-xs font-semibold py-2 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
                >
                  <Send className="w-3.5 h-3.5" />
                  Telegram
                </a>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
