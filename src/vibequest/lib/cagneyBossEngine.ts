// Cagney Carnation Boss Engine - Co-op boss fight inspired by Cuphead

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface DifficultySettings {
  bossMaxHealth: number;
  playerLives: number;
  playerDamage: number;
  scoreMultiplier: number;
  projectileSpeed: number;
  rootAttackInterval: number;
}

const DIFFICULTY_SETTINGS: Record<Difficulty, DifficultySettings> = {
  easy: {
    bossMaxHealth: 250,
    playerLives: 5,
    playerDamage: 8,
    scoreMultiplier: 0.5,
    projectileSpeed: 200,
    rootAttackInterval: 3,
  },
  medium: {
    bossMaxHealth: 400,
    playerLives: 3,
    playerDamage: 5,
    scoreMultiplier: 1,
    projectileSpeed: 280,
    rootAttackInterval: 2.2,
  },
  hard: {
    bossMaxHealth: 600,
    playerLives: 2,
    playerDamage: 3,
    scoreMultiplier: 2,
    projectileSpeed: 350,
    rootAttackInterval: 1.5,
  },
};

export interface CagneyBossConfig {
  onScoreUpdate: (score: number) => void;
  onPlayerHit: (player: 1 | 2, livesRemaining: number) => void;
  onGameOver: () => void;
  onVictory: () => void;
  onBossHealthUpdate: (health: number, maxHealth: number) => void;
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

interface BoomerangPetal {
  x: number;
  y: number;
  width: number;
  height: number;
  velocityX: number;
  velocityY: number;
  active: boolean;
  returning: boolean;
  startX: number;
  maxDistance: number;
  rotation: number;
  rotationSpeed: number;
}

interface RootAttack {
  x: number;
  y: number;
  width: number;
  height: number;
  maxHeight: number;
  active: boolean;
  rising: boolean;
  warningTimer: number;
  stayTimer: number;
  hasDamaged: Set<number>; // Track which players have been hit
}

interface Platform {
  x: number;
  y: number;
  width: number;
  height: number;
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
  direction: 'left' | 'right';
  shootCooldown: number;
  isInvulnerable: boolean;
  invulnerabilityTimer: number;
  lives: number;
  isDead: boolean;
  onPlatform: boolean;
}

interface CagneyBoss {
  x: number;
  y: number;
  width: number;
  height: number;
  health: number;
  maxHealth: number;
  phase: number;
  hitFlash: number;
  attackCooldown: number;
  currentAttack: 'idle' | 'seed' | 'petal' | 'root';
  attackTimer: number;
  rootAttackTimer: number;
  seedShootTimer: number;
  petalShootTimer: number;
  animationFrame: number;
  animationTimer: number;
  swayOffset: number;
  // Death animation
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

export class CagneyBossEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: CagneyBossConfig;
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
  private boss: CagneyBoss;
  private projectiles: Projectile[] = [];
  private boomerangPetals: BoomerangPetal[] = [];
  private rootAttacks: RootAttack[] = [];
  private platforms: Platform[] = [];
  private particles: Particle[] = [];
  private score = 0;
  private gameStarted = false;
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
  private readonly JUMP_FORCE = -650;
  private readonly MOVE_SPEED = 300;
  private readonly SHOOT_COOLDOWN = 0.2;
  private readonly PROJECTILE_SPEED = 500;
  private readonly GROUND_Y = 480;

  constructor(canvas: HTMLCanvasElement, config: CagneyBossConfig) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.config = config;
    this.difficulty = config.difficulty || 'medium';
    this.difficultySettings = DIFFICULTY_SETTINGS[this.difficulty];

