import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/vibequest/supabase';
import { Character } from '@/vibequest/useCharacters';

interface OnlineFighterProps {
  roomCode: string;
  localCharacter: Character;
  remoteCharacter: Character;
  isHost: boolean;
  onBack: () => void;
}

interface PlayerState {
  x: number;
  y: number;
  velocityY: number;
  direction: 'left' | 'right';
  health: number;
  isJumping: boolean;
}

interface ProjectileState {
  x: number;
  y: number;
  velocityX: number;
}

interface BroadcastState {
  player: PlayerState;
  projectiles: ProjectileState[];
  timestamp: number;
}

const CANVAS_W = 1000;
const CANVAS_H = 600;
const PLAYER_W = 50;
const PLAYER_H = 60;
const GRAVITY = 1200;
const JUMP_FORCE = -520;
const MOVE_SPEED = 350;
const FRICTION = 0.85;
const PROJ_SPEED = 600;
const PROJ_DAMAGE = 10;
const SHOOT_CD = 0.3;
const INVULN_TIME = 0.5;
const BROADCAST_INTERVAL = 50; // ms (~20fps)

const PLATFORMS = [
  { x: 0, y: 520, w: 1000, h: 80 },
  { x: 80, y: 380, w: 180, h: 25 },
  { x: 740, y: 380, w: 180, h: 25 },
  { x: 400, y: 280, w: 200, h: 25 },
];

