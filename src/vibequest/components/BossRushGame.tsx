import { useEffect, useRef, useState, useCallback } from 'react';
import { BossRushEngine, PLANT_BOSSES } from '@/vibequest/lib/bossRushEngine';
import { Character } from '@/vibequest/useCharacters';
import { TouchGamepad, TouchState } from '@/vibequest/components/TouchGamepad';
import landingBackground from '@/assets/vibequest/landing-background.webp';
import bossPotatoSprite from '@/assets/vibequest/boss-potato.webp';
import bossOnionSprite from '@/assets/vibequest/boss-onion.webp';
import bossCarrotSprite from '@/assets/vibequest/boss-carrot.webp';
import projectileSprite from '@/assets/vibequest/projectile.webp';

interface BossRushGameProps {
  selectedCharacter: Character;
  onBack: () => void;
  onChangeCharacter?: () => void;
  onChangeMode?: () => void;
}

export const BossRushGame = ({ selectedCharacter, onBack, onChangeCharacter, onChangeMode }: BossRushGameProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<BossRushEngine | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isStarted, setIsStarted] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isVictory, setIsVictory] = useState(false);
  const [isBossDefeated, setIsBossDefeated] = useState(false);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [bossHealth, setBossHealth] = useState({ current: 100, max: 100 });
  const [currentBoss, setCurrentBoss] = useState(0);
  const [nextBossIndex, setNextBossIndex] = useState(0);
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    const check = () =>
      setIsTouch(
        typeof window !== 'undefined' &&
          ('ontouchstart' in window || window.matchMedia('(pointer: coarse)').matches),
      );
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const handleTouchInput = useCallback((state: TouchState) => {
    engineRef.current?.setTouchControls(state);
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;

    const engine = new BossRushEngine(canvasRef.current, {
      onScoreUpdate: setScore,
      onBossDefeated: (bossIndex, totalBosses) => {
        // Pause the game and show "Next Boss" button
        engine.stop();
        setNextBossIndex(bossIndex + 1);
        setCurrentBoss(bossIndex + 1);
        setIsBossDefeated(true);
      },
      onPlayerHit: setLives,
      onGameOver: () => setIsGameOver(true),
      onAllBossesDefeated: () => setIsVictory(true),
      onBossHealthUpdate: (current, max) => setBossHealth({ current, max }),
    });

    engineRef.current = engine;

    // Load assets
    const loadAssets = async () => {
      try {
        await Promise.all([
          engine.loadImage(selectedCharacter.image_url, 'player'),
          engine.loadImage(bossPotatoSprite, 'bossPotato'),
          engine.loadImage(bossOnionSprite, 'bossOnion'),
          engine.loadImage(bossCarrotSprite, 'bossCarrot'),
          engine.loadImage(projectileSprite, 'projectile'),
        ]);
        await engine.init(0);
        setIsReady(true);
      } catch (error) {
        console.error('Failed to load assets:', error);
        setIsReady(true); // Still allow playing with fallback graphics
      }
    };

    loadAssets();

    return () => engine.dispose();
  }, [selectedCharacter]);

  const handleStart = useCallback(() => {
    setIsStarted(true);
    setIsGameOver(false);
    setIsVictory(false);
    setIsBossDefeated(false);
    engineRef.current?.start();
  }, []);

  const handleRestart = useCallback(() => {
    setIsGameOver(false);
    setIsVictory(false);
    setIsBossDefeated(false);
    setLives(3);
    setScore(0);
    setCurrentBoss(0);
    engineRef.current?.restart();
  }, []);

  const handleNextBoss = useCallback(() => {
    setIsBossDefeated(false);
    engineRef.current?.loadNextBoss(nextBossIndex);
    engineRef.current?.start();
  }, [nextBossIndex]);

  const handleGoBack = useCallback(() => {
    engineRef.current?.stop();
    onBack();
  }, [onBack]);

  // Get next boss name
  const getNextBossName = () => {
    if (nextBossIndex < PLANT_BOSSES.length) {
      return PLANT_BOSSES[nextBossIndex].name;
    }
    return '';
  };

  // Get defeated boss name
  const getDefeatedBossName = () => {
    if (nextBossIndex > 0 && nextBossIndex <= PLANT_BOSSES.length) {
      return PLANT_BOSSES[nextBossIndex - 1].name;
    }
    return '';
  };

  // Show menu overlay
  const showMenu = !isStarted || isGameOver || isVictory || isBossDefeated;

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden">
      {/* Canvas is always rendered - scales to fit viewport while preserving 900x550 aspect */}
      <canvas
        ref={canvasRef}
        width={900}
        height={550}
        className="border-2 sm:border-4 border-purple-500 rounded-lg touch-none"
        style={{
          width: '100%',
          height: 'auto',
          maxWidth: 'min(100vw, calc((100vh - 180px) * 900 / 550))',
          maxHeight: 'calc(100vh - 180px)',
        }}
      />

      {/* On-screen gamepad for touch devices */}
      {isTouch && !showMenu && <TouchGamepad onChange={handleTouchInput} />}
      
      {/* Menu overlay */}
      {showMenu && (
        <div 
          className="absolute inset-0 flex items-center justify-center overflow-y-auto p-4"
          style={{ 
            backgroundImage: `url(${landingBackground})`, 
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        >
          <div className="bg-black/80 backdrop-blur-xl rounded-3xl p-5 sm:p-8 text-center space-y-4 sm:space-y-6 max-w-lg w-full my-auto">
            {isGameOver && (
              <>
                <h1 className="text-4xl sm:text-5xl font-bold text-red-500">GAME OVER</h1>
                <p className="text-xl sm:text-2xl text-white">Score: {score}</p>
              </>
            )}
            {isVictory && (
              <>
                <h1 className="text-4xl sm:text-5xl font-bold text-yellow-400">🎉 VICTORY! 🎉</h1>
                <p className="text-xl sm:text-2xl text-white">All bosses defeated!</p>
                <p className="text-lg sm:text-xl text-white">Final Score: {score}</p>
              </>
            )}
            {isBossDefeated && !isVictory && (
              <>
                <h1 className="text-3xl sm:text-4xl font-bold text-green-400">🎊 BOSS DEFEATED! 🎊</h1>
                <p className="text-lg sm:text-xl text-white">{getDefeatedBossName()} has been vanquished!</p>
                <p className="text-base sm:text-lg text-white/80">Score: {score}</p>
                <p className="text-base sm:text-lg text-yellow-300">Next up: {getNextBossName()}</p>
              </>
            )}
            {!isGameOver && !isVictory && !isBossDefeated && (
              <>
                <h1 className="text-4xl sm:text-5xl font-bold text-white">🥕 BOSS RUSH 🥔</h1>
                <p className="text-base sm:text-lg text-white/80">Defeat the Root Pack!</p>
                {isTouch ? (
                  <div className="text-left text-white/70 text-sm space-y-1">
                    <p>◀ ▶ D-pad to move</p>
                    <p>🟢 JUMP button to jump (double-tap for double jump)</p>
                    <p>💥 Red button to shoot</p>
                  </div>
                ) : (
                  <div className="text-left text-white/70 text-sm space-y-1">
                    <p>🎮 Arrow keys to move</p>
                    <p>⬆️ Space/Up to jump</p>
                    <p>💥 X/Z/Ctrl to shoot</p>
                  </div>
                )}
              </>
            )}
            <div className="flex gap-4 justify-center flex-wrap">
              {isBossDefeated && !isVictory ? (
                <button 
                  onClick={handleNextBoss}
                  className="px-6 sm:px-8 py-3 sm:py-4 bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 text-white font-bold rounded-xl text-lg sm:text-xl transition-all hover:scale-105"
                >
                  Fight {getNextBossName()} →
                </button>
              ) : (
                <button 
                  onClick={isGameOver || isVictory ? handleRestart : handleStart} 
                  disabled={!isReady}
                  className="px-6 sm:px-8 py-3 sm:py-4 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 text-white font-bold rounded-xl text-lg sm:text-xl transition-colors"
                >
                  {!isReady ? 'Loading...' : (isGameOver || isVictory ? 'Try Again' : 'START')}
                </button>
              )}
              <button 
                onClick={handleGoBack} 
                className="px-6 sm:px-8 py-3 sm:py-4 bg-gray-600 hover:bg-gray-500 text-white font-bold rounded-xl text-lg sm:text-xl transition-colors"
              >
                Back
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Game UI controls - only show when playing */}
      {!showMenu && (
        <div className="absolute top-2 right-2 sm:top-4 sm:right-4 flex gap-1.5 sm:gap-2 z-40">
          {onChangeCharacter && (
            <button 
              onClick={() => { engineRef.current?.stop(); onChangeCharacter(); }} 
              className="bg-card/80 backdrop-blur-sm rounded-xl px-3 sm:px-4 py-2 hover:bg-card transition-colors text-lg" 
              title="Change Character"
            >
              🎮
            </button>
          )}
          {onChangeMode && (
            <button 
              onClick={() => { engineRef.current?.stop(); onChangeMode(); }} 
              className="bg-card/80 backdrop-blur-sm rounded-xl px-3 sm:px-4 py-2 hover:bg-card transition-colors text-lg" 
              title="Change Mode"
            >
              🎯
            </button>
          )}
          <button 
            onClick={handleRestart} 
            className="bg-card/80 backdrop-blur-sm rounded-xl px-3 sm:px-4 py-2 hover:bg-card transition-colors text-lg" 
            title="Restart"
          >
            🔄
          </button>
          <button 
            onClick={handleGoBack} 
            className="bg-card/80 backdrop-blur-sm rounded-xl px-3 sm:px-4 py-2 hover:bg-card transition-colors text-lg" 
            title="Back"
          >
            🏠
          </button>
        </div>
      )}
    </div>
  );
};
