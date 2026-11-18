/**
 * Sign in, or who you are. The same dialog the global nav opens; each
 * direction only decides what the button looks like.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import VibeAuthDialog from "@/components/vibe-auth/VibeAuthDialog";

export default function Account({
  className,
  style,
  signedOut = "Sign in",
  children,
}: {
  className: string;
  style?: CSSProperties;
  signedOut?: ReactNode;
  /** What a signed-in visitor sees, given their name. */
  children?: (name: string) => ReactNode;
}) {
  const id = useVibeIdentity();
  className = `inline-flex shrink-0 items-center justify-center whitespace-nowrap ${className}`;
  const [open, setOpen] = useState(false);

  /* Same footprint while loading, so the bar does not reflow when the session
     resolves. */
  if (id.loading) return <span className={`${className} invisible`} style={style}>{signedOut}</span>;

  if (!id.isGuest) {
    return (
      <Link to="/profile" className={className} style={style}>
        {children ? children(id.displayName) : id.displayName}
      </Link>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} style={style}>
        {signedOut}
      </button>
      <VibeAuthDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
