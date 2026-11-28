import { useEffect, useRef, useState, useCallback } from 'react';
import { MultiplayerBossRushEngine, Difficulty } from '@/vibequest/lib/multiplayerBossRushEngine';
import { VIBEQUEST_SUPABASE_URL, VIBEQUEST_SUPABASE_KEY } from '@/vibequest/supabase';
import { Character } from '@/vibequest/useCharacters';
import { TwoPlayerTouchPad, TouchControlsGuide, RotateHint, useIsTouch, usePortrait } from '@/vibequest/components/TwoPlayerTouchPad';
import { toast } from 'sonner';
import landingBackground from '@/assets/vibequest/landing-background.webp';
import goopySprite from '@/assets/vibequest/goopy-le-grande.webp';
import projectileSprite from '@/assets/vibequest/projectile.webp';

interface MultiplayerBossRushProps {
  player1Character: Character;
  player2Character: Character;
  onBack: () => void;
}

const DIFFICULTY_INFO: Record<Difficulty, { 
  name: string; 
  emoji: string; 
  color: string; 
  bgColor: string;
  description: string;
  features: string[];
}> = {
  easy: {
    name: 'EASY',
    emoji: '😊',
    color: 'text-green-400',
    bgColor: 'from-green-600/30 to-green-800/30 hover:from-green-500/40 hover:to-green-700/40',
    description: 'Chill mode for casual fun',
    features: ['5 Lives', 'Slower Boss', 'Less Damage'],
  },
  medium: {
    name: 'MEDIUM',
    emoji: '😤',
    color: 'text-yellow-400',
    bgColor: 'from-yellow-600/30 to-orange-700/30 hover:from-yellow-500/40 hover:to-orange-600/40',
    description: 'The intended experience',
    features: ['3 Lives', 'Standard Speed', 'Normal Damage'],
  },
  hard: {
    name: 'HARD',
    emoji: '💀',
    color: 'text-red-400',
    bgColor: 'from-red-600/30 to-red-900/30 hover:from-red-500/40 hover:to-red-800/40',
    description: 'For the brave and skilled',
    features: ['2 Lives', 'Aggressive Boss', '2x Score!'],
  },
};

