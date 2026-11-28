// Multiplayer Boss Rush Engine - Co-op boss fight with Goopy Le Grande
import miniGoopySprite from '@/assets/vibequest/mini-goopy.webp';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface DifficultySettings {
  bossMaxHealth: number;
  bossJumpForce: number;
  bossJumpCooldownBase: number;
  bossPunchCooldownBase: number;
  bossDamageMultiplier: number;
  bossSpeedMultiplier: number;
  playerLives: number;
  playerDamage: number;
  scoreMultiplier: number;
}

const DIFFICULTY_SETTINGS: Record<Difficulty, DifficultySettings> = {
  easy: {
    bossMaxHealth: 200,
    bossJumpForce: -700,
    bossJumpCooldownBase: 2.5,
    bossPunchCooldownBase: 4,
    bossDamageMultiplier: 0.7,
    bossSpeedMultiplier: 0.7,
    playerLives: 5,
    playerDamage: 8,
    scoreMultiplier: 0.5,
  },
  medium: {
    bossMaxHealth: 300,
    bossJumpForce: -900,
    bossJumpCooldownBase: 2,
    bossPunchCooldownBase: 3,
    bossDamageMultiplier: 1,
    bossSpeedMultiplier: 1,
    playerLives: 3,
    playerDamage: 5,
    scoreMultiplier: 1,
  },
  hard: {
    bossMaxHealth: 450,
    bossJumpForce: -1100,
    bossJumpCooldownBase: 1.2,
    bossPunchCooldownBase: 1.8,
    bossDamageMultiplier: 1.5,
    bossSpeedMultiplier: 1.4,
    playerLives: 2,
    playerDamage: 3,
    scoreMultiplier: 2,
  },
};

export interface MultiplayerBossRushConfig {
  onScoreUpdate: (score: number) => void;
  onPlayerHit: (player: 1 | 2, livesRemaining: number) => void;
  onGameOver: () => void;
  onVictory: () => void;
  onBossHealthUpdate: (health: number, maxHealth: number) => void;
  onSfx?: (sfxName: 'punchWindup' | 'punchHit' | 'squashLand' | 'playerHit') => void;
  difficulty?: Difficulty;
}

interface Projectile {
  x: number;
  y: number;
  width: number;
  height: number;
  velocityX: number;
  velocityY: number;
  isPlayerProjectile: boolean;
  playerId?: 1 | 2;
  active: boolean;
}

interface MiniGoopy {
  x: number;
  y: number;
  width: number;
  height: number;
  velocityX: number;
  velocityY: number;
  active: boolean;
  fuseTimer: number;
  isExploding: boolean;
  explosionTimer: number;
}

interface Player {
  id: 1 | 2;
  x: number;
  y: number;
  width: number;
  height: number;
  velocityX: number;
  velocityY: number;
  isJumping: boolean;
  isDucking: boolean;
  direction: 'left' | 'right';
  shootCooldown: number;
  isInvulnerable: boolean;
  invulnerabilityTimer: number;
  lives: number;
  isDead: boolean;
}

interface FistPunch {
  active: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  direction: 'left' | 'right';
  timer: number;
  windupTimer: number;
  isWindingUp: boolean;
}

interface GoopyBoss {
  x: number;
  y: number;
  width: number;
  height: number;
  baseWidth: number;
  baseHeight: number;
  health: number;
  maxHealth: number;
  velocityX: number;
  velocityY: number;
  isJumping: boolean;
  isSquashing: boolean;
  squashTimer: number;
  targetX: number;
  jumpCooldown: number;
  hitFlash: number;
  phase: number;
  scaleX: number;
  scaleY: number;
  fistPunch: FistPunch;
  punchCooldown: number;
  isTransforming: boolean;
  transformTimer: number;
  transformScale: number;
  enraged: boolean;
  // Death animation state
  isDying: boolean;
  deathTimer: number;
  deathRotation: number;
  deathScale: number;
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
  isStar?: boolean;
  rotation?: number;
  rotationSpeed?: number;
}

interface KnockoutState {
  active: boolean;
  timer: number;
  phase: 'slowmo' | 'slam' | 'hold' | 'done';
  textScale: number;
  textY: number;
  shakeIntensity: number;
  particles: Particle[];
}

