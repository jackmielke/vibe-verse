export interface FighterPlayer {
  id: 1 | 2;
  x: number;
  y: number;
  width: number;
  height: number;
  velocityX: number;
  velocityY: number;
  isJumping: boolean;
  direction: 'left' | 'right';
  health: number;
  maxHealth: number;
  isInvulnerable: boolean;
  invulnerabilityTimer: number;
  isShooting: boolean;
  shootCooldown: number;
  // Special abilities
  isCharging: boolean;
  chargeTime: number;
  maxChargeTime: number;
  isDashing: boolean;
  dashTimer: number;
  dashCooldown: number;
  isShielded: boolean;
  shieldTimer: number;
  shieldCooldown: number;
  energy: number;
  maxEnergy: number;
}

export interface Projectile {
  x: number;
  y: number;
  width: number;
  height: number;
  velocityX: number;
  owner: 1 | 2;
  isCharged: boolean;
  damage: number;
}

interface Platform {
  x: number;
  y: number;
  width: number;
  height: number;
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
  type?: 'normal' | 'shield' | 'dash' | 'charge';
}

export interface FighterConfig {
  onHealthUpdate: (player1Health: number, player2Health: number) => void;
  onGameOver: (winner: 1 | 2) => void;
  onScoreUpdate: (player1Score: number, player2Score: number) => void;
  onEnergyUpdate?: (player1Energy: number, player2Energy: number) => void;
}

// Arena layout - symmetrical fighting stage
const ARENA: Platform[] = [
  // Main ground
  { x: 0, y: 520, width: 1000, height: 80 },
  // Left platform
  { x: 80, y: 380, width: 180, height: 25 },
  // Right platform
  { x: 740, y: 380, width: 180, height: 25 },
  // Center high platform
  { x: 400, y: 280, width: 200, height: 25 },
  // Left lower platform
  { x: 180, y: 450, width: 120, height: 20 },
  // Right lower platform
  { x: 700, y: 450, width: 120, height: 20 },
];

