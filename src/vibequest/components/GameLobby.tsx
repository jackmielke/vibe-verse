import { useState, useEffect, useRef, useCallback } from 'react';
import { Character } from '@/vibequest/useCharacters';
import { GameMode } from '@/vibequest/components/GameModeSelection';
import { MessageCircle, Send, Users, Gamepad2, Settings, Volume2, VolumeX } from 'lucide-react';
import landingBackground from '@/assets/vibequest/landing-background.webp';

interface LobbyPlayer {
  id: string;
  character: Character;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  isJumping: boolean;
  facingRight: boolean;
  isReady: boolean;
  name: string;
}

interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
}

interface GameLobbyProps {
  selectedCharacter: Character;
  selectedMode: GameMode;
  onStartGame: () => void;
  onBack: () => void;
  onChangeCharacter: () => void;
}

// Lobby environment objects
const LOBBY_OBJECTS = [
  { id: 'arcade1', type: 'arcade', x: 150, y: 280, label: 'Boss Rush' },
  { id: 'arcade2', type: 'arcade', x: 400, y: 280, label: 'Classic' },
  { id: 'arcade3', type: 'arcade', x: 650, y: 280, label: 'Zombie' },
  { id: 'couch', type: 'couch', x: 850, y: 320 },
  { id: 'table', type: 'table', x: 1000, y: 340 },
  { id: 'portal', type: 'portal', x: 1150, y: 250 },
];

const GRAVITY = 0.8;
const MOVE_SPEED = 5;
const JUMP_FORCE = -15;
const GROUND_Y = 400;

