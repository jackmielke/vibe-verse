/**
 * /worlds — a shareable URL for the world gateway.
 *
 * Deliberately thin. The gateway itself is `WorldPicker`, which is also what
 * the 🌐 chip and "see all worlds" open from `GlobalNav`. There is exactly one
 * definition of "the worlds" in this codebase and this route renders it rather
 * than keeping a second list in sync — a duplicated list is a list that goes
 * stale the first time somebody adds a world to only one of them.
 */
import { useLocation, useNavigate } from "react-router-dom";
import WorldPicker from "@/components/WorldPicker";

export default function Worlds() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // At "/" this IS the front door, so the escape hatch points at the 3D lobby
  // rather than looping back to itself.
  const isHome = pathname === "/";
  return (
    <WorldPicker
      open
      asPage
      homeLabel={isHome ? "↗ open the 3D lobby" : "← back to the hub"}
      onClose={() => navigate(isHome ? "/terminal" : "/")}
    />
  );
}
