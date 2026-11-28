import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/vibequest/supabase';
import { useCharacters, type Character } from '@/vibequest/useCharacters';
import landingBackground from '@/assets/vibequest/landing-background.webp';

interface OnlineLobbyProps {
  initialRoomCode?: string | null;
  onGameStart: (roomCode: string, localPlayer: Character, remotePlayer: Character, isHost: boolean) => void;
  onBack: () => void;
}

type LobbyScreen = 'choose' | 'create' | 'join' | 'waiting';

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export const OnlineLobby = ({ initialRoomCode, onGameStart, onBack }: OnlineLobbyProps) => {
  const { data: characters = [] } = useCharacters();
  const [screen, setScreen] = useState<LobbyScreen>(initialRoomCode ? 'join' : 'choose');
  const [roomCode, setRoomCode] = useState(initialRoomCode || '');
  const [joinCode, setJoinCode] = useState(initialRoomCode || '');
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [remotePlayer, setRemotePlayer] = useState<{ name: string; image_url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const shareLink = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;

  // Handle creating a room
  const handleCreate = useCallback(() => {
    if (!selectedCharacter) return;
    const code = generateRoomCode();
    setRoomCode(code);
    setIsHost(true);
    setScreen('waiting');
  }, [selectedCharacter]);

  // Handle joining a room
  const handleJoin = useCallback(() => {
    if (!selectedCharacter || !joinCode.trim()) return;
    setRoomCode(joinCode.trim().toUpperCase());
    setIsHost(false);
    setScreen('waiting');
  }, [selectedCharacter, joinCode]);

  // Copy link to clipboard
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [shareLink]);

  // Realtime presence for waiting room
  useEffect(() => {
    if (screen !== 'waiting' || !roomCode || !selectedCharacter) return;

    const channelName = `online-fight-${roomCode}`;
    const channel = supabase.channel(channelName, {
      config: { presence: { key: isHost ? 'host' : 'guest' } },
    });

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const otherKey = isHost ? 'guest' : 'host';
        const otherPresence = state[otherKey];
        if (otherPresence && otherPresence.length > 0) {
          const other = otherPresence[0] as any;
          setRemotePlayer({ name: other.name, image_url: other.image_url });
        }
      })
      .on('broadcast', { event: 'start-game' }, (payload) => {
        // Game is starting - both players received this
        const data = payload.payload as any;
        const remoteChar: Character = {
          id: 'remote',
          name: data.name,
          image_url: data.image_url,
          is_default: false,
        };
        onGameStart(roomCode, selectedCharacter, remoteChar, isHost);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({
            name: selectedCharacter.name,
            image_url: selectedCharacter.image_url,
          });
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [screen, roomCode, selectedCharacter, isHost, onGameStart]);

  // When both players are present, host can start the game
  const handleStartGame = useCallback(() => {
    if (!remotePlayer || !selectedCharacter) return;
    const channelName = `online-fight-${roomCode}`;
    const channel = supabase.channel(channelName);
    
    // Broadcast start to both players
    channel.send({
      type: 'broadcast',
      event: 'start-game',
      payload: {
        name: selectedCharacter.name,
        image_url: selectedCharacter.image_url,
      },
    });

    // Host also starts locally
    const remoteChar: Character = {
      id: 'remote',
      name: remotePlayer.name,
      image_url: remotePlayer.image_url,
      is_default: false,
    };
    onGameStart(roomCode, selectedCharacter, remoteChar, isHost);
  }, [remotePlayer, selectedCharacter, roomCode, isHost, onGameStart]);

  return (
    <div
      className="fixed inset-0 overflow-y-auto"
      style={{
        backgroundImage: `url(${landingBackground})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      <div className="min-h-screen flex flex-col items-center justify-center py-8 px-4">
        <div className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-8 md:p-12 shadow-2xl max-w-2xl w-full">
          
          {/* CHOOSE: Create or Join */}
          {screen === 'choose' && (
            <div className="space-y-6 text-center">
              <h1 className="text-4xl md:text-5xl font-bold text-white">⚔️ Online Fighter</h1>
              <p className="text-white/80 text-lg">Battle a friend from another device!</p>
              
              {/* Character Select */}
              <div>
                <p className="text-white/90 font-semibold mb-3">Pick your fighter:</p>
                <div className="grid grid-cols-4 md:grid-cols-6 gap-3 max-h-48 overflow-y-auto">
                  {characters.map((char) => (
                    <button
                      key={char.id}
                      onClick={() => setSelectedCharacter(char)}
                      className={`p-2 rounded-xl border-2 transition-all ${
                        selectedCharacter?.id === char.id
                          ? 'border-cyan-400 bg-cyan-400/20 scale-105'
                          : 'border-white/20 bg-white/5 hover:bg-white/10'
                      }`}
                    >
                      <img src={char.image_url} alt={char.name} className="w-12 h-12 object-contain mx-auto" />
                      <p className="text-white text-xs mt-1 truncate">{char.name}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-4 justify-center pt-2">
                <button
                  onClick={handleCreate}
                  disabled={!selectedCharacter}
                  className="px-8 py-4 bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-xl font-bold rounded-xl hover:scale-105 transition-transform disabled:opacity-40 disabled:hover:scale-100"
                >
                  🏠 Create Room
                </button>
                <button
                  onClick={() => {
                    if (!selectedCharacter) return;
                    setScreen('join');
                  }}
                  disabled={!selectedCharacter}
                  className="px-8 py-4 bg-gradient-to-r from-orange-500 to-red-500 text-white text-xl font-bold rounded-xl hover:scale-105 transition-transform disabled:opacity-40 disabled:hover:scale-100"
                >
                  🔗 Join Room
                </button>
              </div>

              <button onClick={onBack} className="text-white/60 hover:text-white transition-colors">
                ← Back to Modes
              </button>
            </div>
          )}

          {/* JOIN: Enter room code */}
          {screen === 'join' && (
            <div className="space-y-6 text-center">
              <h1 className="text-3xl font-bold text-white">🔗 Join Room</h1>

              {!selectedCharacter && (
                <div>
                  <p className="text-white/90 font-semibold mb-3">Pick your fighter:</p>
                  <div className="grid grid-cols-4 md:grid-cols-6 gap-3 max-h-48 overflow-y-auto">
                    {characters.map((char) => (
                      <button
                        key={char.id}
                        onClick={() => setSelectedCharacter(char)}
                        className={`p-2 rounded-xl border-2 transition-all ${
                          selectedCharacter?.id === char.id
                            ? 'border-cyan-400 bg-cyan-400/20 scale-105'
                            : 'border-white/20 bg-white/5 hover:bg-white/10'
                        }`}
                      >
                        <img src={char.image_url} alt={char.name} className="w-12 h-12 object-contain mx-auto" />
                        <p className="text-white text-xs mt-1 truncate">{char.name}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="text-white/80 mb-2">Enter the 4-letter room code:</p>
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase().slice(0, 4))}
                  placeholder="ABCD"
                  maxLength={4}
                  className="w-48 text-center text-3xl font-mono tracking-[0.5em] bg-white/10 border-2 border-white/30 rounded-xl px-4 py-3 text-white placeholder:text-white/30 focus:border-cyan-400 focus:outline-none"
                />
              </div>

              {error && <p className="text-red-400">{error}</p>}

              <div className="flex gap-4 justify-center">
                <button
                  onClick={handleJoin}
                  disabled={!selectedCharacter || joinCode.length < 4}
                  className="px-8 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white text-xl font-bold rounded-xl hover:scale-105 transition-transform disabled:opacity-40"
                >
                  Join Game
                </button>
                <button
                  onClick={() => setScreen('choose')}
                  className="px-6 py-3 bg-white/20 text-white rounded-xl hover:bg-white/30 transition-colors"
                >
                  Back
                </button>
              </div>
            </div>
          )}

          {/* WAITING: Room created, waiting for opponent */}
          {screen === 'waiting' && (
            <div className="space-y-6 text-center">
              <h1 className="text-3xl font-bold text-white">
                {remotePlayer ? '⚔️ Ready to Fight!' : '⏳ Waiting for Opponent...'}
              </h1>

              {/* Room Code Display */}
              <div className="bg-black/30 rounded-2xl p-6 space-y-3">
                <p className="text-white/70 text-sm">Room Code</p>
                <p className="text-5xl font-mono font-bold text-cyan-400 tracking-[0.5em]">{roomCode}</p>
                <div className="flex gap-2 justify-center">
                  <button
                    onClick={handleCopy}
                    className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 transition-colors text-sm"
                  >
                    {copied ? '✅ Copied!' : '📋 Copy Link'}
                  </button>
                </div>
                <p className="text-white/50 text-xs break-all">{shareLink}</p>
              </div>

              {/* Players */}
              <div className="flex items-center justify-center gap-8">
                <div className="text-center">
                  <img src={selectedCharacter?.image_url} alt="" className="w-20 h-20 object-contain mx-auto mb-2" />
                  <p className="text-cyan-400 font-bold">{selectedCharacter?.name}</p>
                  <p className="text-white/60 text-xs">You {isHost ? '(Host)' : '(Guest)'}</p>
                </div>
                <div className="text-3xl text-white">VS</div>
                <div className="text-center">
                  {remotePlayer ? (
                    <>
                      <img src={remotePlayer.image_url} alt="" className="w-20 h-20 object-contain mx-auto mb-2" />
                      <p className="text-orange-400 font-bold">{remotePlayer.name}</p>
                      <p className="text-white/60 text-xs">Opponent</p>
                    </>
                  ) : (
                    <>
                      <div className="w-20 h-20 mx-auto mb-2 rounded-xl border-2 border-dashed border-white/30 flex items-center justify-center">
                        <span className="text-3xl animate-pulse">❓</span>
                      </div>
                      <p className="text-white/40">Waiting...</p>
                    </>
                  )}
                </div>
              </div>

              {/* Start Button (host only, when both present) */}
              {isHost && remotePlayer && (
                <button
                  onClick={handleStartGame}
                  className="px-12 py-4 bg-gradient-to-r from-green-500 to-emerald-600 text-white text-2xl font-bold rounded-xl hover:scale-105 transition-transform animate-pulse"
                >
                  🎮 START FIGHT!
                </button>
              )}

              {!isHost && remotePlayer && (
                <p className="text-white/60 text-lg">Waiting for host to start...</p>
              )}

              <button onClick={onBack} className="text-white/60 hover:text-white transition-colors">
                ← Leave Room
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
