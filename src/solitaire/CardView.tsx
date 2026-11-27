/**
 * One card, drawn in the DOM. A card is two faces on a 3D flipper inside a
 * positioned shell: the shell slides (transform), the flipper turns (rotateY).
 * Every style that depends on the theme reads a CSS variable set on the table,
 * so changing theme re-colours 52 cards without re-rendering any of them.
 */
import { memo } from "react";
import { isRed, RANK_LABEL, SUIT_GLYPH, type Card } from "./cards";

export interface CardFlags {
  dragging?: boolean;
  lifted?: boolean;
  hint?: boolean;
  shake?: boolean;
  delay?: number;
  flipDelay?: number;
  instant?: boolean;
  buried?: boolean;
}

interface Props extends CardFlags {
  card: Card;
  x: number;
  y: number;
  z: number;
  onDown: (id: number, e: React.PointerEvent) => void;
}

function Pips({ card }: { card: Card }) {
  const g = SUIT_GLYPH[card.suit];
  if (card.rank >= 11) {
    return (
      <div className="sol-court">
        <span className="sol-court-letter">{RANK_LABEL[card.rank]}</span>
        <span className="sol-court-suit">{g}</span>
      </div>
    );
  }
  return <div className={card.rank === 1 ? "sol-pip sol-ace" : "sol-pip"}>{g}</div>;
}

export const CardView = memo(function CardView({
  card, x, y, z, dragging, lifted, hint, shake, delay, flipDelay, instant, buried, onDown,
}: Props) {
  const red = isRed(card.suit);
  const cls = [
    "sol-card",
    dragging && "is-drag",
    lifted && "is-lift",
    hint && "is-hint",
    shake && "is-shake",
    instant && "is-instant",
    buried && "is-buried",
  ].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      data-card={card.id}
      style={{
        transform: `translate3d(${x}px, ${y}px, 0)`,
        zIndex: z,
        transitionDelay: delay ? `${delay}ms` : undefined,
      }}
      onPointerDown={(e) => onDown(card.id, e)}
    >
      <div className={card.up ? "sol-flip is-up" : "sol-flip"} style={{ transitionDelay: flipDelay ? `${flipDelay}ms` : undefined }}>
        <div className={red ? "sol-face sol-front is-red" : "sol-face sol-front"}>
          <div className="sol-corner">
            <span className="sol-rank">{RANK_LABEL[card.rank]}</span>
            <span className="sol-suit">{SUIT_GLYPH[card.suit]}</span>
          </div>
          <Pips card={card} />
          <div className="sol-corner sol-corner-b">
            <span className="sol-rank">{RANK_LABEL[card.rank]}</span>
            <span className="sol-suit">{SUIT_GLYPH[card.suit]}</span>
          </div>
        </div>
        <div className="sol-face sol-back">
          <div className="sol-back-inner">
            <div className="sol-emblem">V</div>
          </div>
        </div>
      </div>
    </div>
  );
});
