import { useEffect, useRef, useState, useCallback } from 'react';
import { CagneyBossEngine, Difficulty } from '@/vibequest/lib/cagneyBossEngine';
import { Character } from '@/vibequest/useCharacters';
import { toast } from 'sonner';
import landingBackground from '@/assets/vibequest/landing-background.webp';
import projectileSprite from '@/assets/vibequest/projectile.webp';

interface CagneyBossRushProps {
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
    emoji: '🌸',
    color: 'text-green-400',
    bgColor: 'from-green-600/30 to-green-800/30 hover:from-green-500/40 hover:to-green-700/40',
    description: 'A pleasant garden stroll',
    features: ['5 Lives', 'Slower Attacks', 'Less Damage'],
  },
  medium: {
    name: 'MEDIUM',
    emoji: '🌺',
    color: 'text-yellow-400',
    bgColor: 'from-yellow-600/30 to-orange-700/30 hover:from-yellow-500/40 hover:to-orange-600/40',
    description: 'The intended experience',
    features: ['3 Lives', 'Standard Speed', 'Normal Damage'],
  },
  hard: {
    name: 'HARD',
    emoji: '🥀',
    color: 'text-red-400',
    bgColor: 'from-red-600/30 to-red-900/30 hover:from-red-500/40 hover:to-red-800/40',
    description: 'A thorny nightmare',
    features: ['2 Lives', 'Relentless Attacks', '2x Score!'],
  },
};

