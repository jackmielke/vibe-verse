// Boss Rush Game Engine - Run and gun style boss fights

export interface BossPhase {
  name: string;
  healthThreshold: number; // Percentage of health when this phase activates (1.0 = 100%)
  attackPattern: 'ground_pound' | 'projectile_barrage' | 'charge' | 'tears' | 'summon' | 'beam';
  attackSpeed: number;
  moveSpeed: number;
}

export interface BossConfig {
  id: string;
  name: string;
  maxHealth: number;
  width: number;
  height: number;
  phases: BossPhase[];
  imageKey: string;
}

export interface BossRushConfig {
  onScoreUpdate: (score: number) => void;
  onBossDefeated: (bossIndex: number, totalBosses: number) => void;
  onPlayerHit: (livesRemaining: number) => void;
  onGameOver: () => void;
  onAllBossesDefeated: () => void;
  onBossHealthUpdate: (health: number, maxHealth: number) => void;
}

interface Projectile {
  x: number;
  y: number;
  width: number;
  height: number;
  velocityX: number;
  velocityY: number;
  isPlayerProjectile: boolean;
  active: boolean;
}

interface Player {
  x: number;
  y: number;
  width: number;
  height: number;
  velocityX: number;
  velocityY: number;
  isJumping: boolean;
  direction: 'left' | 'right';
  isShooting: boolean;
  shootCooldown: number;
  isInvulnerable: boolean;
  invulnerabilityTimer: number;
}

interface Boss {
  x: number;
  y: number;
  width: number;
  height: number;
  health: number;
  maxHealth: number;
  currentPhase: number;
  attackTimer: number;
  moveDirection: number;
  isAttacking: boolean;
  attackType: string;
  hitFlash: number;
  // New animation properties
  windupTimer: number;
  isWindingUp: boolean;
  chargeSpeed: number;
  isCharging: boolean;
  animationFrame: number;
  scaleX: number;
  scaleY: number;
  // Death animation properties
  isDying: boolean;
  deathTimer: number;
  deathPhase: 'wobble' | 'melt' | 'explode' | 'victory';
  wobbleIntensity: number;
  meltProgress: number;
  deathRotation: number;
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

// Define the plant bosses
export const PLANT_BOSSES: BossConfig[] = [
  {
    id: 'potato',
    name: 'Spud the Furious',
    maxHealth: 100,
    width: 150,
    height: 150,
    imageKey: 'bossPotato',
    phases: [
      { name: 'Ground Pound', healthThreshold: 1.0, attackPattern: 'ground_pound', attackSpeed: 2, moveSpeed: 100 },
      { name: 'Rage Mode', healthThreshold: 0.5, attackPattern: 'charge', attackSpeed: 1.5, moveSpeed: 200 },
    ]
  },
  {
    id: 'onion',
    name: 'Weepy the Onion',
    maxHealth: 150,
    width: 140,
    height: 160,
    imageKey: 'bossOnion',
    phases: [
      { name: 'Tear Drops', healthThreshold: 1.0, attackPattern: 'tears', attackSpeed: 1.5, moveSpeed: 80 },
      { name: 'Cry Storm', healthThreshold: 0.6, attackPattern: 'projectile_barrage', attackSpeed: 1, moveSpeed: 120 },
      { name: 'Final Tears', healthThreshold: 0.3, attackPattern: 'tears', attackSpeed: 0.8, moveSpeed: 150 },
    ]
  },
  {
    id: 'carrot',
    name: 'Carrot King',
    maxHealth: 200,
    width: 160,
    height: 180,
    imageKey: 'bossCarrot',
    phases: [
      { name: 'Royal Charge', healthThreshold: 1.0, attackPattern: 'charge', attackSpeed: 2, moveSpeed: 150 },
      { name: 'Beam Attack', healthThreshold: 0.7, attackPattern: 'beam', attackSpeed: 3, moveSpeed: 100 },
      { name: 'Summon Minions', healthThreshold: 0.4, attackPattern: 'summon', attackSpeed: 4, moveSpeed: 80 },
      { name: 'Final Stand', healthThreshold: 0.2, attackPattern: 'projectile_barrage', attackSpeed: 0.5, moveSpeed: 200 },
    ]
  }
];

export class BossRushEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: BossRushConfig;
  private animationId: number | null = null;
  private keys: { [key: string]: boolean } = {};
  private images: { [key: string]: HTMLImageElement } = {};
  private touchControls = { left: false, right: false, jump: false, shoot: false };
  private audioContext: AudioContext | null = null;
  /** Aborted on dispose(): removes every window listener this engine added. */
  private teardown = new AbortController();
  private lastTime = 0;

  // Game state
  private player: Player;
  private boss: Boss | null = null;
  private currentBossIndex = 0;
  private projectiles: Projectile[] = [];
  private particles: Particle[] = [];
  private score = 0;
  private lives = 3;
  private gameStarted = false;
  private hasUsedDoubleJump = false;
  private jumpKeyWasPressed = false; // Track key release for double jump
  private isOnWall: 'left' | 'right' | null = null; // Wall slide tracking
  private wallJumpCooldown = 0; // Prevent immediate re-grab
  
  // Platforms for dodging
  private readonly platforms = [
    { x: 150, y: 320, width: 120, height: 20 },  // Left platform
    { x: 400, y: 280, width: 150, height: 20 },  // Middle platform (higher)
    { x: 680, y: 320, width: 120, height: 20 },  // Right platform
  ];

  // Constants
  private readonly GRAVITY = 1200;
  private readonly JUMP_FORCE = -600;
  private readonly MOVE_SPEED = 350;
  private readonly SHOOT_COOLDOWN = 0.15; // seconds between shots
  private readonly PROJECTILE_SPEED = 600;
  private readonly GROUND_Y = 450;

  constructor(canvas: HTMLCanvasElement, config: BossRushConfig) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.config = config;

