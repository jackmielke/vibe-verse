import { useEffect, useRef, useState } from 'react';
import { GameEngine } from '@/vibequest/lib/gameEngine';
import { Character } from '@/vibequest/useCharacters';
import { GameMode } from '@/vibequest/components/GameModeSelection';
import coinSprite from '@/assets/vibequest/vibe-coin.webp';
import fnafEnemySprite from '@/assets/vibequest/fnaf-enemy.webp';
import zombieEnemySprite from '@/assets/vibequest/zombie-enemy.webp';
import skeletonEnemySprite from '@/assets/vibequest/skeleton-enemy.webp';
import skeletonBossSprite from '@/assets/vibequest/skeleton-boss.webp';
import candySprite from '@/assets/vibequest/candy-collectible.webp';
import pumpkinDecoration from '@/assets/vibequest/pumpkin-decoration.webp';
import ghostDecoration from '@/assets/vibequest/ghost-decoration.webp';
import batDecoration from '@/assets/vibequest/bat-decoration.webp';
import secretTreasure from '@/assets/vibequest/secret-treasure.webp';
import portalSprite from '@/assets/vibequest/goal-portal.webp';
import skyBackground from '@/assets/vibequest/sky-background.webp';
import landingBackground from '@/assets/vibequest/landing-background.webp';
import robotMascot from '@/assets/vibequest/robot-mascot.webp';

interface GameProps {
  selectedCharacter: Character;
  gameMode: GameMode;
  onChangeCharacter?: () => void;
  onChangeMode?: () => void;
}