export const CagneyBossRush = ({ player1Character, player2Character, onBack }: CagneyBossRushProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CagneyBossEngine | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isStarted, setIsStarted] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isVictory, setIsVictory] = useState(false);
  const [score, setScore] = useState(0);
  const [player1Lives, setPlayer1Lives] = useState(3);
  const [player2Lives, setPlayer2Lives] = useState(3);
  const [bossHealth, setBossHealth] = useState({ current: 400, max: 400 });
  const [selectedDifficulty, setSelectedDifficulty] = useState<Difficulty | null>(null);
  const [hoveredDifficulty, setHoveredDifficulty] = useState<Difficulty | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !selectedDifficulty) return;

    const engine = new CagneyBossEngine(canvasRef.current, {
      onScoreUpdate: setScore,
      onPlayerHit: (player, lives) => {
        if (player === 1) setPlayer1Lives(lives);
        else setPlayer2Lives(lives);
      },
      onGameOver: () => {
        setIsGameOver(true);
      },
      onVictory: () => {
        setIsVictory(true);
      },
      onBossHealthUpdate: (current, max) => setBossHealth({ current, max }),
      difficulty: selectedDifficulty,
    });

    engineRef.current = engine;

    const loadAssets = async () => {
      try {
        await Promise.all([
          engine.loadImage(player1Character.image_url, 'player1'),
          engine.loadImage(player2Character.image_url, 'player2'),
          engine.loadImage(projectileSprite, 'projectile'),
        ]);
        await engine.init();
        setIsReady(true);
      } catch (error) {
        console.error('Failed to load assets:', error);
        await engine.init();
        setIsReady(true);
      }
    };

    loadAssets();

    return () => {
      engine.dispose();
    };
  }, [player1Character, player2Character, selectedDifficulty]);

  const handleStart = useCallback(() => {
    setIsStarted(true);
    setIsGameOver(false);
    setIsVictory(false);
    engineRef.current?.start();
  }, []);

  const handleRestart = useCallback(() => {
    setIsGameOver(false);
    setIsVictory(false);
    setPlayer1Lives(selectedDifficulty === 'easy' ? 5 : selectedDifficulty === 'hard' ? 2 : 3);
    setPlayer2Lives(selectedDifficulty === 'easy' ? 5 : selectedDifficulty === 'hard' ? 2 : 3);
    setScore(0);
    engineRef.current?.restart();
  }, [selectedDifficulty]);

  const handleGoBack = useCallback(() => {
    engineRef.current?.stop();
    if (selectedDifficulty && !isStarted) {
      setSelectedDifficulty(null);
    } else {
      onBack();
    }
  }, [onBack, selectedDifficulty, isStarted]);

  const handleChangeDifficulty = useCallback(() => {
    engineRef.current?.stop();
    setSelectedDifficulty(null);
    setIsStarted(false);
    setIsGameOver(false);
    setIsVictory(false);
    setIsReady(false);
  }, []);

  // Difficulty Selection Screen
  if (!selectedDifficulty) {
    return (
      <div 
        className="fixed inset-0 flex items-center justify-center"
        style={{ 
          backgroundImage: `url(${landingBackground})`, 
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        }}
      >
        <div className="bg-black/85 backdrop-blur-xl rounded-3xl p-8 text-center space-y-8 max-w-3xl mx-4 border border-white/10">
          <div className="space-y-2">
            <h1 className="text-5xl font-bold bg-gradient-to-r from-pink-400 via-red-400 to-yellow-400 bg-clip-text text-transparent animate-pulse">
              🌸 CAGNEY CARNATION 🌸
            </h1>
            <p className="text-xl text-white/80">Choose Your Challenge</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                    relative overflow-hidden rounded-2xl p-6 transition-all duration-300 border-2 
                    bg-gradient-to-b ${info.bgColor}
                    ${isHovered ? 'scale-105 border-white/50 shadow-2xl' : 'border-white/20'}
                  `}
                >
                  <div 
                    className={`absolute inset-0 opacity-0 transition-opacity duration-300 ${isHovered ? 'opacity-20' : ''}`}
                    style={{ 
                      background: `radial-gradient(circle at center, ${difficulty === 'easy' ? '#22c55e' : difficulty === 'medium' ? '#eab308' : '#ef4444'}, transparent 70%)` 
                    }}
                  />
                  
                  <div className="relative z-10 space-y-4">
                    <div className={`text-6xl transition-transform duration-300 ${isHovered ? 'scale-125' : ''}`}>
                      {info.emoji}
                    </div>
                    <div className={`text-2xl font-black ${info.color}`}>
                      {info.name}
                    </div>
                    <p className="text-white/70 text-sm min-h-[40px]">
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
        className="border-4 border-pink-500 rounded-lg"
      />
      
      {showMenu && (
        <div 
          className="absolute inset-0 flex items-center justify-center"
          style={{ 
            backgroundImage: `url(${landingBackground})`, 
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        >
          <div className="bg-black/80 backdrop-blur-xl rounded-3xl p-8 text-center space-y-6 max-w-lg border border-white/10">
            {isGameOver && (
              <>
                <h1 className="text-5xl font-bold text-red-500">GAME OVER</h1>
                <p className="text-2xl text-white">Score: {score}</p>
                <p className="text-lg text-white/70">Cagney Carnation wins!</p>
              </>
            )}
            {isVictory && (
              <>
                <h1 className="text-5xl font-bold text-yellow-400">VICTORY!</h1>
                <p className="text-2xl text-white">Cagney Carnation defeated!</p>
                <p className="text-xl text-white">Final Score: {score}</p>
                {selectedDifficulty === 'hard' && (
                  <p className="text-sm text-red-400 font-bold">🏆 HARD MODE CHAMPION! 🏆</p>
                )}
              </>
            )}
            {!isGameOver && !isVictory && (
              <>
                <h1 className="text-5xl font-bold text-pink-400">🌸 CAGNEY CARNATION 🌸</h1>
                <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r ${difficultyInfo.bgColor}`}>
                  <span className="text-2xl">{difficultyInfo.emoji}</span>
                  <span className={`font-bold ${difficultyInfo.color}`}>{difficultyInfo.name} MODE</span>
                </div>
                <p className="text-lg text-white/80">Co-op Boss Fight!</p>
                <div className="grid grid-cols-2 gap-4 text-left text-white/70 text-sm">
                  <div className="bg-yellow-500/20 rounded-xl p-3">
                    <p className="text-yellow-400 font-bold mb-2">Player 1</p>
                    <p>🎮 WASD to move</p>
                    <p>⬆️ W to jump</p>
                    <p>💥 Space to shoot</p>
                  </div>
                  <div className="bg-cyan-500/20 rounded-xl p-3">
                    <p className="text-cyan-400 font-bold mb-2">Player 2</p>
                    <p>🎮 Arrow keys to move</p>
                    <p>⬆️ Up to jump</p>
                    <p>💥 Enter to shoot</p>
                  </div>
                </div>
                <div className="text-sm text-white/60 space-y-1">
                  <p>🌺 Use platforms to dodge attacks!</p>
                  <p>⚠️ Watch for root warnings in Phase 2!</p>
                </div>
              </>
            )}
            
            <div className="space-x-4">
              {(isGameOver || isVictory) && (
                <button 
                  onClick={handleRestart}
                  className="px-6 py-3 bg-gradient-to-r from-pink-500 to-red-500 hover:from-pink-400 hover:to-red-400 text-white font-bold rounded-xl shadow-lg transition-all"
                >
                  Play Again
                </button>
              )}
              {!isGameOver && !isVictory && isReady && (
                <button 
                  onClick={handleStart}
                  className="px-8 py-4 bg-gradient-to-r from-pink-500 to-yellow-500 hover:from-pink-400 hover:to-yellow-400 text-white text-2xl font-bold rounded-xl shadow-lg transition-all animate-pulse"
                >
                  🌸 FIGHT! 🌸
                </button>
              )}
              {!isReady && !isGameOver && !isVictory && (
                <div className="text-white/50 animate-pulse">Loading assets...</div>
              )}
              <button 
                onClick={handleChangeDifficulty}
                className="px-6 py-3 bg-purple-600/50 hover:bg-purple-500/50 text-white font-bold rounded-xl transition-all"
              >
                Change Difficulty
              </button>
              <button 
                onClick={handleGoBack}
                className="px-6 py-3 bg-gray-600/50 hover:bg-gray-500/50 text-white font-bold rounded-xl transition-all"
              >
                Back
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