export class MultiplayerFighterEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: FighterConfig;
  private animationId: number | null = null;
  private keys: { [key: string]: boolean } = {};
  private prevKeys: { [key: string]: boolean } = {};
  private images: { [key: string]: HTMLImageElement } = {};
  private audioContext: AudioContext | null = null;
  /** Aborted on dispose(): removes every window listener this engine added. */
  private teardown = new AbortController();
  
  private player1: FighterPlayer;
  private player2: FighterPlayer;
  private projectiles: Projectile[] = [];
  private particles: Particle[] = [];
  private platforms: Platform[] = ARENA;
  private lastTime = 0;
  
  private player1Score = 0;
  private player2Score = 0;
  private roundWins = { 1: 0, 2: 0 };
  private maxRounds = 3;
  private isRoundOver = false;
  private roundEndTimer = 0;
  
  // Physics constants
  private readonly GRAVITY = 1200;
  private readonly JUMP_FORCE = -520;
  private readonly MOVE_SPEED = 350;
  private readonly FRICTION = 0.85;
  private readonly MAX_HEALTH = 100;
  private readonly PROJECTILE_SPEED = 600;
  private readonly PROJECTILE_DAMAGE = 8;
  private readonly SHOOT_COOLDOWN = 0.25;
  private readonly INVULNERABILITY_TIME = 0.5;
  
  // Special ability constants
  private readonly MAX_ENERGY = 100;
  private readonly ENERGY_REGEN = 15; // per second
  private readonly DASH_SPEED = 900;
  private readonly DASH_DURATION = 0.15;
  private readonly DASH_COOLDOWN = 0.8;
  private readonly DASH_DAMAGE = 15;
  private readonly DASH_ENERGY_COST = 25;
  private readonly SHIELD_DURATION = 1.5;
  private readonly SHIELD_COOLDOWN = 3;
  private readonly SHIELD_ENERGY_COST = 30;
  private readonly CHARGE_TIME = 0.8;
  private readonly CHARGED_SHOT_DAMAGE = 25;
  private readonly CHARGED_SHOT_SPEED = 800;

  constructor(canvas: HTMLCanvasElement, config: FighterConfig) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.config = config;
    
    this.player1 = this.createPlayer(1, 150, 400);
    this.player2 = this.createPlayer(2, 800, 400);
    
    this.setupEventListeners();
    this.initAudio();
  }

  private createPlayer(id: 1 | 2, x: number, y: number): FighterPlayer {
    return {
      id,
      x,
      y,
      width: 50,
      height: 60,
      velocityX: 0,
      velocityY: 0,
      isJumping: false,
      direction: id === 1 ? 'right' : 'left',
      health: this.MAX_HEALTH,
      maxHealth: this.MAX_HEALTH,
      isInvulnerable: false,
      invulnerabilityTimer: 0,
      isShooting: false,
      shootCooldown: 0,
      // Special abilities
      isCharging: false,
      chargeTime: 0,
      maxChargeTime: this.CHARGE_TIME,
      isDashing: false,
      dashTimer: 0,
      dashCooldown: 0,
      isShielded: false,
      shieldTimer: 0,
      shieldCooldown: 0,
      energy: this.MAX_ENERGY,
      maxEnergy: this.MAX_ENERGY,
    };
  }

  private initAudio() {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch (e) {
      console.warn('Web Audio API not supported');
    }
  }

  private setupEventListeners() {
    const handleKeyDown = (e: KeyboardEvent) => {
      this.keys[e.code] = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ', 'ShiftLeft', 'ShiftRight', 'Slash', 'Period'].includes(e.code)) {
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

  init() {
    this.resetRound();
  }

  private resetRound() {
    this.player1 = this.createPlayer(1, 150, 400);
    this.player2 = this.createPlayer(2, 800, 400);
    this.projectiles = [];
    this.particles = [];
    this.isRoundOver = false;
    this.roundEndTimer = 0;
    this.config.onHealthUpdate(this.player1.health, this.player2.health);
    this.config.onEnergyUpdate?.(this.player1.energy, this.player2.energy);
  }

  start() {
    if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume();
    }
    this.lastTime = performance.now();
    this.gameLoop();
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

  private gameLoop = () => {
    const currentTime = performance.now();
    const deltaTime = Math.min((currentTime - this.lastTime) / 1000, 0.05);
    this.lastTime = currentTime;

    this.update(deltaTime);
    this.render();
    
    // Store previous keys for edge detection
    this.prevKeys = { ...this.keys };

    this.animationId = requestAnimationFrame(this.gameLoop);
  };

  private keyJustPressed(code: string): boolean {
    return this.keys[code] && !this.prevKeys[code];
  }

  private update(dt: number) {
    if (this.isRoundOver) {
      this.roundEndTimer -= dt;
      if (this.roundEndTimer <= 0) {
        if (this.roundWins[1] >= 2 || this.roundWins[2] >= 2) {
          const winner = this.roundWins[1] >= 2 ? 1 : 2;
          this.config.onGameOver(winner);
          return;
        }
        this.resetRound();
      }
      return;
    }

    // Update players with controls
    this.updatePlayer(this.player1, dt, {
      left: 'KeyA',
      right: 'KeyD',
      jump: 'KeyW',
      shoot: 'Space',
      dash: 'ShiftLeft',
      shield: 'KeyQ',
    });
    
    this.updatePlayer(this.player2, dt, {
      left: 'ArrowLeft',
      right: 'ArrowRight',
      jump: 'ArrowUp',
      shoot: 'Enter',
      dash: 'ShiftRight',
      shield: 'Slash',
    });

    // Update projectiles
    this.updateProjectiles(dt);

    // Update particles
    this.updateParticles(dt);

    // Check collisions
    this.checkProjectileCollisions();
    this.checkDashCollisions();

    // Check for round end
    if (this.player1.health <= 0 || this.player2.health <= 0) {
      const winner = this.player1.health > 0 ? 1 : 2;
      this.roundWins[winner]++;
      this.isRoundOver = true;
      this.roundEndTimer = 2;
      this.config.onScoreUpdate(this.roundWins[1], this.roundWins[2]);
    }
  }

  private updatePlayer(player: FighterPlayer, dt: number, controls: { left: string; right: string; jump: string; shoot: string; dash: string; shield: string }) {
    // Regenerate energy
    if (!player.isDashing && !player.isShielded) {
      player.energy = Math.min(player.maxEnergy, player.energy + this.ENERGY_REGEN * dt);
    }

    // Handle invulnerability
    if (player.isInvulnerable && !player.isShielded) {
      player.invulnerabilityTimer -= dt;
      if (player.invulnerabilityTimer <= 0) {
        player.isInvulnerable = false;
      }
    }

    // Handle cooldowns
    if (player.shootCooldown > 0) player.shootCooldown -= dt;
    if (player.dashCooldown > 0) player.dashCooldown -= dt;
    if (player.shieldCooldown > 0) player.shieldCooldown -= dt;

    // Handle shield
    if (player.isShielded) {
      player.shieldTimer -= dt;
      if (player.shieldTimer <= 0) {
        player.isShielded = false;
        player.isInvulnerable = false;
      }
      // Create shield particles
      if (Math.random() < 0.3) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 40;
        this.particles.push({
          x: player.x + player.width / 2 + Math.cos(angle) * radius,
          y: player.y + player.height / 2 + Math.sin(angle) * radius,
          velocityX: Math.cos(angle) * 20,
          velocityY: Math.sin(angle) * 20,
          life: 0.3,
          maxLife: 0.3,
          color: player.id === 1 ? '#00ffff' : '#ff6600',
          size: 4,
          type: 'shield',
        });
      }
    }

    // Handle dash
    if (player.isDashing) {
      player.dashTimer -= dt;
      if (player.dashTimer <= 0) {
        player.isDashing = false;
      } else {
        // Dash movement override
        player.velocityX = player.direction === 'right' ? this.DASH_SPEED : -this.DASH_SPEED;
        // Create dash trail particles
        for (let i = 0; i < 2; i++) {
          this.particles.push({
            x: player.x + player.width / 2,
            y: player.y + Math.random() * player.height,
            velocityX: -player.velocityX * 0.2 + (Math.random() - 0.5) * 50,
            velocityY: (Math.random() - 0.5) * 50,
            life: 0.2,
            maxLife: 0.2,
            color: player.id === 1 ? '#00ffff' : '#ff6600',
            size: 6 + Math.random() * 4,
            type: 'dash',
          });
        }
      }
    }

    // Activate shield
    if (this.keyJustPressed(controls.shield) && player.shieldCooldown <= 0 && !player.isShielded && player.energy >= this.SHIELD_ENERGY_COST) {
      player.isShielded = true;
      player.isInvulnerable = true;
      player.shieldTimer = this.SHIELD_DURATION;
      player.shieldCooldown = this.SHIELD_COOLDOWN;
      player.energy -= this.SHIELD_ENERGY_COST;
      this.playShieldSound();
      // Shield activation burst
      for (let i = 0; i < 20; i++) {
        const angle = (i / 20) * Math.PI * 2;
        this.particles.push({
          x: player.x + player.width / 2,
          y: player.y + player.height / 2,
          velocityX: Math.cos(angle) * 150,
          velocityY: Math.sin(angle) * 150,
          life: 0.3,
          maxLife: 0.3,
          color: player.id === 1 ? '#00ffff' : '#ff6600',
          size: 5,
          type: 'shield',
        });
      }
    }

    // Activate dash
    if (this.keyJustPressed(controls.dash) && player.dashCooldown <= 0 && !player.isDashing && !player.isShielded && player.energy >= this.DASH_ENERGY_COST) {
      player.isDashing = true;
      player.dashTimer = this.DASH_DURATION;
      player.dashCooldown = this.DASH_COOLDOWN;
      player.energy -= this.DASH_ENERGY_COST;
      player.isInvulnerable = true;
      player.invulnerabilityTimer = this.DASH_DURATION;
      this.playDashSound();
    }

    // Movement (if not dashing)
    if (!player.isDashing) {
      if (this.keys[controls.left]) {
        player.velocityX = -this.MOVE_SPEED;
        player.direction = 'left';
      } else if (this.keys[controls.right]) {
        player.velocityX = this.MOVE_SPEED;
        player.direction = 'right';
      } else {
        player.velocityX *= this.FRICTION;
      }
    }

    // Jumping
    if (this.keys[controls.jump] && !player.isJumping) {
      player.velocityY = this.JUMP_FORCE;
      player.isJumping = true;
      this.playJumpSound();
    }

    // Charge shot mechanic
    if (this.keys[controls.shoot]) {
      if (!player.isCharging && player.shootCooldown <= 0) {
        player.isCharging = true;
        player.chargeTime = 0;
      }
      if (player.isCharging) {
        player.chargeTime += dt;
        // Charging particles
        if (player.chargeTime > 0.2 && Math.random() < 0.5) {
          const angle = Math.random() * Math.PI * 2;
          const dist = 30 + Math.random() * 20;
          this.particles.push({
            x: player.x + player.width / 2 + Math.cos(angle) * dist,
            y: player.y + player.height / 2 + Math.sin(angle) * dist,
            velocityX: -Math.cos(angle) * 100,
            velocityY: -Math.sin(angle) * 100,
            life: 0.2,
            maxLife: 0.2,
            color: player.chargeTime >= this.CHARGE_TIME ? '#ffff00' : (player.id === 1 ? '#88ffff' : '#ffaa44'),
            size: 3 + (player.chargeTime / this.CHARGE_TIME) * 4,
            type: 'charge',
          });
        }
      }
    } else if (player.isCharging) {
      // Release shot
      const isCharged = player.chargeTime >= this.CHARGE_TIME;
      this.shoot(player, isCharged);
      player.isCharging = false;
      player.chargeTime = 0;
      player.shootCooldown = this.SHOOT_COOLDOWN;
    }

    // Apply gravity
    player.velocityY += this.GRAVITY * dt;

    // Update position
    player.x += player.velocityX * dt;
    player.y += player.velocityY * dt;

    // Platform collisions
    for (const platform of this.platforms) {
      if (this.checkPlatformCollision(player, platform)) {
        if (player.velocityY > 0 && player.y + player.height - player.velocityY * dt <= platform.y + 5) {
          player.y = platform.y - player.height;
          player.velocityY = 0;
          player.isJumping = false;
        } else if (player.velocityY < 0 && player.y - player.velocityY * dt >= platform.y + platform.height - 5) {
          player.y = platform.y + platform.height;
          player.velocityY = 0;
        }
      }
    }

    // Keep player in bounds
    player.x = Math.max(0, Math.min(this.canvas.width - player.width, player.x));
    
    // Fall off screen - take damage
    if (player.y > this.canvas.height) {
      player.y = 100;
      player.x = player.id === 1 ? 150 : 800;
      player.velocityY = 0;
      this.takeDamage(player, 20);
    }

    // Update energy UI
    this.config.onEnergyUpdate?.(this.player1.energy, this.player2.energy);
  }

  private checkPlatformCollision(player: FighterPlayer, platform: Platform): boolean {
    return (
      player.x < platform.x + platform.width &&
      player.x + player.width > platform.x &&
      player.y < platform.y + platform.height &&
      player.y + player.height > platform.y
    );
  }

  private shoot(player: FighterPlayer, isCharged: boolean) {
    const size = isCharged ? 35 : 20;
    const projectile: Projectile = {
      x: player.direction === 'right' ? player.x + player.width : player.x - size,
      y: player.y + player.height / 2 - size / 2,
      width: size,
      height: isCharged ? 20 : 10,
      velocityX: player.direction === 'right' 
        ? (isCharged ? this.CHARGED_SHOT_SPEED : this.PROJECTILE_SPEED) 
        : (isCharged ? -this.CHARGED_SHOT_SPEED : -this.PROJECTILE_SPEED),
      owner: player.id,
      isCharged,
      damage: isCharged ? this.CHARGED_SHOT_DAMAGE : this.PROJECTILE_DAMAGE,
    };
    this.projectiles.push(projectile);
    
    if (isCharged) {
      this.playChargedShotSound();
      // Big muzzle flash
      for (let i = 0; i < 15; i++) {
        this.particles.push({
          x: projectile.x + (player.direction === 'right' ? 0 : size),
          y: projectile.y + size / 2,
          velocityX: (Math.random() - 0.5) * 300 + projectile.velocityX * 0.4,
          velocityY: (Math.random() - 0.5) * 200,
          life: 0.3,
          maxLife: 0.3,
          color: '#ffff00',
          size: 6 + Math.random() * 6,
        });
      }
    } else {
      this.playShootSound();
      // Normal muzzle flash
      for (let i = 0; i < 5; i++) {
        this.particles.push({
          x: projectile.x,
          y: projectile.y + 5,
          velocityX: (Math.random() - 0.5) * 200 + projectile.velocityX * 0.3,
          velocityY: (Math.random() - 0.5) * 100,
          life: 0.2,
          maxLife: 0.2,
          color: player.id === 1 ? '#00ffff' : '#ff6600',
          size: 4 + Math.random() * 4,
        });
      }
    }
  }

  private updateProjectiles(dt: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      proj.x += proj.velocityX * dt;
      
      // Charged shot trail
      if (proj.isCharged && Math.random() < 0.5) {
        this.particles.push({
          x: proj.x + proj.width / 2,
          y: proj.y + proj.height / 2,
          velocityX: (Math.random() - 0.5) * 50,
          velocityY: (Math.random() - 0.5) * 50,
          life: 0.15,
          maxLife: 0.15,
          color: '#ffff00',
          size: 4 + Math.random() * 4,
        });
      }
      
      if (proj.x < -50 || proj.x > this.canvas.width + 50) {
        this.projectiles.splice(i, 1);
      }
    }
  }

  private checkProjectileCollisions() {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      const target = proj.owner === 1 ? this.player2 : this.player1;
      
      if (this.checkCollision(proj, target)) {
        if (target.isShielded) {
          // Deflect projectile
          proj.velocityX = -proj.velocityX;
          proj.owner = target.id;
          this.playDeflectSound();
          // Deflect particles
          for (let j = 0; j < 8; j++) {
            this.particles.push({
              x: proj.x,
              y: proj.y,
              velocityX: (Math.random() - 0.5) * 200,
              velocityY: (Math.random() - 0.5) * 200,
              life: 0.2,
              maxLife: 0.2,
              color: '#ffffff',
              size: 4,
            });
          }
        } else if (!target.isInvulnerable) {
          this.takeDamage(target, proj.damage);
          this.projectiles.splice(i, 1);
          
          // Hit particles
          const particleCount = proj.isCharged ? 20 : 10;
          for (let j = 0; j < particleCount; j++) {
            this.particles.push({
              x: proj.x,
              y: proj.y,
              velocityX: (Math.random() - 0.5) * 400,
              velocityY: (Math.random() - 0.5) * 400,
              life: 0.3,
              maxLife: 0.3,
              color: proj.isCharged ? '#ffff00' : '#ff4444',
              size: 3 + Math.random() * (proj.isCharged ? 8 : 5),
            });
          }
        }
      }
    }
  }

  private checkDashCollisions() {
    // Check if dashing player hits the other
    const checkDash = (attacker: FighterPlayer, target: FighterPlayer) => {
      if (attacker.isDashing && !target.isInvulnerable && !target.isShielded) {
        if (this.checkCollision(attacker, target)) {
          this.takeDamage(target, this.DASH_DAMAGE);
          // Dash hit particles
          for (let i = 0; i < 15; i++) {
            this.particles.push({
              x: target.x + target.width / 2,
              y: target.y + target.height / 2,
              velocityX: (attacker.direction === 'right' ? 1 : -1) * 200 + (Math.random() - 0.5) * 150,
              velocityY: (Math.random() - 0.5) * 200,
              life: 0.3,
              maxLife: 0.3,
              color: attacker.id === 1 ? '#00ffff' : '#ff6600',
              size: 5 + Math.random() * 5,
            });
          }
          // Knock back target
          target.velocityX = (attacker.direction === 'right' ? 1 : -1) * 400;
          target.velocityY = -200;
        }
      }
    };
    
    checkDash(this.player1, this.player2);
    checkDash(this.player2, this.player1);
  }

  private checkCollision(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }

  private takeDamage(player: FighterPlayer, damage: number) {
    if (player.isInvulnerable) return;
    
    player.health = Math.max(0, player.health - damage);
    player.isInvulnerable = true;
    player.invulnerabilityTimer = this.INVULNERABILITY_TIME;
    
    this.config.onHealthUpdate(this.player1.health, this.player2.health);
    this.playHitSound();
  }

  private updateParticles(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.velocityX * dt;
      p.y += p.velocityY * dt;
      if (p.type !== 'shield' && p.type !== 'charge') {
        p.velocityY += 400 * dt;
      }
      p.life -= dt;
      
      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  private render() {
    const ctx = this.ctx;
    const canvas = this.canvas;

    // Clear and draw background
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#1a1a2e');
    gradient.addColorStop(1, '#16213e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw platforms
    for (const platform of this.platforms) {
      ctx.fillStyle = '#4a5568';
      ctx.fillRect(platform.x, platform.y, platform.width, platform.height);
      ctx.fillStyle = '#718096';
      ctx.fillRect(platform.x, platform.y, platform.width, 4);
    }

    // Draw particles (behind players)
    for (const p of this.particles) {
      const alpha = p.life / p.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Draw projectiles
    for (const proj of this.projectiles) {
      const baseColor = proj.owner === 1 ? '#00ffff' : '#ff6600';
      const color = proj.isCharged ? '#ffff00' : baseColor;
      
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = proj.isCharged ? 20 : 10;
      
      if (proj.isCharged) {
        // Draw charged shot as glowing orb
        ctx.beginPath();
        ctx.arc(proj.x + proj.width / 2, proj.y + proj.height / 2, proj.width / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(proj.x, proj.y, proj.width, proj.height);
      }
      ctx.shadowBlur = 0;
    }

    // Draw players
    this.renderPlayer(this.player1, '#00aaff');
    this.renderPlayer(this.player2, '#ff6600');

    // Draw UI
    this.renderUI();

    // Draw round over message
    if (this.isRoundOver) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 48px Arial';
      ctx.textAlign = 'center';
      const winner = this.player1.health > 0 ? 'Player 1' : 'Player 2';
      ctx.fillText(`${winner} wins the round!`, canvas.width / 2, canvas.height / 2);
      
      ctx.font = '24px Arial';
      ctx.fillText(`Round ${this.roundWins[1] + this.roundWins[2]} - Score: P1 ${this.roundWins[1]} - P2 ${this.roundWins[2]}`, canvas.width / 2, canvas.height / 2 + 50);
    }
  }

  private renderPlayer(player: FighterPlayer, color: string) {
    const ctx = this.ctx;
    
    // Draw shield bubble first
    if (player.isShielded) {
      ctx.strokeStyle = player.id === 1 ? '#00ffff' : '#ff6600';
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.5 + Math.sin(performance.now() / 100) * 0.2;
      ctx.beginPath();
      ctx.arc(player.x + player.width / 2, player.y + player.height / 2, 45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Dash glow effect
    if (player.isDashing) {
      ctx.shadowColor = player.id === 1 ? '#00ffff' : '#ff6600';
      ctx.shadowBlur = 20;
    }
    
    // Invulnerability flash
    if (player.isInvulnerable && !player.isShielded && Math.floor(performance.now() / 100) % 2 === 0) {
      ctx.globalAlpha = 0.5;
    }

    // Draw player sprite or colored rectangle
    if (this.images[`player${player.id}`]) {
      ctx.save();
      if (player.direction === 'left') {
        ctx.scale(-1, 1);
        ctx.drawImage(
          this.images[`player${player.id}`],
          -player.x - player.width,
          player.y,
          player.width,
          player.height
        );
      } else {
        ctx.drawImage(
          this.images[`player${player.id}`],
          player.x,
          player.y,
          player.width,
          player.height
        );
      }
      ctx.restore();
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(player.x, player.y, player.width, player.height);
      
      ctx.fillStyle = '#ffffff';
      const eyeY = player.y + 15;
      const eyeSize = 6;
      ctx.beginPath();
      ctx.arc(player.x + 15, eyeY, eyeSize, 0, Math.PI * 2);
      ctx.arc(player.x + 35, eyeY, eyeSize, 0, Math.PI * 2);
      ctx.fill();
    }
    
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    // Charge indicator
    if (player.isCharging && player.chargeTime > 0.1) {
      const chargePercent = Math.min(1, player.chargeTime / this.CHARGE_TIME);
      const indicatorX = player.direction === 'right' ? player.x + player.width + 10 : player.x - 15;
      const indicatorY = player.y + player.height / 2;
      
      ctx.strokeStyle = chargePercent >= 1 ? '#ffff00' : '#888888';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(indicatorX, indicatorY, 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * chargePercent);
      ctx.stroke();
      
      if (chargePercent >= 1) {
        ctx.fillStyle = '#ffff00';
        ctx.beginPath();
        ctx.arc(indicatorX, indicatorY, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Health bar above player
    const barWidth = 50;
    const barHeight = 6;
    const barX = player.x;
    const barY = player.y - 15;
    
    ctx.fillStyle = '#333';
    ctx.fillRect(barX, barY, barWidth, barHeight);
    
    const healthPercent = player.health / player.maxHealth;
    const healthColor = healthPercent > 0.5 ? '#22c55e' : healthPercent > 0.25 ? '#eab308' : '#ef4444';
    ctx.fillStyle = healthColor;
    ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);
    
    // Player label
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`P${player.id}`, player.x + player.width / 2, barY - 5);
  }

  private renderUI() {
    const ctx = this.ctx;
    const barWidth = 300;
    const barHeight = 20;
    const energyBarHeight = 8;
    const margin = 50;
    
    // Player 1 health (left side)
    ctx.fillStyle = '#333';
    ctx.fillRect(margin, 20, barWidth, barHeight);
    const health1Percent = this.player1.health / this.player1.maxHealth;
    ctx.fillStyle = health1Percent > 0.5 ? '#00aaff' : health1Percent > 0.25 ? '#eab308' : '#ef4444';
    ctx.fillRect(margin, 20, barWidth * health1Percent, barHeight);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(margin, 20, barWidth, barHeight);
    
    // Player 1 energy bar
    ctx.fillStyle = '#222';
    ctx.fillRect(margin, 42, barWidth, energyBarHeight);
    ctx.fillStyle = '#00ff88';
    ctx.fillRect(margin, 42, barWidth * (this.player1.energy / this.player1.maxEnergy), energyBarHeight);
    
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(`P1: ${Math.ceil(this.player1.health)}%`, margin + 10, 36);

    // Player 2 health (right side)
    const p2BarX = this.canvas.width - margin - barWidth;
    ctx.fillStyle = '#333';
    ctx.fillRect(p2BarX, 20, barWidth, barHeight);
    const health2Percent = this.player2.health / this.player2.maxHealth;
    ctx.fillStyle = health2Percent > 0.5 ? '#ff6600' : health2Percent > 0.25 ? '#eab308' : '#ef4444';
    ctx.fillRect(p2BarX + barWidth * (1 - health2Percent), 20, barWidth * health2Percent, barHeight);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(p2BarX, 20, barWidth, barHeight);
    
    // Player 2 energy bar
    ctx.fillStyle = '#222';
    ctx.fillRect(p2BarX, 42, barWidth, energyBarHeight);
    ctx.fillStyle = '#00ff88';
    ctx.fillRect(p2BarX + barWidth * (1 - this.player2.energy / this.player2.maxEnergy), 42, barWidth * (this.player2.energy / this.player2.maxEnergy), energyBarHeight);
    
    ctx.textAlign = 'right';
    ctx.fillText(`P2: ${Math.ceil(this.player2.health)}%`, p2BarX + barWidth - 10, 36);

    // Round score in center
    ctx.textAlign = 'center';
    ctx.font = 'bold 28px Arial';
    ctx.fillText(`${this.roundWins[1]} - ${this.roundWins[2]}`, this.canvas.width / 2, 40);

    // Ability cooldown indicators
    this.renderAbilityIndicators(this.player1, margin, 58);
    this.renderAbilityIndicators(this.player2, p2BarX + barWidth - 100, 58);
    
    // Controls hint at bottom
    ctx.font = '12px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillText('P1: WASD + Space(hold=charge) | Shift=Dash | Q=Shield', this.canvas.width / 4, this.canvas.height - 10);
    ctx.fillText('P2: Arrows + Enter(hold=charge) | RShift=Dash | /=Shield', this.canvas.width * 3 / 4, this.canvas.height - 10);
  }

  private renderAbilityIndicators(player: FighterPlayer, x: number, y: number) {
    const ctx = this.ctx;
    const size = 18;
    const gap = 24;
    
    // Dash indicator
    const dashReady = player.dashCooldown <= 0 && player.energy >= this.DASH_ENERGY_COST;
    ctx.fillStyle = dashReady ? '#00ff88' : '#444';
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#fff';
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('⚡', x + size / 2, y + 14);
    
    // Shield indicator
    const shieldReady = player.shieldCooldown <= 0 && player.energy >= this.SHIELD_ENERGY_COST && !player.isShielded;
    ctx.fillStyle = shieldReady ? '#00aaff' : '#444';
    ctx.fillRect(x + gap, y, size, size);
    ctx.fillText('🛡', x + gap + size / 2, y + 14);
    
    // Charge shot indicator (always show if not on cooldown)
    const chargeReady = player.shootCooldown <= 0;
    ctx.fillStyle = chargeReady ? '#ffff00' : '#444';
    ctx.fillRect(x + gap * 2, y, size, size);
    ctx.fillText('💥', x + gap * 2 + size / 2, y + 14);
  }

  // Sound effects
  private playJumpSound() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(300, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(600, this.audioContext.currentTime + 0.1);
    osc.type = 'square';
    gain.gain.setValueAtTime(0.1, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.1);
  }

  private playShootSound() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(800, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(200, this.audioContext.currentTime + 0.08);
    osc.type = 'sawtooth';
    gain.gain.setValueAtTime(0.15, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.08);
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.08);
  }

  private playChargedShotSound() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(400, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, this.audioContext.currentTime + 0.05);
    osc.frequency.exponentialRampToValueAtTime(100, this.audioContext.currentTime + 0.2);
    osc.type = 'sawtooth';
    gain.gain.setValueAtTime(0.25, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.2);
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.2);
  }

  private playDashSound() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(200, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(800, this.audioContext.currentTime + 0.05);
    osc.frequency.exponentialRampToValueAtTime(400, this.audioContext.currentTime + 0.1);
    osc.type = 'triangle';
    gain.gain.setValueAtTime(0.2, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.1);
  }

  private playShieldSound() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(600, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, this.audioContext.currentTime + 0.1);
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.15, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.15);
  }

  private playDeflectSound() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(1000, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(2000, this.audioContext.currentTime + 0.05);
    osc.type = 'square';
    gain.gain.setValueAtTime(0.1, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.08);
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.08);
  }

  private playHitSound() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.setValueAtTime(150, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(50, this.audioContext.currentTime + 0.15);
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.2, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.15);
  }

  restart() {
    this.roundWins = { 1: 0, 2: 0 };
    this.player1Score = 0;
    this.player2Score = 0;
    this.config.onScoreUpdate(0, 0);
    this.resetRound();
  }
}
