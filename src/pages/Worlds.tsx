/**
 * /worlds — a shareable URL for the world gateway.
 *
 * Deliberately thin. The gateway itself is `WorldPicker`, which is also what
 * the 🌐 chip and "see all worlds" open from `GlobalNav`. There is exactly one
 * definition of "the worlds" in this codebase and this route renders it rather
 * than keeping a second list in sync — a duplicated list is a list that goes
 * stale the first time somebody adds a world to only one of them.
 */
import { useNavigate } from "react-router-dom";
import WorldPicker from "@/components/WorldPicker";

export default function Worlds() {
  const navigate = useNavigate();
  return <WorldPicker open asPage onClose={() => navigate("/")} />;
}