export const Game = ({ selectedCharacter, gameMode, onChangeCharacter, onChangeMode }: GameProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameEngineRef = useRef<GameEngine | null>(null);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [isGameWon, setIsGameWon] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isGameStarted, setIsGameStarted] = useState(false);
  const [isGameRunning, setIsGameRunning] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState<number | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [currentLevel, setCurrentLevel] = useState(1);
  const [totalLevels, setTotalLevels] = useState(1);
  const startTimeRef = useRef<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [finalTime, setFinalTime] = useState(0);
  const [playerName, setPlayerName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [leaderboard, setLeaderboard] = useState<Array<{name: string, time: number, score: number, date: string}>>([]);
  const [enemiesStomped, setEnemiesStomped] = useState(0);
  const [showWorldSelection, setShowWorldSelection] = useState(false);
  const [completedWorld, setCompletedWorld] = useState<number | null>(null);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768 || 'ontouchstart' in window);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    const loadLeaderboard = () => {
      const stored = JSON.parse(localStorage.getItem('vibequest.leaderboard') || '[]');
      setLeaderboard(stored);
    };
    loadLeaderboard();
    window.addEventListener('storage', loadLeaderboard);
    return () => window.removeEventListener('storage', loadLeaderboard);
  }, []);

  useEffect(() => {
    if (!canvasRef.current || !isGameStarted || selectedLevel === null) return;

    const canvas = canvasRef.current;
    const game = new GameEngine(canvas, {
      onScoreUpdate: setScore,
      onGameWon: () => {
        if (startTimeRef.current) {
          const completionTime = Math.floor((Date.now() - startTimeRef.current) / 1000);
          setFinalTime(completionTime);
          setElapsedTime(completionTime);
          startTimeRef.current = null;
        }
        setIsGameRunning(false);
        setIsGameWon(true);
      },
      onLifeLost: setLives,
      onGameOver: () => {
        if (startTimeRef.current) {
          const completionTime = Math.floor((Date.now() - startTimeRef.current) / 1000);
          setFinalTime(completionTime);
          setElapsedTime(completionTime);
          startTimeRef.current = null;
        }
        setIsGameRunning(false);
        setIsGameOver(true);
      },
      onLevelComplete: (level, total) => {
        setCompletedWorld(level);
        setCurrentLevel(level + 1);
        setIsGameRunning(false);
        setShowWorldSelection(true);
      },
      onAllLevelsComplete: () => {
        // This callback is no longer used since we always show world selection
      },
      onEnemiesStompedUpdate: setEnemiesStomped,
    });

    // Load all sprites based on game mode
    const enemySprite = gameMode === 'zombie' ? zombieEnemySprite : gameMode === 'candy-run' ? skeletonEnemySprite : fnafEnemySprite;
    const collectibleSprite = gameMode === 'candy-run' ? candySprite : coinSprite;
    
    Promise.all([
      game.loadImage(selectedCharacter.image_url, 'player'),
      game.loadImage(collectibleSprite, 'coin'),
      game.loadImage(enemySprite, 'slime'),
      game.loadImage(portalSprite, 'portal'),
      game.loadImage(skyBackground, 'background'),
      game.loadImage(pumpkinDecoration, 'pumpkin'),
      game.loadImage(ghostDecoration, 'ghost'),
      game.loadImage(batDecoration, 'bat'),
      game.loadImage(secretTreasure, 'treasure'),
      ...(gameMode === 'candy-run' ? [game.loadImage(skeletonBossSprite, 'boss')] : []),
    ]).then(() => {
      game.init(selectedLevel);
      game.start();
      startTimeRef.current = Date.now();
      setTotalLevels(game.getTotalWorlds());
      setCurrentLevel(selectedLevel + 1);
      setIsGameRunning(true);
    });

    gameEngineRef.current = game;

    return () => {
      game.dispose();
      setIsGameRunning(false);
      startTimeRef.current = null;
    };
  }, [isGameStarted, selectedLevel]);

  // Timer effect
  useEffect(() => {
    if (!isGameRunning || isGameWon || isGameOver) return;

    const interval = setInterval(() => {
      if (startTimeRef.current) {
        setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isGameRunning, isGameWon, isGameOver]);

  const handleRestart = () => {
    setIsGameWon(false);
    setIsGameOver(false);
    setScore(0);
    setLives(3);
    setElapsedTime(0);
    setCurrentLevel(1);
    setIsGameRunning(true);
    startTimeRef.current = Date.now();
    setShowNameInput(false);
    setPlayerName('');
    setEnemiesStomped(0);
    if (gameEngineRef.current) {
      gameEngineRef.current.restart();
    }
  };

  const handleStart = (levelIndex: number) => {
    setSelectedLevel(levelIndex);
    setIsGameStarted(true);
  };

  const handleGoHome = () => {
    if (gameEngineRef.current) {
      gameEngineRef.current.stop();
    }
    setIsGameStarted(false);
    setIsGameRunning(false);
    setIsGameWon(false);
    setIsGameOver(false);
    setScore(0);
    setLives(3);
    setElapsedTime(0);
    setFinalTime(0);
    startTimeRef.current = null;
    setShowNameInput(false);
    setPlayerName('');
    setHasSubmitted(false);
    setSelectedLevel(null);
    setEnemiesStomped(0);
    setShowWorldSelection(false);
    setCompletedWorld(null);
  };

  const handleSelectWorld = (worldIndex: number) => {
    setShowWorldSelection(false);
    setSelectedLevel(worldIndex);
    setScore(0);
    setLives(3);
    setEnemiesStomped(0);
    setCurrentLevel(worldIndex + 1);
    
    if (gameEngineRef.current) {
      gameEngineRef.current.loadSpecificWorld(worldIndex);
      setIsGameRunning(true);
      if (!startTimeRef.current) {
        startTimeRef.current = Date.now();
      }
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSubmitScore = () => {
    if (playerName.trim()) {
      const leaderboardEntry = {
        name: playerName.trim(),
        time: finalTime,
        score: score,
        date: new Date().toISOString(),
      };
      
      const existingLeaderboard = JSON.parse(localStorage.getItem('vibequest.leaderboard') || '[]');
      existingLeaderboard.push(leaderboardEntry);
      existingLeaderboard.sort((a: any, b: any) => a.time - b.time);
      localStorage.setItem('vibequest.leaderboard', JSON.stringify(existingLeaderboard.slice(0, 10)));
      setLeaderboard(existingLeaderboard.slice(0, 10));
      setShowNameInput(false);
      setHasSubmitted(true);
    }
  };

  if (!isGameStarted) {
    return (
      <div 
        className="fixed inset-0 overflow-y-auto"
        style={{
          backgroundImage: `url(${landingBackground})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat'
        }}
      >
        <div className="min-h-screen flex flex-col items-center justify-center py-12 px-4 relative z-10">
          {/* Robot Mascot - Subtle corner decoration */}
          <img 
            src={robotMascot} 
            alt="Sky Explorer Robot" 
            className="absolute bottom-4 right-4 w-24 h-24 sm:w-32 sm:h-32 md:w-40 md:h-40 object-contain opacity-70 hover:opacity-100 transition-all duration-500 hover:scale-110 pointer-events-none select-none"
            style={{ filter: 'drop-shadow(0 4px 20px rgba(255, 165, 0, 0.3))' }}
          />
          
          {/* Hero Section with Glassmorphic Box */}
          <div className="text-center space-y-8 mb-16 bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-8 md:p-12 shadow-2xl">
            <div className="space-y-4">
              <h1 className="text-6xl md:text-8xl font-bold text-white drop-shadow-2xl">
                Sky Explorer
              </h1>
              <p className="text-lg md:text-2xl text-white/90 max-w-md mx-auto drop-shadow-lg">
                Collect Vibe Coins and reach the portal as fast as you can!
              </p>
            </div>
            
            <div className="flex flex-col items-center gap-6">
              <div className="text-center mb-2">
                <p className="text-white/90 text-lg md:text-xl font-semibold mb-4">Choose Your World</p>
                <div className="grid grid-cols-2 gap-4">
                  <button 
                    onClick={() => handleStart(0)} 
                    className="game-button text-lg md:text-xl px-8 py-4 hover:scale-105 transition-transform shadow-lg bg-gradient-to-r from-green-500 to-blue-500">
                    🏝️ Sky Islands
                  </button>
                  <button 
                    onClick={() => handleStart(1)} 
                    className="game-button text-lg md:text-xl px-8 py-4 hover:scale-105 transition-transform shadow-lg bg-gradient-to-r from-purple-500 to-pink-500">
                    🏰 Cloud Castles
                  </button>
                  <button 
                    onClick={() => handleStart(2)} 
                    className="game-button text-lg md:text-xl px-8 py-4 hover:scale-105 transition-transform shadow-lg bg-gradient-to-r from-gray-700 to-blue-600">
                    ⚡ Storm Realm
                  </button>
                  <button 
                    onClick={() => handleStart(3)} 
                    className="game-button text-lg md:text-xl px-8 py-4 hover:scale-105 transition-transform shadow-lg bg-gradient-to-r from-black to-purple-900 border-2 border-cyan-400">
                    🌌 Void Peaks
                  </button>
                  {gameMode === 'candy-run' && (
                    <button 
                      onClick={() => handleStart(4)} 
                      className="game-button text-lg md:text-xl px-8 py-4 hover:scale-105 transition-transform shadow-lg bg-gradient-to-r from-red-900 to-black border-2 border-red-500 col-span-2">
                      💀 Boss Battle
                    </button>
                  )}
                </div>
              </div>
              
              {onChangeCharacter && (
                <button 
                  onClick={onChangeCharacter}
                  className="game-button text-base md:text-lg px-6 py-3 hover:scale-105 transition-transform shadow-lg bg-white/20 hover:bg-white/30 border border-white/40">
                  🎮 Change Character
                </button>
              )}
              
              <div className="text-white/80 text-sm md:text-base bg-white/10 backdrop-blur-md rounded-xl px-6 md:px-8 py-3 md:py-4 border border-white/20">
                <p className="font-semibold mb-1 text-white">Controls</p>
                <p className="text-xs md:text-sm">Arrow Keys to Move • Space to Jump</p>
              </div>
            </div>
          </div>

          {/* Leaderboard with Glassmorphic Box */}
          {leaderboard.length > 0 && (
            <div className="w-full max-w-md bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-6 md:p-8 shadow-2xl">
              <h3 className="text-2xl md:text-3xl font-bold text-white mb-6 text-center drop-shadow-lg">🏆 Leaderboard</h3>
              <div className="space-y-2">
                {leaderboard.map((entry, index) => (
                  <div key={index} className="flex items-center justify-between bg-white/10 backdrop-blur-md rounded-lg px-4 py-3 hover:bg-white/20 transition-colors border border-white/10">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <span className="text-base md:text-lg font-bold text-white/70 w-8">{index + 1}.</span>
                      <span className="text-sm md:text-base text-white font-medium truncate">{entry.name}</span>
                    </div>
                    <span className="text-base md:text-lg text-white font-bold ml-4 drop-shadow-md">{formatTime(entry.time)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-game-sky-start to-game-sky-end overflow-hidden">
      {/* Lives Display */}
      <div className="absolute top-4 left-24 z-10 bg-card/80 backdrop-blur-sm rounded-2xl px-6 py-3" style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.15)' }}>
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {[...Array(3)].map((_, i) => (
              <span key={i} className="text-3xl" style={{ 
                filter: i < lives ? 'none' : 'grayscale(100%) opacity(0.3)',
                transition: 'filter 0.3s ease'
              }}>
                ❤️
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Score Display */}
      <div className="absolute top-4 left-[17rem] z-10 bg-card/80 backdrop-blur-sm rounded-2xl px-6 py-3" style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.15)' }}>
        <div className="flex items-center gap-3">
          <span className="text-3xl">{gameMode === 'candy-run' ? '🍬' : '😊'}</span>
          <div>
            <p className="text-sm text-muted-foreground">{gameMode === 'candy-run' ? 'Candy' : 'Vibe Coins'}</p>
            <p className="text-2xl font-bold text-accent">{score}</p>
          </div>
        </div>
      </div>

      {/* Enemies Stomped Display */}
      <div className="absolute top-4 left-[29rem] z-10 bg-card/80 backdrop-blur-sm rounded-2xl px-6 py-3" style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.15)' }}>
        <div className="flex items-center gap-3">
          <span className="text-3xl">{gameMode === 'candy-run' ? '💀' : gameMode === 'zombie' ? '🧟' : '👮'}</span>
          <div>
            <p className="text-sm text-muted-foreground">{gameMode === 'candy-run' ? 'Skeletons' : gameMode === 'zombie' ? 'Zombies' : 'Troops'} Stomped</p>
            <p className="text-2xl font-bold text-destructive">{enemiesStomped}</p>
          </div>
        </div>
      </div>

      {/* Level Display */}
      <div className="absolute top-20 left-24 z-10 bg-card/80 backdrop-blur-sm rounded-2xl px-6 py-3" style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.15)' }}>
        <div className="flex items-center gap-3">
          <span className="text-3xl">🌍</span>
          <div>
            <p className="text-sm text-muted-foreground">World</p>
            <p className="text-2xl font-bold text-primary">{currentLevel} / {totalLevels}</p>
          </div>
        </div>
      </div>

      {/* Timer and Controls Display */}
      <div className="absolute top-4 right-4 z-10 flex gap-2">
        <div className="bg-card/80 backdrop-blur-sm rounded-2xl px-6 py-3" style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.15)' }}>
          <div className="flex items-center gap-3">
            <span className="text-3xl">⏱️</span>
            <div>
              <p className="text-sm text-muted-foreground">Time</p>
              <p className="text-2xl font-bold text-primary">{formatTime(isGameWon ? finalTime : elapsedTime)}</p>
            </div>
          </div>
        </div>
        {onChangeCharacter && (
          <button
            onClick={onChangeCharacter}
            className="bg-card/80 backdrop-blur-sm rounded-2xl px-4 hover:bg-card transition-colors flex items-center justify-center"
            style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.15)' }}
            title="Change Character"
          >
            <span className="text-2xl">🎮</span>
          </button>
        )}
        {onChangeMode && (
          <button
            onClick={onChangeMode}
            className="bg-card/80 backdrop-blur-sm rounded-2xl px-4 hover:bg-card transition-colors flex items-center justify-center"
            style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.15)' }}
            title="Change Game Mode"
          >
            <span className="text-2xl">🎯</span>
          </button>
        )}
        <button
          onClick={handleRestart}
          className="bg-card/80 backdrop-blur-sm rounded-2xl px-4 hover:bg-card transition-colors flex items-center justify-center"
          style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.15)' }}
          title="Restart World"
        >
          <span className="text-2xl">🔄</span>
        </button>
        <button
          onClick={handleGoHome}
          className="bg-card/80 backdrop-blur-sm rounded-2xl px-4 hover:bg-card transition-colors flex items-center justify-center"
          style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.15)' }}
          title="Back to Home"
        >
          <span className="text-2xl">🏠</span>
        </button>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={1200}
        height={600}
        className="border-4 border-border rounded-2xl shadow-2xl max-w-full h-auto"
        style={{ 
          touchAction: 'none',
          maxHeight: isMobile ? '70vh' : 'auto',
          width: isMobile ? '100%' : 'auto'
        }}
      />

      {/* Mobile Touch Controls */}
      {isMobile && (
        <div className="absolute bottom-4 left-0 right-0 z-10 flex justify-between px-4 select-none">
          <div className="flex gap-4">
            <button
              onTouchStart={() => gameEngineRef.current?.setTouchControl('left', true)}
              onTouchEnd={() => gameEngineRef.current?.setTouchControl('left', false)}
              className="w-20 h-20 rounded-full bg-primary/80 backdrop-blur-sm text-4xl flex items-center justify-center active:scale-95 transition-transform select-none touch-none"
              style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.4)', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
            >
              ←
            </button>
            <button
              onTouchStart={() => gameEngineRef.current?.setTouchControl('right', true)}
              onTouchEnd={() => gameEngineRef.current?.setTouchControl('right', false)}
              className="w-20 h-20 rounded-full bg-primary/80 backdrop-blur-sm text-4xl flex items-center justify-center active:scale-95 transition-transform select-none touch-none"
              style={{ boxShadow: '0 4px 20px hsl(var(--primary) / 0.4)', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
            >
              →
            </button>
          </div>
          <button
            onTouchStart={() => gameEngineRef.current?.setTouchControl('jump', true)}
            onTouchEnd={() => gameEngineRef.current?.setTouchControl('jump', false)}
            className="w-20 h-20 rounded-full bg-accent/80 backdrop-blur-sm text-3xl font-bold flex items-center justify-center active:scale-95 transition-transform select-none touch-none"
            style={{ boxShadow: '0 4px 20px hsl(var(--accent) / 0.4)', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
          >
            ↑
          </button>
        </div>
      )}

      {/* Game Over Screen */}
      {isGameOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-secondary/80 backdrop-blur-md z-20">
          <div className="text-center space-y-6 bg-card rounded-3xl p-12 animate-[bounce-in_0.6s_ease-out]" style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div className="text-8xl">💔</div>
            <h2 className="text-5xl font-bold text-destructive">Game Over!</h2>
            <p className="text-2xl text-foreground/80">
              You collected <span className="text-accent font-bold">{score}</span> Vibe Coins - but died.
            </p>
            <button onClick={handleRestart} className="game-button text-xl">
              Try Again
            </button>
          </div>
        </div>
      )}

      {/* Win Screen */}
      {isGameWon && (
        <div className="absolute inset-0 flex items-center justify-center bg-secondary/80 backdrop-blur-md z-20">
          <div className="text-center space-y-6 bg-card rounded-3xl p-12 animate-[bounce-in_0.6s_ease-out] max-w-md" style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div className="text-8xl animate-[coin-spin_2s_ease-in-out_infinite]">🎉</div>
            <h2 className="text-5xl font-bold text-primary">All Worlds Complete! 🎊</h2>
            <div className="space-y-2">
              <p className="text-3xl font-bold text-primary">Time: {formatTime(finalTime)}</p>
              <p className="text-xl text-foreground/80">
                Coins: <span className="text-accent font-bold">{score}</span>
              </p>
            </div>
            
            {!showNameInput ? (
              <div className="space-y-4">
                {!hasSubmitted && (
                  <button 
                    onClick={() => setShowNameInput(true)} 
                    className="game-button text-xl w-full"
                  >
                    Submit to Leaderboard
                  </button>
                )}
                <button 
                  onClick={handleRestart} 
                  className="game-button text-xl w-full bg-secondary hover:bg-secondary/80"
                >
                  Play Again
                </button>
              </div>
            ) : (
              <div className="space-y-4" onKeyDown={(e) => e.stopPropagation()}>
                <input
                  type="text"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="Enter your name"
                  className="w-full px-4 py-3 rounded-lg bg-background border-2 border-primary/20 focus:border-primary outline-none text-lg pointer-events-auto"
                  maxLength={20}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') handleSubmitScore();
                  }}
                  autoFocus
                />
                <div className="flex gap-2">
                  <button 
                    onClick={handleSubmitScore}
                    disabled={!playerName.trim()}
                    className="game-button text-xl flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Submit
                  </button>
                  <button 
                    onClick={handleRestart} 
                    className="game-button text-xl flex-1 bg-secondary hover:bg-secondary/80"
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* World Selection Screen */}
      {showWorldSelection && (
        <div className="absolute inset-0 flex items-center justify-center bg-secondary/80 backdrop-blur-md z-20">
          <div className="text-center space-y-6 bg-card rounded-3xl p-12 animate-[bounce-in_0.6s_ease-out] max-w-2xl w-full mx-4" style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div className="text-8xl">🎊</div>
            <h2 className="text-4xl md:text-5xl font-bold text-primary">World Complete!</h2>
            <div className="space-y-2">
              <p className="text-xl md:text-2xl text-foreground/80">
                You collected <span className="text-accent font-bold">{score}</span> {gameMode === 'candy-run' ? 'Candy' : 'Vibe Coins'}!
              </p>
              {gameMode === 'candy-run' && (
                <p className="text-lg text-foreground/70">
                  Escaped {enemiesStomped} Skeletons 💀
                </p>
              )}
              {gameMode !== 'candy-run' && (
                <p className="text-lg text-foreground/70">
                  Stomped {enemiesStomped} Troops 👾
                </p>
              )}
            </div>
            
            <div className="space-y-4">
              <p className="text-white/90 text-lg md:text-xl font-semibold">Choose Your Next World</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button 
                  onClick={() => handleSelectWorld(0)} 
                  className="game-button text-base md:text-lg px-6 py-4 hover:scale-105 transition-transform shadow-lg bg-gradient-to-r from-green-500 to-blue-500"
                >
                  🏝️ Sky Islands
                </button>
                <button 
                  onClick={() => handleSelectWorld(1)} 
                  className="game-button text-base md:text-lg px-6 py-4 hover:scale-105 transition-transform shadow-lg bg-gradient-to-r from-purple-500 to-pink-500"
                >
                  🏰 Cloud Castles
                </button>
                <button 
                  onClick={() => handleSelectWorld(2)} 
                  className="game-button text-base md:text-lg px-6 py-4 hover:scale-105 transition-transform shadow-lg bg-gradient-to-r from-gray-700 to-blue-600"
                >
                  ⚡ Storm Realm
                </button>
                <button 
                  onClick={() => handleSelectWorld(3)} 
                  className="game-button text-base md:text-lg px-6 py-4 hover:scale-105 transition-transform shadow-lg bg-gradient-to-r from-black to-purple-900 border-2 border-cyan-400"
                >
                  🌌 Void Peaks
                </button>
                {gameMode === 'candy-run' && (
                  <button 
                    onClick={() => handleSelectWorld(4)} 
                    className="game-button text-base md:text-lg px-6 py-4 hover:scale-105 transition-transform shadow-lg bg-gradient-to-r from-red-900 to-black border-2 border-red-500 col-span-full"
                  >
                    💀 Boss Battle
                  </button>
                )}
              </div>
              
              <button 
                onClick={handleGoHome}
                className="game-button text-lg px-6 py-3 w-full bg-secondary hover:bg-secondary/80 mt-4"
              >
                🏠 Back to Home
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
