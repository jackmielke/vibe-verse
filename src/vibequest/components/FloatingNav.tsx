import { Home, Users, ArrowLeft } from 'lucide-react';

interface FloatingNavProps {
  onHome: () => void;
  onChangeCharacter?: () => void;
  onBack?: () => void;
  showCharacterButton?: boolean;
  showBackButton?: boolean;
  currentScreen?: string;
}

export const FloatingNav = ({ 
  onHome, 
  onChangeCharacter, 
  onBack,
  showCharacterButton = false,
  showBackButton = false,
  currentScreen 
}: FloatingNavProps) => {
  return (
    <div className="fixed top-16 left-3 z-50 flex flex-col gap-2">
      {/* Home button - always visible */}
      <button
        onClick={onHome}
        className="group flex items-center gap-2 bg-black/60 hover:bg-black/80 backdrop-blur-xl rounded-full px-4 py-3 border border-white/20 hover:border-white/40 transition-all duration-300 shadow-lg hover:shadow-xl"
        title="Go to Home"
      >
        <Home className="w-5 h-5 text-white" />
        <span className="text-white text-sm font-medium opacity-0 group-hover:opacity-100 max-w-0 group-hover:max-w-[100px] overflow-hidden transition-all duration-300">
          Home
        </span>
      </button>

      {/* Back button - contextual */}
      {showBackButton && onBack && (
        <button
          onClick={onBack}
          className="group flex items-center gap-2 bg-white/10 hover:bg-white/20 backdrop-blur-xl rounded-full px-4 py-3 border border-white/20 hover:border-white/40 transition-all duration-300 shadow-lg"
          title="Go Back"
        >
          <ArrowLeft className="w-5 h-5 text-white" />
          <span className="text-white text-sm font-medium opacity-0 group-hover:opacity-100 max-w-0 group-hover:max-w-[100px] overflow-hidden transition-all duration-300">
            Back
          </span>
        </button>
      )}

      {/* Change character button */}
      {showCharacterButton && onChangeCharacter && (
        <button
          onClick={onChangeCharacter}
          className="group flex items-center gap-2 bg-purple-600/60 hover:bg-purple-600/80 backdrop-blur-xl rounded-full px-4 py-3 border border-purple-400/30 hover:border-purple-400/50 transition-all duration-300 shadow-lg"
          title="Change Character"
        >
          <Users className="w-5 h-5 text-white" />
          <span className="text-white text-sm font-medium opacity-0 group-hover:opacity-100 max-w-0 group-hover:max-w-[100px] overflow-hidden transition-all duration-300">
            Characters
          </span>
        </button>
      )}

      {/* Current screen indicator */}
      {currentScreen && (
        <div className="bg-black/40 backdrop-blur-sm rounded-full px-3 py-1 mt-1">
          <span className="text-white/60 text-xs">{currentScreen}</span>
        </div>
      )}
    </div>
  );
};
