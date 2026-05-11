import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { exchangeCodeForToken } from "@/lib/spotify";

export default function SpotifyCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get("code");
    const err = params.get("error");
    if (err) {
      setError(err);
      return;
    }
    if (!code) {
      setError("No authorization code returned from Spotify.");
      return;
    }
    (async () => {
      try {
        await exchangeCodeForToken(code);
        const back = localStorage.getItem("spotify.return_to") || "/space";
        localStorage.removeItem("spotify.return_to");
        navigate(back, { replace: true });
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [params, navigate]);

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-black text-foreground p-6">
      <div className="glass-panel rounded-2xl border border-primary/30 px-6 py-5 max-w-md text-center">
        {error ? (
          <>
            <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-destructive mb-2">
              Spotify · Error
            </p>
            <p className="text-sm text-foreground">{error}</p>
          </>
        ) : (
          <>
            <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary mb-2">
              Spotify · Connecting
            </p>
            <p className="text-sm text-foreground">
              Talking to Spotify… you'll be back at the village in a sec.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
