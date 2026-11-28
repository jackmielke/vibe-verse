import { useEffect, useRef, useState } from 'react';
import { MultiplayerFighterEngine } from '@/vibequest/lib/multiplayerFighterEngine';
import { Character } from '@/vibequest/useCharacters';

interface MultiplayerFighterProps {
  player1Character: Character;
  player2Character: Character;
  onBack: () => void;
}

export const MultiplayerFighter = ({ player1Character, player2Character, onBack }: MultiplayerFighterProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameEngineRef = useRef<MultiplayerFighterEngine | null>(null);
  const [isStarted, setIsStarted] = useState(false);
  const [player1Health, setPlayer1Health] = useState(100);
  const [player2Health, setPlayer2Health] = useState(100);
  const [player1Score, setPlayer1Score] = useState(0);
  const [player2Score, setPlayer2Score] = useState(0);
  const [winner, setWinner] = useState<1 | 2 | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const resizeCanvas = () => {
      canvas.width = Math.min(1000, window.innerWidth - 40);
      canvas.height = 600;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const game = new MultiplayerFighterEngine(canvas, {
      onHealthUpdate: (p1Health, p2Health) => {
        setPlayer1Health(p1Health);
        setPlayer2Health(p2Health);
      },
      onGameOver: (gameWinner) => {
        setWinner(gameWinner);
      },
      onScoreUpdate: (p1Score, p2Score) => {
        setPlayer1Score(p1Score);
        setPlayer2Score(p2Score);
      },
    });

    // Load character images
    Promise.all([
      game.loadImage(player1Character.image_url, 'player1'),
      game.loadImage(player2Character.image_url, 'player2'),
    ]).then(() => {
      game.init();
    });

    gameEngineRef.current = game;

    return () => {
      game.dispose();
      window.removeEventListener('resize', resizeCanvas);
    };
  }, [player1Character, player2Character]);

  const handleStart = () => {
    setIsStarted(true);
    setWinner(null);
    gameEngineRef.current?.start();
  };

  const handleRestart = () => {
    setWinner(null);
    setPlayer1Health(100);
    setPlayer2Health(100);
    setPlayer1Score(0);
    setPlayer2Score(0);
    gameEngineRef.current?.restart();
    gameEngineRef.current?.start();
  };

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#1a1a2e] to-[#16213e] overflow-hidden">
      {/* Character display */}
      <div className="absolute top-4 left-24 flex items-center gap-3 bg-black/40 backdrop-blur-sm rounded-xl px-4 py-2">
        <img src={player1Character.image_url} alt={player1Character.name} className="w-12 h-12 object-contain rounded" />
        <div>
          <p className="text-xs text-cyan-400">Player 1</p>
          <p className="text-white font-bold">{player1Character.name}</p>
        </div>
      </div>

      <div className="absolute top-4 right-4 flex items-center gap-3 bg-black/40 backdrop-blur-sm rounded-xl px-4 py-2">
        <div className="text-right">
          <p className="text-xs text-orange-400">Player 2</p>
          <p className="text-white font-bold">{player2Character.name}</p>
        </div>
        <img src={player2Character.image_url} alt={player2Character.name} className="w-12 h-12 object-contain rounded" />
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className="border-4 border-white/20 rounded-lg shadow-2xl"
        style={{ maxWidth: '100%' }}
      />

      {/* Start overlay */}
      {!isStarted && !winner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-20">
          <h1 className="text-5xl md:text-7xl font-bold text-white mb-4 text-center">
            ⚔️ Fighter Arena ⚔️
          </h1>
          <p className="text-xl text-white/80 mb-2">Best of 3 rounds!</p>
          <div className="flex gap-8 mb-6">
            <div className="text-center">
              <img src={player1Character.image_url} alt={player1Character.name} className="w-24 h-24 object-contain mx-auto mb-2" />
              <p className="text-cyan-400 font-bold">{player1Character.name}</p>
            </div>
            <div className="text-4xl text-white self-center">VS</div>
            <div className="text-center">
              <img src={player2Character.image_url} alt={player2Character.name} className="w-24 h-24 object-contain mx-auto mb-2" />
              <p className="text-orange-400 font-bold">{player2Character.name}</p>
            </div>
          </div>
          
          {/* Controls guide */}
          <div className="grid grid-cols-2 gap-6 mb-6 text-sm">
            <div className="bg-cyan-500/20 border border-cyan-400/50 rounded-lg p-4">
              <p className="text-cyan-400 font-bold mb-2 text-center">Player 1 Controls</p>
              <div className="text-white/80 space-y-1">
                <p>🎮 <span className="text-white">WASD</span> - Move & Jump</p>
                <p>💥 <span className="text-white">Space</span> - Shoot (hold to charge)</p>
                <p>⚡ <span className="text-white">Shift</span> - Dash Attack</p>
                <p>🛡️ <span className="text-white">Q</span> - Shield</p>
              </div>
            </div>
            <div className="bg-orange-500/20 border border-orange-400/50 rounded-lg p-4">
              <p className="text-orange-400 font-bold mb-2 text-center">Player 2 Controls</p>
              <div className="text-white/80 space-y-1">
                <p>🎮 <span className="text-white">Arrows</span> - Move & Jump</p>
                <p>💥 <span className="text-white">Enter</span> - Shoot (hold to charge)</p>
                <p>⚡ <span className="text-white">R-Shift</span> - Dash Attack</p>
                <p>🛡️ <span className="text-white">/</span> - Shield</p>
              </div>
            </div>
          </div>

          <button
            onClick={handleStart}
            className="px-12 py-4 bg-gradient-to-r from-cyan-500 to-orange-500 text-white text-2xl font-bold rounded-xl hover:scale-105 transition-transform shadow-lg"
          >
            FIGHT!
          </button>
          <button
            onClick={onBack}
            className="mt-4 px-6 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 transition-colors"
          >
            ← Back to Menu
          </button>
        </div>
      )}

      {/* Winner overlay */}
      {winner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-20">
          <h1 className="text-5xl md:text-7xl font-bold text-white mb-4 animate-pulse">
            🏆 Player {winner} Wins! 🏆
          </h1>
          <p className="text-2xl text-white/80 mb-8">
            Final Score: {player1Score} - {player2Score}
          </p>
          <div className="flex gap-4">
            <button
              onClick={handleRestart}
              className="px-8 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white text-xl font-bold rounded-xl hover:scale-105 transition-transform"
            >
              Rematch
            </button>
            <button
              onClick={onBack}
              className="px-8 py-3 bg-white/20 text-white text-xl font-bold rounded-xl hover:bg-white/30 transition-colors"
            >
              Back to Menu
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