export const MultiplayerBossRush = ({ player1Character, player2Character, onBack }: MultiplayerBossRushProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<MultiplayerBossRushEngine | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sfxRef = useRef<{ [key: string]: HTMLAudioElement }>({});
  const [isReady, setIsReady] = useState(false);
  const [isStarted, setIsStarted] = useState(false);
  const isTouch = useIsTouch();
  const portrait = usePortrait();
  const [isGameOver, setIsGameOver] = useState(false);
  const [isVictory, setIsVictory] = useState(false);
  const [score, setScore] = useState(0);
  const [player1Lives, setPlayer1Lives] = useState(3);
  const [player2Lives, setPlayer2Lives] = useState(3);
  const [bossHealth, setBossHealth] = useState({ current: 300, max: 300 });
  const [selectedDifficulty, setSelectedDifficulty] = useState<Difficulty | null>(null);
  const [hoveredDifficulty, setHoveredDifficulty] = useState<Difficulty | null>(null);
  const [isLoadingMusic, setIsLoadingMusic] = useState(false);
  const [musicLoaded, setMusicLoaded] = useState(false);
  const [musicError, setMusicError] = useState(false);
  const [sfxLoaded, setSfxLoaded] = useState(false);

  // Generate a single SFX
  const generateSfx = useCallback(async (prompt: string, duration: number): Promise<string | null> => {
    try {
      const response = await fetch(
        `${VIBEQUEST_SUPABASE_URL}/functions/v1/elevenlabs-sfx`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: VIBEQUEST_SUPABASE_KEY,
            Authorization: `Bearer ${VIBEQUEST_SUPABASE_KEY}`,
          },
          body: JSON.stringify({ prompt, duration }),
        }
      );

      if (!response.ok) return null;
      
      const audioBlob = await response.blob();
      return URL.createObjectURL(audioBlob);
    } catch (error) {
      console.error("Failed to generate SFX:", error);
      return null;
    }
  }, []);

  // Load all sound effects - SEQUENTIAL to avoid rate limits
  const loadSoundEffects = useCallback(async () => {
    if (sfxLoaded) return;
    
    console.log("Loading sound effects (sequential to avoid rate limits)...");
    
    const sfxPrompts = [
      { key: 'punchWindup', prompt: "cartoon fist windup whoosh sound, anticipation buildup, vintage 1930s style", duration: 1 },
      { key: 'punchHit', prompt: "cartoon punch impact hit sound, slapstick comedy, vintage rubber hose animation", duration: 0.5 },
      { key: 'squashLand', prompt: "cartoon blob squash landing thud, jelly bounce splat sound, rubbery impact", duration: 0.8 },
      { key: 'playerHit', prompt: "cartoon character hurt yelp sound, vintage animation pain sound effect", duration: 0.5 },
    ];

    // Load sequentially to avoid 429 rate limit errors
    for (const { key, prompt, duration } of sfxPrompts) {
      try {
        const url = await generateSfx(prompt, duration);
        if (url) {
          const audio = new Audio(url);
          audio.volume = 0.5;
          sfxRef.current[key] = audio;
        }
        // Small delay between requests to be safe
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.warn(`Failed to load SFX ${key}, continuing without it`);
      }
    }

    setSfxLoaded(true);
    console.log("Sound effects loaded (or skipped if failed)");
  }, [sfxLoaded, generateSfx]);

  // Play a sound effect
  const playSfx = useCallback((sfxName: string) => {
    const sfx = sfxRef.current[sfxName];
    if (sfx) {
      sfx.currentTime = 0;
      sfx.play().catch(console.error);
    }
  }, []);

  // Get or generate cached music (only generated once, then cached in storage)
  const loadBossMusic = useCallback(async () => {
    if (musicLoaded || isLoadingMusic) return;
    
    setIsLoadingMusic(true);
    setMusicError(false);
    
    try {
      const response = await fetch(
        `${VIBEQUEST_SUPABASE_URL}/functions/v1/elevenlabs-music`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: VIBEQUEST_SUPABASE_KEY,
            Authorization: `Bearer ${VIBEQUEST_SUPABASE_KEY}`,
          },
          body: JSON.stringify({}),
        }
      );

      if (!response.ok) {
        throw new Error(`Music loading failed: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.url) {
        const audio = new Audio(data.url);
        audio.loop = true;
        audio.volume = 0.4;
        audioRef.current = audio;
        
        setMusicLoaded(true);
        toast.success(data.cached ? "🎵 Boss music loaded!" : "🎵 Boss music generated and cached!", { position: "top-center" });
      }
    } catch (error) {
      console.error("Failed to load music:", error);
      setMusicError(true);
      toast.error("Music loading failed - playing without music", { position: "top-center" });
    } finally {
      setIsLoadingMusic(false);
    }
  }, [musicLoaded, isLoadingMusic]);

  // Start music when game starts
  const playMusic = useCallback(() => {
    if (audioRef.current && musicLoaded) {
      audioRef.current.play().catch(console.error);
    }
  }, [musicLoaded]);

  // Stop music
  const stopMusic = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, []);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      Object.values(sfxRef.current).forEach(audio => {
        URL.revokeObjectURL(audio.src);
      });
    };
  }, []);

  useEffect(() => {
    if (!canvasRef.current || !selectedDifficulty) return;

    const engine = new MultiplayerBossRushEngine(canvasRef.current, {
      onScoreUpdate: setScore,
      onPlayerHit: (player, lives) => {
        if (player === 1) setPlayer1Lives(lives);
        else setPlayer2Lives(lives);
      },
      onGameOver: () => {
        setIsGameOver(true);
        stopMusic();
      },
      onVictory: () => {
        setIsVictory(true);
        stopMusic();
      },
      onBossHealthUpdate: (current, max) => setBossHealth({ current, max }),
      onSfx: playSfx,
      difficulty: selectedDifficulty,
    });

    engineRef.current = engine;

    const loadAssets = async () => {
      try {
        await Promise.all([
          engine.loadImage(player1Character.image_url, 'player1'),
          engine.loadImage(player2Character.image_url, 'player2'),
          engine.loadImage(goopySprite, 'goopy'),
          engine.loadImage(projectileSprite, 'projectile'),
        ]);
        await engine.init();
        setIsReady(true);
        
        // Start loading music and SFX in background
        loadBossMusic();
        loadSoundEffects();
      } catch (error) {
        console.error('Failed to load assets:', error);
        await engine.init();
        setIsReady(true);
      }
    };

    loadAssets();

    return () => {
      engine.dispose();
      stopMusic();
    };
  }, [player1Character, player2Character, selectedDifficulty, loadBossMusic, loadSoundEffects, stopMusic, playSfx]);

  const handleStart = useCallback(() => {
    setIsStarted(true);
    setIsGameOver(false);
    setIsVictory(false);
    playMusic();
    engineRef.current?.start();
  }, [playMusic]);

  const handleRestart = useCallback(() => {
    setIsGameOver(false);
    setIsVictory(false);
    setPlayer1Lives(selectedDifficulty === 'easy' ? 5 : selectedDifficulty === 'hard' ? 2 : 3);
    setPlayer2Lives(selectedDifficulty === 'easy' ? 5 : selectedDifficulty === 'hard' ? 2 : 3);
    setScore(0);
    playMusic();
    engineRef.current?.restart();
  }, [selectedDifficulty, playMusic]);

  const handleGoBack = useCallback(() => {
    engineRef.current?.stop();
    stopMusic();
    if (selectedDifficulty && !isStarted) {
      setSelectedDifficulty(null);
    } else {
      onBack();
    }
  }, [onBack, selectedDifficulty, isStarted, stopMusic]);

  const handleChangeDifficulty = useCallback(() => {
    engineRef.current?.stop();
    stopMusic();
    setSelectedDifficulty(null);
    setIsStarted(false);
    setIsGameOver(false);
    setIsVictory(false);
    setIsReady(false);
    setMusicLoaded(false);
  }, [stopMusic]);

  // Difficulty Selection Screen
  if (!selectedDifficulty) {
    return (
      <div 
        className="fixed inset-0 flex overflow-y-auto p-3"
        style={{ 
          backgroundImage: `url(${landingBackground})`, 
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        }}
      >
        <div className="m-auto bg-black/85 backdrop-blur-xl rounded-3xl p-4 md:p-8 text-center space-y-4 md:space-y-8 max-w-3xl border border-white/10">
          <div className="space-y-2">
            <h1 className="text-3xl md:text-5xl font-bold bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent animate-pulse">
              🫧 GOOPY LE GRANDE 🫧
            </h1>
            <p className="text-xl text-white/80">Choose Your Challenge</p>
          </div>

          <div className="grid grid-cols-3 gap-2 md:gap-4">
            {(['easy', 'medium', 'hard'] as Difficulty[]).map((difficulty) => {
              const info = DIFFICULTY_INFO[difficulty];
              const isHovered = hoveredDifficulty === difficulty;
              
              return (
                <button
                  key={difficulty}
                  onClick={() => setSelectedDifficulty(difficulty)}
                  onMouseEnter={() => setHoveredDifficulty(difficulty)}
                  onMouseLeave={() => setHoveredDifficulty(null)}
                  className={`
                    relative overflow-hidden rounded-2xl p-3 md:p-6 transition-all duration-300 border-2 
                    bg-gradient-to-b ${info.bgColor}
                    ${isHovered ? 'scale-105 border-white/50 shadow-2xl' : 'border-white/20'}
                  `}
                >
                  {/* Glow effect */}
                  <div 
                    className={`absolute inset-0 opacity-0 transition-opacity duration-300 ${isHovered ? 'opacity-20' : ''}`}
                    style={{ 
                      background: `radial-gradient(circle at center, ${difficulty === 'easy' ? '#22c55e' : difficulty === 'medium' ? '#eab308' : '#ef4444'}, transparent 70%)` 
                    }}
                  />
                  
                  <div className="relative z-10 space-y-2 md:space-y-4">
                    <div className={`text-4xl md:text-6xl transition-transform duration-300 ${isHovered ? 'scale-125' : ''}`}>
                      {info.emoji}
                    </div>
                    <div className={`text-lg md:text-2xl font-black ${info.color}`}>
                      {info.name}
                    </div>
                    <p className="text-white/70 text-xs md:text-sm md:min-h-[40px]">
                      {info.description}
                    </p>
                    <div className="space-y-1">
                      {info.features.map((feature, i) => (
                        <div 
                          key={i} 
                          className="text-xs text-white/60 bg-white/5 rounded-full px-3 py-1"
                        >
                          {feature}
                        </div>
                      ))}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <button 
            onClick={onBack}
            className="px-8 py-3 bg-gray-600/50 hover:bg-gray-500/50 text-white font-bold rounded-xl transition-all"
          >
            ← Back to Mode Selection
          </button>
        </div>
      </div>
    );
  }

  const showMenu = !isStarted || isGameOver || isVictory;
  const difficultyInfo = DIFFICULTY_INFO[selectedDifficulty];

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center">
      <canvas 
        ref={canvasRef} 
        width={900} 
        height={550} 
        className="border-4 border-blue-500 rounded-lg"
        style={{ maxWidth: '100vw', maxHeight: '100dvh' }}
      />
      
      {showMenu && (
        <div 
          className="absolute inset-0 flex overflow-y-auto p-3"
          style={{ 
            backgroundImage: `url(${landingBackground})`, 
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        >
          <div className="m-auto bg-black/80 backdrop-blur-xl rounded-3xl p-4 md:p-8 text-center space-y-3 md:space-y-6 max-w-lg border border-white/10">
            {isGameOver && (
              <>
                <h1 className="text-3xl md:text-5xl font-bold text-red-500">GAME OVER</h1>
                <p className="text-2xl text-white">Score: {score}</p>
                <p className="text-lg text-white/70">Goopy Le Grande wins!</p>
              </>
            )}
            {isVictory && (
              <>
                <h1 className="text-3xl md:text-5xl font-bold text-yellow-400">VICTORY!</h1>
                <p className="text-2xl text-white">Goopy Le Grande defeated!</p>
                <p className="text-xl text-white">Final Score: {score}</p>
                {selectedDifficulty === 'hard' && (
                  <p className="text-sm text-red-400 font-bold">🏆 HARD MODE CHAMPION! 🏆</p>
                )}
              </>
            )}
            {!isGameOver && !isVictory && (
              <>
                <h1 className="text-3xl md:text-5xl font-bold text-blue-400">🫧 GOOPY LE GRANDE 🫧</h1>
                <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r ${difficultyInfo.bgColor}`}>
                  <span className="text-2xl">{difficultyInfo.emoji}</span>
                  <span className={`font-bold ${difficultyInfo.color}`}>{difficultyInfo.name} MODE</span>
                </div>
                <p className="text-lg text-white/80">Co-op Boss Fight!</p>
                {isTouch ? (
                  <TouchControlsGuide extras={['duck']} />
                ) : (
                <div className="grid grid-cols-2 gap-4 text-left text-white/70 text-sm">
                  <div className="bg-yellow-500/20 rounded-xl p-3">
                    <p className="text-yellow-400 font-bold mb-2">Player 1</p>
                    <p>🎮 WASD to move</p>
                    <p>⬆️ W to jump</p>
                    <p>⬇️ S to duck</p>
                    <p>💥 Space to shoot</p>
                  </div>
                  <div className="bg-cyan-500/20 rounded-xl p-3">
                    <p className="text-cyan-400 font-bold mb-2">Player 2</p>
                    <p>🎮 Arrow keys to move</p>
                    <p>⬆️ Up to jump</p>
                    <p>⬇️ Down to duck</p>
                    <p>💥 Enter to shoot</p>
                  </div>
                </div>
                )}
                <p className="text-sm text-white/60 mt-2">💡 Duck to dodge Goopy's fist punch!</p>
                
                {/* Audio loading indicator */}
                <div className="mt-4 space-y-1">
                  {isLoadingMusic && (
                    <div className="flex items-center justify-center gap-2 text-yellow-400 text-sm animate-pulse">
                      <span className="text-lg">🎵</span>
                      <span>Loading boss music...</span>
                      <span className="text-lg">🎺</span>
                    </div>
                  )}
                  {musicLoaded && !isLoadingMusic && (
                    <div className="flex items-center justify-center gap-2 text-green-400 text-sm">
                      <span className="text-lg">🎵</span>
                      <span>Boss music ready!</span>
                    </div>
                  )}
                  {sfxLoaded && (
                    <div className="flex items-center justify-center gap-2 text-green-400 text-sm">
                      <span className="text-lg">💥</span>
                      <span>Sound effects loaded!</span>
                    </div>
                  )}
                  {musicError && (
                    <div className="flex items-center justify-center gap-2 text-white/50 text-sm">
                      <span>Playing without music</span>
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="flex flex-col gap-3">
              <div className="flex gap-4 justify-center">
                <button 
                  onClick={isGameOver || isVictory ? handleRestart : handleStart} 
                  disabled={!isReady}
                  className="px-8 py-4 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 text-white font-bold rounded-xl text-xl transition-colors"
                >
                  {!isReady ? 'Loading...' : (isGameOver || isVictory ? 'Try Again' : 'START')}
                </button>
                <button 
                  onClick={handleGoBack} 
                  className="px-8 py-4 bg-gray-600 hover:bg-gray-500 text-white font-bold rounded-xl text-xl transition-colors"
                >
                  Back
                </button>
              </div>
              {(isGameOver || isVictory) && (
                <button 
                  onClick={handleChangeDifficulty}
                  className="px-6 py-2 bg-purple-600/50 hover:bg-purple-500/50 text-white font-bold rounded-xl transition-colors"
                >
                  Change Difficulty
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      
      {!showMenu && (
        <>
          {/* Difficulty badge */}
          <div className="absolute top-4 left-28">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-r ${difficultyInfo.bgColor} border border-white/20`}>
              <span>{difficultyInfo.emoji}</span>
              <span className={`text-sm font-bold ${difficultyInfo.color}`}>{difficultyInfo.name}</span>
            </div>
          </div>
          
          <div className="absolute top-4 right-4 flex gap-2">
            <button 
              onClick={handleRestart} 
              className="bg-card/80 backdrop-blur-sm rounded-xl px-4 py-2 hover:bg-card transition-colors" 
              title="Restart"
            >
              🔄
            </button>
            <button 
              onClick={handleGoBack} 
              className="bg-card/80 backdrop-blur-sm rounded-xl px-4 py-2 hover:bg-card transition-colors" 
              title="Back"
            >
              🏠
            </button>
          </div>
        </>
      )}
      {isTouch && !showMenu && <TwoPlayerTouchPad extras={['duck']} />}
      {isTouch && portrait && showMenu && <RotateHint />}
    </div>
  );
};