export const OnlineFighter = ({ roomCode, localCharacter, remoteCharacter, isHost, onBack }: OnlineFighterProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<Record<string, boolean>>({});
  const localRef = useRef<PlayerState>({
    x: isHost ? 150 : 800,
    y: 400,
    velocityY: 0,
    direction: isHost ? 'right' : 'left',
    health: 100,
    isJumping: false,
  });
  const remoteRef = useRef<PlayerState>({
    x: isHost ? 800 : 150,
    y: 400,
    velocityY: 0,
    direction: isHost ? 'left' : 'right',
    health: 100,
    isJumping: false,
  });
  const localProjRef = useRef<ProjectileState[]>([]);
  const remoteProjRef = useRef<ProjectileState[]>([]);
  const shootCdRef = useRef(0);
  const invulnRef = useRef(0);
  const localImgRef = useRef<HTMLImageElement | null>(null);
  const remoteImgRef = useRef<HTMLImageElement | null>(null);
  const lastTimeRef = useRef(0);
  const animIdRef = useRef<number | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastBroadcastRef = useRef(0);
  const velocityXRef = useRef(0);

  const [localHealth, setLocalHealth] = useState(100);
  const [remoteHealth, setRemoteHealth] = useState(100);
  const [winner, setWinner] = useState<'local' | 'remote' | null>(null);
  const [connected, setConnected] = useState(false);

  // Load images
  useEffect(() => {
    const img1 = new Image();
    img1.src = localCharacter.image_url;
    img1.onload = () => { localImgRef.current = img1; };
    const img2 = new Image();
    img2.src = remoteCharacter.image_url;
    img2.onload = () => { remoteImgRef.current = img2; };
  }, [localCharacter, remoteCharacter]);

  // Set up Realtime channel
  useEffect(() => {
    const channel = supabase.channel(`online-fight-${roomCode}`, {
      config: { broadcast: { self: false } },
    });

    channel
      .on('broadcast', { event: 'game-state' }, (payload) => {
        const data = payload.payload as BroadcastState;
        remoteRef.current = { ...data.player };
        remoteProjRef.current = data.projectiles.map(p => ({ ...p }));
        setRemoteHealth(data.player.health);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setConnected(true);
        }
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomCode]);

  // Keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keysRef.current[e.code] = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyD'].includes(e.code)) {
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      keysRef.current[e.code] = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Game loop
  useEffect(() => {
    if (!canvasRef.current || !connected) return;

    const canvas = canvasRef.current;
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d')!;
    lastTimeRef.current = performance.now();

    const loop = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTimeRef.current) / 1000, 0.05);
      lastTimeRef.current = now;

      if (winner) {
        animIdRef.current = requestAnimationFrame(loop);
        return;
      }

      // --- UPDATE LOCAL PLAYER ---
      const local = localRef.current;
      const keys = keysRef.current;

      // Movement
      if (keys['KeyA'] || keys['ArrowLeft']) {
        velocityXRef.current = -MOVE_SPEED;
        local.direction = 'left';
      } else if (keys['KeyD'] || keys['ArrowRight']) {
        velocityXRef.current = MOVE_SPEED;
        local.direction = 'right';
      } else {
        velocityXRef.current *= FRICTION;
      }

      // Jump
      if ((keys['KeyW'] || keys['ArrowUp'] || keys['Space']) && !local.isJumping) {
        local.velocityY = JUMP_FORCE;
        local.isJumping = true;
      }

      // Shoot
      shootCdRef.current -= dt;
      if (keys['KeyJ'] || keys['Enter'] || keys['KeyE']) {
        if (shootCdRef.current <= 0) {
          const dir = local.direction === 'right' ? 1 : -1;
          localProjRef.current.push({
            x: local.x + PLAYER_W / 2 + dir * 25,
            y: local.y + PLAYER_H / 2,
            velocityX: PROJ_SPEED * dir,
          });
          shootCdRef.current = SHOOT_CD;
        }
      }

      // Gravity
      local.velocityY += GRAVITY * dt;
      local.x += velocityXRef.current * dt;
      local.y += local.velocityY * dt;

      // Platform collision
      for (const p of PLATFORMS) {
        if (local.x + PLAYER_W > p.x && local.x < p.x + p.w &&
            local.y + PLAYER_H > p.y && local.y + PLAYER_H < p.y + p.h + 20 &&
            local.velocityY > 0) {
          local.y = p.y - PLAYER_H;
          local.velocityY = 0;
          local.isJumping = false;
        }
      }

      // Bounds
      local.x = Math.max(0, Math.min(CANVAS_W - PLAYER_W, local.x));
      if (local.y > CANVAS_H) {
        local.y = 100;
        local.x = isHost ? 150 : 800;
        local.health -= 10;
      }

      // Update local projectiles
      localProjRef.current = localProjRef.current.filter(p => {
        p.x += p.velocityX * dt;
        return p.x > -20 && p.x < CANVAS_W + 20;
      });

      // Check remote projectiles hitting local player
      invulnRef.current -= dt;
      const remote = remoteRef.current;
      if (invulnRef.current <= 0) {
        for (let i = remoteProjRef.current.length - 1; i >= 0; i--) {
          const rp = remoteProjRef.current[i];
          if (rp.x > local.x && rp.x < local.x + PLAYER_W &&
              rp.y > local.y && rp.y < local.y + PLAYER_H) {
            local.health -= PROJ_DAMAGE;
            invulnRef.current = INVULN_TIME;
            remoteProjRef.current.splice(i, 1);
          }
        }
      }

      setLocalHealth(local.health);

      // Check win/lose
      if (local.health <= 0) {
        setWinner('remote');
      } else if (remote.health <= 0) {
        setWinner('local');
      }

      // Broadcast state
      if (now - lastBroadcastRef.current > BROADCAST_INTERVAL && channelRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'game-state',
          payload: {
            player: { ...local },
            projectiles: localProjRef.current.map(p => ({ ...p })),
            timestamp: now,
          } as BroadcastState,
        });
        lastBroadcastRef.current = now;
      }

      // --- RENDER ---
      // Background
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      // Platforms
      for (const p of PLATFORMS) {
        ctx.fillStyle = '#2d2d5e';
        ctx.fillRect(p.x, p.y, p.w, p.h);
        ctx.fillStyle = '#4a4a8a';
        ctx.fillRect(p.x, p.y, p.w, 4);
      }

      // Draw players
      const drawPlayer = (ps: PlayerState, img: HTMLImageElement | null, color: string) => {
        const flash = invulnRef.current > 0 && ps === local;
        if (flash && Math.floor(now / 100) % 2 === 0) return;

        if (img) {
          ctx.save();
          if (ps.direction === 'left') {
            ctx.translate(ps.x + PLAYER_W, ps.y);
            ctx.scale(-1, 1);
            ctx.drawImage(img, 0, 0, PLAYER_W, PLAYER_H);
          } else {
            ctx.drawImage(img, ps.x, ps.y, PLAYER_W, PLAYER_H);
          }
          ctx.restore();
        } else {
          ctx.fillStyle = color;
          ctx.fillRect(ps.x, ps.y, PLAYER_W, PLAYER_H);
        }

        // Health bar above player
        const barW = 50;
        const barH = 6;
        const barX = ps.x;
        const barY = ps.y - 12;
        ctx.fillStyle = '#333';
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = ps.health > 30 ? '#22c55e' : '#ef4444';
        ctx.fillRect(barX, barY, barW * Math.max(0, ps.health / 100), barH);
      };

      drawPlayer(local, localImgRef.current, '#00bcd4');
      drawPlayer(remote, remoteImgRef.current, '#ff6600');

      // Draw projectiles
      ctx.fillStyle = '#00ffff';
      for (const p of localProjRef.current) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#ff6600';
      for (const p of remoteProjRef.current) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }

      // HUD
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`You: ${Math.max(0, local.health)} HP`, 20, 30);
      ctx.textAlign = 'right';
      ctx.fillText(`Opponent: ${Math.max(0, remote.health)} HP`, CANVAS_W - 20, 30);
      ctx.textAlign = 'left';

      animIdRef.current = requestAnimationFrame(loop);
    };

    animIdRef.current = requestAnimationFrame(loop);

    return () => {
      if (animIdRef.current) cancelAnimationFrame(animIdRef.current);
    };
  }, [connected, winner, isHost]);

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#1a1a2e] to-[#16213e]">
      {/* Player info */}
      <div className="absolute top-4 left-24 flex items-center gap-3 bg-black/40 backdrop-blur-sm rounded-xl px-4 py-2">
        <img src={localCharacter.image_url} alt="" className="w-10 h-10 object-contain rounded" />
        <div>
          <p className="text-xs text-cyan-400">You</p>
          <p className="text-white font-bold text-sm">{localCharacter.name}</p>
        </div>
      </div>
      <div className="absolute top-4 right-4 flex items-center gap-3 bg-black/40 backdrop-blur-sm rounded-xl px-4 py-2">
        <div className="text-right">
          <p className="text-xs text-orange-400">Opponent</p>
          <p className="text-white font-bold text-sm">{remoteCharacter.name}</p>
        </div>
        <img src={remoteCharacter.image_url} alt="" className="w-10 h-10 object-contain rounded" />
      </div>

      {/* Controls hint */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/40 backdrop-blur-sm rounded-xl px-4 py-2">
        <p className="text-white/60 text-xs text-center">
          WASD/Arrows: Move • E/Enter/J: Shoot
        </p>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className="border-4 border-white/20 rounded-lg shadow-2xl"
        style={{ maxWidth: '100%' }}
      />

      {!connected && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-20">
          <p className="text-white text-2xl animate-pulse">Connecting...</p>
        </div>
      )}

      {/* Winner overlay */}
      {winner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-20">
          <h1 className="text-5xl md:text-7xl font-bold text-white mb-4 animate-pulse">
            {winner === 'local' ? '🏆 You Win! 🏆' : '💀 You Lose! 💀'}
          </h1>
          <button
            onClick={onBack}
            className="px-8 py-3 bg-white/20 text-white text-xl font-bold rounded-xl hover:bg-white/30 transition-colors mt-6"
          >
            Back to Lobby
          </button>
        </div>
      )}
    </div>
  );
};
