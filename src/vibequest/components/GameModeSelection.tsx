import { useState } from 'react';
import landingBackground from '@/assets/vibequest/landing-background.webp';

export type GameMode = 'classic' | 'zombie' | 'candy-run' | 'boss-rush' | 'star-wars-shooter' | 'multiplayer-fighter' | 'multiplayer-boss-rush' | 'cagney-boss-rush' | 'lobby' | 'online-fighter';

type FilterType = 'all' | 'single' | 'multiplayer';

interface GameModeSelectionProps {
  onSelectMode: (mode: GameMode) => void;
  onBack: () => void;
}

const SINGLE_PLAYER_MODES: GameMode[] = ['classic', 'zombie', 'candy-run', 'boss-rush', 'star-wars-shooter'];
const MULTIPLAYER_MODES: GameMode[] = ['multiplayer-fighter', 'multiplayer-boss-rush', 'cagney-boss-rush', 'online-fighter'];

export const GameModeSelection = ({ onSelectMode, onBack }: GameModeSelectionProps) => {
  const [filter, setFilter] = useState<FilterType>('all');

  const gameModes = [
    { id: 'classic' as GameMode, emoji: '👮', title: 'Classic Mode', description: 'Fight the Vibe Police', gradient: 'from-green-500 to-blue-500', type: 'single' },
    { id: 'zombie' as GameMode, emoji: '🧟', title: 'Zombie Mode', description: 'Survive the undead', gradient: 'from-purple-600 to-red-600', type: 'single' },
    { id: 'candy-run' as GameMode, emoji: '🍬', title: 'Candy Run', description: 'Escape spooky skeletons', gradient: 'from-pink-500 to-purple-500', type: 'single' },
    { id: 'boss-rush' as GameMode, emoji: '🥕', title: 'Boss Rush', description: 'Defeat the Root Pack!', gradient: 'from-orange-500 to-red-600', type: 'single' },
    { id: 'star-wars-shooter' as GameMode, emoji: '🗡️', title: 'Vader Duel', description: 'Blast Darth Vader — dodge the shockwave!', gradient: 'from-slate-900 to-red-700', type: 'single' },
    { id: 'multiplayer-fighter' as GameMode, emoji: '⚔️', title: '2P Fighter', description: 'Local multiplayer battle!', gradient: 'from-cyan-500 to-orange-500', type: 'multiplayer' },
    { id: 'multiplayer-boss-rush' as GameMode, emoji: '🫧', title: 'Co-op Goopy', description: 'Team up vs Goopy Le Grande!', gradient: 'from-blue-500 to-cyan-400', type: 'multiplayer' },
    { id: 'cagney-boss-rush' as GameMode, emoji: '🌸', title: 'Co-op Cagney', description: 'Team up vs Cagney Carnation!', gradient: 'from-pink-500 to-red-400', type: 'multiplayer' },
    { id: 'online-fighter' as GameMode, emoji: '🌐', title: 'Online Fighter', description: 'Fight a friend remotely!', gradient: 'from-violet-500 to-cyan-500', type: 'multiplayer' },
  ];

  const filteredModes = gameModes.filter(mode => {
    if (filter === 'all') return true;
    if (filter === 'single') return SINGLE_PLAYER_MODES.includes(mode.id);
    if (filter === 'multiplayer') return MULTIPLAYER_MODES.includes(mode.id);
    return true;
  });

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
        <div className="text-center space-y-6 bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-8 md:p-12 shadow-2xl max-w-3xl w-full">
          <div className="space-y-4">
            <h1 className="text-4xl md:text-6xl font-bold text-white drop-shadow-2xl">
              Choose Game Mode
            </h1>
            <p className="text-lg md:text-xl text-white/90 max-w-md mx-auto drop-shadow-lg">
              Select your adventure style!
            </p>
          </div>

          {/* Filter Tabs */}
          <div className="flex justify-center gap-2 flex-wrap">
            <button
              onClick={() => setFilter('all')}
              className={`px-6 py-3 rounded-full font-bold text-lg transition-all ${
                filter === 'all'
                  ? 'bg-white text-gray-900 shadow-lg scale-105'
                  : 'bg-white/20 text-white hover:bg-white/30'
              }`}
            >
              🎮 All Games
            </button>
            <button
              onClick={() => setFilter('single')}
              className={`px-6 py-3 rounded-full font-bold text-lg transition-all ${
                filter === 'single'
                  ? 'bg-gradient-to-r from-green-500 to-blue-500 text-white shadow-lg scale-105'
                  : 'bg-white/20 text-white hover:bg-white/30'
              }`}
            >
              👤 Solo
            </button>
            <button
              onClick={() => setFilter('multiplayer')}
              className={`px-6 py-3 rounded-full font-bold text-lg transition-all ${
                filter === 'multiplayer'
                  ? 'bg-gradient-to-r from-orange-500 to-pink-500 text-white shadow-lg scale-105'
                  : 'bg-white/20 text-white hover:bg-white/30'
              }`}
            >
              👥 Multiplayer
            </button>
          </div>
          
          {/* Game Modes Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {filteredModes.map(mode => (
              <button 
                key={mode.id}
                onClick={() => onSelectMode(mode.id)}
                className={`game-button text-xl px-6 py-10 hover:scale-105 transition-all shadow-lg bg-gradient-to-r ${mode.gradient} flex flex-col items-center gap-3 relative`}
              >
                {/* Player count badge */}
                <span className="absolute top-2 right-2 bg-black/30 px-2 py-1 rounded-full text-xs">
                  {mode.type === 'single' ? '1P' : '2P'}
                </span>
                <span className="text-5xl">{mode.emoji}</span>
                <div>
                  <p className="text-xl font-bold">{mode.title}</p>
                  <p className="text-sm text-white/80 mt-1">{mode.description}</p>
                </div>
              </button>
            ))}
          </div>

          {/* Lobby Button - Separate from game modes */}
          <div className="pt-4 border-t border-white/20">
            <button 
              onClick={() => onSelectMode('lobby')}
              className="game-button px-8 py-4 hover:scale-105 transition-all shadow-lg bg-gradient-to-r from-indigo-500 to-purple-600 flex items-center justify-center gap-3 mx-auto"
            >
              <span className="text-3xl">🏠</span>
              <div className="text-left">
                <p className="text-lg font-bold">Hangout Lobby</p>
                <p className="text-sm text-white/80">Chill, chat & explore</p>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