    this.player = this.createPlayer();
    this.setupEventListeners();
    this.initAudio();
  }

  private createPlayer(): Player {
    return {
      x: 100,
      y: this.GROUND_Y - 60,
      width: 50,
      height: 60,
      velocityX: 0,
      velocityY: 0,
      isJumping: false,
      direction: 'right',
      isShooting: false,
      shootCooldown: 0,
      isInvulnerable: false,
      invulnerabilityTimer: 0,
    };
  }

  private initAudio() {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch (e) {
      console.warn('Web Audio API not supported');
    }
  }

  private playShootSound() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(800, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(400, this.audioContext.currentTime + 0.1);
    osc.type = 'square';
    gain.gain.setValueAtTime(0.1, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.1);
  }

  private playHitSound() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(200, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(50, this.audioContext.currentTime + 0.2);
    osc.type = 'sawtooth';
    gain.gain.setValueAtTime(0.2, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.2);
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.2);
  }

  private playBossHitSound() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(300, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, this.audioContext.currentTime + 0.15);
    osc.type = 'triangle';
    gain.gain.setValueAtTime(0.15, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.15);
  }

  private setupEventListeners() {
    const handleKeyDown = (e: KeyboardEvent) => {
      this.keys[e.code] = true;
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      this.keys[e.code] = false;
    };

    window.addEventListener('keydown', handleKeyDown, { signal: this.teardown.signal });
    window.addEventListener('keyup', handleKeyUp, { signal: this.teardown.signal });

    // Touch controls
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = this.canvas.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;

      if (x < this.canvas.width / 3) {
        this.touchControls.left = true;
      } else if (x > this.canvas.width * 2 / 3) {
        this.touchControls.right = true;
      }
      if (y < this.canvas.height / 2) {
        this.touchControls.jump = true;
      }
      if (y > this.canvas.height / 2 && x > this.canvas.width / 3 && x < this.canvas.width * 2 / 3) {
        this.touchControls.shoot = true;
      }
    });

    this.canvas.addEventListener('touchend', () => {
      this.touchControls = { left: false, right: false, jump: false, shoot: false };
    });
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

  async init(startingBoss: number = 0) {
    this.currentBossIndex = startingBoss;
    this.loadBoss(this.currentBossIndex);
    this.player = this.createPlayer();
    this.lives = 3;
    this.score = 0;
    this.projectiles = [];
    this.particles = [];
    this.gameStarted = false;
  }

  private loadBoss(index: number) {
    if (index >= PLANT_BOSSES.length) {
      this.config.onAllBossesDefeated();
      return;
    }

    const bossConfig = PLANT_BOSSES[index];
    this.boss = {
      x: this.canvas.width - bossConfig.width - 50,
      y: this.GROUND_Y - bossConfig.height,
      width: bossConfig.width,
      height: bossConfig.height,
      health: bossConfig.maxHealth,
      maxHealth: bossConfig.maxHealth,
      currentPhase: 0,
      attackTimer: 2, // Initial delay before first attack
      moveDirection: -1,
      isAttacking: false,
      attackType: bossConfig.phases[0].attackPattern,
      hitFlash: 0,
      // Animation properties
      windupTimer: 0,
      isWindingUp: false,
      chargeSpeed: 0,
      isCharging: false,
      animationFrame: 0,
      scaleX: 1,
      scaleY: 1,
      // Death animation properties
      isDying: false,
      deathTimer: 0,
      deathPhase: 'wobble',
      wobbleIntensity: 0,
      meltProgress: 0,
      deathRotation: 0,
    };

    this.projectiles = [];
    this.player = this.createPlayer();
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
    this.init(this.currentBossIndex);
    this.start();
  }

  // Load a specific boss by index (for "Next Boss" button)
  loadNextBoss(bossIndex: number) {
    this.currentBossIndex = bossIndex;
    this.loadBoss(bossIndex);
    this.projectiles = [];
    this.particles = [];
  }

  private gameLoop(currentTime: number) {
    const deltaTime = Math.min((currentTime - this.lastTime) / 1000, 0.05);
    this.lastTime = currentTime;

    this.update(deltaTime);
    this.render();

    this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
  }

  private update(deltaTime: number) {
    this.handleInput(deltaTime);
    this.updatePlayer(deltaTime);
    this.updateBoss(deltaTime);
    this.updateProjectiles(deltaTime);
    this.updateParticles(deltaTime);
    this.checkCollisions();
  }

  private handleInput(deltaTime: number) {
    // Movement
    if (this.keys['ArrowLeft'] || this.keys['KeyA'] || this.touchControls.left) {
      this.player.velocityX = -this.MOVE_SPEED;
      this.player.direction = 'left';
    } else if (this.keys['ArrowRight'] || this.keys['KeyD'] || this.touchControls.right) {
      this.player.velocityX = this.MOVE_SPEED;
      this.player.direction = 'right';
    } else {
      this.player.velocityX *= 0.8;
    }

    // Jump (with double jump and wall jump support)
    const jumpPressed = this.keys['ArrowUp'] || this.keys['KeyW'] || this.keys['Space'] || this.touchControls.jump;
    
    if (jumpPressed && !this.jumpKeyWasPressed) {
      if (!this.player.isJumping) {
        // First jump from ground
        this.player.velocityY = this.JUMP_FORCE;
        this.player.isJumping = true;
        this.hasUsedDoubleJump = false;
      } else if (this.isOnWall && this.wallJumpCooldown <= 0) {
        // Wall jump - jump away from wall
        this.player.velocityY = this.JUMP_FORCE * 0.9;
        this.player.velocityX = this.isOnWall === 'left' ? 400 : -400; // Push away from wall
        this.player.direction = this.isOnWall === 'left' ? 'right' : 'left';
        this.wallJumpCooldown = 0.3; // Brief cooldown before can grab wall again
        this.hasUsedDoubleJump = false; // Wall jump resets double jump
        // Wall jump particles
        const wallX = this.isOnWall === 'left' ? 0 : this.canvas.width;
        for (let i = 0; i < 10; i++) {
          this.particles.push({
            x: wallX,
            y: this.player.y + this.player.height / 2,
            velocityX: (this.isOnWall === 'left' ? 1 : -1) * (Math.random() * 100 + 50),
            velocityY: (Math.random() - 0.5) * 150,
            life: 0.4,
            maxLife: 0.4,
            color: '#B8860B',
            size: 4 + Math.random() * 4,
          });
        }
        this.isOnWall = null;
      } else if (!this.hasUsedDoubleJump) {
        // Double jump in air
        this.player.velocityY = this.JUMP_FORCE * 0.85; // Slightly weaker
        this.hasUsedDoubleJump = true;
        // Double jump particles
        for (let i = 0; i < 8; i++) {
          this.particles.push({
            x: this.player.x + this.player.width / 2,
            y: this.player.y + this.player.height,
            velocityX: (Math.random() - 0.5) * 150,
            velocityY: Math.random() * 100 + 50,
            life: 0.3,
            maxLife: 0.3,
            color: '#87CEEB',
            size: 4 + Math.random() * 4,
          });
        }
      }
    }
    this.jumpKeyWasPressed = jumpPressed;

    // Shoot
    if ((this.keys['KeyX'] || this.keys['KeyZ'] || this.keys['ControlLeft'] || this.keys['ControlRight'] || this.touchControls.shoot) && this.player.shootCooldown <= 0) {
      this.shoot();
      this.player.shootCooldown = this.SHOOT_COOLDOWN;
    }

    if (this.player.shootCooldown > 0) {
      this.player.shootCooldown -= deltaTime;
    }
  }

  private shoot() {
    this.playShootSound();
    
    const projectile: Projectile = {
      x: this.player.direction === 'right' ? this.player.x + this.player.width : this.player.x - 15,
      y: this.player.y + this.player.height / 2 - 7,
      width: 15,
      height: 15,
      velocityX: this.player.direction === 'right' ? this.PROJECTILE_SPEED : -this.PROJECTILE_SPEED,
      velocityY: 0,
      isPlayerProjectile: true,
      active: true,
    };

    this.projectiles.push(projectile);
    this.player.isShooting = true;
    setTimeout(() => { this.player.isShooting = false; }, 100);

    // Muzzle flash particles
    for (let i = 0; i < 5; i++) {
      this.particles.push({
        x: projectile.x,
        y: projectile.y + 7,
        velocityX: (Math.random() - 0.5) * 100 + (this.player.direction === 'right' ? 50 : -50),
        velocityY: (Math.random() - 0.5) * 100,
        life: 0.2,
        maxLife: 0.2,
        color: '#FFD700',
        size: 3 + Math.random() * 3,
      });
    }
  }

  private updatePlayer(deltaTime: number) {
    // Apply gravity
    this.player.velocityY += this.GRAVITY * deltaTime;
    
    // Update position
    this.player.x += this.player.velocityX * deltaTime;
    this.player.y += this.player.velocityY * deltaTime;

    // Platform collision (only when falling)
    if (this.player.velocityY > 0) {
      for (const platform of this.platforms) {
        const playerBottom = this.player.y + this.player.height;
        const wasAbove = playerBottom - this.player.velocityY * deltaTime <= platform.y;
        
        if (wasAbove &&
            playerBottom >= platform.y &&
            playerBottom <= platform.y + platform.height + 10 &&
            this.player.x + this.player.width > platform.x &&
            this.player.x < platform.x + platform.width) {
          this.player.y = platform.y - this.player.height;
          this.player.velocityY = 0;
          this.player.isJumping = false;
          this.hasUsedDoubleJump = false; // Reset double jump on landing
          break;
        }
      }
    }

    // Ground collision
    if (this.player.y + this.player.height > this.GROUND_Y) {
      this.player.y = this.GROUND_Y - this.player.height;
      this.player.velocityY = 0;
      this.player.isJumping = false;
      this.hasUsedDoubleJump = false;
      this.isOnWall = null;
    }

    // Wall jump cooldown
    if (this.wallJumpCooldown > 0) {
      this.wallJumpCooldown -= deltaTime;
    }

    // Wall slide detection (only when falling and pressing toward wall)
    this.isOnWall = null;
    if (this.player.isJumping && this.player.velocityY > 0 && this.wallJumpCooldown <= 0) {
      const pressingLeft = this.keys['ArrowLeft'] || this.keys['KeyA'] || this.touchControls.left;
      const pressingRight = this.keys['ArrowRight'] || this.keys['KeyD'] || this.touchControls.right;
      
      if (this.player.x <= 0 && pressingLeft) {
        this.isOnWall = 'left';
        this.player.velocityY = Math.min(this.player.velocityY, 150); // Slow fall on wall
      } else if (this.player.x + this.player.width >= this.canvas.width && pressingRight) {
        this.isOnWall = 'right';
        this.player.velocityY = Math.min(this.player.velocityY, 150); // Slow fall on wall
      }
    }

    // Screen bounds
    if (this.player.x < 0) this.player.x = 0;
    if (this.player.x + this.player.width > this.canvas.width) {
      this.player.x = this.canvas.width - this.player.width;
    }

    // Invulnerability timer
    if (this.player.isInvulnerable) {
      this.player.invulnerabilityTimer -= deltaTime;
      if (this.player.invulnerabilityTimer <= 0) {
        this.player.isInvulnerable = false;
      }
    }
  }

  private updateBoss(deltaTime: number) {
    if (!this.boss) return;
    
    // Handle death animation
    if (this.boss.isDying) {
      this.updateDeathAnimation(deltaTime);
      return;
    }

    const bossConfig = PLANT_BOSSES[this.currentBossIndex];
    
    // Update animation frame
    this.boss.animationFrame += deltaTime * 5;
    
    // Update phase based on health
    const healthPercent = this.boss.health / this.boss.maxHealth;
    for (let i = bossConfig.phases.length - 1; i >= 0; i--) {
      if (healthPercent <= bossConfig.phases[i].healthThreshold) {
        if (this.boss.currentPhase !== i) {
          this.boss.currentPhase = i;
          this.boss.attackType = bossConfig.phases[i].attackPattern;
          // Phase change animation - squash and stretch
          this.boss.scaleX = 1.3;
          this.boss.scaleY = 0.7;
          // Add phase change particles
          for (let j = 0; j < 20; j++) {
            this.particles.push({
              x: this.boss.x + this.boss.width / 2,
              y: this.boss.y + this.boss.height / 2,
              velocityX: (Math.random() - 0.5) * 300,
              velocityY: (Math.random() - 0.5) * 300,
              life: 0.8,
              maxLife: 0.8,
              color: ['#FF0000', '#FF6600', '#FFFF00'][Math.floor(Math.random() * 3)],
              size: 8 + Math.random() * 8,
            });
          }
        }
        break;
      }
    }

    const currentPhase = bossConfig.phases[this.boss.currentPhase];

    // Boss hit flash
    if (this.boss.hitFlash > 0) {
      this.boss.hitFlash -= deltaTime;
    }
    
    // Smooth scale back to normal
    this.boss.scaleX += (1 - this.boss.scaleX) * deltaTime * 8;
    this.boss.scaleY += (1 - this.boss.scaleY) * deltaTime * 8;

    // Handle windup animation
    if (this.boss.isWindingUp) {
      this.boss.windupTimer -= deltaTime;
      // Squash effect during windup
      this.boss.scaleX = 1.2;
      this.boss.scaleY = 0.8;
      
      if (this.boss.windupTimer <= 0) {
        this.boss.isWindingUp = false;
        this.executeActualAttack(currentPhase);
      }
      return; // Don't move during windup
    }
    
    // Handle charging
    if (this.boss.isCharging) {
      const chargeDir = this.player.x < this.boss.x ? -1 : 1;
      this.boss.x += chargeDir * this.boss.chargeSpeed * deltaTime;
      this.boss.scaleX = 0.8;
      this.boss.scaleY = 1.2;
      
      // Charge trail particles
      if (Math.random() < 0.5) {
        this.particles.push({
          x: this.boss.x + (chargeDir > 0 ? 0 : this.boss.width),
          y: this.boss.y + this.boss.height * 0.8,
          velocityX: -chargeDir * 100,
          velocityY: -50,
          life: 0.3,
          maxLife: 0.3,
          color: '#FF6600',
          size: 10 + Math.random() * 10,
        });
      }
      
      // Stop charging at edges
      if (this.boss.x < 50 || this.boss.x + this.boss.width > this.canvas.width - 50) {
        this.boss.isCharging = false;
        this.boss.isAttacking = false;
        this.boss.scaleX = 0.7;
        this.boss.scaleY = 1.3;
      }
      return;
    }

    // Boss AI based on attack pattern
    this.boss.attackTimer -= deltaTime;

    if (this.boss.attackTimer <= 0) {
      this.startBossAttack(currentPhase);
      this.boss.attackTimer = currentPhase.attackSpeed;
    }

    // Movement
    this.boss.x += this.boss.moveDirection * currentPhase.moveSpeed * deltaTime;

    // Bounce off walls
    if (this.boss.x < this.canvas.width / 2) {
      this.boss.moveDirection = 1;
    } else if (this.boss.x + this.boss.width > this.canvas.width - 20) {
      this.boss.moveDirection = -1;
    }

    // Keep boss grounded
    this.boss.y = this.GROUND_Y - this.boss.height;
  }
  
  // Start attack with windup animation
  private startBossAttack(phase: BossPhase) {
    if (!this.boss) return;
    
    this.boss.isWindingUp = true;
    this.boss.isAttacking = true;
    
    // Different windup times for different attacks
    switch (phase.attackPattern) {
      case 'charge':
        this.boss.windupTimer = 0.5; // Longer windup for charge
        break;
      case 'ground_pound':
        this.boss.windupTimer = 0.4;
        break;
      case 'projectile_barrage':
        this.boss.windupTimer = 0.3;
        break;
      default:
        this.boss.windupTimer = 0.25;
    }
  }
  
  // Execute the actual attack after windup
  private executeActualAttack(phase: BossPhase) {
    this.executeBossAttack(phase);
  }

  private executeBossAttack(phase: BossPhase) {
    if (!this.boss) return;

    switch (phase.attackPattern) {
      case 'ground_pound':
        // Spawn dirt projectiles
        for (let i = 0; i < 5; i++) {
          this.projectiles.push({
            x: this.boss.x + this.boss.width / 2 - 10 + (i - 2) * 40,
            y: this.GROUND_Y - 20,
            width: 20,
            height: 20,
            velocityX: (i - 2) * 80,
            velocityY: -400 - Math.random() * 200,
            isPlayerProjectile: false,
            active: true,
          });
        }
        break;

      case 'tears':
        // Crying tears that arc upward then fall at random positions
        for (let i = 0; i < 4; i++) {
          // Random landing position across the arena (not aimed at player)
          const randomLandingX = 50 + Math.random() * (this.canvas.width - 100);
          const startX = this.boss.x + 20 + Math.random() * (this.boss.width - 40);
          
          this.projectiles.push({
            x: startX,
            y: this.boss.y + 40,
            width: 15,
            height: 20,
            velocityX: (randomLandingX - startX) * 0.4, // Horizontal movement toward random target
            velocityY: -350 - Math.random() * 150, // Launch UP first
            isPlayerProjectile: false,
            active: true,
          });
        }
        break;

      case 'projectile_barrage':
        // For Weepy: 8 tears arcing up then falling at random spots
        const currentBossConfig = PLANT_BOSSES[this.currentBossIndex];
        if (currentBossConfig.id === 'onion') {
          for (let i = 0; i < 8; i++) {
            const randomLandingX = 30 + Math.random() * (this.canvas.width - 60);
            const startX = this.boss.x + 10 + Math.random() * (this.boss.width - 20);
            
            this.projectiles.push({
              x: startX,
              y: this.boss.y + 30,
              width: 15,
              height: 20,
              velocityX: (randomLandingX - startX) * 0.5,
              velocityY: -400 - Math.random() * 200, // Higher arc
              isPlayerProjectile: false,
              active: true,
            });
          }
        } else {
          // Default aimed projectiles for other bosses
          const angle = Math.atan2(
            this.player.y - this.boss.y,
            this.player.x - this.boss.x
          );
          for (let i = -1; i <= 1; i++) {
            const spreadAngle = angle + i * 0.2;
            this.projectiles.push({
              x: this.boss.x,
              y: this.boss.y + this.boss.height / 2,
              width: 20,
              height: 20,
              velocityX: Math.cos(spreadAngle) * 300,
              velocityY: Math.sin(spreadAngle) * 300,
              isPlayerProjectile: false,
              active: true,
            });
          }
        }
        break;

      case 'charge':
        // Boss charges toward player with actual charging animation
        this.boss.isCharging = true;
        this.boss.chargeSpeed = 600; // Fast charge
        this.boss.scaleX = 0.8;
        this.boss.scaleY = 1.2;
        
        // Charge start particles
        for (let i = 0; i < 15; i++) {
          this.particles.push({
            x: this.boss.x + this.boss.width / 2,
            y: this.boss.y + this.boss.height,
            velocityX: (Math.random() - 0.5) * 200,
            velocityY: -100 - Math.random() * 100,
            life: 0.5,
            maxLife: 0.5,
            color: '#FF4400',
            size: 8 + Math.random() * 8,
          });
        }
        
        // Auto-stop charge after a duration
        setTimeout(() => {
          if (this.boss) {
            this.boss.isCharging = false;
            this.boss.isAttacking = false;
          }
        }, 800);
        break;

      case 'beam':
        // Horizontal beam
        for (let i = 0; i < 8; i++) {
          setTimeout(() => {
            if (this.boss) {
              this.projectiles.push({
                x: 0,
                y: this.boss.y + this.boss.height / 2 + (Math.random() - 0.5) * 40,
                width: 30,
                height: 15,
                velocityX: 500,
                velocityY: 0,
                isPlayerProjectile: false,
                active: true,
              });
            }
          }, i * 100);
        }
        break;

      case 'summon':
        // Spawn small projectiles from sides
        for (let i = 0; i < 4; i++) {
          this.projectiles.push({
            x: Math.random() < 0.5 ? 0 : this.canvas.width,
            y: 100 + Math.random() * 200,
            width: 25,
            height: 25,
            velocityX: Math.random() < 0.5 ? 200 : -200,
            velocityY: 50 + Math.random() * 100,
            isPlayerProjectile: false,
            active: true,
          });
        }
        break;
    }

    this.boss.isAttacking = true;
    setTimeout(() => {
      if (this.boss) this.boss.isAttacking = false;
    }, 300);
  }

  private updateProjectiles(deltaTime: number) {
    for (const proj of this.projectiles) {
      if (!proj.active) continue;

      proj.x += proj.velocityX * deltaTime;
      proj.y += proj.velocityY * deltaTime;

      // Apply gravity to enemy projectiles
      if (!proj.isPlayerProjectile) {
        proj.velocityY += 300 * deltaTime;
      }

      // Remove off-screen projectiles
      if (proj.x < -50 || proj.x > this.canvas.width + 50 ||
          proj.y < -50 || proj.y > this.canvas.height + 50) {
        proj.active = false;
      }
    }

    // Clean up inactive projectiles
    this.projectiles = this.projectiles.filter(p => p.active);
  }

  private updateParticles(deltaTime: number) {
    for (const particle of this.particles) {
      particle.x += particle.velocityX * deltaTime;
      particle.y += particle.velocityY * deltaTime;
      particle.life -= deltaTime;
    }

    this.particles = this.particles.filter(p => p.life > 0);
  }

  private checkCollisions() {
    if (!this.boss || this.boss.isDying) return;

    // Player projectiles hitting boss
    for (const proj of this.projectiles) {
      if (proj.isPlayerProjectile && proj.active) {
        if (this.checkRectCollision(proj, this.boss)) {
          proj.active = false;
          this.boss.health -= 5;
          this.boss.hitFlash = 0.1;
          this.score += 10;
          this.config.onScoreUpdate(this.score);
          this.config.onBossHealthUpdate(this.boss.health, this.boss.maxHealth);
          this.playBossHitSound();

          // Hit particles
          for (let i = 0; i < 8; i++) {
            this.particles.push({
              x: proj.x,
              y: proj.y,
              velocityX: (Math.random() - 0.5) * 200,
              velocityY: (Math.random() - 0.5) * 200,
              life: 0.3,
              maxLife: 0.3,
              color: '#FF6600',
              size: 4 + Math.random() * 4,
            });
          }

          // Check boss death
          if (this.boss.health <= 0) {
            this.defeatBoss();
          }
        }
      }
    }

    // Enemy projectiles hitting player
    if (!this.player.isInvulnerable) {
      for (const proj of this.projectiles) {
        if (!proj.isPlayerProjectile && proj.active) {
          if (this.checkRectCollision(proj, this.player)) {
            this.playerHit();
            proj.active = false;
          }
        }
      }

      // Boss body collision with player
      if (this.checkRectCollision(this.player, this.boss)) {
        this.playerHit();
      }
    }
  }

  private checkRectCollision(a: { x: number; y: number; width: number; height: number },
                              b: { x: number; y: number; width: number; height: number }): boolean {
    return a.x < b.x + b.width &&
           a.x + a.width > b.x &&
           a.y < b.y + b.height &&
           a.y + a.height > b.y;
  }

  private playerHit() {
    this.playHitSound();
    this.lives--;
    this.player.isInvulnerable = true;
    this.player.invulnerabilityTimer = 2;

    // Hit particles
    for (let i = 0; i < 10; i++) {
      this.particles.push({
        x: this.player.x + this.player.width / 2,
        y: this.player.y + this.player.height / 2,
        velocityX: (Math.random() - 0.5) * 300,
        velocityY: (Math.random() - 0.5) * 300,
        life: 0.5,
        maxLife: 0.5,
        color: '#FF0000',
        size: 5 + Math.random() * 5,
      });
    }

    this.config.onPlayerHit(this.lives);

    if (this.lives <= 0) {
      this.config.onGameOver();
      this.stop();
    }
  }

  private defeatBoss() {
    if (!this.boss || this.boss.isDying) return;
    
    // Start death animation instead of immediately removing boss
    this.boss.isDying = true;
    this.boss.deathTimer = 0;
    this.boss.deathPhase = 'wobble';
    this.boss.wobbleIntensity = 0;
    this.boss.meltProgress = 0;
    this.boss.deathRotation = 0;
    
    // Clear all projectiles
    this.projectiles = [];
    
    this.score += 500;
    this.config.onScoreUpdate(this.score);
  }

  private updateDeathAnimation(deltaTime: number) {
    if (!this.boss || !this.boss.isDying) return;
    
    this.boss.deathTimer += deltaTime;
    
    const bossConfig = PLANT_BOSSES[this.currentBossIndex];
    const colors = ['#CD853F', '#9932CC', '#FF6600', '#00FF88', '#FF69B4'];
    const bossColor = colors[this.currentBossIndex % colors.length];
    
    switch (this.boss.deathPhase) {
      case 'wobble':
        // Phase 1: Intense wobbling and shaking (0-1s)
        this.boss.wobbleIntensity = Math.min(this.boss.deathTimer * 20, 15);
        this.boss.scaleX = 1 + Math.sin(this.boss.deathTimer * 40) * 0.15;
        this.boss.scaleY = 1 + Math.cos(this.boss.deathTimer * 40) * 0.15;
        
        // Sparks flying off
        if (Math.random() < 0.4) {
          this.particles.push({
            x: this.boss.x + Math.random() * this.boss.width,
            y: this.boss.y + Math.random() * this.boss.height,
            velocityX: (Math.random() - 0.5) * 300,
            velocityY: -200 - Math.random() * 200,
            life: 0.5,
            maxLife: 0.5,
            color: ['#FFFF00', '#FF6600', '#FFFFFF'][Math.floor(Math.random() * 3)],
            size: 3 + Math.random() * 5,
          });
        }
        
        if (this.boss.deathTimer >= 1.0) {
          this.boss.deathPhase = 'melt';
          this.boss.deathTimer = 0;
        }
        break;
        
      case 'melt':
        // Phase 2: Boss melts/deflates (1-2s)
        this.boss.meltProgress = Math.min(this.boss.deathTimer / 1.2, 1);
        this.boss.scaleX = 1.5 - this.boss.meltProgress * 0.7; // Flatten horizontally
        this.boss.scaleY = 1 - this.boss.meltProgress * 0.8; // Squash vertically
        this.boss.deathRotation = Math.sin(this.boss.deathTimer * 15) * 0.1;
        
        // Dripping goo particles
        if (Math.random() < 0.6) {
          this.particles.push({
            x: this.boss.x + Math.random() * this.boss.width,
            y: this.boss.y + this.boss.height * (1 - this.boss.meltProgress * 0.5),
            velocityX: (Math.random() - 0.5) * 50,
            velocityY: 50 + Math.random() * 100,
            life: 0.8,
            maxLife: 0.8,
            color: bossColor,
            size: 8 + Math.random() * 8,
          });
        }
        
        if (this.boss.deathTimer >= 1.2) {
          this.boss.deathPhase = 'explode';
          this.boss.deathTimer = 0;
          this.createBossExplosion();
        }
        break;
        
      case 'explode':
        // Phase 3: Explosion (brief)
        if (this.boss.deathTimer >= 0.3) {
          this.boss.deathPhase = 'victory';
          this.boss.deathTimer = 0;
        }
        break;
        
      case 'victory':
        // Phase 4: Show "WALLOPED!" and transition
        if (this.boss.deathTimer >= 2.5) {
          const defeatedBoss = this.boss;
          this.boss = null;
          
          this.currentBossIndex++;
          if (this.currentBossIndex >= PLANT_BOSSES.length) {
            this.config.onAllBossesDefeated();
          } else {
            this.config.onBossDefeated(this.currentBossIndex - 1, PLANT_BOSSES.length);
            this.loadBoss(this.currentBossIndex);
          }
        }
        break;
    }
  }

  private createBossExplosion() {
    if (!this.boss) return;
    
    const centerX = this.boss.x + this.boss.width / 2;
    const centerY = this.boss.y + this.boss.height / 2;
    const bossConfig = PLANT_BOSSES[this.currentBossIndex];
    
    // Massive goo explosion - fountain upward
    for (let i = 0; i < 60; i++) {
      const angle = (Math.random() - 0.5) * Math.PI; // Mostly upward
      const speed = 200 + Math.random() * 400;
      this.particles.push({
        x: centerX + (Math.random() - 0.5) * 40,
        y: centerY,
        velocityX: Math.sin(angle) * speed,
        velocityY: -Math.abs(Math.cos(angle)) * speed - 100,
        life: 1.5,
        maxLife: 1.5,
        color: ['#FFD700', '#FF6600', '#FF00FF', '#00FF00', '#00FFFF', '#FF0066'][Math.floor(Math.random() * 6)],
        size: 8 + Math.random() * 15,
      });
    }
    
    // Star burst
    for (let i = 0; i < 20; i++) {
      const angle = (i / 20) * Math.PI * 2;
      this.particles.push({
        x: centerX,
        y: centerY,
        velocityX: Math.cos(angle) * 350,
        velocityY: Math.sin(angle) * 350,
        life: 1.2,
        maxLife: 1.2,
        color: '#FFFFFF',
        size: 6 + Math.random() * 6,
      });
    }
    
    // Confetti rain
    for (let i = 0; i < 40; i++) {
      this.particles.push({
        x: Math.random() * this.canvas.width,
        y: -20,
        velocityX: (Math.random() - 0.5) * 100,
        velocityY: 150 + Math.random() * 200,
        life: 2.5,
        maxLife: 2.5,
        color: ['#FF0066', '#00FF66', '#6600FF', '#FFFF00', '#00FFFF'][Math.floor(Math.random() * 5)],
        size: 5 + Math.random() * 8,
      });
    }
  }

  private renderVictorySplash() {
    if (!this.boss || this.boss.deathPhase !== 'victory') return;
    
    const progress = Math.min(this.boss.deathTimer / 0.5, 1);
    const bossConfig = PLANT_BOSSES[this.currentBossIndex];
    
    // Screen flash
    if (this.boss.deathTimer < 0.15) {
      this.ctx.fillStyle = `rgba(255, 255, 255, ${1 - this.boss.deathTimer / 0.15})`;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    
    // "WALLOPED!" text
    const scale = progress < 1 ? 0.5 + progress * 1.5 : 2 - Math.sin(this.boss.deathTimer * 3) * 0.1;
    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2 - 50;
    
    this.ctx.save();
    this.ctx.translate(centerX, centerY);
    this.ctx.scale(scale, scale);
    
    // Text shadow
    this.ctx.font = 'bold 60px Arial';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillStyle = '#000000';
    this.ctx.fillText('WALLOPED!', 4, 4);
    
    // Main text with gradient
    const gradient = this.ctx.createLinearGradient(-150, -30, 150, 30);
    gradient.addColorStop(0, '#FFD700');
    gradient.addColorStop(0.5, '#FFFFFF');
    gradient.addColorStop(1, '#FFD700');
    this.ctx.fillStyle = gradient;
    this.ctx.fillText('WALLOPED!', 0, 0);
    
    // Stroke
    this.ctx.strokeStyle = '#8B4513';
    this.ctx.lineWidth = 3;
    this.ctx.strokeText('WALLOPED!', 0, 0);
    
    this.ctx.restore();
    
    // Boss name underneath
    if (progress >= 0.5) {
      const subProgress = (progress - 0.5) * 2;
      this.ctx.globalAlpha = subProgress;
      this.ctx.font = 'bold 24px Arial';
      this.ctx.textAlign = 'center';
      this.ctx.fillStyle = '#FFFFFF';
      this.ctx.fillText(`${bossConfig.name} Defeated!`, centerX, centerY + 60);
      this.ctx.globalAlpha = 1;
    }
  }

  private render() {
    // Clear canvas
    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw background pattern
    this.drawBackground();

    // Draw ground
    this.ctx.fillStyle = '#2d5016';
    this.ctx.fillRect(0, this.GROUND_Y, this.canvas.width, this.canvas.height - this.GROUND_Y);
    
    // Ground grass
    this.ctx.fillStyle = '#3d7020';
    this.ctx.fillRect(0, this.GROUND_Y, this.canvas.width, 10);

    // Draw platforms
    this.renderPlatforms();

    // Draw particles (behind characters)
    this.renderParticles();

    // Draw boss
    this.renderBoss();

    // Draw player
    this.renderPlayer();

    // Draw projectiles
    this.renderProjectiles();

    // Draw UI
    this.renderUI();
    
    // Draw victory splash on top
    this.renderVictorySplash();
  }

  private drawBackground() {
    // Gradient sky
    const gradient = this.ctx.createLinearGradient(0, 0, 0, this.GROUND_Y);
    gradient.addColorStop(0, '#16213e');
    gradient.addColorStop(0.5, '#1a1a2e');
    gradient.addColorStop(1, '#0f3460');
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, this.canvas.width, this.GROUND_Y);

    // Stars
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    for (let i = 0; i < 50; i++) {
      const x = (i * 137) % this.canvas.width;
      const y = (i * 89) % (this.GROUND_Y - 50);
      const size = (i % 3) + 1;
      this.ctx.fillRect(x, y, size, size);
    }
  }

  private renderPlatforms() {
    for (const platform of this.platforms) {
      // Platform shadow
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      this.ctx.fillRect(platform.x + 5, platform.y + 5, platform.width, platform.height);
      
      // Platform body
      const gradient = this.ctx.createLinearGradient(platform.x, platform.y, platform.x, platform.y + platform.height);
      gradient.addColorStop(0, '#8B4513');
      gradient.addColorStop(0.5, '#A0522D');
      gradient.addColorStop(1, '#654321');
      this.ctx.fillStyle = gradient;
      this.ctx.fillRect(platform.x, platform.y, platform.width, platform.height);
      
      // Platform grass top
      this.ctx.fillStyle = '#3d7020';
      this.ctx.fillRect(platform.x, platform.y, platform.width, 5);
      
      // Highlight
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      this.ctx.fillRect(platform.x + 2, platform.y + 2, platform.width - 4, 3);
    }
  }

  private renderPlayer() {
    this.ctx.save();

    // Invulnerability flash
    if (this.player.isInvulnerable && Math.floor(this.player.invulnerabilityTimer * 10) % 2 === 0) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw player sprite or character image
    if (this.images['player']) {
      this.ctx.translate(this.player.x + this.player.width / 2, this.player.y);
      if (this.player.direction === 'left') {
        this.ctx.scale(-1, 1);
      }
      this.ctx.drawImage(this.images['player'], -this.player.width / 2, 0, this.player.width, this.player.height);
    } else {
      // Fallback rectangle player
      this.ctx.fillStyle = '#4CAF50';
      this.ctx.fillRect(this.player.x, this.player.y, this.player.width, this.player.height);

      // Eyes
      this.ctx.fillStyle = 'white';
      const eyeX = this.player.direction === 'right' ? this.player.x + 30 : this.player.x + 10;
      this.ctx.fillRect(eyeX, this.player.y + 15, 10, 10);
      this.ctx.fillStyle = 'black';
      this.ctx.fillRect(eyeX + 3, this.player.y + 18, 4, 4);

      // Shooting arm effect
      if (this.player.isShooting) {
        this.ctx.fillStyle = '#FFD700';
        const armX = this.player.direction === 'right' ? this.player.x + this.player.width : this.player.x - 10;
        this.ctx.fillRect(armX, this.player.y + 25, 15, 10);
      }
    }

    this.ctx.restore();
  }

  private renderBoss() {
    if (!this.boss) return;
    
    // Don't render if in explosion/victory phase
    if (this.boss.isDying && (this.boss.deathPhase === 'explode' || this.boss.deathPhase === 'victory')) {
      return;
    }

    this.ctx.save();

    // Death animation visuals
    if (this.boss.isDying) {
      // Wobble offset
      const wobbleX = Math.sin(this.boss.animationFrame * 30) * this.boss.wobbleIntensity;
      const wobbleY = Math.cos(this.boss.animationFrame * 25) * this.boss.wobbleIntensity * 0.5;
      this.ctx.translate(wobbleX, wobbleY);
      
      // Rotation during melt
      if (this.boss.deathRotation !== 0) {
        const centerX = this.boss.x + this.boss.width / 2;
        const centerY = this.boss.y + this.boss.height / 2;
        this.ctx.translate(centerX, centerY);
        this.ctx.rotate(this.boss.deathRotation);
        this.ctx.translate(-centerX, -centerY);
      }
      
      // Flash colors during dying
      if (Math.floor(this.boss.animationFrame * 10) % 2 === 0) {
        this.ctx.filter = 'hue-rotate(180deg) brightness(1.5)';
      }
    }

    // Hit flash
    if (this.boss.hitFlash > 0) {
      this.ctx.filter = 'brightness(2)';
    }

    // Attacking animation (shake)
    let offsetX = 0;
    let offsetY = 0;
    if (this.boss.isAttacking && !this.boss.isWindingUp && !this.boss.isCharging) {
      offsetX = (Math.random() - 0.5) * 10;
      offsetY = (Math.random() - 0.5) * 10;
    }
    
    // Windup visual indicator
    if (this.boss.isWindingUp) {
      // Pulsing glow during windup
      const pulse = Math.sin(this.boss.animationFrame * 10) * 0.3 + 0.7;
      this.ctx.shadowColor = '#FF0000';
      this.ctx.shadowBlur = 30 * pulse;
      
      // Warning particles
      if (Math.random() < 0.3) {
        this.particles.push({
          x: this.boss.x + Math.random() * this.boss.width,
          y: this.boss.y + this.boss.height,
          velocityX: (Math.random() - 0.5) * 50,
          velocityY: -100 - Math.random() * 50,
          life: 0.3,
          maxLife: 0.3,
          color: '#FFFF00',
          size: 5 + Math.random() * 5,
        });
      }
    }
    
    // Charging visual
    if (this.boss.isCharging) {
      this.ctx.shadowColor = '#FF4400';
      this.ctx.shadowBlur = 20;
    }

    const bossConfig = PLANT_BOSSES[this.currentBossIndex];
    const centerX = this.boss.x + this.boss.width / 2;
    const centerY = this.boss.y + this.boss.height / 2;
    
    // Apply squash/stretch scaling
    this.ctx.translate(centerX + offsetX, centerY + offsetY);
    this.ctx.scale(this.boss.scaleX, this.boss.scaleY);
    this.ctx.translate(-centerX, -centerY);
    
    if (this.images[bossConfig.imageKey]) {
      this.ctx.drawImage(
        this.images[bossConfig.imageKey],
        this.boss.x,
        this.boss.y,
        this.boss.width,
        this.boss.height
      );
    } else {
      // Fallback colored rectangle
      const colors = ['#CD853F', '#9932CC', '#FF6600'];
      this.ctx.fillStyle = colors[this.currentBossIndex % 3];
      this.ctx.fillRect(
        this.boss.x,
        this.boss.y,
        this.boss.width,
        this.boss.height
      );

      // Boss eyes - angry when attacking
      this.ctx.fillStyle = 'white';
      this.ctx.fillRect(this.boss.x + 30, this.boss.y + 40, 30, 30);
      this.ctx.fillRect(this.boss.x + 80, this.boss.y + 40, 30, 30);
      
      // Eyes turn red when attacking
      this.ctx.fillStyle = this.boss.isAttacking ? '#FF0000' : '#000000';
      const eyeOffsetY = this.boss.isWindingUp ? -5 : 0; // Eyes look up during windup
      this.ctx.fillRect(this.boss.x + 40, this.boss.y + 50 + eyeOffsetY, 15, 15);
      this.ctx.fillRect(this.boss.x + 90, this.boss.y + 50 + eyeOffsetY, 15, 15);
      
      // Angry eyebrows when attacking
      if (this.boss.isAttacking || this.boss.isWindingUp) {
        this.ctx.fillStyle = '#000000';
        this.ctx.save();
        this.ctx.translate(this.boss.x + 45, this.boss.y + 35);
        this.ctx.rotate(-0.3);
        this.ctx.fillRect(0, 0, 25, 5);
        this.ctx.restore();
        
        this.ctx.save();
        this.ctx.translate(this.boss.x + 95, this.boss.y + 35);
        this.ctx.rotate(0.3);
        this.ctx.fillRect(-20, 0, 25, 5);
        this.ctx.restore();
      }
    }

    this.ctx.restore();
    
    // Draw attack type indicator
    if (this.boss.isWindingUp) {
      this.ctx.fillStyle = 'rgba(255, 0, 0, 0.8)';
      this.ctx.font = 'bold 16px Arial';
      this.ctx.textAlign = 'center';
      const attackName = this.boss.attackType.replace('_', ' ').toUpperCase();
      this.ctx.fillText(`⚠️ ${attackName}!`, this.boss.x + this.boss.width / 2, this.boss.y - 10);
    }
  }

  private renderProjectiles() {
    for (const proj of this.projectiles) {
      if (!proj.active) continue;

      if (proj.isPlayerProjectile) {
        // Player projectile
        if (this.images['projectile']) {
          this.ctx.drawImage(this.images['projectile'], proj.x, proj.y, proj.width, proj.height);
        } else {
          this.ctx.fillStyle = '#00BFFF';
          this.ctx.beginPath();
          this.ctx.arc(proj.x + proj.width / 2, proj.y + proj.height / 2, proj.width / 2, 0, Math.PI * 2);
          this.ctx.fill();

          // Glow effect
          this.ctx.shadowColor = '#00BFFF';
          this.ctx.shadowBlur = 10;
          this.ctx.beginPath();
          this.ctx.arc(proj.x + proj.width / 2, proj.y + proj.height / 2, proj.width / 3, 0, Math.PI * 2);
          this.ctx.fill();
          this.ctx.shadowBlur = 0;
        }
      } else {
        // Enemy projectile
        this.ctx.fillStyle = '#FF4444';
        this.ctx.beginPath();
        this.ctx.arc(proj.x + proj.width / 2, proj.y + proj.height / 2, proj.width / 2, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
  }

  private renderParticles() {
    for (const particle of this.particles) {
      const alpha = particle.life / particle.maxLife;
      this.ctx.globalAlpha = alpha;
      this.ctx.fillStyle = particle.color;
      this.ctx.beginPath();
      this.ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  private renderUI() {
    // Boss health bar background
    if (this.boss) {
      const barWidth = 400;
      const barHeight = 25;
      const barX = (this.canvas.width - barWidth) / 2;
      const barY = 20;

      // Background
      this.ctx.fillStyle = '#333';
      this.ctx.fillRect(barX - 2, barY - 2, barWidth + 4, barHeight + 4);

      // Health bar
      const healthPercent = this.boss.health / this.boss.maxHealth;
      const healthColor = healthPercent > 0.5 ? '#4CAF50' : healthPercent > 0.25 ? '#FFC107' : '#F44336';
      this.ctx.fillStyle = healthColor;
      this.ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);

      // Boss name
      const bossConfig = PLANT_BOSSES[this.currentBossIndex];
      this.ctx.fillStyle = 'white';
      this.ctx.font = 'bold 16px Arial';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(bossConfig.name, this.canvas.width / 2, barY + barHeight + 20);

      // Phase indicator
      this.ctx.font = '12px Arial';
      this.ctx.fillText(`Phase ${this.boss.currentPhase + 1}/${bossConfig.phases.length}`, this.canvas.width / 2, barY + barHeight + 38);
    }

    // Lives display
    this.ctx.fillStyle = 'white';
    this.ctx.font = 'bold 20px Arial';
    this.ctx.textAlign = 'left';
    this.ctx.fillText(`Lives: ${'❤️'.repeat(this.lives)}`, 20, 30);

    // Score
    this.ctx.textAlign = 'right';
    this.ctx.fillText(`Score: ${this.score}`, this.canvas.width - 20, 30);

    // Controls hint
    this.ctx.font = '12px Arial';
    this.ctx.textAlign = 'center';
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    this.ctx.fillText('Arrow keys to move, X/Z/Ctrl to shoot', this.canvas.width / 2, this.canvas.height - 10);
  }

  setTouchControls(controls: { left: boolean; right: boolean; jump: boolean; shoot: boolean }) {
    this.touchControls = controls;
  }

  getCurrentBossIndex(): number {
    return this.currentBossIndex;
  }

  getScore(): number {
    return this.score;
  }

  getLives(): number {
    return this.lives;
  }
}
