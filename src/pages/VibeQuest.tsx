import { useState, useCallback, useEffect } from 'react';
import { HomeScreen } from '@/vibequest/components/HomeScreen';
import { CharacterSelection } from '@/vibequest/components/CharacterSelection';
import { GameModeSelection, GameMode } from '@/vibequest/components/GameModeSelection';
import { Game } from '@/vibequest/components/Game';
import { BossRushGame } from '@/vibequest/components/BossRushGame';
import { StarWarsShooter } from '@/vibequest/components/StarWarsShooter';
import { MultiplayerCharacterSelect } from '@/vibequest/components/MultiplayerCharacterSelect';
import { MultiplayerFighter } from '@/vibequest/components/MultiplayerFighter';
import { MultiplayerBossRush } from '@/vibequest/components/MultiplayerBossRush';
import { CagneyBossRush } from '@/vibequest/components/CagneyBossRush';
import { GameLobby } from '@/vibequest/components/GameLobby';
import { OnlineLobby } from '@/vibequest/components/OnlineLobby';
import { OnlineFighter } from '@/vibequest/components/OnlineFighter';
import { FloatingNav } from '@/vibequest/components/FloatingNav';
import { Character } from '@/vibequest/useCharacters';
import { useWorldStamp } from '@/hooks/use-world-stamp';
import '@/vibequest/vibequest.css';

/*
 * VIBEQUEST: Jack's 2D platformer and boss rush, ported in from its own
 * Lovable project (github.com/jackmielke/VibeQuest). Everything that moves
 * lives in src/vibequest/; this page is the original's screen router,
 * unchanged apart from the wrapper that scopes its theme (vibequest.css).
 * Characters, the online fighter channel and the boss music still talk to
 * the original project's Supabase (src/vibequest/supabase.ts).
 */

type Screen = 'home' | 'mode-select' | 'character-select' | 'multiplayer-character-select' | 'lobby' | 'game' | 'online-lobby' | 'online-game';