    this.player1 = this.createPlayer(1, 100);
    this.player2 = this.createPlayer(2, 200);
    this.boss = this.createBoss();
    this.platforms = this.createPlatforms();
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
      direction: 'right',
      shootCooldown: 0,
      isInvulnerable: false,
      invulnerabilityTimer: 0,
      lives: this.difficultySettings.playerLives,
      isDead: false,
      onPlatform: false,
    };
  }

  private createBoss(): CagneyBoss {
    const width = 180;
    const height = 220;
    return {
      x: this.canvas.width - width - 50,
      y: this.GROUND_Y - height,
      width,
      height,
      health: this.difficultySettings.bossMaxHealth,
      maxHealth: this.difficultySettings.bossMaxHealth,
      phase: 1,
      hitFlash: 0,
      attackCooldown: 2,
      currentAttack: 'idle',
      attackTimer: 0,
      rootAttackTimer: 0,
      seedShootTimer: 0,
      petalShootTimer: 0,
      animationFrame: 0,
      animationTimer: 0,
      swayOffset: 0,
      isDying: false,
      deathTimer: 0,
      deathRotation: 0,
      deathScale: 1,
    };
  }

  private createPlatforms(): Platform[] {
    return [
      { x: 150, y: 380, width: 120, height: 20 },
      { x: 400, y: 320, width: 120, height: 20 },
      { x: 250, y: 250, width: 100, height: 20 },
    ];
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
    this.platforms = this.createPlatforms();
    this.score = 0;
    this.projectiles = [];
    this.boomerangPetals = [];
    this.rootAttacks = [];
    this.particles = [];
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
    this.updateBoomerangPetals(deltaTime);
    this.updateRootAttacks(deltaTime);
    this.updateParticles(deltaTime);
    this.checkCollisions();
    this.checkGameState();
  }

  private handleInput(deltaTime: number) {
    // Player 1: WASD + Space
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
        this.player1.onPlatform = false;
      }

      if (this.keys['Space'] && this.player1.shootCooldown <= 0) {
        this.shoot(this.player1);
        this.player1.shootCooldown = this.SHOOT_COOLDOWN;
      }
    }

    // Player 2: Arrow keys + Enter
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
        this.player2.onPlatform = false;
      }

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

    // Muzzle flash particles
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

    player.onPlatform = false;

    // Platform collision
    for (const platform of this.platforms) {
      if (
        player.velocityY >= 0 &&
        player.x + player.width > platform.x &&
        player.x < platform.x + platform.width &&
        player.y + player.height >= platform.y &&
        player.y + player.height <= platform.y + platform.height + 20
      ) {
        player.y = platform.y - player.height;
        player.velocityY = 0;
        player.isJumping = false;
        player.onPlatform = true;
      }
    }

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
    // Boss sway animation
    this.boss.swayOffset = Math.sin(performance.now() * 0.002) * 10;
    this.boss.animationTimer += deltaTime;

    // Hit flash decay
    if (this.boss.hitFlash > 0) {
      this.boss.hitFlash -= deltaTime * 5;
    }

    // Update phase based on health
    const healthPercent = this.boss.health / this.boss.maxHealth;
    if (healthPercent <= 0.5 && this.boss.phase === 1) {
      this.boss.phase = 2;
      // Phase transition particles
      for (let i = 0; i < 20; i++) {
        this.particles.push({
          x: this.boss.x + this.boss.width / 2,
          y: this.boss.y + this.boss.height / 2,
          velocityX: (Math.random() - 0.5) * 300,
          velocityY: (Math.random() - 0.5) * 300,
          life: 1,
          maxLife: 1,
          color: '#FF6B6B',
          size: 5 + Math.random() * 5,
        });
      }
    }

    // Attack logic
    this.boss.attackCooldown -= deltaTime;

    if (this.boss.attackCooldown <= 0) {
      // Choose attack based on phase
      if (this.boss.phase === 1) {
        // Phase 1: Seeds and boomerang petals
        const attack = Math.random();
        if (attack < 0.6) {
          this.shootSeeds();
        } else {
          this.shootBoomerangPetal();
        }
      } else {
        // Phase 2: Add root attacks
        const attack = Math.random();
        if (attack < 0.35) {
          this.shootSeeds();
        } else if (attack < 0.65) {
          this.shootBoomerangPetal();
        } else {
          this.spawnRootAttack();
        }
      }

      this.boss.attackCooldown = 1.5 + Math.random() * 1.5;
      if (this.boss.phase === 2) {
        this.boss.attackCooldown *= 0.7; // Faster attacks in phase 2
      }
    }
  }

  private shootSeeds() {
    this.playSound(400, 0.15);
    
    const seedCount = this.boss.phase === 2 ? 4 : 3;
    for (let i = 0; i < seedCount; i++) {
      const angle = -0.3 + (i / (seedCount - 1)) * 0.6 - Math.PI;
      this.projectiles.push({
        x: this.boss.x,
        y: this.boss.y + this.boss.height / 2 + i * 20,
        width: 20,
        height: 15,
        velocityX: Math.cos(angle) * this.difficultySettings.projectileSpeed,
        velocityY: Math.sin(angle) * this.difficultySettings.projectileSpeed + (Math.random() - 0.5) * 100,
        isPlayerProjectile: false,
        active: true,
      });
    }
  }

  private shootBoomerangPetal() {
    this.playSound(500, 0.2, 'sine');
    
    // Find closest player
    const targetPlayer = !this.player1.isDead && !this.player2.isDead
      ? (Math.random() > 0.5 ? this.player1 : this.player2)
      : (!this.player1.isDead ? this.player1 : this.player2);

    if (targetPlayer.isDead) return;

    const angle = Math.atan2(
      targetPlayer.y - this.boss.y - this.boss.height / 3,
      targetPlayer.x - this.boss.x
    );

    this.boomerangPetals.push({
      x: this.boss.x + 20,
      y: this.boss.y + this.boss.height / 3,
      width: 30,
      height: 30,
      velocityX: Math.cos(angle) * 400,
      velocityY: Math.sin(angle) * 400,
      active: true,
      returning: false,
      startX: this.boss.x + 20,
      maxDistance: 500,
      rotation: 0,
      rotationSpeed: 15,
    });
  }

  private spawnRootAttack() {
    this.playSound(150, 0.3, 'sawtooth');
    
    // Spawn root at random player position (with warning)
    const targetPlayer = !this.player1.isDead && !this.player2.isDead
      ? (Math.random() > 0.5 ? this.player1 : this.player2)
      : (!this.player1.isDead ? this.player1 : this.player2);

    if (targetPlayer.isDead) return;

    this.rootAttacks.push({
      x: targetPlayer.x + targetPlayer.width / 2 - 30,
      y: this.GROUND_Y,
      width: 60,
      height: 0,
      maxHeight: 150,
      active: true,
      rising: false,
      warningTimer: 0.8, // Warning before root appears
      stayTimer: 0,
      hasDamaged: new Set(),
    });
  }

  private updateProjectiles(deltaTime: number) {
    for (const p of this.projectiles) {
      if (!p.active) continue;

      p.x += p.velocityX * deltaTime;
      p.y += p.velocityY * deltaTime;

      // Boss seeds have gravity
      if (!p.isPlayerProjectile) {
        p.velocityY += 200 * deltaTime;
      }

      // Remove if off screen
      if (p.x < -50 || p.x > this.canvas.width + 50 || p.y > this.canvas.height + 50) {
        p.active = false;
      }
    }

    this.projectiles = this.projectiles.filter(p => p.active);
  }

  private updateBoomerangPetals(deltaTime: number) {
    for (const petal of this.boomerangPetals) {
      if (!petal.active) continue;

      petal.x += petal.velocityX * deltaTime;
      petal.y += petal.velocityY * deltaTime;
      petal.rotation += petal.rotationSpeed * deltaTime;

      // Check if should start returning
      const distanceFromStart = Math.abs(petal.x - petal.startX);
      if (!petal.returning && distanceFromStart > petal.maxDistance) {
        petal.returning = true;
      }

      // Return to boss
      if (petal.returning) {
        const dx = this.boss.x + this.boss.width / 2 - petal.x;
        const dy = this.boss.y + this.boss.height / 2 - petal.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 30) {
          petal.active = false;
        } else {
          petal.velocityX = (dx / dist) * 350;
          petal.velocityY = (dy / dist) * 350;
        }
      }

      // Remove if off screen (shouldn't happen with boomerang)
      if (petal.x < -100 || petal.x > this.canvas.width + 100) {
        petal.active = false;
      }
    }

    this.boomerangPetals = this.boomerangPetals.filter(p => p.active);
  }

  private updateRootAttacks(deltaTime: number) {
    for (const root of this.rootAttacks) {
      if (!root.active) continue;

      if (root.warningTimer > 0) {
        // Warning phase
        root.warningTimer -= deltaTime;
        if (root.warningTimer <= 0) {
          root.rising = true;
          this.playSound(200, 0.2, 'triangle');
        }
      } else if (root.rising) {
        // Rising phase
        root.height += 400 * deltaTime;
        root.y = this.GROUND_Y - root.height;
        
        if (root.height >= root.maxHeight) {
          root.rising = false;
          root.stayTimer = 0.5;
        }
      } else if (root.stayTimer > 0) {
        // Stay phase
        root.stayTimer -= deltaTime;
      } else {
        // Retract phase
        root.height -= 300 * deltaTime;
        root.y = this.GROUND_Y - root.height;
        
        if (root.height <= 0) {
          root.active = false;
        }
      }
    }

    this.rootAttacks = this.rootAttacks.filter(r => r.active);
  }

  private updateParticles(deltaTime: number) {
    for (const p of this.particles) {
      p.x += p.velocityX * deltaTime;
      p.y += p.velocityY * deltaTime;
      p.velocityY += 300 * deltaTime; // Gravity
      p.life -= deltaTime;
      if (p.rotation !== undefined && p.rotationSpeed !== undefined) {
        p.rotation += p.rotationSpeed * deltaTime;
      }
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
        this.boss.hitFlash = 1;
        this.score += 10 * this.difficultySettings.scoreMultiplier;
        this.config.onScoreUpdate(this.score);
        this.config.onBossHealthUpdate(this.boss.health, this.boss.maxHealth);
        this.playSound(300, 0.15);

        // Hit particles
        for (let i = 0; i < 5; i++) {
          this.particles.push({
            x: p.x,
            y: p.y,
            velocityX: (Math.random() - 0.5) * 150,
            velocityY: (Math.random() - 0.5) * 150,
            life: 0.3,
            maxLife: 0.3,
            color: '#FF6B6B',
            size: 4 + Math.random() * 4,
          });
        }
      }
    }

    // Boss projectiles hitting players
    const checkPlayerHit = (player: Player, projectile: Projectile | BoomerangPetal) => {
      if (player.isDead || player.isInvulnerable) return;
      
      if (this.rectIntersect(player, projectile)) {
        this.playerHit(player);
        if ('velocityX' in projectile && !('returning' in projectile)) {
          (projectile as Projectile).active = false;
        }
      }
    };

    for (const p of this.projectiles) {
      if (!p.active || p.isPlayerProjectile) continue;
      checkPlayerHit(this.player1, p);
      checkPlayerHit(this.player2, p);
    }

    for (const petal of this.boomerangPetals) {
      if (!petal.active) continue;
      checkPlayerHit(this.player1, petal);
      checkPlayerHit(this.player2, petal);
    }

    // Root attacks hitting players
    for (const root of this.rootAttacks) {
      if (!root.active || root.warningTimer > 0) continue;
      
      const checkRootHit = (player: Player) => {
        if (player.isDead || player.isInvulnerable) return;
        if (root.hasDamaged.has(player.id)) return;
        
        if (this.rectIntersect(player, { x: root.x, y: root.y, width: root.width, height: root.height })) {
          this.playerHit(player);
          root.hasDamaged.add(player.id);
        }
      };
      
      checkRootHit(this.player1);
      checkRootHit(this.player2);
    }
  }

  private playerHit(player: Player) {
    player.lives--;
    player.isInvulnerable = true;
    player.invulnerabilityTimer = 2;
    this.config.onPlayerHit(player.id, player.lives);
    this.playSound(200, 0.3, 'sawtooth');

    // Knockback
    player.velocityY = -400;
    player.velocityX = player.x < this.boss.x ? -200 : 200;

    if (player.lives <= 0) {
      player.isDead = true;
    }
  }

  private checkGameState() {
    if (this.knockout.active) return;

    // Victory - start death animation
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
    this.playSound(400, 0.3, 'sine');
  }

  private spawnStarParticles(x: number, y: number, count: number) {
    const colors = ['#FFD700', '#FF6B6B', '#4ECDC4', '#FF69B4', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'];
    
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
    
    const colors = ['#FFD700', '#FF69B4', '#98D8C8', '#F7DC6F'];
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
      const spinProgress = this.boss.deathTimer / spinDuration;
      this.boss.deathRotation += deltaTime * (5 + spinProgress * 25);
    } else if (this.boss.deathTimer < spinDuration + shrinkDuration) {
      const shrinkProgress = (this.boss.deathTimer - spinDuration) / shrinkDuration;
      this.boss.deathRotation += deltaTime * 30;
      this.boss.deathScale = 1 - shrinkProgress * 0.8;
      this.boss.y -= deltaTime * 50;
    } else if (this.boss.deathTimer < totalDeathTime) {
      if (this.boss.deathScale > 0.1) {
        this.boss.deathScale = 0;
        this.spawnStarParticles(
          this.boss.x + this.boss.width / 2,
          this.boss.y + this.boss.height / 2,
          40
        );
        this.playSound(150, 0.5, 'sawtooth');
      }
    } else {
      this.startKnockout();
    }
  }

  private updateKnockout(deltaTime: number) {
    if (!this.knockout.active) return;
    
    this.knockout.timer += deltaTime;
    
    for (const p of this.knockout.particles) {
      p.x += p.velocityX * deltaTime;
      p.y += p.velocityY * deltaTime;
      p.velocityY += 50 * deltaTime;
      p.life -= deltaTime;
      if (p.rotation !== undefined && p.rotationSpeed !== undefined) {
        p.rotation += p.rotationSpeed * deltaTime;
      }
    }
    this.knockout.particles = this.knockout.particles.filter(p => p.life > 0);
    
    switch (this.knockout.phase) {
      case 'slowmo':
        if (this.knockout.timer > 0.3) {
          this.knockout.phase = 'slam';
          this.knockout.timer = 0;
        }
        break;
        
      case 'slam':
        const slamProgress = Math.min(this.knockout.timer / 0.4, 1);
        const elastic = slamProgress < 1 
          ? 1 - Math.pow(2, -10 * slamProgress) * Math.cos((slamProgress * 10 - 0.75) * (2 * Math.PI) / 3)
          : 1;
        
        this.knockout.textY = -200 + elastic * (this.canvas.height / 2 + 200);
        this.knockout.textScale = elastic * 1.2;
        
        if (slamProgress >= 1) {
          this.knockout.shakeIntensity = 20;
          this.knockout.phase = 'hold';
          this.knockout.timer = 0;
          this.playSound(80, 0.3, 'sine');
        }
        break;
        
      case 'hold':
        this.knockout.shakeIntensity = Math.max(0, this.knockout.shakeIntensity - deltaTime * 40);
        this.knockout.textScale = 1 + Math.sin(this.knockout.timer * 3) * 0.05;
        
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

    ctx.save();
    if (this.knockout.shakeIntensity > 0) {
      const shakeX = (Math.random() - 0.5) * this.knockout.shakeIntensity;
      const shakeY = (Math.random() - 0.5) * this.knockout.shakeIntensity;
      ctx.translate(shakeX, shakeY);
    }

    // Simple open field background
    ctx.fillStyle = '#87CEEB'; // Sky blue
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Simple ground - flat green field
    ctx.fillStyle = '#228B22';
    ctx.fillRect(0, this.GROUND_Y, this.canvas.width, this.canvas.height - this.GROUND_Y);
    ctx.fillStyle = '#32CD32';
    ctx.fillRect(0, this.GROUND_Y, this.canvas.width, 8);

    // Platforms
    this.renderPlatforms();

    // Root attack warnings and roots
    this.renderRootAttacks();

    // Particles
    this.renderParticles();

    // Boss
    if (this.boss.deathScale > 0) {
      this.renderBoss();
    }

    // Players
    this.renderPlayer(this.player1, '#FFD700');
    this.renderPlayer(this.player2, '#00FFFF');

    // Projectiles
    this.renderProjectiles();

    // Boomerang petals
    this.renderBoomerangPetals();

    // UI
    this.renderUI();

    ctx.restore();

    // Knockout overlay
    if (this.knockout.active) {
      this.renderKnockout();
    }
  }

  private renderBackgroundFlowers() {
    const ctx = this.ctx;
    const time = performance.now() * 0.001;
    
    // Draw some simple background flowers
    for (let i = 0; i < 8; i++) {
      const x = 50 + i * 110;
      const y = this.GROUND_Y - 20 + Math.sin(time + i) * 5;
      
      // Stem
      ctx.strokeStyle = '#228B22';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, this.GROUND_Y);
      ctx.quadraticCurveTo(x + Math.sin(time + i) * 10, y + 30, x, y);
      ctx.stroke();
      
      // Flower petals
      ctx.fillStyle = ['#FF69B4', '#FFD700', '#FF6B6B', '#9370DB'][i % 4];
      for (let j = 0; j < 5; j++) {
        const angle = (j / 5) * Math.PI * 2 + time * 0.5;
        ctx.beginPath();
        ctx.ellipse(
          x + Math.cos(angle) * 8,
          y + Math.sin(angle) * 8,
          6, 10,
          angle, 0, Math.PI * 2
        );
        ctx.fill();
      }
      
      // Center
      ctx.fillStyle = '#FFD700';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private renderPlatforms() {
    const ctx = this.ctx;
    
    for (const platform of this.platforms) {
      // Platform shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.fillRect(platform.x + 5, platform.y + 5, platform.width, platform.height);
      
      // Platform
      ctx.fillStyle = '#8B4513';
      ctx.fillRect(platform.x, platform.y, platform.width, platform.height);
      
      // Grass on top
      ctx.fillStyle = '#32CD32';
      ctx.fillRect(platform.x, platform.y, platform.width, 5);
      
      // Vines
      ctx.strokeStyle = '#228B22';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(platform.x + 10, platform.y + platform.height);
      ctx.quadraticCurveTo(platform.x, platform.y + platform.height + 20, platform.x + 15, platform.y + platform.height + 30);
      ctx.stroke();
    }
  }

  private renderRootAttacks() {
    const ctx = this.ctx;
    
    for (const root of this.rootAttacks) {
      if (root.warningTimer > 0) {
        // Warning indicator
        ctx.save();
        ctx.globalAlpha = 0.5 + Math.sin(performance.now() * 0.02) * 0.3;
        ctx.fillStyle = '#FF4444';
        ctx.beginPath();
        ctx.moveTo(root.x + root.width / 2, this.GROUND_Y - 50);
        ctx.lineTo(root.x + root.width / 2 - 20, this.GROUND_Y - 10);
        ctx.lineTo(root.x + root.width / 2 + 20, this.GROUND_Y - 10);
        ctx.closePath();
        ctx.fill();
        
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('!', root.x + root.width / 2, this.GROUND_Y - 25);
        ctx.restore();
      } else if (root.height > 0) {
        // Root
        ctx.fillStyle = '#8B4513';
        ctx.fillRect(root.x, root.y, root.width, root.height);
        
        // Root details - thorns
        ctx.fillStyle = '#654321';
        for (let i = 0; i < root.height / 30; i++) {
          const y = root.y + i * 30;
          ctx.beginPath();
          ctx.moveTo(root.x, y);
          ctx.lineTo(root.x - 10, y + 15);
          ctx.lineTo(root.x, y + 10);
          ctx.fill();
          
          ctx.beginPath();
          ctx.moveTo(root.x + root.width, y + 15);
          ctx.lineTo(root.x + root.width + 10, y);
          ctx.lineTo(root.x + root.width, y + 5);
          ctx.fill();
        }
        
        // Root tip
        ctx.beginPath();
        ctx.moveTo(root.x, root.y);
        ctx.lineTo(root.x + root.width / 2, root.y - 20);
        ctx.lineTo(root.x + root.width, root.y);
        ctx.fill();
      }
    }
  }

  private renderParticles() {
    const ctx = this.ctx;
    
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = p.life / p.maxLife;
      
      if (p.isStar) {
        ctx.translate(p.x, p.y);
        if (p.rotation !== undefined) {
          ctx.rotate(p.rotation);
        }
        ctx.fillStyle = p.color;
        this.drawStar(ctx, 0, 0, 5, p.size, p.size / 2);
      } else {
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
    const step = Math.PI / spikes;

    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);
    
    for (let i = 0; i < spikes; i++) {
      let x = cx + Math.cos(rot) * outerRadius;
      let y = cy + Math.sin(rot) * outerRadius;
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

  private renderBoss() {
    const ctx = this.ctx;
    const boss = this.boss;

    ctx.save();

    const centerX = boss.x + boss.width / 2;
    const centerY = boss.y + boss.height / 2;

    ctx.translate(centerX, centerY);
    
    if (boss.isDying) {
      ctx.rotate(boss.deathRotation);
      ctx.scale(boss.deathScale, boss.deathScale);
    }
    
    ctx.translate(-centerX, -centerY);

    // Sway animation
    const swayX = boss.isDying ? 0 : boss.swayOffset;

    // Hit flash
    if (boss.hitFlash > 0 && !boss.isDying) {
      ctx.globalAlpha = 0.5 + Math.sin(performance.now() * 0.05) * 0.5;
    }

    const img = this.images['cagney'];
    if (img) {
      ctx.drawImage(img, boss.x + swayX, boss.y, boss.width, boss.height);
      
      // Phase 2 angry tint
      if (boss.phase === 2 && !boss.isDying) {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = 'rgba(255, 100, 100, 0.3)';
        ctx.fillRect(boss.x + swayX, boss.y, boss.width, boss.height);
        ctx.globalCompositeOperation = 'source-over';
      }
    } else {
      // Fallback: Draw stylized flower boss
      this.renderCagneyFallback(boss.x + swayX, boss.y, boss.width, boss.height, boss.isDying);
    }

    ctx.restore();

    // Boss name
    if (!boss.isDying) {
      ctx.fillStyle = boss.phase === 2 ? '#FF4444' : 'white';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      const bossName = boss.phase === 2 ? '🌺 CAGNEY CARNATION 🌺' : '🌸 CAGNEY CARNATION 🌸';
      ctx.fillText(bossName, boss.x + boss.width / 2, boss.y - 10);
    }
  }

  private renderCagneyFallback(x: number, y: number, width: number, height: number, isDying: boolean) {
    const ctx = this.ctx;
    const time = performance.now() * 0.001;

    // Stem
    ctx.fillStyle = '#228B22';
    ctx.fillRect(x + width / 2 - 15, y + height * 0.6, 30, height * 0.4);

    // Leaves
    ctx.fillStyle = '#32CD32';
    ctx.beginPath();
    ctx.ellipse(x + width / 2 - 30, y + height * 0.7, 25, 12, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + width / 2 + 30, y + height * 0.75, 25, 12, 0.3, 0, Math.PI * 2);
    ctx.fill();

    // Flower head - large petals
    const petalCount = 8;
    const petalRadius = width * 0.4;
    const centerY = y + height * 0.35;
    const centerX = x + width / 2;
    
    for (let i = 0; i < petalCount; i++) {
      const angle = (i / petalCount) * Math.PI * 2 + (isDying ? 0 : Math.sin(time) * 0.1);
      const petalX = centerX + Math.cos(angle) * petalRadius * 0.5;
      const petalY = centerY + Math.sin(angle) * petalRadius * 0.5;
      
      ctx.fillStyle = i % 2 === 0 ? '#FF6B6B' : '#FF8E8E';
      ctx.beginPath();
      ctx.ellipse(petalX, petalY, 30, 45, angle, 0, Math.PI * 2);
      ctx.fill();
    }

    // Flower center (face area)
    ctx.fillStyle = '#FFD700';
    ctx.beginPath();
    ctx.arc(centerX, centerY, 40, 0, Math.PI * 2);
    ctx.fill();

    // Face
    if (isDying) {
      // Dizzy eyes
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      for (let eye = 0; eye < 2; eye++) {
        const eyeX = centerX + (eye === 0 ? -15 : 15);
        const eyeY = centerY - 5;
        ctx.beginPath();
        for (let i = 0; i < 2; i++) {
          const angle = i * Math.PI * 0.7 + time * 10;
          ctx.arc(eyeX, eyeY, 3 + i * 3, angle, angle + Math.PI);
        }
        ctx.stroke();
      }
      // Wavy mouth
      ctx.beginPath();
      ctx.moveTo(centerX - 20, centerY + 15);
      for (let i = 0; i <= 8; i++) {
        ctx.lineTo(centerX - 20 + i * 5, centerY + 15 + Math.sin(i * 1.5 + time * 10) * 5);
      }
      ctx.stroke();
    } else {
      // Normal angry eyes
      ctx.fillStyle = 'white';
      ctx.beginPath();
      ctx.ellipse(centerX - 15, centerY - 5, 12, 15, 0, 0, Math.PI * 2);
      ctx.ellipse(centerX + 15, centerY - 5, 12, 15, 0, 0, Math.PI * 2);
      ctx.fill();

      // Pupils (looking at players)
      ctx.fillStyle = 'black';
      const lookX = (this.player1.x + this.player2.x) / 2;
      const pupilOffsetX = Math.min(5, Math.max(-5, (lookX - centerX) / 50));
      ctx.beginPath();
      ctx.arc(centerX - 15 + pupilOffsetX, centerY - 3, 6, 0, Math.PI * 2);
      ctx.arc(centerX + 15 + pupilOffsetX, centerY - 3, 6, 0, Math.PI * 2);
      ctx.fill();

      // Angry eyebrows
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(centerX - 25, centerY - 18);
      ctx.lineTo(centerX - 5, centerY - 12);
      ctx.moveTo(centerX + 25, centerY - 18);
      ctx.lineTo(centerX + 5, centerY - 12);
      ctx.stroke();

      // Mean smile
      ctx.beginPath();
      ctx.arc(centerX, centerY + 10, 15, 0.2, Math.PI - 0.2);
      ctx.stroke();
    }
  }

  private renderPlayer(player: Player, accentColor: string) {
    if (player.isDead) return;

    const ctx = this.ctx;

    if (player.isInvulnerable && Math.floor(performance.now() / 100) % 2 === 0) {
      ctx.globalAlpha = 0.5;
    }

    const img = this.images[`player${player.id}`];
    
    if (img) {
      ctx.save();
      if (player.direction === 'left') {
        ctx.translate(player.x + player.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(img, 0, player.y, player.width, player.height);
      } else {
        ctx.drawImage(img, player.x, player.y, player.width, player.height);
      }
      ctx.restore();
    } else {
      ctx.fillStyle = accentColor;
      ctx.fillRect(player.x, player.y, player.width, player.height);
    }

    ctx.globalAlpha = 1;

    // Player indicator
    ctx.fillStyle = accentColor;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`P${player.id}`, player.x + player.width / 2, player.y - 5);
  }

  private renderProjectiles() {
    const ctx = this.ctx;
    
    for (const p of this.projectiles) {
      if (!p.active) continue;
      
      if (p.isPlayerProjectile) {
        const img = this.images['projectile'];
        if (img) {
          ctx.drawImage(img, p.x, p.y, p.width, p.height);
        } else {
          ctx.fillStyle = p.playerId === 1 ? '#FFD700' : '#00FFFF';
          ctx.beginPath();
          ctx.arc(p.x + p.width / 2, p.y + p.height / 2, p.width / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // Boss seed projectile
        ctx.fillStyle = '#8B4513';
        ctx.beginPath();
        ctx.ellipse(p.x + p.width / 2, p.y + p.height / 2, p.width / 2, p.height / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#654321';
        ctx.beginPath();
        ctx.arc(p.x + p.width / 2 - 3, p.y + p.height / 2 - 2, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private renderBoomerangPetals() {
    const ctx = this.ctx;
    
    for (const petal of this.boomerangPetals) {
      if (!petal.active) continue;
      
      ctx.save();
      ctx.translate(petal.x + petal.width / 2, petal.y + petal.height / 2);
      ctx.rotate(petal.rotation);
      
      // Draw petal shape
      ctx.fillStyle = '#FF69B4';
      ctx.beginPath();
      ctx.ellipse(0, 0, petal.width / 2, petal.height / 3, 0, 0, Math.PI * 2);
      ctx.fill();
      
      // Second petal perpendicular
      ctx.fillStyle = '#FF1493';
      ctx.beginPath();
      ctx.ellipse(0, 0, petal.height / 3, petal.width / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      
      // Center
      ctx.fillStyle = '#FFD700';
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.restore();
    }
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
    const healthColor = this.boss.phase === 2 ? '#FF6B6B' : '#FF69B4';
    ctx.fillStyle = healthColor;
    ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);

    // Phase marker
    ctx.fillStyle = '#FFD700';
    ctx.fillRect(barX + barWidth * 0.5 - 2, barY, 4, barHeight);

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(barX, barY, barWidth, barHeight);

    ctx.fillStyle = 'white';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`CAGNEY CARNATION - Phase ${this.boss.phase}`, this.canvas.width / 2, barY + barHeight + 20);

    // Player 1 lives
    ctx.textAlign = 'left';
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`P1: ${'❤️'.repeat(this.player1.lives)}${this.player1.isDead ? ' DEAD' : ''}`, 20, 30);

    // Player 2 lives
    ctx.textAlign = 'right';
    ctx.fillStyle = '#00FFFF';
    ctx.fillText(`P2: ${'❤️'.repeat(this.player2.lives)}${this.player2.isDead ? ' DEAD' : ''}`, this.canvas.width - 20, 30);

    // Score
    ctx.textAlign = 'center';
    ctx.fillStyle = 'white';
    ctx.fillText(`Score: ${this.score}`, this.canvas.width / 2, this.canvas.height - 20);
  }

  private renderKnockout() {
    const ctx = this.ctx;
    
    if (this.knockout.phase === 'slowmo') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    
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
    
    if (this.knockout.phase !== 'slowmo') {
      ctx.save();
      
      const centerX = this.canvas.width / 2;
      const textY = this.knockout.textY;
      
      ctx.shadowColor = '#FF69B4';
      ctx.shadowBlur = 30;
      ctx.shadowOffsetY = 5;
      
      ctx.font = `bold ${72 * this.knockout.textScale}px Impact, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      const textGradient = ctx.createLinearGradient(centerX - 200, textY - 40, centerX + 200, textY + 40);
      textGradient.addColorStop(0, '#FFD700');
      textGradient.addColorStop(0.3, '#FFEF5C');
      textGradient.addColorStop(0.5, '#FFFFFF');
      textGradient.addColorStop(0.7, '#FFEF5C');
      textGradient.addColorStop(1, '#FFD700');
      
      ctx.strokeStyle = '#8B4513';
      ctx.lineWidth = 8 * this.knockout.textScale;
      ctx.strokeText('A KNOCKOUT!', centerX, textY);
      
      ctx.fillStyle = textGradient;
      ctx.fillText('A KNOCKOUT!', centerX, textY);
      
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fillText('A KNOCKOUT!', centerX, textY - 2);
      
      ctx.restore();
    }
  }

  getScore(): number {
    return this.score;
  }
}
