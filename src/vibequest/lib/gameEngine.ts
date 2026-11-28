import { pickUpVibeyCoin } from '@/lib/vibeyPickup';
import { WORLDS, type WorldData } from './levels';

interface GameConfig {
  onScoreUpdate: (score: number) => void;
  onGameWon: () => void;
  onLifeLost: (livesRemaining: number) => void;
  onGameOver: () => void;
  onLevelComplete: (currentLevel: number, totalLevels: number) => void;
  onAllLevelsComplete: () => void;
  onEnemiesStompedUpdate: (enemiesStomped: number) => void;
}

interface GameObject {
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
}

interface Player extends GameObject {
  velocityX: number;
  velocityY: number;
  isJumping: boolean;
  direction: 'left' | 'right';
  ducking: boolean;
  normalHeight: number;
}

interface Enemy extends GameObject {
  velocityX: number;
  direction: number;
  isDying?: boolean;
  deathTimer?: number;
  squashScale?: number;
}

interface Coin extends GameObject {
  collected: boolean;
  floatOffset: number;
}

interface Shield extends GameObject {
  collected: boolean;
  floatOffset: number;
}

interface Particle {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GameConfig;
  private animationId: number | null = null;
  private keys: { [key: string]: boolean } = {};
  private images: { [key: string]: HTMLImageElement } = {};
  private touchControls = { left: false, right: false, jump: false };
  private audioContext: AudioContext | null = null;
  /** Aborted on dispose(): removes every window listener this engine added. */
  private teardown = new AbortController();
  private musicGainNode: GainNode | null = null;
  private musicOscillators: OscillatorNode[] = [];
  
  // Game state
  private player: Player;
  private platforms: GameObject[] = [];
  private coins: Coin[] = [];
  private shields: Shield[] = [];
  private secrets: Coin[] = [];
  private decorations: Array<GameObject & { decorationType: string }> = [];
  private enemies: Enemy[] = [];
  private boss: (GameObject & { health: number; maxHealth: number; velocityX: number; direction: number; attackCooldown: number }) | null = null;
  private goal: (GameObject & { visible: boolean }) | null = null;
  private score = 0;
  private cameraX = 0;
  private lives = 3;
  private isInvulnerable = false;
  private invulnerabilityTimer = 0;
  private shieldActive = false;
  private shieldTimer = 0;
  private lastTime = 0;
  private particles: Particle[] = [];
  private currentWorld = 0;
  private startingWorld = 0;
  private currentWorldData: WorldData | null = null;
  private enemiesStomped = 0;
  
  // Constants (per second, not per frame)
  private readonly GRAVITY = 1000; // Reduced for easier jumping
  private readonly JUMP_FORCE = -550; // Increased for higher jumps
  private readonly MOVE_SPEED = 320; // Increased for faster movement
  private readonly FRICTION = 0.85;

  constructor(canvas: HTMLCanvasElement, config: GameConfig) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.config = config;
    
    this.player = {
      x: 100,
      y: 100,
      width: 50,
      height: 60,
      velocityX: 0,
      velocityY: 0,
      isJumping: false,
      direction: 'right',
      type: 'player',
      ducking: false,
      normalHeight: 60,
    };

