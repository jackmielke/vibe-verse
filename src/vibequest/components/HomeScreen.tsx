import { useState } from 'react';
import landingBackground from '@/assets/vibequest/landing-background.webp';
import robotMascot from '@/assets/vibequest/robot-mascot.webp';

interface HomeScreenProps {
  onStartGame: () => void;
}

export const HomeScreen = ({ onStartGame }: HomeScreenProps) => {
  const [isHovering, setIsHovering] = useState(false);

  return (
    <div 
      className="fixed inset-0 overflow-hidden"
      style={{
        backgroundImage: `url(${landingBackground})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat'
      }}
    >
      {/* Animated background overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/20 to-black/60" />
      
      {/* Floating particles effect */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {[...Array(20)].map((_, i) => (
          <div
            key={i}
            className="absolute w-2 h-2 bg-white/20 rounded-full animate-pulse"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 2}s`,
              animationDuration: `${2 + Math.random() * 3}s`,
            }}
          />
        ))}
      </div>

      <div className="relative z-10 min-h-screen flex flex-col items-center justify-center px-4">
        {/* Logo/Title area */}
        <div className="text-center space-y-6 mb-12">
          <div className="relative">
            <h1 className="text-6xl md:text-8xl font-black text-white drop-shadow-2xl tracking-tight">
              VIBE
              <span className="bg-gradient-to-r from-yellow-400 via-pink-500 to-purple-500 bg-clip-text text-transparent">
                QUEST
              </span>
            </h1>
            <div className="absolute -inset-4 bg-gradient-to-r from-yellow-400/20 via-pink-500/20 to-purple-500/20 blur-3xl -z-10 animate-pulse" />
          </div>
          <p className="text-xl md:text-2xl text-white/80 font-light tracking-wide">
            Choose your adventure, defeat the odds
          </p>
        </div>

        {/* Mascot */}
        <div 
          className={`relative transition-transform duration-500 ${isHovering ? 'scale-110' : 'scale-100'}`}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
        >
          <img 
            src={robotMascot} 
            alt="Robot Mascot" 
            className="w-40 h-40 md:w-56 md:h-56 object-contain drop-shadow-2xl"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-purple-500/30 to-transparent rounded-full blur-2xl -z-10" />
        </div>

        {/* Main CTA */}
        <button
          onClick={onStartGame}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
          className="mt-12 group relative overflow-hidden"
        >
          <div className="relative px-12 py-5 bg-gradient-to-r from-yellow-500 via-pink-500 to-purple-600 rounded-2xl font-bold text-white text-2xl md:text-3xl shadow-2xl transition-all duration-300 group-hover:shadow-pink-500/50 group-hover:scale-105">
            <span className="relative z-10">PLAY NOW</span>
            <div className="absolute inset-0 bg-gradient-to-r from-yellow-400 via-pink-400 to-purple-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          </div>
          <div className="absolute -inset-1 bg-gradient-to-r from-yellow-400 via-pink-500 to-purple-600 rounded-2xl blur opacity-50 group-hover:opacity-75 transition-opacity duration-300 -z-10" />
        </button>

        {/* Quick stats or info */}
        <div className="mt-16 flex gap-8 text-center">
          <div className="text-white/60">
            <p className="text-2xl font-bold text-white">7</p>
            <p className="text-sm">Game Modes</p>
          </div>
          <div className="w-px bg-white/20" />
          <div className="text-white/60">
            <p className="text-2xl font-bold text-white">∞</p>
            <p className="text-sm">Characters</p>
          </div>
          <div className="w-px bg-white/20" />
          <div className="text-white/60">
            <p className="text-2xl font-bold text-white">2P</p>
            <p className="text-sm">Co-op Ready</p>
          </div>
        </div>
      </div>

      {/* Bottom gradient fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />
    </div>
  );
};
