/**
 * The letterbox — the one place a reader can write into this world without
 * standing in it.
 *
 * The graffiti wall opened in July and was still blank in August, and the
 * paper kept reporting that, which was funny and also the diagnosis: the
 * only way to write anything was to walk up to a plywood board inside a 3D
 * world. Most people who read the paper never go there. This is the same
 * wall with a letterbox on the front of it — your line goes up in the plaza
 * AND into tomorrow's postbag, where the editor may print it under your
 * name with a reply underneath.
 *
 * Deliberately two plain fields and a button. A newspaper's letters page has
 * never needed an account.
 */
import { useState } from "react";
import { sendLetter } from "@/lib/vibeTimes";

const NAME_KEY = "times.letterName";

export function Letterbox() {
  // The name is remembered because signing your letter every morning is a
  // chore, and an unsigned letters page is a worse letters page.
  const [author, setAuthor] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [body, setBody] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const line = body.trim();
    if (!line || state === "sending") return;
    setState("sending");
    setError(null);
    const signed = author.trim();
    const result = await sendLetter(signed || "a reader", line);
    if (!result.ok) {
      setError(result.error ?? "the postbag is jammed");
      setState("idle");
      return;
    }
    if (signed) localStorage.setItem(NAME_KEY, signed);
    setBody("");
    setState("sent");
  }

  return (
    <section className="mt-8 border border-[#2a2118]/40 p-4">
      <h4 className="text-center text-sm font-bold uppercase tracking-[0.25em]">✉️ Write to the Editor</h4>

      {state === "sent" ? (
        <div className="mt-3 text-center text-sm leading-relaxed">
          <p className="italic">Your line is in the postbag, and it is on the wall in the plaza.</p>
          <p className="mt-1 opacity-70">
            The editor prints what the editor prints. Come back in the morning.
          </p>
          <button
            onClick={() => setState("idle")}
            className="mt-2 text-[11px] uppercase tracking-widest underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100"
          >
            write another
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-3">
          <p className="text-center text-sm leading-relaxed opacity-80">
            One line, printed as you wrote it, if the editor likes it.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              maxLength={40}
              placeholder="your name"
              aria-label="your name"
              className="w-full border border-[#2a2118]/40 bg-transparent px-3 py-2 text-sm placeholder:text-[#2a2118]/40 focus:border-[#2a2118] focus:outline-none sm:w-40"
              style={{ fontFamily: "inherit" }}
            />
            <input
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={240}
              placeholder="…and what you have to say"
              aria-label="your letter"
              data-testid="letter-body"
              className="min-w-0 flex-1 border border-[#2a2118]/40 bg-transparent px-3 py-2 text-sm placeholder:text-[#2a2118]/40 focus:border-[#2a2118] focus:outline-none"
              style={{ fontFamily: "inherit" }}
            />
            <button
              type="submit"
              disabled={!body.trim() || state === "sending"}
              data-testid="letter-send"
              className="border border-[#2a2118] bg-[#2a2118] px-4 py-2 text-xs font-bold uppercase tracking-widest text-[#efe8d8] transition-opacity disabled:opacity-30"
            >
              {state === "sending" ? "posting…" : "post it"}
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] uppercase tracking-widest opacity-50">
            {error ?? `${240 - body.length} characters left · goes up on the wall either way`}
          </p>
        </form>
      )}
    </section>
  );
}
