import { useState } from 'react';
import { Character, useCharacters } from '@/vibequest/useCharacters';
import { AddCharacterDialog } from './AddCharacterDialog';
import { useQueryClient } from '@tanstack/react-query';

interface MultiplayerCharacterSelectProps {
  onStartGame: (player1: Character, player2: Character) => void;
  onBack: () => void;
}

export const MultiplayerCharacterSelect = ({ onStartGame, onBack }: MultiplayerCharacterSelectProps) => {
  const { data: characters, isLoading } = useCharacters();
  const queryClient = useQueryClient();
  const [player1Selection, setPlayer1Selection] = useState<Character | null>(null);
  const [player2Selection, setPlayer2Selection] = useState<Character | null>(null);
  const [selectingPlayer, setSelectingPlayer] = useState<1 | 2>(1);

  const handleCharacterClick = (character: Character) => {
    if (selectingPlayer === 1) {
      setPlayer1Selection(character);
      setSelectingPlayer(2);
    } else {
      setPlayer2Selection(character);
    }
  };

  const handleStartGame = () => {
    if (player1Selection && player2Selection) {
      onStartGame(player1Selection, player2Selection);
    }
  };

  const handleReset = () => {
    setPlayer1Selection(null);
    setPlayer2Selection(null);
    setSelectingPlayer(1);
  };

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-gradient-to-b from-[#1a1a2e] to-[#16213e]">
        <div className="text-white text-2xl animate-pulse">Loading characters...</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-y-auto bg-gradient-to-b from-[#1a1a2e] to-[#16213e]">
      <div className="min-h-screen flex flex-col items-center justify-center py-8 px-4">
        <h1 className="text-4xl md:text-6xl font-bold text-white mb-2 text-center">
          ⚔️ Select Fighters ⚔️
        </h1>
        
        {/* Selection status */}
        <div className="flex gap-8 mb-8">
          <div className={`text-center p-4 rounded-xl border-4 transition-all ${selectingPlayer === 1 && !player1Selection ? 'border-cyan-400 bg-cyan-400/20 animate-pulse' : 'border-white/20 bg-white/10'}`}>
            <p className="text-cyan-400 font-bold mb-2">Player 1</p>
            {player1Selection ? (
              <div>
                <img src={player1Selection.image_url} alt={player1Selection.name} className="w-20 h-20 object-contain mx-auto" />
                <p className="text-white mt-2">{player1Selection.name}</p>
              </div>
            ) : (
              <div className="w-20 h-20 border-2 border-dashed border-cyan-400 rounded-lg flex items-center justify-center mx-auto">
                <span className="text-cyan-400">?</span>
              </div>
            )}
          </div>
          
          <div className="text-4xl text-white self-center">VS</div>
          
          <div className={`text-center p-4 rounded-xl border-4 transition-all ${selectingPlayer === 2 && !player2Selection ? 'border-orange-400 bg-orange-400/20 animate-pulse' : 'border-white/20 bg-white/10'}`}>
            <p className="text-orange-400 font-bold mb-2">Player 2</p>
            {player2Selection ? (
              <div>
                <img src={player2Selection.image_url} alt={player2Selection.name} className="w-20 h-20 object-contain mx-auto" />
                <p className="text-white mt-2">{player2Selection.name}</p>
              </div>
            ) : (
              <div className="w-20 h-20 border-2 border-dashed border-orange-400 rounded-lg flex items-center justify-center mx-auto">
                <span className="text-orange-400">?</span>
              </div>
            )}
          </div>
        </div>

        {/* Instruction */}
        <p className="text-white/80 text-lg mb-6">
          {!player1Selection 
            ? '👈 Player 1: Choose your fighter!' 
            : !player2Selection 
              ? '👉 Player 2: Choose your fighter!' 
              : '✅ Ready to battle!'}
        </p>

        {/* Character grid */}
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-4 max-w-4xl mb-8">
          {characters?.map((character) => {
            const isP1Selected = player1Selection?.id === character.id;
            const isP2Selected = player2Selection?.id === character.id;
            const isSelected = isP1Selected || isP2Selected;
            
            return (
              <button
                key={character.id}
                onClick={() => handleCharacterClick(character)}
                disabled={isSelected}
                className={`relative p-3 rounded-xl transition-all ${
                  isSelected 
                    ? 'opacity-50 cursor-not-allowed' 
                    : 'hover:scale-110 hover:bg-white/20 cursor-pointer'
                } ${
                  isP1Selected 
                    ? 'ring-4 ring-cyan-400' 
                    : isP2Selected 
                      ? 'ring-4 ring-orange-400' 
                      : 'bg-white/10 border border-white/20'
                }`}
              >
                <img
                  src={character.image_url}
                  alt={character.name}
                  className="w-16 h-16 object-contain mx-auto"
                />
                <p className="text-white text-sm mt-2 text-center truncate">{character.name}</p>
                {isP1Selected && (
                  <span className="absolute -top-2 -left-2 bg-cyan-400 text-black text-xs font-bold px-2 py-1 rounded">P1</span>
                )}
                {isP2Selected && (
                  <span className="absolute -top-2 -right-2 bg-orange-400 text-black text-xs font-bold px-2 py-1 rounded">P2</span>
                )}
              </button>
            );
          })}
          
          {/* Add character option */}
          <AddCharacterDialog onCharacterAdded={() => queryClient.invalidateQueries({ queryKey: ['vibequest-characters'] })} />
        </div>

        {/* Action buttons */}
        <div className="flex gap-4">
          {player1Selection && player2Selection && (
            <button
              onClick={handleStartGame}
              className="px-8 py-3 bg-gradient-to-r from-cyan-500 to-orange-500 text-white text-xl font-bold rounded-xl hover:scale-105 transition-transform shadow-lg"
            >
              START BATTLE! ⚔️
            </button>
          )}
          
          {(player1Selection || player2Selection) && (
            <button
              onClick={handleReset}
              className="px-6 py-3 bg-white/20 text-white rounded-xl hover:bg-white/30 transition-colors"
            >
              Reset Selection
            </button>
          )}
          
          <button
            onClick={onBack}
            className="px-6 py-3 bg-white/10 text-white rounded-xl hover:bg-white/20 transition-colors"
          >
            ← Back
          </button>
        </div>
      </div>
    </div>
  );
};