export const GameLobby = ({ 
  selectedCharacter, 
  selectedMode, 
  onStartGame, 
  onBack, 
  onChangeCharacter 
}: GameLobbyProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [player, setPlayer] = useState<LobbyPlayer>({
    id: 'player1',
    character: selectedCharacter,
    x: 200,
    y: GROUND_Y,
    velocityX: 0,
    velocityY: 0,
    isJumping: false,
    facingRight: true,
    isReady: false,
    name: 'You'
  });
  
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { id: '1', playerId: 'system', playerName: 'System', message: 'Welcome to the lobby! Walk around and explore.', timestamp: Date.now() },
    { id: '2', playerId: 'system', playerName: 'System', message: 'Press SPACE or tap the portal to start!', timestamp: Date.now() + 1 },
  ]);
  const [chatInput, setChatInput] = useState('');
  const [showChat, setShowChat] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [keys, setKeys] = useState({ left: false, right: false, up: false });
  const [nearPortal, setNearPortal] = useState(false);
  const [portalPulse, setPortalPulse] = useState(0);
  
  const characterImageRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef(0);

  // Load character image
  useEffect(() => {
    const img = new Image();
    img.src = selectedCharacter.image_url;
    img.onload = () => {
      characterImageRef.current = img;
    };
  }, [selectedCharacter]);

  // Handle keyboard input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        setKeys(k => ({ ...k, left: true }));
      }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        setKeys(k => ({ ...k, right: true }));
      }
      if ((e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W' || e.key === ' ') && !player.isJumping) {
        setKeys(k => ({ ...k, up: true }));
      }
      if (e.key === 'Enter' && nearPortal) {
        onStartGame();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        setKeys(k => ({ ...k, left: false }));
      }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        setKeys(k => ({ ...k, right: false }));
      }
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W' || e.key === ' ') {
        setKeys(k => ({ ...k, up: false }));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [player.isJumping, nearPortal, onStartGame]);

  // Game loop for physics
  useEffect(() => {
    const gameLoop = () => {
      setPlayer(prev => {
        let newVelocityX = 0;
        let newVelocityY = prev.velocityY + GRAVITY;
        let newFacingRight = prev.facingRight;
        
        if (keys.left) {
          newVelocityX = -MOVE_SPEED;
          newFacingRight = false;
        }
        if (keys.right) {
          newVelocityX = MOVE_SPEED;
          newFacingRight = true;
        }
        if (keys.up && !prev.isJumping) {
          newVelocityY = JUMP_FORCE;
        }

        let newX = prev.x + newVelocityX;
        let newY = prev.y + newVelocityY;
        let newIsJumping = true;

        // Ground collision
        if (newY >= GROUND_Y) {
          newY = GROUND_Y;
          newVelocityY = 0;
          newIsJumping = false;
        }

        // Boundary limits
        newX = Math.max(40, Math.min(1240, newX));

        // Check portal proximity
        const portal = LOBBY_OBJECTS.find(o => o.type === 'portal');
        if (portal) {
          const dist = Math.abs(newX - portal.x);
          setNearPortal(dist < 80);
        }

        return {
          ...prev,
          x: newX,
          y: newY,
          velocityX: newVelocityX,
          velocityY: newVelocityY,
          isJumping: newIsJumping,
          facingRight: newFacingRight
        };
      });

      // Portal pulse animation
      setPortalPulse(p => (p + 0.1) % (Math.PI * 2));

      frameRef.current = requestAnimationFrame(gameLoop);
    };

    frameRef.current = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(frameRef.current);
  }, [keys]);

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      // Clear
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw ground with gradient
      const groundGradient = ctx.createLinearGradient(0, GROUND_Y + 20, 0, canvas.height);
      groundGradient.addColorStop(0, '#2d1b4e');
      groundGradient.addColorStop(1, '#1a0f2e');
      ctx.fillStyle = groundGradient;
      ctx.fillRect(0, GROUND_Y + 40, canvas.width, canvas.height - GROUND_Y);

      // Draw floor tiles
      ctx.fillStyle = '#3d2b5e';
      for (let i = 0; i < canvas.width; i += 80) {
        ctx.fillRect(i, GROUND_Y + 40, 78, 10);
        ctx.fillStyle = '#4d3b6e';
        ctx.fillRect(i + 2, GROUND_Y + 42, 74, 6);
        ctx.fillStyle = '#3d2b5e';
      }

      // Draw lobby objects
      LOBBY_OBJECTS.forEach(obj => {
        if (obj.type === 'arcade') {
          // Arcade cabinet
          ctx.fillStyle = '#1a1a2e';
          ctx.fillRect(obj.x - 30, obj.y, 60, 100);
          ctx.fillStyle = '#16213e';
          ctx.fillRect(obj.x - 25, obj.y + 10, 50, 40);
          
          // Screen glow
          const screenGlow = ctx.createRadialGradient(obj.x, obj.y + 30, 0, obj.x, obj.y + 30, 30);
          screenGlow.addColorStop(0, 'rgba(0, 255, 200, 0.5)');
          screenGlow.addColorStop(1, 'rgba(0, 255, 200, 0)');
          ctx.fillStyle = screenGlow;
          ctx.fillRect(obj.x - 25, obj.y + 10, 50, 40);
          
          // Label
          ctx.fillStyle = '#00ffc8';
          ctx.font = '10px Arial';
          ctx.textAlign = 'center';
          ctx.fillText(obj.label || '', obj.x, obj.y + 90);
        }
        
        if (obj.type === 'couch') {
          ctx.fillStyle = '#8b4513';
          ctx.fillRect(obj.x - 50, obj.y, 100, 50);
          ctx.fillStyle = '#a0522d';
          ctx.fillRect(obj.x - 45, obj.y - 20, 90, 25);
        }
        
        if (obj.type === 'table') {
          ctx.fillStyle = '#654321';
          ctx.fillRect(obj.x - 30, obj.y, 60, 10);
          ctx.fillRect(obj.x - 25, obj.y + 10, 10, 40);
          ctx.fillRect(obj.x + 15, obj.y + 10, 10, 40);
        }
        
        if (obj.type === 'portal') {
          // Portal effect
          const pulseScale = 1 + Math.sin(portalPulse) * 0.15;
          const portalGlow = ctx.createRadialGradient(obj.x, obj.y + 50, 0, obj.x, obj.y + 50, 80 * pulseScale);
          portalGlow.addColorStop(0, 'rgba(138, 43, 226, 0.9)');
          portalGlow.addColorStop(0.5, 'rgba(75, 0, 130, 0.6)');
          portalGlow.addColorStop(1, 'rgba(138, 43, 226, 0)');
          
          ctx.beginPath();
          ctx.ellipse(obj.x, obj.y + 50, 50 * pulseScale, 70 * pulseScale, 0, 0, Math.PI * 2);
          ctx.fillStyle = portalGlow;
          ctx.fill();
          
          // Inner portal
          ctx.beginPath();
          ctx.ellipse(obj.x, obj.y + 50, 30, 50, 0, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(200, 100, 255, 0.8)';
          ctx.fill();
          
          // Portal particles
          for (let i = 0; i < 8; i++) {
            const angle = (portalPulse * 2 + i * Math.PI / 4);
            const px = obj.x + Math.cos(angle) * 40;
            const py = obj.y + 50 + Math.sin(angle) * 60;
            ctx.beginPath();
            ctx.arc(px, py, 3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 200, 255, 0.8)';
            ctx.fill();
          }
          
          // "START" text
          if (nearPortal) {
            ctx.font = 'bold 16px Arial';
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.fillText('ENTER to START!', obj.x, obj.y - 20);
          } else {
            ctx.font = '12px Arial';
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.textAlign = 'center';
            ctx.fillText('START GAME', obj.x, obj.y - 20);
          }
        }
      });

      // Draw player
      const playerSize = 64;
      if (characterImageRef.current) {
        ctx.save();
        if (!player.facingRight) {
          ctx.translate(player.x + playerSize / 2, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(
            characterImageRef.current, 
            0, 
            player.y - playerSize + 20, 
            playerSize, 
            playerSize
          );
        } else {
          ctx.drawImage(
            characterImageRef.current, 
            player.x - playerSize / 2, 
            player.y - playerSize + 20, 
            playerSize, 
            playerSize
          );
        }
        ctx.restore();
        
        // Player name tag
        ctx.font = 'bold 12px Arial';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(player.name, player.x, player.y - 50);
      } else {
        // Fallback rectangle
        ctx.fillStyle = '#ff6b6b';
        ctx.fillRect(player.x - 20, player.y - 40, 40, 60);
      }

      // Draw "WASD to move" hint
      ctx.font = '14px Arial';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.textAlign = 'left';
      ctx.fillText('WASD or Arrow Keys to move', 20, 30);

      raf = requestAnimationFrame(render);
    };

    let raf = 0;
    render();
    return () => cancelAnimationFrame(raf);
  }, [player, nearPortal, portalPulse]);

  const sendMessage = useCallback(() => {
    if (chatInput.trim()) {
      setChatMessages(prev => [...prev, {
        id: Date.now().toString(),
        playerId: 'player1',
        playerName: 'You',
        message: chatInput.trim(),
        timestamp: Date.now()
      }]);
      setChatInput('');
    }
  }, [chatInput]);

  return (
    <div 
      className="fixed inset-0 overflow-hidden"
      style={{
        backgroundImage: `url(${landingBackground})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {/* Dark overlay */}
      <div className="absolute inset-0 bg-black/40" />
      
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-30 p-4">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center gap-4">
            <button 
              onClick={onBack}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 backdrop-blur-sm rounded-lg text-white transition-all"
            >
              ← Back
            </button>
            <div className="px-4 py-2 bg-gradient-to-r from-purple-600/80 to-pink-600/80 backdrop-blur-sm rounded-lg">
              <span className="text-white font-bold">{selectedMode.replace('-', ' ').toUpperCase()}</span>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={onChangeCharacter}
              className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 backdrop-blur-sm rounded-lg text-white transition-all"
            >
              <img 
                src={selectedCharacter.image_url} 
                alt={selectedCharacter.name}
                className="w-8 h-8 rounded-full object-cover border-2 border-white/50"
              />
              <span className="hidden sm:inline">Change</span>
            </button>
            
            <button 
              onClick={() => setSoundEnabled(!soundEnabled)}
              className="p-2 bg-white/10 hover:bg-white/20 backdrop-blur-sm rounded-lg text-white transition-all"
            >
              {soundEnabled ? <Volume2 size={20} /> : <VolumeX size={20} />}
            </button>
          </div>
        </div>
      </div>

      {/* Main lobby area */}
      <div className="relative z-10 flex flex-col h-full pt-20 pb-4 px-4">
        {/* Canvas game area */}
        <div className="flex-1 flex items-center justify-center">
          <div className="relative w-full max-w-5xl">
            <canvas
              ref={canvasRef}
              width={1280}
              height={500}
              className="w-full h-auto rounded-2xl border-4 border-purple-500/50 shadow-2xl shadow-purple-500/20"
              style={{ 
                imageRendering: 'pixelated',
                background: 'linear-gradient(180deg, #1a0a2e 0%, #2d1b4e 50%, #1a0f2e 100%)'
              }}
            />
            
            {/* Mobile controls */}
            <div className="absolute bottom-4 left-4 flex gap-2 lg:hidden">
              <button 
                className="w-14 h-14 bg-white/20 backdrop-blur-sm rounded-xl text-white text-2xl active:bg-white/40"
                onTouchStart={() => setKeys(k => ({ ...k, left: true }))}
                onTouchEnd={() => setKeys(k => ({ ...k, left: false }))}
              >
                ←
              </button>
              <button 
                className="w-14 h-14 bg-white/20 backdrop-blur-sm rounded-xl text-white text-2xl active:bg-white/40"
                onTouchStart={() => setKeys(k => ({ ...k, right: true }))}
                onTouchEnd={() => setKeys(k => ({ ...k, right: false }))}
              >
                →
              </button>
            </div>
            <div className="absolute bottom-4 right-4 flex gap-2 lg:hidden">
              <button 
                className="w-14 h-14 bg-white/20 backdrop-blur-sm rounded-xl text-white text-2xl active:bg-white/40"
                onTouchStart={() => setKeys(k => ({ ...k, up: true }))}
                onTouchEnd={() => setKeys(k => ({ ...k, up: false }))}
              >
                ↑
              </button>
              <button 
                className="w-16 h-14 bg-gradient-to-r from-purple-500 to-pink-500 rounded-xl text-white font-bold active:scale-95"
                onClick={onStartGame}
              >
                GO!
              </button>
            </div>
          </div>
        </div>

        {/* Bottom panel with chat and quick actions */}
        <div className="flex gap-4 max-w-5xl mx-auto w-full mt-4">
          {/* Chat panel */}
          <div 
            className={`flex-1 bg-black/40 backdrop-blur-sm rounded-xl overflow-hidden transition-all ${
              showChat ? 'max-h-48' : 'max-h-12'
            }`}
          >
            <button 
              className="w-full px-4 py-3 flex items-center justify-between text-white hover:bg-white/10 transition-colors"
              onClick={() => setShowChat(!showChat)}
            >
              <div className="flex items-center gap-2">
                <MessageCircle size={18} />
                <span className="font-medium">Chat</span>
              </div>
              <span className="text-white/60">{showChat ? '▼' : '▲'}</span>
            </button>
            
            {showChat && (
              <div className="p-3 pt-0">
                <div className="h-20 overflow-y-auto mb-2 space-y-1">
                  {chatMessages.map(msg => (
                    <div key={msg.id} className="text-sm">
                      <span className={`font-medium ${msg.playerId === 'system' ? 'text-yellow-400' : 'text-purple-400'}`}>
                        {msg.playerName}:
                      </span>
                      <span className="text-white/80 ml-2">{msg.message}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && sendMessage()}
                    placeholder="Type a message..."
                    className="flex-1 px-3 py-2 bg-white/10 rounded-lg text-white placeholder-white/40 text-sm outline-none focus:ring-2 ring-purple-500/50"
                  />
                  <button 
                    onClick={sendMessage}
                    className="p-2 bg-purple-500 hover:bg-purple-600 rounded-lg text-white transition-colors"
                  >
                    <Send size={18} />
                  </button>
                </div>
              </div>
            )}
          </div>
          
          {/* Quick action buttons */}
          <div className="flex flex-col gap-2">
            <button
              onClick={onStartGame}
              className="px-8 py-4 bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 rounded-xl font-bold text-white shadow-lg shadow-green-500/30 transition-all hover:scale-105 active:scale-95"
            >
              <div className="flex items-center gap-2">
                <Gamepad2 size={24} />
                <span>START GAME</span>
              </div>
            </button>
            
            <div className="flex gap-2">
              <button className="flex-1 px-4 py-2 bg-white/10 hover:bg-white/20 backdrop-blur-sm rounded-lg text-white text-sm transition-all flex items-center justify-center gap-1">
                <Users size={16} />
                <span className="hidden sm:inline">Invite</span>
              </button>
              <button className="flex-1 px-4 py-2 bg-white/10 hover:bg-white/20 backdrop-blur-sm rounded-lg text-white text-sm transition-all flex items-center justify-center gap-1">
                <Settings size={16} />
                <span className="hidden sm:inline">Settings</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