export class MultiplayerBossRushEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: MultiplayerBossRushConfig;
  private difficulty: Difficulty;
  private difficultySettings: DifficultySettings;
  private animationId: number | null = null;
  private keys: { [key: string]: boolean } = {};
  private images: { [key: string]: HTMLImageElement } = {};
  private audioContext: AudioContext | null = null;
  /** Aborted on dispose(): removes every window listener this engine added. */
  private teardown = new AbortController();
  private lastTime = 0;

  // Game state
  private player1: Player;
  private player2: Player;
  private boss: GoopyBoss;
  private projectiles: Projectile[] = [];
  private particles: Particle[] = [];
  private miniGoopies: MiniGoopy[] = [];
  private score = 0;
  private gameStarted = false;
  private miniGoopyImage: HTMLImageElement | null = null;
  private knockout: KnockoutState = {
    active: false,
    timer: 0,
    phase: 'slowmo',
    textScale: 0,
    textY: -200,
    shakeIntensity: 0,
    particles: [],
  };

  // Constants
  private readonly GRAVITY = 1500;
  private readonly JUMP_FORCE = -700;
  private readonly MOVE_SPEED = 350;
  private readonly SHOOT_COOLDOWN = 0.18;
  private readonly PROJECTILE_SPEED = 550;
  private readonly GROUND_Y = 450;

  constructor(canvas: HTMLCanvasElement, config: MultiplayerBossRushConfig) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.config = config;
    this.difficulty = config.difficulty || 'medium';
    this.difficultySettings = DIFFICULTY_SETTINGS[this.difficulty];

    this.player1 = this.createPlayer(1, 100);
    this.player2 = this.createPlayer(2, 200);
    this.boss = this.createBoss();
    this.setupEventListeners();
    this.initAudio();
  }

  setDifficulty(difficulty: Difficulty) {
    this.difficulty = difficulty;
    this.difficultySettings = DIFFICULTY_SETTINGS[difficulty];
  }

  private createPlayer(id: 1 | 2, startX: number): Player {
    return {
      id,
      x: startX,
      y: this.GROUND_Y - 60,
      width: 50,
      height: 60,
      velocityX: 0,
      velocityY: 0,
      isJumping: false,
      isDucking: false,
      direction: 'right',
      shootCooldown: 0,
      isInvulnerable: false,
      invulnerabilityTimer: 0,
      lives: this.difficultySettings.playerLives,
      isDead: false,
    };
  }

  private createBoss(): GoopyBoss {
    const width = 120;
    const height = 120;
    return {
      x: this.canvas.width / 2 - width / 2,
      y: this.GROUND_Y - height,
      width,
      height,
      baseWidth: width,
      baseHeight: height,
      health: this.difficultySettings.bossMaxHealth,
      maxHealth: this.difficultySettings.bossMaxHealth,
      velocityX: 0,
      velocityY: 0,
      isJumping: false,
      isSquashing: false,
      squashTimer: 0,
      targetX: this.canvas.width / 2,
      jumpCooldown: this.difficultySettings.bossJumpCooldownBase,
      hitFlash: 0,
      phase: 1,
      scaleX: 1,
      scaleY: 1,
      fistPunch: {
        active: false,
        x: 0,
        y: 0,
        width: 80,
        height: 40,
        direction: 'left',
        timer: 0,
        windupTimer: 0,
        isWindingUp: false,
      },
      punchCooldown: this.difficultySettings.bossPunchCooldownBase,
      isTransforming: false,
      transformTimer: 0,
      transformScale: 1,
      enraged: false,
      isDying: false,
      deathTimer: 0,
      deathRotation: 0,
      deathScale: 1,
    };
  }

  private initAudio() {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch (e) {
      console.warn('Web Audio API not supported');
    }
  }

  private playSound(freq: number, duration: number, type: OscillatorType = 'square') {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(freq, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq / 2, this.audioContext.currentTime + duration);
    osc.type = type;
    gain.gain.setValueAtTime(0.1, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);
    osc.start();
    osc.stop(this.audioContext.currentTime + duration);
  }

  private playBounceSound() {
    this.playSound(150, 0.2, 'sine');
  }

  private setupEventListeners() {
    const handleKeyDown = (e: KeyboardEvent) => {
      this.keys[e.code] = true;
      if (['Space', 'ArrowUp', 'KeyW'].includes(e.code)) {
        e.preventDefault();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      this.keys[e.code] = false;
    };

    window.addEventListener('keydown', handleKeyDown, { signal: this.teardown.signal });
    window.addEventListener('keyup', handleKeyUp, { signal: this.teardown.signal });
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

  async init() {
    this.player1 = this.createPlayer(1, 100);
    this.player2 = this.createPlayer(2, 200);
    this.boss = this.createBoss();
    this.score = 0;
    this.projectiles = [];
    this.particles = [];
    this.miniGoopies = [];
    this.gameStarted = false;
    this.knockout = {
      active: false,
      timer: 0,
      phase: 'slowmo',
      textScale: 0,
      textY: -200,
      shakeIntensity: 0,
      particles: [],
    };
    this.config.onBossHealthUpdate(this.boss.health, this.boss.maxHealth);
    
    // Load mini goopy image
    this.miniGoopyImage = new Image();
    this.miniGoopyImage.src = miniGoopySprite;
  }

  start() {
    this.gameStarted = true;
    this.lastTime = performance.now();
    this.gameLoop(this.lastTime);
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
    }
  }

  restart() {
    this.stop();
    this.init();
    this.start();
  }

  private gameLoop(currentTime: number) {
    const deltaTime = Math.min((currentTime - this.lastTime) / 1000, 0.05);
    this.lastTime = currentTime;

    this.update(deltaTime);
    this.render();

    this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
  }

  private update(deltaTime: number) {
    // Handle knockout sequence
    if (this.knockout.active) {
      this.updateKnockout(deltaTime);
      this.updateParticles(deltaTime);
      return;
    }
    
    // Handle boss death animation
    if (this.boss.isDying) {
      this.updateDeathAnimation(deltaTime);
      this.updateParticles(deltaTime);
      return;
    }
    
    this.handleInput(deltaTime);
    this.updatePlayer(this.player1, deltaTime);
    this.updatePlayer(this.player2, deltaTime);
    this.updateBoss(deltaTime);
    this.updateProjectiles(deltaTime);
    this.updateMiniGoopies(deltaTime);
    this.updateParticles(deltaTime);
    this.checkCollisions();
    this.checkGameState();
  }

  private handleInput(deltaTime: number) {
    // Player 1: WASD + Space to shoot, S to duck
    if (!this.player1.isDead) {
      if (this.keys['KeyA']) {
        this.player1.velocityX = -this.MOVE_SPEED;
        this.player1.direction = 'left';
      } else if (this.keys['KeyD']) {
        this.player1.velocityX = this.MOVE_SPEED;
        this.player1.direction = 'right';
      } else {
        this.player1.velocityX *= 0.8;
      }

      if (this.keys['KeyW'] && !this.player1.isJumping) {
        this.player1.velocityY = this.JUMP_FORCE;
        this.player1.isJumping = true;
      }

      // Ducking with S key
      this.player1.isDucking = this.keys['KeyS'] && !this.player1.isJumping;

      if (this.keys['Space'] && this.player1.shootCooldown <= 0) {
        this.shoot(this.player1);
        this.player1.shootCooldown = this.SHOOT_COOLDOWN;
      }
    }

    // Player 2: Arrow keys + Enter to shoot, Down to duck
    if (!this.player2.isDead) {
      if (this.keys['ArrowLeft']) {
        this.player2.velocityX = -this.MOVE_SPEED;
        this.player2.direction = 'left';
      } else if (this.keys['ArrowRight']) {
        this.player2.velocityX = this.MOVE_SPEED;
        this.player2.direction = 'right';
      } else {
        this.player2.velocityX *= 0.8;
      }

      if (this.keys['ArrowUp'] && !this.player2.isJumping) {
        this.player2.velocityY = this.JUMP_FORCE;
        this.player2.isJumping = true;
      }

      // Ducking with Down arrow
      this.player2.isDucking = this.keys['ArrowDown'] && !this.player2.isJumping;

      if (this.keys['Enter'] && this.player2.shootCooldown <= 0) {
        this.shoot(this.player2);
        this.player2.shootCooldown = this.SHOOT_COOLDOWN;
      }
    }

    // Update cooldowns
    if (this.player1.shootCooldown > 0) this.player1.shootCooldown -= deltaTime;
    if (this.player2.shootCooldown > 0) this.player2.shootCooldown -= deltaTime;
  }

  private shoot(player: Player) {
    this.playSound(800, 0.1);

    const projectile: Projectile = {
      x: player.direction === 'right' ? player.x + player.width : player.x - 15,
      y: player.y + player.height / 2 - 7,
      width: 15,
      height: 15,
      velocityX: player.direction === 'right' ? this.PROJECTILE_SPEED : -this.PROJECTILE_SPEED,
      velocityY: 0,
      isPlayerProjectile: true,
      playerId: player.id,
      active: true,
    };

    this.projectiles.push(projectile);

    // Muzzle flash
    for (let i = 0; i < 4; i++) {
      this.particles.push({
        x: projectile.x,
        y: projectile.y + 7,
        velocityX: (Math.random() - 0.5) * 80 + (player.direction === 'right' ? 40 : -40),
        velocityY: (Math.random() - 0.5) * 80,
        life: 0.15,
        maxLife: 0.15,
        color: player.id === 1 ? '#FFD700' : '#00FFFF',
        size: 3 + Math.random() * 3,
      });
    }
  }

  private updatePlayer(player: Player, deltaTime: number) {
    if (player.isDead) return;

    player.velocityY += this.GRAVITY * deltaTime;
    player.x += player.velocityX * deltaTime;
    player.y += player.velocityY * deltaTime;

    // Ground collision
    if (player.y + player.height > this.GROUND_Y) {
      player.y = this.GROUND_Y - player.height;
      player.velocityY = 0;
      player.isJumping = false;
    }

    // Screen bounds
    if (player.x < 0) player.x = 0;
    if (player.x + player.width > this.canvas.width) {
      player.x = this.canvas.width - player.width;
    }

    // Invulnerability
    if (player.isInvulnerable) {
      player.invulnerabilityTimer -= deltaTime;
      if (player.invulnerabilityTimer <= 0) {
        player.isInvulnerable = false;
      }
    }
  }

  private updateBoss(deltaTime: number) {
    // Phase changes based on health
    const healthPercent = this.boss.health / this.boss.maxHealth;
    const previousPhase = this.boss.phase;
    
    if (healthPercent <= 0.3) {
      this.boss.phase = 3;
    } else if (healthPercent <= 0.6) {
      this.boss.phase = 2;
    }

    // Trigger transformation when entering phase 3 (enraged mode)
    if (this.boss.phase === 3 && previousPhase !== 3 && !this.boss.enraged) {
      this.triggerEnragedTransformation();
    }

    // Handle transformation animation
    if (this.boss.isTransforming) {
      this.updateTransformation(deltaTime);
      return; // Don't do other updates during transformation
    }

    // Hit flash
    if (this.boss.hitFlash > 0) {
      this.boss.hitFlash -= deltaTime;
    }

    // Update fist punch attack
    this.updateFistPunch(deltaTime);

    // Squash animation after landing
    if (this.boss.isSquashing) {
      this.boss.squashTimer -= deltaTime;
      // Squash: wide and short
      const squashProgress = 1 - (this.boss.squashTimer / 0.3);
      if (squashProgress < 0.5) {
        // Squashing down
        this.boss.scaleX = 1 + squashProgress * 0.6;
        this.boss.scaleY = 1 - squashProgress * 0.4;
      } else {
        // Bouncing back
        const bounceProgress = (squashProgress - 0.5) * 2;
        this.boss.scaleX = 1.3 - bounceProgress * 0.3;
        this.boss.scaleY = 0.6 + bounceProgress * 0.4;
      }
      
      if (this.boss.squashTimer <= 0) {
        this.boss.isSquashing = false;
        this.boss.scaleX = 1;
        this.boss.scaleY = 1;
      }
    }

    // Jumping AI
    this.boss.jumpCooldown -= deltaTime;
    this.boss.punchCooldown -= deltaTime;

    // Decide to punch/shoot or jump
    if (!this.boss.isJumping && !this.boss.isSquashing && !this.boss.fistPunch.active && !this.boss.fistPunch.isWindingUp) {
      // Try to attack if cooldown is ready
      if (this.boss.punchCooldown <= 0) {
        if (this.boss.phase >= 2) {
          // Phase 2+: Shoot mini Goopy instead of fist punch
          this.shootMiniGoopy();
        } else {
          // Phase 1: Normal fist punch
          const nearbyPlayer = this.findNearbyPlayer();
          if (nearbyPlayer) {
            this.startFistPunch(nearbyPlayer);
          }
        }
      }
      
      // Jump if not punching and cooldown ready
      if (this.boss.jumpCooldown <= 0 && !this.boss.fistPunch.isWindingUp) {
        // Pick a target - aim for a player or random spot
        const targets: { x: number }[] = [];
        if (!this.player1.isDead) targets.push(this.player1);
        if (!this.player2.isDead) targets.push(this.player2);
        
        if (targets.length > 0) {
          const target = targets[Math.floor(Math.random() * targets.length)];
          this.boss.targetX = target.x + (Math.random() - 0.5) * 100;
        } else {
          this.boss.targetX = Math.random() * (this.canvas.width - this.boss.width);
        }

        // Jump towards target - faster when enraged
        const dx = this.boss.targetX - this.boss.x;
        const enragedMultiplier = this.boss.enraged ? 1.5 : 1;
        const baseJumpSpeed = 200 * this.difficultySettings.bossSpeedMultiplier * enragedMultiplier;
        const jumpSpeed = baseJumpSpeed + this.boss.phase * 80;
        this.boss.velocityX = Math.sign(dx) * Math.min(Math.abs(dx) * 2, jumpSpeed);
        this.boss.velocityY = (this.difficultySettings.bossJumpForce - this.boss.phase * 80) * enragedMultiplier;
        this.boss.isJumping = true;
        
        // Cooldown based on phase and difficulty - much faster when enraged
        const enragedCooldownMultiplier = this.boss.enraged ? 0.5 : 1;
        this.boss.jumpCooldown = (this.difficultySettings.bossJumpCooldownBase - this.boss.phase * 0.3) * enragedCooldownMultiplier;
      }
    }

    // Apply physics
    if (this.boss.isJumping) {
      this.boss.velocityY += this.GRAVITY * deltaTime;
      this.boss.x += this.boss.velocityX * deltaTime;
      this.boss.y += this.boss.velocityY * deltaTime;

      // Screen bounds
      if (this.boss.x < 0) {
        this.boss.x = 0;
        this.boss.velocityX *= -0.5;
      }
      if (this.boss.x + this.boss.width > this.canvas.width) {
        this.boss.x = this.canvas.width - this.boss.width;
        this.boss.velocityX *= -0.5;
      }

      // Ground collision - land and squash
      if (this.boss.y + this.boss.height >= this.GROUND_Y) {
        this.boss.y = this.GROUND_Y - this.boss.height;
        this.boss.velocityY = 0;
        this.boss.velocityX = 0;
        this.boss.isJumping = false;
        this.boss.isSquashing = true;
        this.boss.squashTimer = 0.3;
        this.playBounceSound();
        this.config.onSfx?.('squashLand');

        // Impact particles
        for (let i = 0; i < 10; i++) {
          this.particles.push({
            x: this.boss.x + this.boss.width / 2 + (Math.random() - 0.5) * this.boss.width,
            y: this.GROUND_Y,
            velocityX: (Math.random() - 0.5) * 200,
            velocityY: -Math.random() * 150,
            life: 0.4,
            maxLife: 0.4,
            color: '#4A90D9',
            size: 5 + Math.random() * 5,
          });
        }
      }
    }
  }

  private triggerEnragedTransformation() {
    this.boss.isTransforming = true;
    this.boss.transformTimer = 2.0; // 2 second transformation
    this.boss.isJumping = false;
    this.boss.velocityX = 0;
    this.boss.velocityY = 0;
    this.boss.fistPunch.active = false;
    this.boss.fistPunch.isWindingUp = false;
    
    // Play dramatic sound
    this.playSound(100, 0.5, 'sawtooth');
    
    // Explosion of particles
    for (let i = 0; i < 30; i++) {
      this.particles.push({
        x: this.boss.x + this.boss.width / 2,
        y: this.boss.y + this.boss.height / 2,
        velocityX: (Math.random() - 0.5) * 400,
        velocityY: (Math.random() - 0.5) * 400,
        life: 1.5,
        maxLife: 1.5,
        color: Math.random() > 0.5 ? '#FF4444' : '#FF8800',
        size: 8 + Math.random() * 8,
      });
    }
  }

  private updateTransformation(deltaTime: number) {
    this.boss.transformTimer -= deltaTime;
    
    const progress = 1 - (this.boss.transformTimer / 2.0);
    
    // Pulsing scale during transformation
    const pulseScale = 1 + Math.sin(progress * Math.PI * 6) * 0.3;
    this.boss.scaleX = pulseScale;
    this.boss.scaleY = pulseScale;
    
    // Gradually increase size
    const sizeMultiplier = 1 + progress * 0.5; // Grow to 1.5x size
    this.boss.width = this.boss.baseWidth * sizeMultiplier;
    this.boss.height = this.boss.baseHeight * sizeMultiplier;
    this.boss.transformScale = sizeMultiplier;
    
    // Keep boss on ground
    this.boss.y = this.GROUND_Y - this.boss.height;
    
    // Spawn angry particles
    if (Math.random() < 0.3) {
      this.particles.push({
        x: this.boss.x + Math.random() * this.boss.width,
        y: this.boss.y + Math.random() * this.boss.height,
        velocityX: (Math.random() - 0.5) * 100,
        velocityY: -Math.random() * 150,
        life: 0.5,
        maxLife: 0.5,
        color: '#FF4444',
        size: 5 + Math.random() * 5,
      });
    }
    
    // Play rumble sounds
    if (Math.random() < 0.1) {
      this.playSound(80 + Math.random() * 40, 0.2, 'sawtooth');
    }
    
    // Finish transformation
    if (this.boss.transformTimer <= 0) {
      this.boss.isTransforming = false;
      this.boss.enraged = true;
      this.boss.scaleX = 1;
      this.boss.scaleY = 1;
      
      // Final size
      this.boss.width = this.boss.baseWidth * 1.5;
      this.boss.height = this.boss.baseHeight * 1.5;
      this.boss.transformScale = 1.5;
      this.boss.y = this.GROUND_Y - this.boss.height;
      
      // Also increase fist punch size
      this.boss.fistPunch.width = 120;
      this.boss.fistPunch.height = 60;
      
      // Explosion effect
      for (let i = 0; i < 40; i++) {
        this.particles.push({
          x: this.boss.x + this.boss.width / 2,
          y: this.boss.y + this.boss.height / 2,
          velocityX: (Math.random() - 0.5) * 500,
          velocityY: (Math.random() - 0.5) * 500,
          life: 1,
          maxLife: 1,
          color: Math.random() > 0.5 ? '#FF0000' : '#FF6600',
          size: 10 + Math.random() * 10,
        });
      }
      
      // Big sound
      this.playSound(60, 0.6, 'square');
    }
  }

  private findNearbyPlayer(): Player | null {
    // Larger punch range when enraged (bigger boss)
    const punchRange = this.boss.enraged ? 280 : 200;
    const players: Player[] = [];
    
    if (!this.player1.isDead) {
      const dist = Math.abs(this.player1.x - this.boss.x);
      if (dist < punchRange) players.push(this.player1);
    }
    if (!this.player2.isDead) {
      const dist = Math.abs(this.player2.x - this.boss.x);
      if (dist < punchRange) players.push(this.player2);
    }
    
    if (players.length === 0) return null;
    return players[Math.floor(Math.random() * players.length)];
  }

  private startFistPunch(targetPlayer: Player) {
    const punch = this.boss.fistPunch;
    punch.isWindingUp = true;
    // Faster windup when enraged
    punch.windupTimer = this.boss.enraged ? 0.3 : 0.5;
    punch.direction = targetPlayer.x < this.boss.x + this.boss.width / 2 ? 'left' : 'right';
    this.playSound(200, 0.2, 'sawtooth'); // Warning sound
    this.config.onSfx?.('punchWindup');
  }

  private updateFistPunch(deltaTime: number) {
    const punch = this.boss.fistPunch;
    
    // Wind up phase - boss prepares the punch
    if (punch.isWindingUp) {
      punch.windupTimer -= deltaTime;
      if (punch.windupTimer <= 0) {
        // Launch the punch!
        punch.isWindingUp = false;
        punch.active = true;
        punch.timer = 0.3; // Punch duration
        punch.y = this.boss.y + this.boss.height / 2 - punch.height / 2;
        
        if (punch.direction === 'left') {
          punch.x = this.boss.x - punch.width;
        } else {
          punch.x = this.boss.x + this.boss.width;
        }
        
        this.playSound(150, 0.3, 'square'); // Punch sound
        // Faster punch cooldown when enraged
        const enragedCooldownMultiplier = this.boss.enraged ? 0.4 : 1;
        this.boss.punchCooldown = (this.difficultySettings.bossPunchCooldownBase - this.boss.phase * 0.4) * enragedCooldownMultiplier;
      }
    }
    
    // Active punch phase
    if (punch.active) {
      punch.timer -= deltaTime;
      
      // Update punch position to follow boss
      punch.y = this.boss.y + this.boss.height / 2 - punch.height / 2;
      if (punch.direction === 'left') {
        punch.x = this.boss.x - punch.width;
      } else {
        punch.x = this.boss.x + this.boss.width;
      }
      
      if (punch.timer <= 0) {
        punch.active = false;
      }
    }
  }

  private updateProjectiles(deltaTime: number) {
    for (const p of this.projectiles) {
      if (!p.active) continue;

      p.x += p.velocityX * deltaTime;
      p.y += p.velocityY * deltaTime;

      // Remove if off screen
      if (p.x < -20 || p.x > this.canvas.width + 20 || p.y < -20 || p.y > this.canvas.height + 20) {
        p.active = false;
      }
    }

    this.projectiles = this.projectiles.filter(p => p.active);
  }

  private shootMiniGoopy() {
    // Shoot mini Goopy at a random player
    const targets: Player[] = [];
    if (!this.player1.isDead) targets.push(this.player1);
    if (!this.player2.isDead) targets.push(this.player2);
    
    if (targets.length === 0) return;
    
    const target = targets[Math.floor(Math.random() * targets.length)];
    const direction = target.x < this.boss.x + this.boss.width / 2 ? -1 : 1;
    
    this.miniGoopies.push({
      x: this.boss.x + this.boss.width / 2 - 25,
      y: this.boss.y + this.boss.height / 2 - 25,
      width: 50,
      height: 50,
      velocityX: direction * 250,
      velocityY: -100,
      active: true,
      fuseTimer: 1.2, // Explodes after 1.2 seconds
      isExploding: false,
      explosionTimer: 0.4,
    });
    
    // Cooldown for next attack
    this.boss.punchCooldown = this.difficultySettings.bossPunchCooldownBase * 0.5;
    this.playSound(250, 0.2, 'sine');
  }

  private updateMiniGoopies(deltaTime: number) {
    for (const mg of this.miniGoopies) {
      if (!mg.active) continue;
      
      if (mg.isExploding) {
        // Handle explosion
        mg.explosionTimer -= deltaTime;
        if (mg.explosionTimer <= 0) {
          mg.active = false;
        }
      } else {
        // Move the mini goopy
        mg.x += mg.velocityX * deltaTime;
        mg.y += mg.velocityY * deltaTime;
        mg.velocityY += 400 * deltaTime; // Gravity
        
        // Bounce off ground
        if (mg.y + mg.height >= this.GROUND_Y) {
          mg.y = this.GROUND_Y - mg.height;
          mg.velocityY = -Math.abs(mg.velocityY) * 0.5;
          mg.velocityX *= 0.8;
        }
        
        // Screen bounds
        if (mg.x < 0) {
          mg.x = 0;
          mg.velocityX *= -0.5;
        }
        if (mg.x + mg.width > this.canvas.width) {
          mg.x = this.canvas.width - mg.width;
          mg.velocityX *= -0.5;
        }
        
        // Count down fuse
        mg.fuseTimer -= deltaTime;
        if (mg.fuseTimer <= 0) {
          // EXPLODE!
          mg.isExploding = true;
          mg.explosionTimer = 0.4;
          this.playSound(120, 0.4, 'sawtooth');
          
          // Explosion particles
          for (let i = 0; i < 20; i++) {
            const angle = (i / 20) * Math.PI * 2;
            this.particles.push({
              x: mg.x + mg.width / 2,
              y: mg.y + mg.height / 2,
              velocityX: Math.cos(angle) * (150 + Math.random() * 100),
              velocityY: Math.sin(angle) * (150 + Math.random() * 100),
              life: 0.5,
              maxLife: 0.5,
              color: Math.random() > 0.5 ? '#FF4444' : '#FF8800',
              size: 6 + Math.random() * 6,
            });
          }
          
          // Check if explosion hits players
          const explosionRadius = 80;
          const explosionCenterX = mg.x + mg.width / 2;
          const explosionCenterY = mg.y + mg.height / 2;
          
          const checkExplosionHit = (player: Player) => {
            if (player.isDead || player.isInvulnerable) return;
            const playerCenterX = player.x + player.width / 2;
            const playerCenterY = player.y + player.height / 2;
            const dist = Math.sqrt(
              Math.pow(playerCenterX - explosionCenterX, 2) +
              Math.pow(playerCenterY - explosionCenterY, 2)
            );
            if (dist < explosionRadius) {
              this.playerHit(player);
            }
          };
          
          checkExplosionHit(this.player1);
          checkExplosionHit(this.player2);
        }
      }
    }
    
    this.miniGoopies = this.miniGoopies.filter(mg => mg.active);
  }

  private updateParticles(deltaTime: number) {
    for (const p of this.particles) {
      p.x += p.velocityX * deltaTime;
      p.y += p.velocityY * deltaTime;
      p.velocityY += 300 * deltaTime; // Gravity on particles
      p.life -= deltaTime;
    }

    this.particles = this.particles.filter(p => p.life > 0);
  }

  private checkCollisions() {
    // Player projectiles hitting boss
    for (const p of this.projectiles) {
      if (!p.active || !p.isPlayerProjectile) continue;

      if (this.rectIntersect(p, this.boss)) {
        p.active = false;
        this.boss.health -= this.difficultySettings.playerDamage;
        this.boss.hitFlash = 0.1;
        this.score += Math.floor(10 * this.difficultySettings.scoreMultiplier);
        this.config.onScoreUpdate(this.score);
        this.config.onBossHealthUpdate(this.boss.health, this.boss.maxHealth);
        this.playSound(300, 0.15, 'triangle');

        // Hit particles
        for (let i = 0; i < 5; i++) {
          this.particles.push({
            x: p.x,
            y: p.y,
            velocityX: (Math.random() - 0.5) * 150,
            velocityY: (Math.random() - 0.5) * 150,
            life: 0.3,
            maxLife: 0.3,
            color: '#4A90D9',
            size: 4 + Math.random() * 4,
          });
        }
      }
    }

    // Boss hitting players
    const checkPlayerBossCollision = (player: Player) => {
      if (player.isDead || player.isInvulnerable) return;

      if (this.rectIntersect(this.getPlayerHitbox(player), this.boss)) {
        this.playerHit(player);
      }
    };

    checkPlayerBossCollision(this.player1);
    checkPlayerBossCollision(this.player2);

    // Fist punch hitting players (can be ducked!)
    if (this.boss.fistPunch.active) {
      const checkPunchCollision = (player: Player) => {
        if (player.isDead || player.isInvulnerable) return;
        
        // If player is ducking, they avoid the punch!
        if (player.isDucking) return;
        
        const playerHitbox = this.getPlayerHitbox(player);
        if (this.rectIntersect(playerHitbox, this.boss.fistPunch)) {
          this.config.onSfx?.('punchHit');
          this.playerHit(player);
        }
      };
      
      checkPunchCollision(this.player1);
      checkPunchCollision(this.player2);
    }
  }

  private getPlayerHitbox(player: Player): { x: number; y: number; width: number; height: number } {
    if (player.isDucking) {
      // When ducking, hitbox is half height and positioned at the bottom
      return {
        x: player.x,
        y: player.y + player.height / 2,
        width: player.width * 1.2, // Slightly wider when ducking
        height: player.height / 2,
      };
    }
    return {
      x: player.x,
      y: player.y,
      width: player.width,
      height: player.height,
    };
  }

  private playerHit(player: Player) {
    player.lives--;
    player.isInvulnerable = true;
    player.invulnerabilityTimer = 2;
    this.config.onPlayerHit(player.id, player.lives);
    this.config.onSfx?.('playerHit');
    this.playSound(200, 0.3, 'sawtooth');

    // Knockback
    player.velocityY = -400;
    player.velocityX = player.x < this.boss.x ? -300 : 300;

    if (player.lives <= 0) {
      player.isDead = true;
    }
  }

  private checkGameState() {
    // If knockout is active, don't check anything else
    if (this.knockout.active) return;
    
    // Victory - start death animation instead of immediately ending
    if (this.boss.health <= 0 && !this.boss.isDying) {
      this.startBossDeathAnimation();
      return;
    }

    // Game over if both players dead
    if (this.player1.isDead && this.player2.isDead) {
      this.config.onGameOver();
      this.stop();
    }
  }

  private startBossDeathAnimation() {
    this.boss.isDying = true;
    this.boss.deathTimer = 0;
    this.boss.deathRotation = 0;
    this.boss.deathScale = 1;
    
    // Play death sound
    this.playSound(400, 0.3, 'sine');
    this.playSound(300, 0.4, 'sine');
  }

  private spawnStarParticles(x: number, y: number, count: number) {
    const colors = ['#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96E6A1', '#FF9F43', '#EE5A24', '#A55EEA'];
    
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 / count) * i + Math.random() * 0.5;
      const speed = 200 + Math.random() * 400;
      
      this.particles.push({
        x,
        y,
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * speed - 150,
        life: 1.5 + Math.random() * 1,
        maxLife: 1.5 + Math.random() * 1,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 8 + Math.random() * 12,
        isStar: true,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 10,
      });
    }
  }

  private startKnockout() {
    this.knockout = {
      active: true,
      timer: 0,
      phase: 'slowmo',
      textScale: 0,
      textY: -200,
      shakeIntensity: 0,
      particles: [],
    };
    
    // Spawn knockout celebration particles
    const colors = ['#FFD700', '#FFA500', '#FF6347', '#FFFF00'];
    for (let i = 0; i < 50; i++) {
      this.knockout.particles.push({
        x: Math.random() * this.canvas.width,
        y: -50 - Math.random() * 200,
        velocityX: (Math.random() - 0.5) * 100,
        velocityY: 100 + Math.random() * 200,
        life: 3,
        maxLife: 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 4 + Math.random() * 8,
        isStar: Math.random() > 0.5,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 5,
      });
    }
  }

  private updateDeathAnimation(deltaTime: number) {
    if (!this.boss.isDying) return;
    
    this.boss.deathTimer += deltaTime;
    
    const spinDuration = 1.5;
    const shrinkDuration = 0.8;
    const explodeDuration = 0.3;
    const totalDeathTime = spinDuration + shrinkDuration + explodeDuration;
    
    if (this.boss.deathTimer < spinDuration) {
      // Phase 1: Spinning rapidly with dizzy expression
      const spinProgress = this.boss.deathTimer / spinDuration;
      this.boss.deathRotation += deltaTime * (5 + spinProgress * 25); // Accelerating spin
      
      // Wobble scale for dizzy effect
      this.boss.scaleX = 1 + Math.sin(this.boss.deathTimer * 20) * 0.1;
      this.boss.scaleY = 1 + Math.cos(this.boss.deathTimer * 20) * 0.1;
      
    } else if (this.boss.deathTimer < spinDuration + shrinkDuration) {
      // Phase 2: Shrinking while still spinning
      const shrinkProgress = (this.boss.deathTimer - spinDuration) / shrinkDuration;
      this.boss.deathRotation += deltaTime * 30;
      this.boss.deathScale = 1 - shrinkProgress * 0.8;
      this.boss.scaleX = this.boss.deathScale;
      this.boss.scaleY = this.boss.deathScale;
      
      // Rise up slightly
      this.boss.y -= deltaTime * 50;
      
    } else if (this.boss.deathTimer < totalDeathTime) {
      // Phase 3: Explosion
      if (this.boss.deathScale > 0.1) {
        this.boss.deathScale = 0;
        this.boss.scaleX = 0;
        this.boss.scaleY = 0;
        
        // Big star explosion
        this.spawnStarParticles(
          this.boss.x + this.boss.width / 2,
          this.boss.y + this.boss.height / 2,
          40
        );
        
        // Play explosion sound
        this.playSound(150, 0.5, 'sawtooth');
        this.playSound(100, 0.6, 'sine');
      }
      
    } else {
      // Start knockout sequence
      this.startKnockout();
    }
  }

  private updateKnockout(deltaTime: number) {
    if (!this.knockout.active) return;
    
    this.knockout.timer += deltaTime;
    
    // Update knockout particles
    for (const p of this.knockout.particles) {
      p.x += p.velocityX * deltaTime;
      p.y += p.velocityY * deltaTime;
      p.velocityY += 50 * deltaTime; // Light gravity
      p.life -= deltaTime;
      if (p.rotation !== undefined && p.rotationSpeed !== undefined) {
        p.rotation += p.rotationSpeed * deltaTime;
      }
    }
    this.knockout.particles = this.knockout.particles.filter(p => p.life > 0);
    
    switch (this.knockout.phase) {
      case 'slowmo':
        // Brief slow-mo moment (0.3 seconds)
        if (this.knockout.timer > 0.3) {
          this.knockout.phase = 'slam';
          this.knockout.timer = 0;
        }
        break;
        
      case 'slam':
        // Text slams down (0.4 seconds)
        const slamProgress = Math.min(this.knockout.timer / 0.4, 1);
        // Elastic easing for slam effect
        const elastic = slamProgress < 1 
          ? 1 - Math.pow(2, -10 * slamProgress) * Math.cos((slamProgress * 10 - 0.75) * (2 * Math.PI) / 3)
          : 1;
        
        this.knockout.textY = -200 + elastic * (this.canvas.height / 2 + 200);
        this.knockout.textScale = elastic * 1.2;
        
        if (slamProgress >= 1) {
          this.knockout.shakeIntensity = 20;
          this.knockout.phase = 'hold';
          this.knockout.timer = 0;
          
          // Play slam sound
          this.playSound(80, 0.3, 'sine');
          this.playSound(60, 0.4, 'triangle');
        }
        break;
        
      case 'hold':
        // Screen shake decreases
        this.knockout.shakeIntensity = Math.max(0, this.knockout.shakeIntensity - deltaTime * 40);
        this.knockout.textScale = 1 + Math.sin(this.knockout.timer * 3) * 0.05;
        
        // Hold for 2 seconds then trigger victory
        if (this.knockout.timer > 2) {
          this.knockout.phase = 'done';
          this.config.onVictory();
          this.stop();
        }
        break;
    }
  }

  private rectIntersect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }

  private render() {
    const ctx = this.ctx;

    // Apply screen shake for knockout
    ctx.save();
    if (this.knockout.shakeIntensity > 0) {
      const shakeX = (Math.random() - 0.5) * this.knockout.shakeIntensity;
      const shakeY = (Math.random() - 0.5) * this.knockout.shakeIntensity;
      ctx.translate(shakeX, shakeY);
    }

    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, this.canvas.height);
    gradient.addColorStop(0, '#1a1a2e');
    gradient.addColorStop(1, '#16213e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Ground
    ctx.fillStyle = '#2d4a3e';
    ctx.fillRect(0, this.GROUND_Y, this.canvas.width, this.canvas.height - this.GROUND_Y);
    ctx.fillStyle = '#3d5a4e';
    ctx.fillRect(0, this.GROUND_Y, this.canvas.width, 5);

    // Particles (behind entities) - render stars specially
    this.renderParticles();

    // Boss (only if not fully dead)
    if (this.boss.deathScale > 0) {
      this.renderBoss();
    }

    // Players
    this.renderPlayer(this.player1, '#FFD700');
    this.renderPlayer(this.player2, '#00FFFF');

    // Projectiles
    for (const p of this.projectiles) {
      if (!p.active) continue;
      
      const img = this.images['projectile'];
      if (img) {
        ctx.drawImage(img, p.x, p.y, p.width, p.height);
      } else {
        ctx.fillStyle = p.playerId === 1 ? '#FFD700' : '#00FFFF';
        ctx.beginPath();
        ctx.arc(p.x + p.width / 2, p.y + p.height / 2, p.width / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Mini Goopies
    this.renderMiniGoopies();

    // UI
    this.renderUI();
    
    ctx.restore();

    // Render knockout on top of everything (outside screen shake)
    if (this.knockout.active) {
      this.renderKnockout();
    }
  }

  private renderParticles() {
    const ctx = this.ctx;
    
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = p.life / p.maxLife;
      
      if (p.isStar) {
        // Render as a star
        ctx.translate(p.x, p.y);
        if (p.rotation !== undefined) {
          ctx.rotate(p.rotation);
        }
        ctx.fillStyle = p.color;
        this.drawStar(ctx, 0, 0, 5, p.size, p.size / 2);
      } else {
        // Regular circle particle
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      
      ctx.restore();
    }
  }

  private drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, spikes: number, outerRadius: number, innerRadius: number) {
    let rot = Math.PI / 2 * 3;
    let x = cx;
    let y = cy;
    const step = Math.PI / spikes;

    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);
    
    for (let i = 0; i < spikes; i++) {
      x = cx + Math.cos(rot) * outerRadius;
      y = cy + Math.sin(rot) * outerRadius;
      ctx.lineTo(x, y);
      rot += step;

      x = cx + Math.cos(rot) * innerRadius;
      y = cy + Math.sin(rot) * innerRadius;
      ctx.lineTo(x, y);
      rot += step;
    }
    
    ctx.lineTo(cx, cy - outerRadius);
    ctx.closePath();
    ctx.fill();
  }

  private renderKnockout() {
    const ctx = this.ctx;
    
    // Semi-transparent overlay during slowmo
    if (this.knockout.phase === 'slowmo') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    
    // Render knockout particles
    for (const p of this.knockout.particles) {
      ctx.save();
      ctx.globalAlpha = p.life / p.maxLife;
      ctx.translate(p.x, p.y);
      if (p.rotation !== undefined) {
        ctx.rotate(p.rotation);
      }
      ctx.fillStyle = p.color;
      
      if (p.isStar) {
        this.drawStar(ctx, 0, 0, 5, p.size, p.size / 2);
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      }
      ctx.restore();
    }
    
    // Draw KNOCKOUT text
    if (this.knockout.phase !== 'slowmo') {
      ctx.save();
      
      const centerX = this.canvas.width / 2;
      const textY = this.knockout.textY;
      
      // Text shadow/glow
      ctx.shadowColor = '#FF6B00';
      ctx.shadowBlur = 30;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 5;
      
      // Main text
      ctx.font = `bold ${72 * this.knockout.textScale}px Impact, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      // Gold gradient
      const textGradient = ctx.createLinearGradient(centerX - 200, textY - 40, centerX + 200, textY + 40);
      textGradient.addColorStop(0, '#FFD700');
      textGradient.addColorStop(0.3, '#FFEF5C');
      textGradient.addColorStop(0.5, '#FFFFFF');
      textGradient.addColorStop(0.7, '#FFEF5C');
      textGradient.addColorStop(1, '#FFD700');
      
      // Stroke
      ctx.strokeStyle = '#8B4513';
      ctx.lineWidth = 8 * this.knockout.textScale;
      ctx.strokeText('A KNOCKOUT!', centerX, textY);
      
      // Fill with gradient
      ctx.fillStyle = textGradient;
      ctx.fillText('A KNOCKOUT!', centerX, textY);
      
      // Inner highlight
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = `bold ${72 * this.knockout.textScale}px Impact, sans-serif`;
      ctx.fillText('A KNOCKOUT!', centerX, textY - 2);
      
      ctx.restore();
    }
  }

  private renderBoss() {
    const ctx = this.ctx;
    const boss = this.boss;

    ctx.save();
    
    // Apply squash/stretch and death animation transformation
    const centerX = boss.x + boss.width / 2;
    const centerY = boss.y + boss.height / 2;
    
    ctx.translate(centerX, centerY);
    
    // Death rotation
    if (boss.isDying) {
      ctx.rotate(boss.deathRotation);
    }
    
    ctx.scale(boss.scaleX, boss.scaleY);
    ctx.translate(-centerX, -centerY);

    // Hit flash
    if (boss.hitFlash > 0 && !boss.isDying) {
      ctx.globalAlpha = 0.5 + Math.sin(performance.now() * 0.05) * 0.5;
    }

    // Enraged color overlay
    const isEnragedOrTransforming = boss.enraged || boss.isTransforming;
    
    const img = this.images['goopy'];
    if (img) {
      // Draw base image
      ctx.drawImage(img, boss.x, boss.y, boss.width, boss.height);
      
      // Apply red tint for enraged mode
      if (isEnragedOrTransforming) {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = boss.isTransforming 
          ? `rgba(255, ${Math.floor(100 + Math.sin(performance.now() * 0.01) * 50)}, 0, 0.5)`
          : 'rgba(255, 50, 50, 0.4)';
        ctx.fillRect(boss.x, boss.y, boss.width, boss.height);
        ctx.globalCompositeOperation = 'source-over';
      }
    } else {
      // Fallback: draw slime circle (blue or red based on enraged)
      const baseColor = isEnragedOrTransforming ? '#CC2200' : '#4A90D9';
      ctx.fillStyle = baseColor;
      ctx.beginPath();
      ctx.ellipse(
        boss.x + boss.width / 2,
        boss.y + boss.height / 2,
        boss.width / 2,
        boss.height / 2,
        0, 0, Math.PI * 2
      );
      ctx.fill();

      // Face - show dizzy expression during death
      if (boss.isDying) {
        // Dizzy spiral eyes
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 3;
        
        // Left spiral eye
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const angle = i * Math.PI * 0.7 + performance.now() * 0.01;
          const radius = 5 + i * 4;
          ctx.arc(boss.x + boss.width * 0.35, boss.y + boss.height * 0.4, radius, angle, angle + Math.PI);
        }
        ctx.stroke();
        
        // Right spiral eye
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const angle = -i * Math.PI * 0.7 - performance.now() * 0.01;
          const radius = 5 + i * 4;
          ctx.arc(boss.x + boss.width * 0.65, boss.y + boss.height * 0.4, radius, angle, angle + Math.PI);
        }
        ctx.stroke();
        
        // Wavy dizzy mouth
        ctx.strokeStyle = '#2a5080';
        ctx.lineWidth = 3;
        ctx.beginPath();
        const mouthY = boss.y + boss.height * 0.6;
        const mouthStartX = boss.x + boss.width * 0.35;
        ctx.moveTo(mouthStartX, mouthY);
        for (let i = 0; i <= 10; i++) {
          const x = mouthStartX + (i / 10) * boss.width * 0.3;
          const y = mouthY + Math.sin(i * 1.5 + performance.now() * 0.01) * 5;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else {
        // Normal face
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.ellipse(boss.x + boss.width * 0.35, boss.y + boss.height * 0.4, 15, 18, 0, 0, Math.PI * 2);
        ctx.ellipse(boss.x + boss.width * 0.65, boss.y + boss.height * 0.4, 15, 18, 0, 0, Math.PI * 2);
        ctx.fill();

        // Pupils
        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.ellipse(boss.x + boss.width * 0.35, boss.y + boss.height * 0.42, 8, 10, 0, 0, Math.PI * 2);
        ctx.ellipse(boss.x + boss.width * 0.65, boss.y + boss.height * 0.42, 8, 10, 0, 0, Math.PI * 2);
        ctx.fill();

        // Smile
        ctx.strokeStyle = '#2a5080';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(boss.x + boss.width / 2, boss.y + boss.height * 0.55, 25, 0.1, Math.PI - 0.1);
        ctx.stroke();
      }

      // Nose
      ctx.fillStyle = '#c44';
      ctx.beginPath();
      ctx.ellipse(boss.x + boss.width / 2, boss.y + boss.height * 0.5, 6, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // Don't render fist punch or name during death
    if (boss.isDying) return;

    // Render fist punch
    this.renderFistPunch();

    // Boss name with enraged indicator
    ctx.fillStyle = boss.enraged ? '#FF4444' : 'white';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    const bossName = boss.enraged ? '💀 GOOPY LE GRANDE 💀' : '🫧 GOOPY LE GRANDE 🫧';
    ctx.fillText(bossName, boss.x + boss.width / 2, boss.y - 10);
    
    // Enraged visual effect - pulsing aura
    if (boss.enraged && !boss.isTransforming) {
      ctx.save();
      ctx.globalAlpha = 0.2 + Math.sin(performance.now() * 0.005) * 0.1;
      ctx.strokeStyle = '#FF0000';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(
        boss.x + boss.width / 2,
        boss.y + boss.height / 2,
        boss.width / 2 + 10,
        boss.height / 2 + 10,
        0, 0, Math.PI * 2
      );
      ctx.stroke();
      ctx.restore();
    }
  }

  private renderFistPunch() {
    const ctx = this.ctx;
    const punch = this.boss.fistPunch;
    
    // Draw wind-up warning
    if (punch.isWindingUp) {
      ctx.save();
      ctx.globalAlpha = 0.5 + Math.sin(performance.now() * 0.02) * 0.3;
      ctx.fillStyle = '#FF4444';
      
      const warningX = punch.direction === 'left' 
        ? this.boss.x - 100 
        : this.boss.x + this.boss.width;
      const warningY = this.boss.y + this.boss.height / 2 - 20;
      
      // Warning indicator
      ctx.beginPath();
      ctx.moveTo(warningX + (punch.direction === 'left' ? 80 : 0), warningY);
      ctx.lineTo(warningX + (punch.direction === 'left' ? 80 : 0), warningY + 40);
      ctx.lineTo(warningX + (punch.direction === 'left' ? 0 : 80), warningY + 20);
      ctx.closePath();
      ctx.fill();
      
      // "!" warning text
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('!', warningX + 40, warningY + 28);
      ctx.restore();
    }
    
    // Draw active punch
    if (punch.active) {
      ctx.save();
      ctx.fillStyle = '#4A90D9';
      ctx.strokeStyle = '#2a5080';
      ctx.lineWidth = 4;
      
      // Draw fist (rounded rectangle)
      const fistX = punch.x;
      const fistY = punch.y;
      const fistW = punch.width;
      const fistH = punch.height;
      const radius = 10;
      
      ctx.beginPath();
      ctx.moveTo(fistX + radius, fistY);
      ctx.lineTo(fistX + fistW - radius, fistY);
      ctx.quadraticCurveTo(fistX + fistW, fistY, fistX + fistW, fistY + radius);
      ctx.lineTo(fistX + fistW, fistY + fistH - radius);
      ctx.quadraticCurveTo(fistX + fistW, fistY + fistH, fistX + fistW - radius, fistY + fistH);
      ctx.lineTo(fistX + radius, fistY + fistH);
      ctx.quadraticCurveTo(fistX, fistY + fistH, fistX, fistY + fistH - radius);
      ctx.lineTo(fistX, fistY + radius);
      ctx.quadraticCurveTo(fistX, fistY, fistX + radius, fistY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      
      // Knuckle details
      ctx.fillStyle = '#3a7ec9';
      for (let i = 0; i < 3; i++) {
        const knuckleX = fistX + 15 + i * 20;
        ctx.beginPath();
        ctx.arc(knuckleX, fistY + fistH / 2, 8, 0, Math.PI * 2);
        ctx.fill();
      }
      
      // Motion lines
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.6;
      const lineStartX = punch.direction === 'left' ? fistX + fistW + 10 : fistX - 10;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(lineStartX, fistY + 10 + i * 10);
        ctx.lineTo(lineStartX + (punch.direction === 'left' ? 30 : -30), fistY + 10 + i * 10);
        ctx.stroke();
      }
      
      ctx.restore();
    }
  }

  private renderMiniGoopies() {
    const ctx = this.ctx;
    
    for (const mg of this.miniGoopies) {
      if (!mg.active) continue;
      
      ctx.save();
      
      if (mg.isExploding) {
        // Draw explosion
        const progress = 1 - (mg.explosionTimer / 0.4);
        const explosionSize = 80 + progress * 60;
        
        ctx.globalAlpha = 1 - progress;
        
        // Outer explosion ring
        const gradient = ctx.createRadialGradient(
          mg.x + mg.width / 2, mg.y + mg.height / 2, 0,
          mg.x + mg.width / 2, mg.y + mg.height / 2, explosionSize
        );
        gradient.addColorStop(0, '#FFFF00');
        gradient.addColorStop(0.3, '#FF8800');
        gradient.addColorStop(0.6, '#FF4444');
        gradient.addColorStop(1, 'rgba(255, 0, 0, 0)');
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(mg.x + mg.width / 2, mg.y + mg.height / 2, explosionSize, 0, Math.PI * 2);
        ctx.fill();
        
        // Inner flash
        ctx.fillStyle = '#FFFFFF';
        ctx.globalAlpha = (1 - progress) * 0.8;
        ctx.beginPath();
        ctx.arc(mg.x + mg.width / 2, mg.y + mg.height / 2, explosionSize * 0.3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Draw mini Goopy (bouncing around before exploding)
        const wobble = Math.sin(performance.now() * 0.02) * 3;
        const fuseFlash = mg.fuseTimer < 0.5 ? (Math.sin(performance.now() * 0.03) > 0 ? 1 : 0.5) : 1;
        
        ctx.globalAlpha = fuseFlash;
        
        // Try to draw image first
        if (this.miniGoopyImage && this.miniGoopyImage.complete) {
          ctx.drawImage(
            this.miniGoopyImage,
            mg.x + wobble,
            mg.y,
            mg.width,
            mg.height
          );
        } else {
          // Fallback: draw blue slime circle
          ctx.fillStyle = '#4A90D9';
          ctx.beginPath();
          ctx.ellipse(
            mg.x + mg.width / 2 + wobble,
            mg.y + mg.height / 2,
            mg.width / 2,
            mg.height / 2,
            0, 0, Math.PI * 2
          );
          ctx.fill();
          
          // Face
          ctx.fillStyle = 'white';
          ctx.beginPath();
          ctx.arc(mg.x + mg.width * 0.35 + wobble, mg.y + mg.height * 0.4, 6, 0, Math.PI * 2);
          ctx.arc(mg.x + mg.width * 0.65 + wobble, mg.y + mg.height * 0.4, 6, 0, Math.PI * 2);
          ctx.fill();
          
          ctx.fillStyle = 'black';
          ctx.beginPath();
          ctx.arc(mg.x + mg.width * 0.35 + wobble, mg.y + mg.height * 0.42, 3, 0, Math.PI * 2);
          ctx.arc(mg.x + mg.width * 0.65 + wobble, mg.y + mg.height * 0.42, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        
        // Fuse warning glow when about to explode
        if (mg.fuseTimer < 0.6) {
          ctx.strokeStyle = '#FF4444';
          ctx.lineWidth = 3;
          ctx.globalAlpha = 0.5 + Math.sin(performance.now() * 0.02) * 0.3;
          ctx.beginPath();
          ctx.ellipse(
            mg.x + mg.width / 2 + wobble,
            mg.y + mg.height / 2,
            mg.width / 2 + 5,
            mg.height / 2 + 5,
            0, 0, Math.PI * 2
          );
          ctx.stroke();
        }
      }
      
      ctx.restore();
    }
  }

  private renderPlayer(player: Player, accentColor: string) {
    if (player.isDead) return;

    const ctx = this.ctx;

    // Invulnerability flicker
    if (player.isInvulnerable && Math.floor(performance.now() / 100) % 2 === 0) {
      ctx.globalAlpha = 0.5;
    }

    const img = this.images[`player${player.id}`];
    
    // Ducking squish effect
    const drawWidth = player.isDucking ? player.width * 1.2 : player.width;
    const drawHeight = player.isDucking ? player.height * 0.5 : player.height;
    const drawY = player.isDucking ? player.y + player.height * 0.5 : player.y;
    const drawX = player.isDucking ? player.x - (drawWidth - player.width) / 2 : player.x;
    
    if (img) {
      ctx.save();
      if (player.direction === 'left') {
        ctx.translate(drawX + drawWidth, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(img, 0, drawY, drawWidth, drawHeight);
      } else {
        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
      }
      ctx.restore();
    } else {
      // Fallback rectangle
      ctx.fillStyle = accentColor;
      ctx.fillRect(drawX, drawY, drawWidth, drawHeight);
    }

    ctx.globalAlpha = 1;

    // Player indicator
    ctx.fillStyle = accentColor;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`P${player.id}`, player.x + player.width / 2, player.y - 5);
  }

  private renderUI() {
    const ctx = this.ctx;

    // Boss health bar
    const barWidth = 400;
    const barHeight = 20;
    const barX = (this.canvas.width - barWidth) / 2;
    const barY = 20;

    ctx.fillStyle = '#333';
    ctx.fillRect(barX, barY, barWidth, barHeight);

    const healthPercent = Math.max(0, this.boss.health / this.boss.maxHealth);
    ctx.fillStyle = healthPercent > 0.3 ? '#4A90D9' : '#ff4444';
    ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(barX, barY, barWidth, barHeight);

    ctx.fillStyle = 'white';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`GOOPY LE GRANDE - Phase ${this.boss.phase}`, this.canvas.width / 2, barY + barHeight + 20);

    // Player 1 lives (left)
    ctx.textAlign = 'left';
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`P1: ${'❤️'.repeat(this.player1.lives)}${this.player1.isDead ? ' DEAD' : ''}`, 20, 30);

    // Player 2 lives (right)
    ctx.textAlign = 'right';
    ctx.fillStyle = '#00FFFF';
    ctx.fillText(`P2: ${'❤️'.repeat(this.player2.lives)}${this.player2.isDead ? ' DEAD' : ''}`, this.canvas.width - 20, 30);

    // Score
    ctx.textAlign = 'center';
    ctx.fillStyle = 'white';
    ctx.fillText(`Score: ${this.score}`, this.canvas.width / 2, this.canvas.height - 20);
  }

  getScore(): number {
    return this.score;
  }
}
