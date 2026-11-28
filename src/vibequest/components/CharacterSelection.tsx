import { useState } from 'react';
import { useCharacters, Character } from '@/vibequest/useCharacters';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AddCharacterDialog } from '@/vibequest/components/AddCharacterDialog';
import landingBackground from '@/assets/vibequest/landing-background.webp';

interface CharacterSelectionProps {
  onSelectCharacter: (character: Character) => void;
}

export const CharacterSelection = ({ onSelectCharacter }: CharacterSelectionProps) => {
  const { data: characters, isLoading, refetch } = useCharacters();
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);

  const handleCharacterClick = (character: Character) => {
    setSelectedCharacter(character);
  };

  const handleContinue = () => {
    if (selectedCharacter) {
      onSelectCharacter(selectedCharacter);
    }
  };

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-gradient-to-b from-primary/20 to-background">
        <p className="text-2xl text-foreground">Loading characters...</p>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 w-full overflow-hidden bg-cover bg-center"
      style={{ backgroundImage: `url(${landingBackground})` }}
    >
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm pointer-events-none" />

      <main className="relative z-10 h-full w-full flex items-center justify-center p-3 sm:p-4">
        <Card className="w-full max-w-6xl bg-card/95 backdrop-blur-md">
          <div className="flex flex-col h-[calc(100vh-1.5rem)] sm:h-[calc(100vh-2rem)]">
            <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 sm:p-6 border-b border-border/50">
              <div className="min-w-0">
                <h1 className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                  Select Fighter
                </h1>
                <p className="text-sm text-muted-foreground">
                  Pick your character, then confirm
                </p>
              </div>
              <AddCharacterDialog onCharacterAdded={() => refetch()} />
            </header>

            <section className="flex-1 min-h-0 p-4 sm:p-6">
              <div className="h-full rounded-2xl bg-background/40 border border-border/50 p-3 sm:p-4">
                <div className="h-full overflow-y-auto pr-1">
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2 sm:gap-3">
                    {characters?.map((character) => (
                      <button
                        key={character.id}
                        type="button"
                        onClick={() => handleCharacterClick(character)}
                        className={
                          "group relative rounded-xl p-2 sm:p-3 transition-all duration-200 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
                          (selectedCharacter?.id === character.id
                            ? "bg-primary/20 ring-2 ring-primary"
                            : "bg-card hover:bg-accent")
                        }
                        aria-pressed={selectedCharacter?.id === character.id}
                      >
                        <div className="aspect-square mb-2 flex items-center justify-center rounded-lg bg-background/40 overflow-hidden">
                          <img
                            src={character.image_url}
                            alt={character.name}
                            loading="lazy"
                            className="w-full h-full object-contain"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="font-bold text-xs sm:text-sm truncate">
                            {character.name}
                          </h3>
                          {character.is_default && (
                            <span className="shrink-0 rounded-full bg-primary text-primary-foreground text-[10px] px-2 py-0.5">
                              Default
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <footer className="p-4 sm:p-6 border-t border-border/50 bg-card/60">
              <Button
                onClick={handleContinue}
                disabled={!selectedCharacter}
                className="w-full text-base sm:text-lg py-4 sm:py-6"
                size="lg"
              >
                Confirm {selectedCharacter?.name || 'Selection'}
              </Button>
            </footer>
          </div>
        </Card>
      </main>
    </div>
  );
};
