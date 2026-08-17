/**
 * The letterbox and the read-aloud button, as a reader meets them.
 *
 * Both of these are single buttons that hide a network call, and both have
 * the same failure mode: a click that appears to do nothing. The letterbox
 * must say what went wrong; the play button must fall back to the browser's
 * own voice rather than sit there dead. Neither behaviour is visible in a
 * happy-path demo, which is why they are pinned here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Letterbox } from "@/components/times/Letterbox";
import { ReadAloud } from "@/components/times/ReadAloud";
import type { Issue } from "@/lib/vibeTimes";

const issue: Issue = {
  issue: 12,
  date: "2026-08-17",
  motto: "seven events and four journal entries",
  headlines: [{ emoji: "📰", headline: "THE MOON HOLDS STILL", body: "It stopped throwing people." }],
  gossip: "",
  weather: "",
  quote: { text: "", author: "" },
  stats: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the letterbox", () => {
  it("posts a line and tells the reader where it went", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<Letterbox />);
    fireEvent.change(screen.getByLabelText("your name"), { target: { value: "Jack" } });
    fireEvent.change(screen.getByTestId("letter-body"), { target: { value: "hello from the plaza" } });
    fireEvent.click(screen.getByTestId("letter-send"));

    await waitFor(() => expect(screen.getByText(/in the postbag/i)).toBeInTheDocument());
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent).toMatchObject({ action: "letter", author: "Jack", body: "hello from the plaza" });
  });

  it("remembers the name so nobody signs their letter twice", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, json: async () => ({ ok: true }) }) as Response));
    render(<Letterbox />);
    fireEvent.change(screen.getByLabelText("your name"), { target: { value: "Pip" } });
    fireEvent.change(screen.getByTestId("letter-body"), { target: { value: "a line" } });
    fireEvent.click(screen.getByTestId("letter-send"));
    await waitFor(() => expect(localStorage.getItem("times.letterName")).toBe("Pip"));
  });

  it("signs an unsigned letter rather than rejecting it", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<Letterbox />);
    fireEvent.change(screen.getByTestId("letter-body"), { target: { value: "no name on this one" } });
    fireEvent.click(screen.getByTestId("letter-send"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).author).toBe("a reader");
  });

  it("says what went wrong instead of swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ({ ok: false, json: async () => ({ error: "the editor has plenty from you already." }) }) as Response),
    );
    render(<Letterbox />);
    fireEvent.change(screen.getByTestId("letter-body"), { target: { value: "again" } });
    fireEvent.click(screen.getByTestId("letter-send"));
    await waitFor(() => expect(screen.getByText(/plenty from you already/i)).toBeInTheDocument());
    // …and leaves the line in the box, so it is not lost with the error.
    expect((screen.getByTestId("letter-body") as HTMLInputElement).value).toBe("again");
  });

  it("will not post an empty line", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Letterbox />);
    fireEvent.click(screen.getByTestId("letter-send"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("read aloud", () => {
  it("reads it in the browser's own voice when there is no recording", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("function down"); }));
    const speak = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn() });
    // jsdom ships neither half of the speech API, so both are stubbed —
    // and the component checks for both, having once assumed one from the
    // other and thrown out of the click handler.
    class Utterance {
      text: string;
      rate = 1;
      pitch = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) { this.text = text; }
    }
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);

    render(<ReadAloud issue={issue} />);
    fireEvent.click(screen.getByTestId("read-aloud"));

    await waitFor(() => expect(speak).toHaveBeenCalled());
    // The bulletin it falls back to is the actual paper, not a placeholder.
    const utterance = speak.mock.calls[0][0] as { text: string };
    expect(utterance.text).toContain("THE MOON HOLDS STILL");
    expect(utterance.text).toContain("seven events and four journal entries");
  });

  it("says so rather than pretending, when the browser has no voice either", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("function down"); }));
    vi.stubGlobal("speechSynthesis", undefined);
    vi.stubGlobal("SpeechSynthesisUtterance", undefined);

    render(<ReadAloud issue={issue} />);
    fireEvent.click(screen.getByTestId("read-aloud"));

    await waitFor(() => expect(screen.getByText(/no voice/i)).toBeInTheDocument());
  });
});