function VibeQuestScreens() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('home');
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [selectedMode, setSelectedMode] = useState<GameMode | null>(null);
  const [multiplayerPlayers, setMultiplayerPlayers] = useState<{ player1: Character; player2: Character } | null>(null);
  const [onlineState, setOnlineState] = useState<{
    roomCode: string;
    localChar: Character;
    remoteChar: Character;
    isHost: boolean;
  } | null>(null);
  const [initialRoomCode, setInitialRoomCode] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('room');
  });

  // Check for ?room= param on load
  useEffect(() => {
    if (initialRoomCode) {
      setSelectedMode('online-fighter');
      setCurrentScreen('online-lobby');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Reset everything and go home
  const goHome = useCallback(() => {
    setCurrentScreen('home');
    setSelectedCharacter(null);
    setSelectedMode(null);
    setMultiplayerPlayers(null);
    setOnlineState(null);
  }, []);

  // Go back one step
  const goBack = useCallback(() => {
    const isCoopMode = selectedMode?.startsWith('multiplayer') || selectedMode === 'cagney-boss-rush';
    const isLobbyMode = selectedMode === 'lobby';

    switch (currentScreen) {
      case 'mode-select':
        setCurrentScreen('home');
        break;
      case 'character-select':
        setCurrentScreen('mode-select');
        setSelectedCharacter(null);
        break;
      case 'multiplayer-character-select':
        setCurrentScreen('mode-select');
        setSelectedMode(null);
        break;
      case 'lobby':
        setCurrentScreen('character-select');
        break;
      case 'game':
        if (isCoopMode) {
          setCurrentScreen('multiplayer-character-select');
          setMultiplayerPlayers(null);
        } else if (isLobbyMode) {
          setCurrentScreen('lobby');
        } else {
          // Go back to mode select for regular games (skip lobby)
          setCurrentScreen('mode-select');
          setSelectedCharacter(null);
          setSelectedMode(null);
        }
        break;
      default:
        goHome();
    }
  }, [currentScreen, selectedMode, goHome]);

  // Change character (go to character select but keep mode)
  const changeCharacter = useCallback(() => {
    const isCoopMode = selectedMode?.startsWith('multiplayer') || selectedMode === 'cagney-boss-rush';

    if (isCoopMode) {
      setCurrentScreen('multiplayer-character-select');
      setMultiplayerPlayers(null);
    } else {
      setCurrentScreen('character-select');
      setSelectedCharacter(null);
    }
  }, [selectedMode]);

  // Start actual game from lobby
  const startGameFromLobby = useCallback(() => {
    setCurrentScreen('game');
  }, []);

  // Handle mode selection
  const handleModeSelect = useCallback((mode: GameMode) => {
    setSelectedMode(mode);

    if (mode === 'online-fighter') {
      setCurrentScreen('online-lobby');
      return;
    }

    // Lobby is a special mode - goes directly to lobby screen
    if (mode === 'lobby') {
      setCurrentScreen('character-select');
      return;
    }

    const isCoopMode = mode.startsWith('multiplayer') || mode === 'cagney-boss-rush';
    if (isCoopMode) {
      setCurrentScreen('multiplayer-character-select');
    } else {
      setCurrentScreen('character-select');
    }
  }, []);

  // Handle online game start
  const handleOnlineGameStart = useCallback((roomCode: string, localChar: Character, remoteChar: Character, isHost: boolean) => {
    setOnlineState({ roomCode, localChar, remoteChar, isHost });
    setCurrentScreen('online-game');
  }, []);

  // Handle character selection (for single player modes)
  const handleCharacterSelect = useCallback((character: Character) => {
    setSelectedCharacter(character);
    // If lobby mode, go to lobby; otherwise go straight to game
    if (selectedMode === 'lobby') {
      setCurrentScreen('lobby');
    } else {
      setCurrentScreen('game');
    }
  }, [selectedMode]);

  // Handle multiplayer character selection
  const handleMultiplayerStart = useCallback((player1: Character, player2: Character) => {
    setMultiplayerPlayers({ player1, player2 });
    setCurrentScreen('game');
  }, []);

  // Get screen name for display
  const getScreenName = () => {
    switch (currentScreen) {
      case 'mode-select': return 'Game Modes';
      case 'character-select': return 'Characters';
      case 'multiplayer-character-select': return 'Select Players';
      case 'lobby': return 'Lobby';
      case 'game': return selectedMode?.replace('-', ' ').toUpperCase() || 'Playing';
      default: return undefined;
    }
  };

  // HOME SCREEN
  if (currentScreen === 'home') {
    return <HomeScreen onStartGame={() => setCurrentScreen('mode-select')} />;
  }

  // MODE SELECT
  if (currentScreen === 'mode-select') {
    return (
      <>
        <FloatingNav 
          onHome={goHome} 
          showBackButton={true}
          onBack={goBack}
          currentScreen={getScreenName()}
        />
        <GameModeSelection 
          onSelectMode={handleModeSelect} 
          onBack={goBack}
        />
      </>
    );
  }

  // CHARACTER SELECT (single player)
  if (currentScreen === 'character-select') {
    return (
      <>
        <FloatingNav 
          onHome={goHome} 
          showBackButton={true}
          onBack={goBack}
          currentScreen={getScreenName()}
        />
        <CharacterSelection 
          onSelectCharacter={handleCharacterSelect} 
        />
      </>
    );
  }

  // LOBBY (only when 'lobby' mode is selected - it's now a hangout space)
  if (currentScreen === 'lobby' && selectedCharacter && selectedMode === 'lobby') {
    return (
      <GameLobby
        selectedCharacter={selectedCharacter}
        selectedMode={selectedMode}
        onStartGame={startGameFromLobby}
        onBack={goBack}
        onChangeCharacter={changeCharacter}
      />
    );
  }

  // MULTIPLAYER CHARACTER SELECT
  if (currentScreen === 'multiplayer-character-select') {
    return (
      <>
        <FloatingNav 
          onHome={goHome} 
          showBackButton={true}
          onBack={goBack}
          currentScreen={getScreenName()}
        />
        <MultiplayerCharacterSelect
          onStartGame={handleMultiplayerStart}
          onBack={goBack}
        />
      </>
    );
  }
  // ONLINE LOBBY
  if (currentScreen === 'online-lobby') {
    return (
      <>
        <FloatingNav onHome={goHome} showBackButton={true} onBack={goBack} currentScreen="Online Fighter" />
        <OnlineLobby
          initialRoomCode={initialRoomCode}
          onGameStart={handleOnlineGameStart}
          onBack={goBack}
        />
      </>
    );
  }

  // ONLINE GAME
  if (currentScreen === 'online-game' && onlineState) {
    return (
      <>
        <FloatingNav onHome={goHome} currentScreen="Online Fight" />
        <OnlineFighter
          roomCode={onlineState.roomCode}
          localCharacter={onlineState.localChar}
          remoteCharacter={onlineState.remoteChar}
          isHost={onlineState.isHost}
          onBack={() => { setOnlineState(null); setCurrentScreen('online-lobby'); }}
        />
      </>
    );
  }

  // GAME SCREENS
  if (currentScreen === 'game') {
    // Multiplayer Fighter
    if (selectedMode === 'multiplayer-fighter' && multiplayerPlayers) {
      return (
        <>
          <FloatingNav 
            onHome={goHome}
            showCharacterButton={true}
            onChangeCharacter={changeCharacter}
            currentScreen="2P Fighter"
          />
          <MultiplayerFighter
            player1Character={multiplayerPlayers.player1}
            player2Character={multiplayerPlayers.player2}
            onBack={goBack}
          />
        </>
      );
    }

    // Multiplayer Boss Rush (Co-op vs Goopy)
    if (selectedMode === 'multiplayer-boss-rush' && multiplayerPlayers) {
      return (
        <>
          <FloatingNav 
            onHome={goHome}
            showCharacterButton={true}
            onChangeCharacter={changeCharacter}
            currentScreen="Co-op Goopy"
          />
          <MultiplayerBossRush
            player1Character={multiplayerPlayers.player1}
            player2Character={multiplayerPlayers.player2}
            onBack={goBack}
          />
        </>
      );
    }

    // Cagney Carnation Boss Rush (Co-op)
    if (selectedMode === 'cagney-boss-rush' && multiplayerPlayers) {
      return (
        <>
          <FloatingNav 
            onHome={goHome}
            showCharacterButton={true}
            onChangeCharacter={changeCharacter}
            currentScreen="Co-op Cagney"
          />
          <CagneyBossRush
            player1Character={multiplayerPlayers.player1}
            player2Character={multiplayerPlayers.player2}
            onBack={goBack}
          />
        </>
      );
    }

    // Boss Rush (single player)
    if (selectedMode === 'boss-rush' && selectedCharacter) {
      return (
        <>
          <FloatingNav 
            onHome={goHome}
            showCharacterButton={true}
            onChangeCharacter={changeCharacter}
            currentScreen="Boss Rush"
          />
          <BossRushGame
            selectedCharacter={selectedCharacter}
            onBack={goBack}
            onChangeCharacter={changeCharacter}
            onChangeMode={() => setCurrentScreen('mode-select')}
          />
        </>
      );
    }

    // Star Wars Vader Duel (single player, standalone)
    if (selectedMode === 'star-wars-shooter' && selectedCharacter) {
      return (
        <>
          <FloatingNav
            onHome={goHome}
            showCharacterButton={true}
            onChangeCharacter={changeCharacter}
            currentScreen="Vader Duel"
          />
          <StarWarsShooter
            selectedCharacter={selectedCharacter}
            onBack={goBack}
            onChangeCharacter={changeCharacter}
            onChangeMode={() => setCurrentScreen('mode-select')}
          />
        </>
      );
    }

    // Other single player modes (classic, zombie, candy-run)
    if (selectedCharacter && selectedMode) {
      return (
        <>
          <FloatingNav 
            onHome={goHome}
            showCharacterButton={true}
            onChangeCharacter={changeCharacter}
            currentScreen={selectedMode.replace('-', ' ').toUpperCase()}
          />
          <Game 
            selectedCharacter={selectedCharacter} 
            gameMode={selectedMode}
            onChangeCharacter={changeCharacter}
            onChangeMode={() => setCurrentScreen('mode-select')}
          />
        </>
      );
    }
  }

  // Fallback - go home
  return <HomeScreen onStartGame={() => setCurrentScreen('mode-select')} />;
};

export default function VibeQuest() {
  useWorldStamp("/vibequest", "VibeQuest");
  return (
    <div className="vq-root">
      <VibeQuestScreens />
    </div>
  );
}