    this.setupEventListeners();
    this.initAudio();
  }

  private initAudio() {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.musicGainNode = this.audioContext.createGain();
      this.musicGainNode.connect(this.audioContext.destination);
      this.musicGainNode.gain.value = 0.15; // Lower volume for background music
    } catch (e) {
      console.warn('Web Audio API not supported');
    }
  }

  private startBackgroundMusic() {
    if (!this.audioContext || !this.musicGainNode) return;
    
    // Stop any existing music
    this.stopBackgroundMusic();
    
    // Hip hop beat with kick, snare, and hi-hat pattern
    const bpm = 90;
    const beatDuration = 60 / bpm; // Duration of one beat in seconds
    
    const createLoop = () => {
      const startTime = this.audioContext!.currentTime;
      
      // Kick drum pattern (beats 1 and 3)
      [0, 2].forEach(beat => {
        const kickTime = startTime + beat * beatDuration;
        const kickOsc = this.audioContext!.createOscillator();
        const kickGain = this.audioContext!.createGain();
        
        kickOsc.connect(kickGain);
        kickGain.connect(this.musicGainNode!);
        
        kickOsc.frequency.setValueAtTime(150, kickTime);
        kickOsc.frequency.exponentialRampToValueAtTime(50, kickTime + 0.05);
        kickOsc.type = 'sine';
        
        kickGain.gain.setValueAtTime(0.6, kickTime);
        kickGain.gain.exponentialRampToValueAtTime(0.01, kickTime + 0.15);
        
        kickOsc.start(kickTime);
        kickOsc.stop(kickTime + 0.15);
        this.musicOscillators.push(kickOsc);
      });
      
      // Snare on beat 2 and 4
      [1, 3].forEach(beat => {
        const snareTime = startTime + beat * beatDuration;
        const snareOsc = this.audioContext!.createOscillator();
        const snareGain = this.audioContext!.createGain();
        const noiseBuffer = this.audioContext!.createBuffer(1, this.audioContext!.sampleRate * 0.1, this.audioContext!.sampleRate);
        const noiseData = noiseBuffer.getChannelData(0);
        for (let i = 0; i < noiseData.length; i++) {
          noiseData[i] = Math.random() * 2 - 1;
        }
        const noise = this.audioContext!.createBufferSource();
        noise.buffer = noiseBuffer;
        
        snareOsc.connect(snareGain);
        noise.connect(snareGain);
        snareGain.connect(this.musicGainNode!);
        
        snareOsc.frequency.setValueAtTime(200, snareTime);
        snareOsc.type = 'triangle';
        
        snareGain.gain.setValueAtTime(0.4, snareTime);
        snareGain.gain.exponentialRampToValueAtTime(0.01, snareTime + 0.1);
        
        snareOsc.start(snareTime);
        snareOsc.stop(snareTime + 0.1);
        noise.start(snareTime);
        noise.stop(snareTime + 0.08);
        this.musicOscillators.push(snareOsc);
      });
      
      // Hi-hat pattern (8th notes)
      [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].forEach(beat => {
        const hatTime = startTime + beat * beatDuration;
        const hatOsc = this.audioContext!.createOscillator();
        const hatGain = this.audioContext!.createGain();
        
        hatOsc.connect(hatGain);
        hatGain.connect(this.musicGainNode!);
        
        hatOsc.frequency.setValueAtTime(8000, hatTime);
        hatOsc.type = 'square';
        
        const volume = beat % 1 === 0 ? 0.15 : 0.08; // Accent on quarter notes
        hatGain.gain.setValueAtTime(volume, hatTime);
        hatGain.gain.exponentialRampToValueAtTime(0.01, hatTime + 0.03);
        
        hatOsc.start(hatTime);
        hatOsc.stop(hatTime + 0.03);
        this.musicOscillators.push(hatOsc);
      });
      
      // Bass line (simple two-note pattern)
      const bassNotes = [110, 130]; // A2, C3
      [0, 2].forEach((beat, i) => {
        const bassTime = startTime + beat * beatDuration;
        const bassOsc = this.audioContext!.createOscillator();
        const bassGain = this.audioContext!.createGain();
        
        bassOsc.connect(bassGain);
        bassGain.connect(this.musicGainNode!);
        
        bassOsc.frequency.setValueAtTime(bassNotes[i % 2], bassTime);
        bassOsc.type = 'sawtooth';
        
        bassGain.gain.setValueAtTime(0.25, bassTime);
        bassGain.gain.setValueAtTime(0.25, bassTime + beatDuration - 0.05);
        bassGain.gain.exponentialRampToValueAtTime(0.01, bassTime + beatDuration);
        
        bassOsc.start(bassTime);
        bassOsc.stop(bassTime + beatDuration);
        this.musicOscillators.push(bassOsc);
      });
    };
    
    // Create initial loop
    createLoop();
    
    // Set up infinite looping every 4 beats
    const loopDuration = beatDuration * 4;
    const loopInterval = setInterval(() => {
      if (this.animationId) {
        createLoop();
      } else {
        clearInterval(loopInterval);
      }
    }, loopDuration * 1000);
  }

  private stopBackgroundMusic() {
    this.musicOscillators.forEach(osc => {
      try {
        osc.stop();
      } catch (e) {
        // Oscillator might already be stopped
      }
    });
    this.musicOscillators = [];
  }

  private startBossMusic() {
    if (!this.audioContext || !this.musicGainNode) return;
    
    // Stop any existing music
    this.stopBackgroundMusic();
    
    // Suspenseful boss music - slower, darker, more intense
    const bpm = 60; // Slower, more menacing
    const beatDuration = 60 / bpm;
    
    const createLoop = () => {
      const startTime = this.audioContext!.currentTime;
      
      // Deep rumbling bass drone (creates tension)
      const droneOsc = this.audioContext!.createOscillator();
      const droneGain = this.audioContext!.createGain();
      droneOsc.connect(droneGain);
      droneGain.connect(this.musicGainNode!);
      
      droneOsc.frequency.setValueAtTime(55, startTime); // A1 - very low
      droneOsc.type = 'sawtooth';
      droneGain.gain.setValueAtTime(0.2, startTime);
      droneGain.gain.setValueAtTime(0.25, startTime + beatDuration * 2);
      droneGain.gain.setValueAtTime(0.2, startTime + beatDuration * 4);
      
      droneOsc.start(startTime);
      droneOsc.stop(startTime + beatDuration * 4);
      this.musicOscillators.push(droneOsc);
      
      // Heavy kick drum (powerful, threatening)
      [0, 2].forEach(beat => {
        const kickTime = startTime + beat * beatDuration;
        const kickOsc = this.audioContext!.createOscillator();
        const kickGain = this.audioContext!.createGain();
        
        kickOsc.connect(kickGain);
        kickGain.connect(this.musicGainNode!);
        
        kickOsc.frequency.setValueAtTime(120, kickTime);
        kickOsc.frequency.exponentialRampToValueAtTime(40, kickTime + 0.1);
        kickOsc.type = 'sine';
        
        kickGain.gain.setValueAtTime(0.8, kickTime);
        kickGain.gain.exponentialRampToValueAtTime(0.01, kickTime + 0.2);
        
        kickOsc.start(kickTime);
        kickOsc.stop(kickTime + 0.2);
        this.musicOscillators.push(kickOsc);
      });
      
      // Dissonant synth stabs (creates unease)
      [1, 3].forEach(beat => {
        const stabTime = startTime + beat * beatDuration;
        const stab1 = this.audioContext!.createOscillator();
        const stab2 = this.audioContext!.createOscillator();
        const stabGain = this.audioContext!.createGain();
        
        stab1.connect(stabGain);
        stab2.connect(stabGain);
        stabGain.connect(this.musicGainNode!);
        
        // Dissonant interval (tritone - "devil's interval")
        stab1.frequency.setValueAtTime(185, stabTime); // F#3
        stab2.frequency.setValueAtTime(262, stabTime); // C4
        stab1.type = 'sawtooth';
        stab2.type = 'sawtooth';
        
        stabGain.gain.setValueAtTime(0.3, stabTime);
        stabGain.gain.exponentialRampToValueAtTime(0.01, stabTime + 0.15);
        
        stab1.start(stabTime);
        stab2.start(stabTime);
        stab1.stop(stabTime + 0.15);
        stab2.stop(stabTime + 0.15);
        this.musicOscillators.push(stab1, stab2);
      });
      
      // Eerie high-pitched oscillating sound (like a siren)
      [0.5, 1.5, 2.5, 3.5].forEach(beat => {
        const eerieTime = startTime + beat * beatDuration;
        const eerieOsc = this.audioContext!.createOscillator();
        const eerieGain = this.audioContext!.createGain();
        
        eerieOsc.connect(eerieGain);
        eerieGain.connect(this.musicGainNode!);
        
        eerieOsc.frequency.setValueAtTime(1200, eerieTime);
        eerieOsc.frequency.exponentialRampToValueAtTime(1400, eerieTime + 0.1);
        eerieOsc.type = 'sine';
        
        eerieGain.gain.setValueAtTime(0.1, eerieTime);
        eerieGain.gain.exponentialRampToValueAtTime(0.01, eerieTime + 0.1);
        
        eerieOsc.start(eerieTime);
        eerieOsc.stop(eerieTime + 0.1);
        this.musicOscillators.push(eerieOsc);
      });
      
      // Pulsing sub-bass (creates physical tension)
      [0, 1, 2, 3].forEach(beat => {
        const pulseTime = startTime + beat * beatDuration;
        const pulseOsc = this.audioContext!.createOscillator();
        const pulseGain = this.audioContext!.createGain();
        
        pulseOsc.connect(pulseGain);
        pulseGain.connect(this.musicGainNode!);
        
        pulseOsc.frequency.setValueAtTime(65, pulseTime); // C2
        pulseOsc.type = 'sine';
        
        pulseGain.gain.setValueAtTime(0.15, pulseTime);
        pulseGain.gain.exponentialRampToValueAtTime(0.01, pulseTime + 0.3);
        
        pulseOsc.start(pulseTime);
        pulseOsc.stop(pulseTime + 0.3);
        this.musicOscillators.push(pulseOsc);
      });
    };
    
    // Create initial loop
    createLoop();
    
    // Set up infinite looping
    const loopDuration = beatDuration * 4;
    const loopInterval = setInterval(() => {
      if (this.animationId) {
        createLoop();
      } else {
        clearInterval(loopInterval);
      }
    }, loopDuration * 1000);
  }

  private playCoinSound() {
    if (!this.audioContext) return;
    
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    
    // Mario-like coin sound frequencies
    oscillator.frequency.setValueAtTime(988, this.audioContext.currentTime);
    oscillator.frequency.setValueAtTime(1319, this.audioContext.currentTime + 0.1);
    
    oscillator.type = 'square';
    
    // Quick fade out
    gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.2);
    
    oscillator.start(this.audioContext.currentTime);
    oscillator.stop(this.audioContext.currentTime + 0.2);
  }

  private playJumpSound() {
    if (!this.audioContext) return;
    
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    
    // Quick upward sweep for jump
    oscillator.frequency.setValueAtTime(200, this.audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(600, this.audioContext.currentTime + 0.1);
    
    oscillator.type = 'square';
    
    gainNode.gain.setValueAtTime(0.2, this.audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
    
    oscillator.start(this.audioContext.currentTime);
    oscillator.stop(this.audioContext.currentTime + 0.1);
  }

  private playDeathSound() {
    if (!this.audioContext) return;
    
    // Funny "bonk" sound - soft and comedic
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    
    // Gentle downward sweep with wobble for comedy
    oscillator.frequency.setValueAtTime(200, this.audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(60, this.audioContext.currentTime + 0.2);
    
    oscillator.type = 'sine'; // Soft, friendly sound
    
    // Very gentle volume - fade in slightly then fade out for smooth "boop" effect
    gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.08, this.audioContext.currentTime + 0.02); // Much quieter!
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.2);
    
    oscillator.start(this.audioContext.currentTime);
    oscillator.stop(this.audioContext.currentTime + 0.2);
  }

  private playLevelClearSound() {
    if (!this.audioContext) return;
    
    // Short, pleasant victory jingle (much shorter and quieter)
    const notes = [523, 659, 784]; // C, E, G
    const noteDuration = 0.12;
    
    notes.forEach((frequency, index) => {
      const oscillator = this.audioContext!.createOscillator();
      const gainNode = this.audioContext!.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext!.destination);
      
      oscillator.frequency.setValueAtTime(frequency, this.audioContext!.currentTime);
      oscillator.type = 'sine'; // Softer sine wave instead of square
      
      const startTime = this.audioContext!.currentTime + index * noteDuration;
      gainNode.gain.setValueAtTime(0.15, startTime); // Much quieter
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + noteDuration);
      
      oscillator.start(startTime);
      oscillator.stop(startTime + noteDuration);
    });
  }

  private playStompSound() {
    if (!this.audioContext) return;
    
    // Fun cartoonish "squash" sound with multiple layers
    
    // Layer 1: Quick descending "bonk"
    const bonkOsc = this.audioContext.createOscillator();
    const bonkGain = this.audioContext.createGain();
    bonkOsc.connect(bonkGain);
    bonkGain.connect(this.audioContext.destination);
    
    bonkOsc.frequency.setValueAtTime(800, this.audioContext.currentTime);
    bonkOsc.frequency.exponentialRampToValueAtTime(150, this.audioContext.currentTime + 0.08);
    bonkOsc.type = 'square';
    
    bonkGain.gain.setValueAtTime(0.3, this.audioContext.currentTime);
    bonkGain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
    
    bonkOsc.start(this.audioContext.currentTime);
    bonkOsc.stop(this.audioContext.currentTime + 0.1);
    
    // Layer 2: Bass "thump" for impact
    const thumpOsc = this.audioContext.createOscillator();
    const thumpGain = this.audioContext.createGain();
    thumpOsc.connect(thumpGain);
    thumpGain.connect(this.audioContext.destination);
    
    thumpOsc.frequency.setValueAtTime(120, this.audioContext.currentTime);
    thumpOsc.frequency.exponentialRampToValueAtTime(30, this.audioContext.currentTime + 0.12);
    thumpOsc.type = 'sine';
    
    thumpGain.gain.setValueAtTime(0.4, this.audioContext.currentTime);
    thumpGain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);
    
    thumpOsc.start(this.audioContext.currentTime);
    thumpOsc.stop(this.audioContext.currentTime + 0.15);
    
    // Layer 3: Quick "pop" at the end for comedy
    const popOsc = this.audioContext.createOscillator();
    const popGain = this.audioContext.createGain();
    popOsc.connect(popGain);
    popGain.connect(this.audioContext.destination);
    
    popOsc.frequency.setValueAtTime(400, this.audioContext.currentTime + 0.05);
    popOsc.frequency.exponentialRampToValueAtTime(200, this.audioContext.currentTime + 0.1);
    popOsc.type = 'triangle';
    
    popGain.gain.setValueAtTime(0.2, this.audioContext.currentTime + 0.05);
    popGain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.12);
    
    popOsc.start(this.audioContext.currentTime + 0.05);
    popOsc.stop(this.audioContext.currentTime + 0.12);
  }

  private playLavaSound() {
    if (!this.audioContext) return;
    
    // Gentle "sizzle" sound for lava death - comedic not scary
    const sizzleOsc = this.audioContext.createOscillator();
    const sizzleGain = this.audioContext.createGain();
    sizzleOsc.connect(sizzleGain);
    sizzleGain.connect(this.audioContext.destination);
    
    sizzleOsc.frequency.setValueAtTime(300, this.audioContext.currentTime);
    sizzleOsc.frequency.exponentialRampToValueAtTime(80, this.audioContext.currentTime + 0.25);
    sizzleOsc.type = 'triangle'; // Much softer than sawtooth
    
    // Gentle fade in and out - no abrupt start
    sizzleGain.gain.setValueAtTime(0, this.audioContext.currentTime);
    sizzleGain.gain.linearRampToValueAtTime(0.1, this.audioContext.currentTime + 0.03); // Much quieter
    sizzleGain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.25);
    
    sizzleOsc.start(this.audioContext.currentTime);
    sizzleOsc.stop(this.audioContext.currentTime + 0.25);
  }

  private playShieldSound() {
    if (!this.audioContext) return;
    
    // Magical "whoosh" power-up sound
    const shield1 = this.audioContext.createOscillator();
    const shield2 = this.audioContext.createOscillator();
    const shieldGain = this.audioContext.createGain();
    
    shield1.connect(shieldGain);
    shield2.connect(shieldGain);
    shieldGain.connect(this.audioContext.destination);
    
    shield1.frequency.setValueAtTime(400, this.audioContext.currentTime);
    shield1.frequency.exponentialRampToValueAtTime(800, this.audioContext.currentTime + 0.2);
    shield2.frequency.setValueAtTime(600, this.audioContext.currentTime);
    shield2.frequency.exponentialRampToValueAtTime(1200, this.audioContext.currentTime + 0.2);
    
    shield1.type = 'sine';
    shield2.type = 'sine';
    
    shieldGain.gain.setValueAtTime(0.25, this.audioContext.currentTime);
    shieldGain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.25);
    
    shield1.start(this.audioContext.currentTime);
    shield2.start(this.audioContext.currentTime);
    shield1.stop(this.audioContext.currentTime + 0.25);
    shield2.stop(this.audioContext.currentTime + 0.25);
  }

  private playSecretSound() {
    if (!this.audioContext) return;
    
    // Magical treasure sound - ascending arpeggio
    const notes = [523, 659, 784, 1047]; // C, E, G, C (octave higher)
    const noteDuration = 0.08;
    
    notes.forEach((frequency, index) => {
      const oscillator = this.audioContext!.createOscillator();
      const gainNode = this.audioContext!.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext!.destination);
      
      oscillator.frequency.setValueAtTime(frequency, this.audioContext!.currentTime);
      oscillator.type = 'sine';
      
      const startTime = this.audioContext!.currentTime + index * noteDuration;
      gainNode.gain.setValueAtTime(0.3, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + noteDuration * 2);
      
      oscillator.start(startTime);
      oscillator.stop(startTime + noteDuration * 2);
    });
  }

  private createParticles(x: number, y: number, count: number, colors: string[]) {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = 100 + Math.random() * 150;
      this.particles.push({
        x,
        y,
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * speed - 50,
        life: 1,
        maxLife: 1,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 3 + Math.random() * 4,
      });
    }
  }

  private updateParticles(deltaTime: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      
      particle.x += particle.velocityX * deltaTime;
      particle.y += particle.velocityY * deltaTime;
      particle.velocityY += 500 * deltaTime; // Gravity
      particle.life -= deltaTime;
      
      if (particle.life <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  async loadImage(src: string, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.images[key] = img;
        resolve();
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  init(startingWorld: number = 0) {
    this.startingWorld = startingWorld;
    this.loadWorld(startingWorld);
  }

  private loadWorld(worldIndex: number) {
    if (worldIndex >= WORLDS.length) {
      this.config.onAllLevelsComplete();
      this.stop();
      return;
    }

    this.currentWorld = worldIndex;
    const world = WORLDS[worldIndex];
    this.currentWorldData = world;

    // Clear existing world data
    this.platforms = [];
    this.coins = [];
    this.shields = [];
    this.secrets = [];
    this.decorations = [];
    this.enemies = [];
    this.particles = [];

    // Set player start position
    this.player.x = world.playerStart.x;
    this.player.y = world.playerStart.y;
    this.player.velocityX = 0;
    this.player.velocityY = 0;
    this.cameraX = 0;

    // Load platforms
    world.platforms.forEach(p => {
      this.platforms.push({ ...p, type: 'platform' });
    });

    // Load coins
    world.coins.forEach(c => {
      this.coins.push({ ...c, type: 'coin', collected: false, floatOffset: 0 });
    });

    // Load shields
    world.shields.forEach(s => {
      this.shields.push({ ...s, type: 'shield', collected: false, floatOffset: 0 });
    });

    // Load secrets
    if (world.secrets) {
      world.secrets.forEach(s => {
        this.secrets.push({ ...s, type: 'secret', collected: false });
      });
    }

    // Load decorations
    if (world.decorations) {
      world.decorations.forEach(d => {
        this.decorations.push({ ...d, type: 'decoration', decorationType: d.type });
      });
    }

    // Load enemies
    world.enemies.forEach(e => {
      this.enemies.push({ ...e, type: 'enemy' });
    });

    // Load boss if present
    if (world.boss) {
      this.boss = {
        ...world.boss,
        type: 'boss',
        maxHealth: world.boss.health,
        velocityX: 2,
        direction: 1,
        attackCooldown: 0,
      };
    } else {
      this.boss = null;
    }

    this.goal = { ...world.goal, type: 'goal', visible: !world.boss };
  }

  private nextWorld() {
    // No longer auto-progress - just notify that level is complete
    this.config.onLevelComplete(this.currentWorld, WORLDS.length);
    this.stop(); // Stop the game engine to show world selection
  }

  // Public method to load a specific world (called from UI)
  loadSpecificWorld(worldIndex: number) {
    this.loadWorld(worldIndex);
    this.start();
  }

  private setupEventListeners() {
    window.addEventListener('keydown', (e) => {
      this.keys[e.key] = true;
      if (e.key === ' ' || e.key === 'ArrowUp') {
        e.preventDefault();
      }
    }, { signal: this.teardown.signal });

    window.addEventListener('keyup', (e) => {
      this.keys[e.key] = false;
    }, { signal: this.teardown.signal });
  }

  private handleInput(deltaTime: number) {
    // Handle ducking
    if (this.keys['ArrowDown']) {
      if (!this.player.ducking && !this.player.isJumping) {
        const heightDiff = this.player.height - this.player.normalHeight / 2;
        this.player.y += heightDiff; // Move player down to maintain ground position
        this.player.height = this.player.normalHeight / 2;
        this.player.ducking = true;
      }
    } else {
      if (this.player.ducking) {
        this.player.height = this.player.normalHeight;
        this.player.y -= this.player.normalHeight / 2; // Move player up to restore position
        this.player.ducking = false;
      }
    }

    if (this.keys['ArrowLeft'] || this.touchControls.left) {
      this.player.velocityX = -this.MOVE_SPEED;
      this.player.direction = 'left';
    } else if (this.keys['ArrowRight'] || this.touchControls.right) {
      this.player.velocityX = this.MOVE_SPEED;
      this.player.direction = 'right';
    } else {
      this.player.velocityX *= Math.pow(this.FRICTION, deltaTime * 60);
    }

    // Handle jumping (can't jump while ducking)
    if ((this.keys[' '] || this.keys['ArrowUp'] || this.touchControls.jump) && !this.player.ducking) {
      if (!this.player.isJumping) {
        this.player.velocityY = this.JUMP_FORCE;
        this.player.isJumping = true;
        this.touchControls.jump = false;
        this.playJumpSound();
      }
    }
  }

  setTouchControl(control: 'left' | 'right' | 'jump', active: boolean) {
    this.touchControls[control] = active;
  }

  private update(deltaTime: number) {
    this.handleInput(deltaTime);

    // Apply gravity
    this.player.velocityY += this.GRAVITY * deltaTime;

    // Update player position
    this.player.x += this.player.velocityX * deltaTime;
    this.player.y += this.player.velocityY * deltaTime;

    // Camera follows player
    this.cameraX = this.player.x - this.canvas.width / 3;
    if (this.cameraX < 0) this.cameraX = 0;

    // Platform collision
    this.player.isJumping = true;
    for (const platform of this.platforms) {
      if (this.checkCollision(this.player, platform)) {
        if (this.player.velocityY > 0 && this.player.y + this.player.height - this.player.velocityY <= platform.y) {
          this.player.y = platform.y - this.player.height;
          this.player.velocityY = 0;
          this.player.isJumping = false;
        }
      }
    }

    // Lava collision - instant death!
    const lavaHeight = 80;
    const lavaY = this.canvas.height - lavaHeight;
    if (this.player.y + this.player.height > lavaY && !this.isInvulnerable && !this.shieldActive) {
      // Create dramatic fire particles
      this.createParticles(
        this.player.x + this.player.width / 2, 
        lavaY, 
        20, 
        ['#ef4444', '#f97316', '#fb923c', '#fbbf24', '#f59e0b']
      );
      this.playLavaSound();
      this.loseLife();
    }

    // Coin collection
    for (const coin of this.coins) {
      if (!coin.collected && this.checkCollision(this.player, coin)) {
        coin.collected = true;
        this.score++;
        this.config.onScoreUpdate(this.score);
        this.playCoinSound();
        // A Vibey Coin: it lands in the shared balance too.
        pickUpVibeyCoin('vibequest');
        this.createParticles(coin.x + coin.width / 2, coin.y + coin.height / 2, 8, ['#7dffd4', '#59b8ff', '#9dffe0', '#eafff8']);
      }
    }

    // Shield collection
    for (const shield of this.shields) {
      if (!shield.collected && this.checkCollision(this.player, shield)) {
        shield.collected = true;
        this.shieldActive = true;
        this.shieldTimer = 5000; // 5 seconds of protection
        this.playShieldSound();
        // Spawn cyan/blue sparkle particles
        this.createParticles(shield.x + shield.width / 2, shield.y + shield.height / 2, 15, ['#06b6d4', '#0ea5e9', '#3b82f6', '#60a5fa', '#38bdf8']);
      }
    }

    // Secret treasure collection (worth 5 points!)
    for (const secret of this.secrets) {
      if (!secret.collected && this.checkCollision(this.player, secret)) {
        secret.collected = true;
        this.score += 5; // Worth 5x a normal coin!
        this.config.onScoreUpdate(this.score);
        this.playSecretSound();
        // Spawn golden treasure particles
        this.createParticles(secret.x + secret.width / 2, secret.y + secret.height / 2, 20, ['#fbbf24', '#f59e0b', '#fde047', '#facc15', '#fff']);
      }
    }

    // Enemy movement and collision
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      
      // Handle death animation
      if (enemy.isDying) {
        enemy.deathTimer! -= deltaTime;
        // Squash down quickly (0.1s), then fade the rest
        if (enemy.deathTimer! > 0.2) {
          enemy.squashScale = 1 - ((0.3 - enemy.deathTimer!) / 0.1) * 0.8; // Squash to 20% height
        }
        
        if (enemy.deathTimer! <= 0) {
          this.enemies.splice(i, 1);
          continue;
        }
        // Skip movement and collision while dying
        continue;
      }
      
      enemy.x += enemy.velocityX * enemy.direction * deltaTime * 60;
      
      // Bounce off platform edges
      const onPlatform = this.platforms.find(p => 
        enemy.x + enemy.width / 2 >= p.x && 
        enemy.x + enemy.width / 2 <= p.x + p.width &&
        Math.abs(enemy.y + enemy.height - p.y) < 5
      );
      
      if (onPlatform) {
        if (enemy.x <= onPlatform.x || enemy.x + enemy.width >= onPlatform.x + onPlatform.width) {
          enemy.direction *= -1;
        }
      }
      
      // Bounce off screen edges (for floating enemies)
      const screenLeft = this.cameraX;
      const screenRight = this.cameraX + this.canvas.width;
      
      if (enemy.x < screenLeft) {
        enemy.x = screenLeft;
        enemy.direction = 1; // Move right
      } else if (enemy.x + enemy.width > screenRight) {
        enemy.x = screenRight - enemy.width;
        enemy.direction = -1; // Move left
      }

      // Player-enemy collision
      if (this.checkCollision(this.player, enemy) && !this.isInvulnerable && !this.shieldActive) {
        // Check if player is jumping on enemy from above
        const isStomping = this.player.velocityY > 0 && 
                          this.player.y + this.player.height - 15 < enemy.y;
        
        if (isStomping) {
          // Stomp the enemy - trigger death animation!
          enemy.isDying = true;
          enemy.deathTimer = 0.3; // 0.3 seconds death animation
          enemy.squashScale = 1;
          
          // Create particle burst effect
          this.createParticles(
            enemy.x + enemy.width / 2, 
            enemy.y + enemy.height / 2, 
            12, 
            ['#a855f7', '#c084fc', '#e879f9', '#f0abfc'] // Purple particles for slime enemies
          );
          
          this.score += 2; // Bonus points for stomping
          this.config.onScoreUpdate(this.score);
          this.enemiesStomped++;
          this.config.onEnemiesStompedUpdate(this.enemiesStomped);
          this.playStompSound();
          // Small bounce for player
          this.player.velocityY = -300;
        } else {
          // Hit from the side - take damage
          this.loseLife();
        }
      }
    }

    // Boss logic
    if (this.boss) {
      // Update attack cooldown
      if (this.boss.attackCooldown > 0) {
        this.boss.attackCooldown -= deltaTime;
      }

      // Boss movement - patrol left and right
      this.boss.x += this.boss.velocityX * this.boss.direction * deltaTime * 60;

      // Bounce off screen boundaries
      const bossScreenLeft = 200;
      const bossScreenRight = 1000;
      if (this.boss.x < bossScreenLeft || this.boss.x + this.boss.width > bossScreenRight) {
        this.boss.direction *= -1;
      }

      // Boss-player collision
      if (this.checkCollision(this.player, this.boss) && !this.isInvulnerable && !this.shieldActive) {
        const isStomping = this.player.velocityY > 0 && 
                          this.player.y + this.player.height - 15 < this.boss.y;
        
        if (isStomping && this.boss.attackCooldown <= 0) {
          // Hit the boss
          this.boss.health--;
          this.boss.attackCooldown = 0.5; // Half second invulnerability
          
          // Create impact particles
          this.createParticles(
            this.boss.x + this.boss.width / 2,
            this.boss.y + 20,
            15,
            ['#ef4444', '#dc2626', '#991b1b', '#fff']
          );
          
          this.score += 5;
          this.config.onScoreUpdate(this.score);
          this.playStompSound();
          this.player.velocityY = -400; // Big bounce
          
          // Check if boss defeated
          if (this.boss.health <= 0) {
            // Boss defeated - huge particle explosion
            this.createParticles(
              this.boss.x + this.boss.width / 2,
              this.boss.y + this.boss.height / 2,
              50,
              ['#fbbf24', '#f59e0b', '#ef4444', '#dc2626', '#fff']
            );
            this.playSecretSound();
            this.score += 20; // Big bonus for defeating boss
            this.config.onScoreUpdate(this.score);
            this.boss = null; // Remove boss
            
            // Show the goal portal after defeating boss
            if (this.goal) {
              this.goal.visible = true;
            }
          }
        } else if (!isStomping) {
          // Hit from side - take damage
          this.loseLife();
        }
      }
    }


    // Goal collision
    if (this.goal && this.checkCollision(this.player, this.goal)) {
      this.playLevelClearSound();
      // Always show world selection after completing a level
      this.nextWorld();
    }

    // Update invulnerability
    if (this.isInvulnerable) {
      this.invulnerabilityTimer -= deltaTime * 1000;
      if (this.invulnerabilityTimer <= 0) {
        this.isInvulnerable = false;
      }
    }

    // Update shield timer
    if (this.shieldActive) {
      this.shieldTimer -= deltaTime * 1000;
      if (this.shieldTimer <= 0) {
        this.shieldActive = false;
      }
    }

    // Update particles
    this.updateParticles(deltaTime);
  }

  private loseLife() {
    this.lives--;
    this.playDeathSound();
    this.config.onLifeLost(this.lives);
    
    if (this.lives <= 0) {
      this.config.onGameOver();
      this.stop();
    } else {
      // Respawn with invulnerability
      this.player.x = 100;
      this.player.y = 100;
      this.player.velocityX = 0;
      this.player.velocityY = 0;
      this.isInvulnerable = true;
      this.invulnerabilityTimer = 2000; // 2 seconds
    }
  }

  private checkCollision(a: GameObject, b: GameObject): boolean {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }

  private render() {
    // Clear canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw themed background
    if (this.currentWorldData) {
      const gradient = this.ctx.createLinearGradient(0, 0, 0, this.canvas.height);
      const colors = this.currentWorldData.theme.background.match(/hsl\([^)]+\)|#[0-9A-Fa-f]{6}/g) || ['#87CEEB', '#E0F6FF'];
      gradient.addColorStop(0, colors[0]);
      gradient.addColorStop(1, colors[1] || colors[0]);
      this.ctx.fillStyle = gradient;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    } else if (this.images['background']) {
      const bgX = -this.cameraX * 0.3;
      this.ctx.drawImage(this.images['background'], bgX, 0, this.canvas.width * 2, this.canvas.height);
    }

    // Draw animated lava at the bottom
    const lavaHeight = 80;
    const lavaY = this.canvas.height - lavaHeight;
    const time = Date.now() / 1000;
    
    // Lava gradient
    const lavaGradient = this.ctx.createLinearGradient(0, lavaY, 0, this.canvas.height);
    lavaGradient.addColorStop(0, '#ef4444');
    lavaGradient.addColorStop(0.5, '#dc2626');
    lavaGradient.addColorStop(1, '#991b1b');
    this.ctx.fillStyle = lavaGradient;
    this.ctx.fillRect(0, lavaY, this.canvas.width, lavaHeight);
    
    // Lava bubbles/waves effect
    this.ctx.save();
    for (let i = 0; i < 8; i++) {
      const bubbleX = (i / 8) * this.canvas.width + (Math.sin(time * 2 + i) * 30);
      const bubbleY = lavaY + 20 + Math.sin(time * 3 + i * 0.5) * 15;
      const bubbleSize = 15 + Math.sin(time * 2.5 + i) * 8;
      
      this.ctx.fillStyle = `rgba(251, 146, 60, ${0.4 + Math.sin(time * 2 + i) * 0.2})`;
      this.ctx.beginPath();
      this.ctx.arc(bubbleX, bubbleY, bubbleSize, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.restore();

    // Save context for camera
    this.ctx.save();
    this.ctx.translate(-this.cameraX, 0);

    // Draw themed platforms
    for (const platform of this.platforms) {
      const platformColor = this.currentWorldData?.theme.platformColor || '#4ade80';
      this.ctx.fillStyle = platformColor;
      this.ctx.shadowColor = platformColor + '40';
      this.ctx.shadowBlur = 10;
      this.ctx.fillRect(platform.x, platform.y, platform.width, platform.height);
      
      // Platform top highlight
      this.ctx.globalAlpha = 0.3;
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(platform.x, platform.y, platform.width, 8);
      this.ctx.globalAlpha = 1;
      this.ctx.shadowBlur = 0;
    }

    // Draw coins with enhanced effects
    for (const coin of this.coins) {
      if (!coin.collected) {
        const floatY = coin.y + Math.sin(time * 2 + coin.floatOffset) * 8;
        const rotation = time * 2 + coin.floatOffset;
        const scale = 1 + Math.sin(time * 3 + coin.floatOffset) * 0.1;
        const pulse = 1 + Math.sin(time * 5 + coin.floatOffset) * 0.3;
        
        if (this.images['coin']) {
          this.ctx.save();
          
          // Outer glow rings
          const centerX = coin.x + coin.width / 2;
          const centerY = floatY + coin.height / 2;
          
          // Create multiple glow layers
          for (let i = 3; i > 0; i--) {
            const glowSize = (coin.width * 0.8) * pulse * (1 + i * 0.3);
            const glowAlpha = 0.15 / i;
            
            const glowGradient = this.ctx.createRadialGradient(
              centerX, centerY, 0,
              centerX, centerY, glowSize
            );
            glowGradient.addColorStop(0, `rgba(125, 255, 212, ${glowAlpha})`);
            glowGradient.addColorStop(0.5, `rgba(89, 184, 255, ${glowAlpha * 0.5})`);
            glowGradient.addColorStop(1, 'rgba(125, 255, 212, 0)');
            
            this.ctx.fillStyle = glowGradient;
            this.ctx.beginPath();
            this.ctx.arc(centerX, centerY, glowSize, 0, Math.PI * 2);
            this.ctx.fill();
          }
          
          // Sparkle particles around coin
          for (let i = 0; i < 6; i++) {
            const angle = (time * 2 + coin.floatOffset + i * Math.PI / 3);
            const sparkleDistance = 25 + Math.sin(time * 3) * 5;
            const sparkleX = centerX + Math.cos(angle) * sparkleDistance;
            const sparkleY = centerY + Math.sin(angle) * sparkleDistance;
            const sparkleSize = 2 + Math.sin(time * 4 + i) * 1.5;
            const sparkleAlpha = 0.6 + Math.sin(time * 5 + i) * 0.4;
            
            this.ctx.fillStyle = `rgba(157, 255, 224, ${sparkleAlpha})`;
            this.ctx.shadowColor = 'rgba(125, 255, 212, 1)';
            this.ctx.shadowBlur = 8;
            this.ctx.beginPath();
            this.ctx.arc(sparkleX, sparkleY, sparkleSize, 0, Math.PI * 2);
            this.ctx.fill();
          }
          
          // Main coin shadow
          this.ctx.shadowColor = 'rgba(125, 255, 212, 0.9)';
          this.ctx.shadowBlur = 30;
          
          // Draw coin with rotation and scale
          this.ctx.translate(centerX, centerY);
          this.ctx.rotate(rotation * 0.5);
          this.ctx.scale(scale, scale);
          
          this.ctx.drawImage(
            this.images['coin'],
            -coin.width / 2 - 5,
            -coin.height / 2 - 5,
            coin.width + 10,
            coin.height + 10
          );
          
          this.ctx.restore();
        }
      }
    }

    // Draw shields
    for (const shield of this.shields) {
      if (!shield.collected) {
        const floatY = shield.y + Math.sin(time * 2 + shield.floatOffset) * 8;
        const pulse = 1 + Math.sin(time * 4) * 0.15;
        
        this.ctx.save();
        // Draw glowing shield icon
        this.ctx.shadowColor = 'rgba(6, 182, 212, 1)';
        this.ctx.shadowBlur = 25;
        
        // Shield shape (hexagon)
        const centerX = shield.x + shield.width / 2;
        const centerY = floatY + shield.height / 2;
        const radius = (shield.width / 2) * pulse;
        
        this.ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle = (Math.PI / 3) * i;
          const x = centerX + radius * Math.cos(angle);
          const y = centerY + radius * Math.sin(angle);
          if (i === 0) this.ctx.moveTo(x, y);
          else this.ctx.lineTo(x, y);
        }
        this.ctx.closePath();
        
        // Gradient fill
        const gradient = this.ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
        gradient.addColorStop(0, 'rgba(6, 182, 212, 0.9)');
        gradient.addColorStop(0.5, 'rgba(14, 165, 233, 0.7)');
        gradient.addColorStop(1, 'rgba(59, 130, 246, 0.5)');
        this.ctx.fillStyle = gradient;
        this.ctx.fill();
        
        // Border
        this.ctx.strokeStyle = '#38bdf8';
        this.ctx.lineWidth = 3;
        this.ctx.stroke();
        
        this.ctx.restore();
      }
    }

    // Draw decorations (non-interactive)
    for (const decoration of this.decorations) {
      const imageName = decoration.decorationType;
      if (this.images[imageName]) {
        this.ctx.save();
        this.ctx.globalAlpha = 0.8;
        this.ctx.drawImage(
          this.images[imageName],
          decoration.x,
          decoration.y,
          decoration.width,
          decoration.height
        );
        this.ctx.restore();
      }
    }

    // Draw secret treasures
    for (const secret of this.secrets) {
      if (!secret.collected && this.images['treasure']) {
        const floatY = secret.y + Math.sin(time * 2 + secret.floatOffset) * 10;
        const rotation = time * 1.5 + secret.floatOffset;
        const pulse = 1 + Math.sin(time * 4 + secret.floatOffset) * 0.2;
        
        this.ctx.save();
        
        // Magical glow
        const centerX = secret.x + secret.width / 2;
        const centerY = floatY + secret.height / 2;
        
        for (let i = 3; i > 0; i--) {
          const glowSize = secret.width * pulse * (1 + i * 0.4);
          const glowAlpha = 0.2 / i;
          
          const glowGradient = this.ctx.createRadialGradient(
            centerX, centerY, 0,
            centerX, centerY, glowSize
          );
          glowGradient.addColorStop(0, `rgba(255, 215, 0, ${glowAlpha})`);
          glowGradient.addColorStop(0.5, `rgba(255, 165, 0, ${glowAlpha * 0.5})`);
          glowGradient.addColorStop(1, 'rgba(255, 215, 0, 0)');
          
          this.ctx.fillStyle = glowGradient;
          this.ctx.beginPath();
          this.ctx.arc(centerX, centerY, glowSize, 0, Math.PI * 2);
          this.ctx.fill();
        }
        
        this.ctx.shadowColor = 'rgba(255, 215, 0, 1)';
        this.ctx.shadowBlur = 30;
        
        this.ctx.translate(centerX, centerY);
        this.ctx.rotate(rotation * 0.3);
        this.ctx.scale(pulse, pulse);
        
        this.ctx.drawImage(
          this.images['treasure'],
          -secret.width / 2,
          -secret.height / 2,
          secret.width,
          secret.height
        );
        
        this.ctx.restore();
      }
    }

    // Draw enemies with enhanced effects
    for (const enemy of this.enemies) {
      if (this.images['slime']) {
        this.ctx.save();
        
        // Apply death animation effects
        if (enemy.isDying) {
          const opacity = Math.max(0, enemy.deathTimer! / 0.3);
          this.ctx.globalAlpha = opacity;
          
          // Apply squash effect
          const squashScale = enemy.squashScale || 1;
          const centerX = enemy.x + enemy.width / 2;
          const centerY = enemy.y + enemy.height;
          
          this.ctx.translate(centerX, centerY);
          this.ctx.scale(1 + (1 - squashScale) * 0.5, squashScale);
          this.ctx.translate(-centerX, -centerY);
        } else {
          // Alive enemy effects
          const bounce = Math.sin(time * 4 + enemy.x * 0.01) * 0.08;
          const glowPulse = 0.6 + Math.sin(time * 3 + enemy.x * 0.02) * 0.4;
          
          // Menacing glow aura
          const centerX = enemy.x + enemy.width / 2;
          const centerY = enemy.y + enemy.height / 2;
          
          // Multiple glow layers for danger effect
          for (let i = 2; i > 0; i--) {
            const glowSize = enemy.width * 0.7 * (1 + i * 0.2) * glowPulse;
            const glowAlpha = 0.2 / i;
            
            const glowGradient = this.ctx.createRadialGradient(
              centerX, centerY, 0,
              centerX, centerY, glowSize
            );
            glowGradient.addColorStop(0, `rgba(168, 85, 247, ${glowAlpha})`);
            glowGradient.addColorStop(0.5, `rgba(192, 132, 252, ${glowAlpha * 0.5})`);
            glowGradient.addColorStop(1, 'rgba(168, 85, 247, 0)');
            
            this.ctx.fillStyle = glowGradient;
            this.ctx.beginPath();
            this.ctx.arc(centerX, centerY, glowSize, 0, Math.PI * 2);
            this.ctx.fill();
          }
          
          // Shadow beneath enemy
          this.ctx.save();
          this.ctx.globalAlpha = 0.3;
          this.ctx.fillStyle = '#000000';
          this.ctx.beginPath();
          this.ctx.ellipse(
            centerX,
            enemy.y + enemy.height + 5,
            enemy.width * 0.4,
            enemy.height * 0.15,
            0, 0, Math.PI * 2
          );
          this.ctx.fill();
          this.ctx.restore();
          
          // Apply bounce animation
          this.ctx.translate(centerX, centerY);
          this.ctx.scale(1, 1 + bounce);
          this.ctx.translate(-centerX, -centerY);
          
          // Enemy glow
          this.ctx.shadowColor = 'rgba(168, 85, 247, 0.8)';
          this.ctx.shadowBlur = 20;
        }
        
        if (enemy.direction < 0) {
          this.ctx.scale(-1, 1);
          this.ctx.drawImage(this.images['slime'], -enemy.x - enemy.width, enemy.y, enemy.width, enemy.height);
        } else {
          this.ctx.drawImage(this.images['slime'], enemy.x, enemy.y, enemy.width, enemy.height);
        }
        this.ctx.restore();
      }
    }

    // Draw boss
    if (this.boss && this.images['boss']) {
      this.ctx.save();
      
      const centerX = this.boss.x + this.boss.width / 2;
      const centerY = this.boss.y + this.boss.height / 2;
      
      // Boss menacing aura - dark red glow
      const glowPulse = 1 + Math.sin(time * 4) * 0.2;
      for (let i = 3; i > 0; i--) {
        const glowSize = this.boss.width * 0.8 * (1 + i * 0.3) * glowPulse;
        const glowAlpha = 0.25 / i;
        
        const glowGradient = this.ctx.createRadialGradient(
          centerX, centerY, 0,
          centerX, centerY, glowSize
        );
        glowGradient.addColorStop(0, `rgba(239, 68, 68, ${glowAlpha})`);
        glowGradient.addColorStop(0.5, `rgba(220, 38, 38, ${glowAlpha * 0.5})`);
        glowGradient.addColorStop(1, 'rgba(239, 68, 68, 0)');
        
        this.ctx.fillStyle = glowGradient;
        this.ctx.beginPath();
        this.ctx.arc(centerX, centerY, glowSize, 0, Math.PI * 2);
        this.ctx.fill();
      }
      
      // Flash red when hit
      if (this.boss.attackCooldown > 0) {
        this.ctx.globalAlpha = 0.5 + Math.sin(time * 20) * 0.5;
      }
      
      // Shadow
      this.ctx.save();
      this.ctx.globalAlpha = 0.4;
      this.ctx.fillStyle = '#000000';
      this.ctx.beginPath();
      this.ctx.ellipse(
        centerX,
        this.boss.y + this.boss.height + 10,
        this.boss.width * 0.5,
        this.boss.height * 0.2,
        0, 0, Math.PI * 2
      );
      this.ctx.fill();
      this.ctx.restore();
      
      // Boss glow
      this.ctx.shadowColor = 'rgba(239, 68, 68, 1)';
      this.ctx.shadowBlur = 40;
      
      // Draw boss (flip based on direction)
      if (this.boss.direction < 0) {
        this.ctx.scale(-1, 1);
        this.ctx.drawImage(this.images['boss'], -this.boss.x - this.boss.width, this.boss.y, this.boss.width, this.boss.height);
      } else {
        this.ctx.drawImage(this.images['boss'], this.boss.x, this.boss.y, this.boss.width, this.boss.height);
      }
      
      this.ctx.restore();
      
      // Boss health bar
      const barWidth = this.boss.width;
      const barHeight = 8;
      const barX = this.boss.x;
      const barY = this.boss.y - 20;
      const healthPercent = this.boss.health / this.boss.maxHealth;
      
      // Background
      this.ctx.fillStyle = '#333333';
      this.ctx.fillRect(barX, barY, barWidth, barHeight);
      
      // Health
      this.ctx.fillStyle = healthPercent > 0.5 ? '#22c55e' : healthPercent > 0.25 ? '#eab308' : '#ef4444';
      this.ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);
      
      // Border
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(barX, barY, barWidth, barHeight);
    }

    // Draw goal (only if visible)
    if (this.goal && this.goal.visible && this.images['portal']) {
      this.ctx.save();
      this.ctx.shadowColor = 'rgba(168, 85, 247, 0.8)';
      this.ctx.shadowBlur = 30;
      const portalScale = 1 + Math.sin(time * 3) * 0.05;
      const scaledWidth = this.goal.width * portalScale;
      const scaledHeight = this.goal.height * portalScale;
      this.ctx.drawImage(
        this.images['portal'],
        this.goal.x - (scaledWidth - this.goal.width) / 2,
        this.goal.y - (scaledHeight - this.goal.height) / 2,
        scaledWidth,
        scaledHeight
      );
      this.ctx.restore();
    }

    // Draw particles
    for (const particle of this.particles) {
      this.ctx.save();
      const alpha = particle.life / particle.maxLife;
      this.ctx.globalAlpha = alpha;
      this.ctx.fillStyle = particle.color;
      this.ctx.shadowColor = particle.color;
      this.ctx.shadowBlur = 10;
      this.ctx.beginPath();
      this.ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }

    // Draw player (with flashing effect when invulnerable)
    if (this.images['player']) {
      this.ctx.save();
      
      // Shield glow effect
      if (this.shieldActive) {
        const shieldPulse = 1 + Math.sin(time * 6) * 0.1;
        const shieldRadius = (this.player.width / 2 + 15) * shieldPulse;
        
        this.ctx.shadowColor = 'rgba(6, 182, 212, 0.8)';
        this.ctx.shadowBlur = 30;
        this.ctx.beginPath();
        this.ctx.arc(
          this.player.x + this.player.width / 2,
          this.player.y + this.player.height / 2,
          shieldRadius,
          0,
          Math.PI * 2
        );
        const shieldGradient = this.ctx.createRadialGradient(
          this.player.x + this.player.width / 2,
          this.player.y + this.player.height / 2,
          shieldRadius * 0.7,
          this.player.x + this.player.width / 2,
          this.player.y + this.player.height / 2,
          shieldRadius
        );
        shieldGradient.addColorStop(0, 'rgba(6, 182, 212, 0)');
        shieldGradient.addColorStop(0.7, 'rgba(6, 182, 212, 0.3)');
        shieldGradient.addColorStop(1, 'rgba(59, 130, 246, 0.6)');
        this.ctx.fillStyle = shieldGradient;
        this.ctx.fill();
        
        // Shield ring
        this.ctx.strokeStyle = `rgba(56, 189, 248, ${0.6 + Math.sin(time * 6) * 0.3})`;
        this.ctx.lineWidth = 3;
        this.ctx.stroke();
      }
      
      // Flash effect during invulnerability
      if (this.isInvulnerable && Math.floor(this.invulnerabilityTimer / 10) % 2 === 0) {
        this.ctx.globalAlpha = 0.5;
      }
      
      // Apply ducking squish effect
      if (this.player.ducking) {
        const centerX = this.player.x + this.player.width / 2;
        const bottomY = this.player.y + this.player.height;
        this.ctx.translate(centerX, bottomY);
        this.ctx.scale(1.2, 0.5); // Wider and half height
        this.ctx.translate(-centerX, -bottomY);
      }
      
      if (this.player.direction === 'left') {
        this.ctx.scale(-1, 1);
        this.ctx.drawImage(this.images['player'], -this.player.x - this.player.width, this.player.y, this.player.width, this.player.normalHeight);
      } else {
        this.ctx.drawImage(this.images['player'], this.player.x, this.player.y, this.player.width, this.player.normalHeight);
      }
      this.ctx.restore();
    }

    // Restore context
    this.ctx.restore();

  }

  private gameLoop = (currentTime: number) => {
    if (!this.lastTime) this.lastTime = currentTime;
    const deltaTime = Math.min((currentTime - this.lastTime) / 1000, 0.1); // Cap at 100ms to prevent large jumps
    this.lastTime = currentTime;
    
    this.update(deltaTime);
    this.render();
    this.animationId = requestAnimationFrame(this.gameLoop);
  };

  start() {
    if (!this.animationId) {
      this.lastTime = 0;
      // Choose music based on whether there's a boss
      if (this.boss) {
        this.startBossMusic();
      } else {
        this.startBackgroundMusic();
      }
      this.gameLoop(0);
    }
  }

  /** Unmount: stop the loop, drop window listeners, release the audio context. */
  dispose() {
    this.stop();
    this.teardown.abort();
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
      this.stopBackgroundMusic();
    }
  }

  restart() {
    this.score = 0;
    this.lives = 3;
    this.isInvulnerable = false;
    this.invulnerabilityTimer = 0;
    this.shieldActive = false;
    this.shieldTimer = 0;
    this.enemiesStomped = 0;
    
    this.config.onScoreUpdate(0);
    this.config.onLifeLost(3);
    this.config.onEnemiesStompedUpdate(0);
    
    this.loadWorld(this.startingWorld);
    this.start();
  }

  getCurrentWorld(): number {
    return this.currentWorld + 1; // Return 1-indexed for display
  }

  getWorldName(): string {
    return this.currentWorldData?.name || '';
  }

  getTotalWorlds(): number {
    return WORLDS.length;
  }
}
