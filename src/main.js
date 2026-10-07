/**
 * DroneSim SVG - Usine d'Assemblage & Contrôle Qualité
 * Moteur de simulation industrielle 100% Vanilla JavaScript & SVG natif
 * Conforme aux Prompts 1, 2, 3, 4, 5, 6 + Passerelle MQTT / Node-RED
 */

import mqtt from 'mqtt';

// ============================================================================
// 1. ÉTAT GLOBAL ET CONFIGURATION
// ============================================================================

const CONFIG = {
  // Coordonnées de la ligne (viewBox 1600x680)
  LINE_Y: 276,
  SPAWN_X: 160,
  SENSOR_S1_X: 436,
  ASSEMBLY_X: 605,
  CONV_2_START_X: 720,
  QC_X: 1095,
  DIVERTER_X: 1245,
  PASS_TARGET_X: 1400,
  PASS_TARGET_Y: 195,
  FAIL_TARGET_X: 1400,
  FAIL_TARGET_Y: 410,
  ITEM_SIZE: 52,
  QUEUE_GAP: 66,
};

// Paramètres ajustables dynamiquement (Prompt 4)
const state = {
  isRunning: true,
  isPaused: false,
  simSpeed: 1, // 1x, 2x, 5x
  soundEnabled: true,

  // Paramètres utilisateur
  params: {
    conveyorSpeed: 80, // px/s
    spawnInterval: 5.0, // secondes entre chaque kit
    assemblyTime: 3.0, // secondes d'assemblage
    qcTime: 2.0, // secondes de scan qualité
    defectRate: 20, // pourcentage théorique de défaut (0 - 60)
  },

  // Timers et cadences
  spawnTimer: 0,
  totalElapsed: 0,
  nextDroneId: 101,
  pendingInjectCount: 0,

  // Postes de travail
  assemblyStation: {
    state: 'IDLE', // 'IDLE' | 'PROCESSING'
    drone: null,
    timer: 0,
    queueCount: 0,
    totalDone: 0,
    isBottleneck: false,
  },

  qcStation: {
    state: 'IDLE', // 'IDLE' | 'SCANNING'
    drone: null,
    timer: 0,
    queueCount: 0,
    totalTested: 0,
    passCount: 0,
    failCount: 0,
    isBottleneck: false,
  },

  // Capteurs industriels (Prompt 6)
  sensors: {
    s1Presence: false,
    s2Scan: false,
    s3Count: 0,
    s3PulseTimer: 0,
  },

  // Mode Défi (Prompt 5)
  challenge: {
    active: true,
    mode: '100', // '100' | '50' | '20' | 'free'
    targetCount: 100,
    targetSeconds: 600, // 10 minutes
    timeRemaining: 600,
    completed: false,
    victory: false,
  },

  // Statistiques de la ligne
  stats: {
    totalInjected: 0,
    assembled: 0,
    passed: 0,
    failed: 0,
    actualDefectRate: 0,
    recentDepartures: [], // Pour calcul de cadence instantanée ppm
  },

  // Liste des drones actifs sur le convoyeur
  drones: [],

  // Drones archivés dans le stock ou rebut
  storedPass: 0,
  storedFail: 0,

  // Horloge de cycle
  propellerAngle: 0,

  // Passerelle MQTT & Node-RED
  mqtt: {
    client: null,
    connected: false,
    connecting: false,
    brokerUrl: 'ws://localhost:9001',
    topicPrefix: 'factory/dronesim',
    clientId: `dronesim_${Math.random().toString(16).substring(2, 8)}`,
    publishRateMs: 1000,
    txCount: 0,
    rxCount: 0,
    publishTimer: null,
  },
};

// ============================================================================
// 2. MOTEUR AUDIO SCADA (Web Audio API natif, aucun fichier externe)
// ============================================================================

class SoundManager {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
  }

  beep(freq, duration = 0.08, type = 'sine', gainVal = 0.08) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx || this.ctx.state === 'suspended') {
      if (this.ctx) this.ctx.resume();
      return;
    }
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (_) {}
  }

  playSpawn() {
    this.beep(420, 0.06, 'triangle', 0.05);
  }

  playAssemblyStart() {
    this.beep(280, 0.12, 'sawtooth', 0.04);
  }

  playAssemblyDone() {
    this.beep(587.33, 0.09, 'sine', 0.06);
    setTimeout(() => this.beep(880, 0.12, 'sine', 0.06), 90);
  }

  playScan() {
    this.beep(980, 0.08, 'triangle', 0.03);
  }

  playPass() {
    this.beep(523.25, 0.08, 'sine', 0.07);
    setTimeout(() => this.beep(659.25, 0.08, 'sine', 0.07), 80);
    setTimeout(() => this.beep(783.99, 0.15, 'sine', 0.08), 160);
  }

  playFail() {
    this.beep(196, 0.18, 'sawtooth', 0.09);
    setTimeout(() => this.beep(164.81, 0.25, 'sawtooth', 0.1), 120);
  }

  playAlarm() {
    this.beep(880, 0.12, 'square', 0.08);
    setTimeout(() => this.beep(660, 0.12, 'square', 0.08), 120);
  }

  playVictory() {
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => {
      setTimeout(() => this.beep(f, 0.2, 'sine', 0.1), i * 150);
    });
  }
}

const audio = new SoundManager();

// ============================================================================
// 3. CLASSE PRODUIT : DRONE (Étape Kit -> Assemblé -> Scanné)
// ============================================================================

class DroneItem {
  constructor(id) {
    this.id = id;
    this.serial = `DRN-${String(id).padStart(4, '0')}`;
    this.state = 'KIT'; // 'KIT' | 'ASSEMBLING' | 'ASSEMBLED' | 'SCANNING' | 'INSPECTED_PASS' | 'INSPECTED_FAIL'
    this.x = CONFIG.SPAWN_X;
    this.y = CONFIG.LINE_Y;
    this.targetY = CONFIG.LINE_Y;
    this.speed = state.params.conveyorSpeed;
    this.entryTime = state.totalElapsed;
    this.isDefective = false; // Calculé au poste de QC
    this.isStored = false;

    // Éléments SVG mis en cache pour performances optimales
    this.svgGroup = null;
    this.createSvgElement();
  }

  createSvgElement() {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'drone-unit');
    g.setAttribute('data-id', this.id);
    g.style.cursor = 'pointer';

    // Interaction tooltip inspection
    g.addEventListener('mouseenter', (e) => showDroneTooltip(this, e));
    g.addEventListener('mouseleave', () => hideDroneTooltip());

    this.svgGroup = g;
    this.render();
    document.getElementById('drones-layer').appendChild(g);
  }

  render() {
    if (!this.svgGroup) return;

    // Mise à jour de la position avec translation SVG
    this.svgGroup.setAttribute('transform', `translate(${this.x}, ${this.y})`);

    let innerHtml = '';

    if (this.state === 'KIT' || (this.state === 'ASSEMBLING' && state.assemblyStation.timer < state.params.assemblyTime * 0.7)) {
      // 🟢 ÉTAPE 1 : KIT DE PIÈCES DRONE BRUT (Plateau thermoformé avec cadre nu en X + hélices détachées)
      innerHtml = `
        <!-- Boîte / Plateau du Kit -->
        <rect x="-26" y="-26" width="52" height="52" rx="4" fill="#0f172a" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="2 2" />
        <rect x="-23" y="-23" width="46" height="46" rx="2" fill="#1e293b" />
        
        <!-- Châssis nu en X sans hélices -->
        <line x1="-16" y1="-16" x2="16" y2="16" stroke="#475569" stroke-width="4" stroke-linecap="round" />
        <line x1="16" y1="-16" x2="-16" y2="16" stroke="#475569" stroke-width="4" stroke-linecap="round" />
        <circle cx="0" cy="0" r="7" fill="#0284c7" stroke="#38bdf8" stroke-width="1" />
        <rect x="-5" y="-5" width="10" height="10" rx="2" fill="#0f172a" />
        
        <!-- 4 Hélices détachées sous blister latéral -->
        <circle cx="-18" cy="-18" r="3" fill="#64748b" />
        <circle cx="18" cy="-18" r="3" fill="#64748b" />
        <circle cx="-18" cy="18" r="3" fill="#64748b" />
        <circle cx="18" cy="18" r="3" fill="#64748b" />

        <!-- Étiquette code-barre du kit -->
        <rect x="-16" y="16" width="32" height="6" fill="#fff" opacity="0.8" />
        <line x1="-14" y1="17" x2="-14" y2="21" stroke="#000" stroke-width="1" />
        <line x1="-10" y1="17" x2="-10" y2="21" stroke="#000" stroke-width="1.5" />
        <line x1="-5" y1="17" x2="-5" y2="21" stroke="#000" stroke-width="1" />
        <line x1="2" y1="17" x2="2" y2="21" stroke="#000" stroke-width="2" />
        <line x1="10" y1="17" x2="10" y2="21" stroke="#000" stroke-width="1" />

        <!-- Badge texte KIT -->
        <text x="0" y="-12" text-anchor="middle" fill="#94a3b8" font-size="7" font-weight="700" font-family="monospace">KIT #${this.id}</text>
      `;
    } else {
      // 🟢 ÉTAPE 2 & 3 : DRONE QUADRICOPTÈRE ASSEMBLÉ
      const angle = state.propellerAngle;
      const isDefect = this.state === 'INSPECTED_FAIL';
      const isPass = this.state === 'INSPECTED_PASS';

      // Couleur de fuselage et éclairage
      const mainColor = isDefect ? '#e11d48' : (isPass ? '#10b981' : '#0284c7');
      const armColor = isDefect ? '#881337' : '#334155';
      const propColor = isDefect ? '#f43f5e' : (isPass ? '#34d399' : '#38bdf8');

      innerHtml = `
        <!-- Halo d'état si inspecté -->
        ${isPass ? '<circle cx="0" cy="0" r="28" fill="none" stroke="#10b981" stroke-width="2" stroke-dasharray="3 3" opacity="0.8" />' : ''}
        ${isDefect ? '<circle cx="0" cy="0" r="28" fill="none" stroke="#f43f5e" stroke-width="2" opacity="0.8" />' : ''}

        <!-- 4 Bras structurels en fibre de carbone -->
        <line x1="-20" y1="-20" x2="20" y2="20" stroke="${armColor}" stroke-width="5" stroke-linecap="round" />
        <line x1="20" y1="-20" x2="-20" y2="20" stroke="${armColor}" stroke-width="5" stroke-linecap="round" />

        <!-- 4 Moteurs Brushless -->
        <circle cx="-20" cy="-20" r="5" fill="#1e293b" stroke="${mainColor}" stroke-width="1.5" />
        <circle cx="20" cy="-20" r="5" fill="#1e293b" stroke="${mainColor}" stroke-width="1.5" />
        <circle cx="-20" cy="20" r="5" fill="#1e293b" stroke="${mainColor}" stroke-width="1.5" />
        <circle cx="20" cy="20" r="5" fill="#1e293b" stroke="${mainColor}" stroke-width="1.5" />

        <!-- 4 Hélices Tripales en rotation rapide -->
        <g transform="translate(-20, -20) rotate(${angle})">
          <line x1="-9" y1="0" x2="9" y2="0" stroke="${propColor}" stroke-width="2.5" stroke-linecap="round" opacity="0.9" />
          <line x1="0" y1="-9" x2="0" y2="9" stroke="${propColor}" stroke-width="2.5" stroke-linecap="round" opacity="0.9" />
          <circle cx="0" cy="0" r="2" fill="#fff" />
        </g>
        <g transform="translate(20, -20) rotate(${-angle})">
          <line x1="-9" y1="0" x2="9" y2="0" stroke="${propColor}" stroke-width="2.5" stroke-linecap="round" opacity="0.9" />
          <line x1="0" y1="-9" x2="0" y2="9" stroke="${propColor}" stroke-width="2.5" stroke-linecap="round" opacity="0.9" />
          <circle cx="0" cy="0" r="2" fill="#fff" />
        </g>
        <g transform="translate(-20, 20) rotate(${-angle})">
          <line x1="-9" y1="0" x2="9" y2="0" stroke="${propColor}" stroke-width="2.5" stroke-linecap="round" opacity="0.9" />
          <line x1="0" y1="-9" x2="0" y2="9" stroke="${propColor}" stroke-width="2.5" stroke-linecap="round" opacity="0.9" />
          <circle cx="0" cy="0" r="2" fill="#fff" />
        </g>
        <g transform="translate(20, 20) rotate(${angle})">
          <line x1="-9" y1="0" x2="9" y2="0" stroke="${propColor}" stroke-width="2.5" stroke-linecap="round" opacity="0.9" />
          <line x1="0" y1="-9" x2="0" y2="9" stroke="${propColor}" stroke-width="2.5" stroke-linecap="round" opacity="0.9" />
          <circle cx="0" cy="0" r="2" fill="#fff" />
        </g>

        <!-- Fuselage central aérodynamique -->
        <ellipse cx="0" cy="0" rx="14" ry="10" fill="#0f172a" stroke="${mainColor}" stroke-width="2" />
        
        <!-- Caméra 4K Gimbal à l'avant (orientation vers la droite du flux) -->
        <rect x="10" y="-4" width="7" height="8" rx="2" fill="#334155" />
        <circle cx="15" cy="0" r="2" fill="#06b6d4" />

        <!-- Feux de navigation LED -->
        <circle cx="16" cy="-14" r="2" fill="#10b981" />
        <circle cx="16" cy="14" r="2" fill="#10b981" />
        <circle cx="-16" cy="-14" r="2" fill="#ef4444" />
        <circle cx="-16" cy="14" r="2" fill="#ef4444" />

        <!-- Sceau de certification ou anomalie -->
        ${isPass ? `
          <g transform="translate(0, -18)">
            <rect x="-18" y="-7" width="36" height="11" rx="3" fill="#064e3b" stroke="#10b981" stroke-width="1" />
            <text x="0" y="1" text-anchor="middle" fill="#6ee7b7" font-size="7" font-weight="800">QC PASS</text>
          </g>
        ` : ''}

        ${isDefect ? `
          <g transform="translate(0, -18)">
            <rect x="-18" y="-7" width="36" height="11" rx="3" fill="#4c0519" stroke="#f43f5e" stroke-width="1" />
            <text x="0" y="1" text-anchor="middle" fill="#fecdd3" font-size="7" font-weight="800">REJET</text>
          </g>
          <!-- Croix d'erreur sur fuselage -->
          <line x1="-5" y1="-5" x2="5" y2="5" stroke="#f43f5e" stroke-width="2" />
          <line x1="5" y1="-5" x2="-5" y2="5" stroke="#f43f5e" stroke-width="2" />
        ` : ''}

        <!-- Numéro de série miniature -->
        <text x="0" y="3" text-anchor="middle" fill="#e2e8f0" font-size="6.5" font-weight="700" font-family="monospace">#${this.id}</text>
      `;
    }

    this.svgGroup.innerHTML = innerHtml;
  }

  destroy() {
    if (this.svgGroup && this.svgGroup.parentNode) {
      this.svgGroup.parentNode.removeChild(this.svgGroup);
    }
  }
}

// ============================================================================
// 4. BOUCLE PRINCIPALE DE SIMULATION
// ============================================================================

let lastTimestamp = 0;

function simulationLoop(timestamp) {
  if (!lastTimestamp) lastTimestamp = timestamp;
  const rawDelta = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;

  // Limitation pour éviter les sauts en arrière-plan
  const dt = Math.min(rawDelta, 0.1) * (state.isRunning && !state.isPaused ? state.simSpeed : 0);

  if (dt > 0) {
    state.totalElapsed += dt;
    state.propellerAngle = (state.propellerAngle + dt * 1200) % 360;

    // Mise à jour de la logique industrielle
    updateSourceSpawn(dt);
    updateDronesMovement(dt);
    updateAssemblyStation(dt);
    updateQcStation(dt);
    updateSensors(dt);
    updateChallenge(dt);
    checkBottlenecks();
    updateUi();
  }

  // Animation continue des rouleaux de convoyeur
  if (state.isRunning && !state.isPaused) {
    animateConveyorRollers(timestamp);
  }

  requestAnimationFrame(simulationLoop);
}

// ============================================================================
// 5. POSTE SOURCE : GÉNÉRATION AUTOMATIQUE DES KITS (Prompt 1)
// ============================================================================

function updateSourceSpawn(dt) {
  state.spawnTimer += dt;
  const interval = state.params.spawnInterval;

  // Décompte visuel sur la source
  const sourceCycleEl = document.getElementById('source-cycle-display');
  if (sourceCycleEl) {
    if (state.pendingInjectCount > 0) {
      sourceCycleEl.textContent = `File: +${state.pendingInjectCount}`;
    } else {
      const remain = Math.max(0, interval - state.spawnTimer).toFixed(1);
      sourceCycleEl.textContent = `${remain}s`;
    }
  }

  // Traitement prioritaire des injections manuelles en attente
  if (state.pendingInjectCount > 0) {
    const isOccupied = state.drones.some((d) => d.x < CONFIG.SPAWN_X + 45);
    if (!isOccupied) {
      state.pendingInjectCount--;
      spawnDroneEntity();
    }
  }

  // Injection automatique au rythme de cycle configuré
  if (state.spawnTimer >= interval) {
    state.spawnTimer = 0;
    const isOccupied = state.drones.some((d) => d.x < CONFIG.SPAWN_X + CONFIG.QUEUE_GAP);
    if (!isOccupied) {
      spawnDroneEntity();
    }
  }
}

function requestManualInjection() {
  state.pendingInjectCount++;
  audio.beep(480, 0.08, 'triangle', 0.06);

  // Animation instantanée du piston pour feedback visuel immédiat
  const piston = document.getElementById('source-piston');
  if (piston) {
    piston.setAttribute('x', '35');
    setTimeout(() => piston.setAttribute('x', '15'), 160);
  }

  // Si l'entrée est dégagée, injecter immédiatement
  const isOccupied = state.drones.some((d) => d.x < CONFIG.SPAWN_X + 45);
  if (!isOccupied) {
    state.pendingInjectCount--;
    spawnDroneEntity();
  } else {
    // Si l'entrée est occupée, le kit est placé dans la file d'attente tampon
    const led = document.getElementById('source-led');
    if (led) {
      led.setAttribute('fill', '#f59e0b');
      setTimeout(() => led.setAttribute('fill', '#10b981'), 250);
    }
  }
}

function spawnDroneEntity() {
  const drone = new DroneItem(state.nextDroneId++);
  state.drones.push(drone);
  state.stats.totalInjected++;

  // Effet d'animation de piston pneumatique
  const piston = document.getElementById('source-piston');
  if (piston) {
    piston.setAttribute('x', '35');
    setTimeout(() => piston.setAttribute('x', '15'), 180);
  }

  // Voyant flash bleu d'injection
  const led = document.getElementById('source-led');
  if (led) {
    led.setAttribute('fill', '#38bdf8');
    setTimeout(() => led.setAttribute('fill', '#10b981'), 200);
  }

  audio.playSpawn();
}

// ============================================================================
// 6. DÉPLACEMENT PHYSIQUE SUR CONVOYEUR & ACCUMULATION (Prompts 1, 2)
// ============================================================================

function updateDronesMovement(dt) {
  const speed = state.params.conveyorSpeed;
  const queueGap = CONFIG.QUEUE_GAP;

  // Tri des drones par position X décroissante (ceux les plus en avant d'abord)
  state.drones.sort((a, b) => b.x - a.x);

  for (let i = 0; i < state.drones.length; i++) {
    const drone = state.drones[i];

    // Si le drone est actuellement en cours de traitement dans une machine, il ne bouge pas
    if (drone.state === 'ASSEMBLING' || drone.state === 'SCANNING') {
      continue;
    }

    // Calcul de l'obstacle devant ce drone
    let canMove = true;
    let stopX = 9999;

    // Obstacle 1 : Le drone directement devant lui sur la même section
    if (i > 0) {
      const droneAhead = state.drones[i - 1];
      // Ne bloque que si sur la même trajectoire principale
      if (Math.abs(drone.y - droneAhead.y) < 30 || drone.x < CONFIG.DIVERTER_X) {
        stopX = droneAhead.x - queueGap;
      }
    }

    // Obstacle 2 : Arrêt devant le Poste d'Assemblage si la machine est occupée
    if (drone.state === 'KIT' && drone.x < CONFIG.ASSEMBLY_X) {
      if (state.assemblyStation.state !== 'IDLE' || state.assemblyStation.drone !== null) {
        stopX = Math.min(stopX, CONFIG.ASSEMBLY_X - queueGap);
      } else {
        // La machine est libre, le kit s'arrête exactement au centre pour être pris
        stopX = Math.min(stopX, CONFIG.ASSEMBLY_X);
      }
    }

    // Obstacle 3 : Arrêt devant le Poste de Scan QC si la machine est occupée
    if (drone.state === 'ASSEMBLED' && drone.x < CONFIG.QC_X && drone.x >= CONFIG.CONV_2_START_X) {
      if (state.qcStation.state !== 'IDLE' || state.qcStation.drone !== null) {
        stopX = Math.min(stopX, CONFIG.QC_X - queueGap);
      } else {
        // La machine QC est libre, le drone s'arrête exactement au banc
        stopX = Math.min(stopX, CONFIG.QC_X);
      }
    }

    // Déplacement sur l'axe X
    if (drone.x < stopX) {
      drone.x += speed * dt;
      if (drone.x > stopX) drone.x = stopX;
    }

    // Transition d'aiguillage après le QC (Bifurcation Tri Conforme / Rejet)
    if (drone.x >= CONFIG.DIVERTER_X) {
      if (drone.state === 'INSPECTED_PASS') {
        drone.targetY = CONFIG.PASS_TARGET_Y;
      } else if (drone.state === 'INSPECTED_FAIL') {
        drone.targetY = CONFIG.FAIL_TARGET_Y;
      }

      // Interpolation douce vers la voie de sortie
      drone.y += (drone.targetY - drone.y) * Math.min(1, dt * 4);
    }

    // Arrivée dans la zone de stockage finale
    if (drone.x >= CONFIG.PASS_TARGET_X) {
      handleDroneArrival(drone);
    }

    drone.render();
  }

  // Nettoyage des drones stockés
  state.drones = state.drones.filter((d) => !d.isStored);
}

function handleDroneArrival(drone) {
  drone.isStored = true;
  drone.destroy();

  // Enregistrement pour cadence instantanée
  state.stats.recentDepartures.push(state.totalElapsed);
  if (state.stats.recentDepartures.length > 20) {
    state.stats.recentDepartures.shift();
  }

  if (drone.state === 'INSPECTED_PASS') {
    state.stats.passed++;
    state.storedPass++;
    audio.playPass();
    triggerStockPulse('stock-pass-count-big', '#10b981');
    updateStockDisplay('stock-pass-items-display', state.storedPass, '#10b981');
  } else {
    state.stats.failed++;
    state.storedFail++;
    audio.playFail();
    triggerStockPulse('stock-fail-count-big', '#f43f5e');
    updateStockDisplay('stock-fail-items-display', state.storedFail, '#f43f5e');
  }

  // Détection d'alerte si taux de défaut > 30% (Prompt 6)
  checkQualityAlert();
}

// ============================================================================
// 7. POSTE D'ASSEMBLAGE ROBOTISÉ : TRANSFORMATION KIT -> DRONE (Prompt 2)
// ============================================================================

function updateAssemblyStation(dt) {
  const station = state.assemblyStation;

  // Calcul du nombre de kits en attente avant le poste (Prompt 2 & 4)
  station.queueCount = state.drones.filter((d) => d.state === 'KIT' && d.x >= 200 && d.x <= CONFIG.ASSEMBLY_X).length;
  const queueEl = document.getElementById('assembly-queue-count');
  if (queueEl) queueEl.textContent = station.queueCount;

  if (station.state === 'IDLE') {
    // Cherche un kit qui est arrivé à la position d'assemblage
    const readyKit = state.drones.find((d) => d.state === 'KIT' && Math.abs(d.x - CONFIG.ASSEMBLY_X) < 4);

    if (readyKit) {
      station.state = 'PROCESSING';
      station.drone = readyKit;
      station.timer = 0;
      readyKit.state = 'ASSEMBLING';
      readyKit.x = CONFIG.ASSEMBLY_X; // Fixe au centre

      // Mise à jour visuelle SVG : statut & balise
      setAssemblyUiState('ASSEMBLAGE EN COURS...', '#f59e0b', true);
      audio.playAssemblyStart();
    }
  } else if (station.state === 'PROCESSING') {
    station.timer += dt;
    const progress = Math.min(1, station.timer / state.params.assemblyTime);

    // Mise à jour de la barre de progression en SVG
    const pBar = document.getElementById('assembly-progress-bar');
    if (pBar) pBar.setAttribute('width', `${(progress * 220).toFixed(0)}`);

    // Animation mécanique du bras robotisé SCARA
    animateRobotArm(progress);

    // À la fin du cycle d'assemblage (Prompt 2 : temps de traitement 3s)
    if (station.timer >= state.params.assemblyTime) {
      // Transformation visuelle : Le kit devient un DRONE complet !
      station.drone.state = 'ASSEMBLED';
      station.drone.render();

      station.totalDone++;
      state.stats.assembled++;

      const doneEl = document.getElementById('assembly-done-count');
      if (doneEl) doneEl.textContent = station.totalDone;

      // Libération de la machine
      station.state = 'IDLE';
      station.drone = null;
      station.timer = 0;

      setAssemblyUiState('EN ATTENTE', '#94a3b8', false);
      audio.playAssemblyDone();

      // Réinitialisation du bras robot
      resetRobotArm();
    }
  }
}

function setAssemblyUiState(text, color, active) {
  const statusText = document.getElementById('assembly-status-text');
  const beacon = document.getElementById('assembly-beacon');
  const frame = document.getElementById('assembly-frame');
  const sparks = document.getElementById('welding-sparks');

  if (statusText) {
    statusText.textContent = text;
    statusText.setAttribute('fill', color);
  }
  if (beacon) {
    beacon.setAttribute('fill', active ? '#3b82f6' : '#10b981');
    beacon.setAttribute('filter', active ? 'url(#glow-cyan)' : 'url(#glow-green)');
  }
  if (frame) {
    frame.setAttribute('stroke', active ? '#38bdf8' : '#3b82f6');
  }
  if (sparks) {
    sparks.setAttribute('opacity', active ? '1' : '0');
  }
}

function animateRobotArm(progress) {
  const toolHead = document.getElementById('robot-tool-head');
  const elbow = document.getElementById('robot-joint-elbow');
  const seg2 = document.getElementById('robot-segment-2');

  // Mouvement vertical sinusoïdal de vissage/soudure
  const descent = Math.sin(progress * Math.PI) * 18;
  const toolY = 265 + descent;

  if (toolHead) {
    toolHead.setAttribute('transform', `translate(605, ${toolY})`);
  }
  if (seg2) {
    seg2.setAttribute('y2', `${toolY}`);
  }
}

function resetRobotArm() {
  const toolHead = document.getElementById('robot-tool-head');
  const seg2 = document.getElementById('robot-segment-2');
  const pBar = document.getElementById('assembly-progress-bar');
  if (toolHead) toolHead.setAttribute('transform', 'translate(605, 265)');
  if (seg2) seg2.setAttribute('y2', '265');
  if (pBar) pBar.setAttribute('width', '0');
}

// ============================================================================
// 8. POSTE DE CONTRÔLE QUALITÉ : SCAN OPTIQUE & DÉCISION (Prompt 3)
// ============================================================================

function updateQcStation(dt) {
  const station = state.qcStation;

  // File d'attente avant le banc de scan
  station.queueCount = state.drones.filter((d) => d.state === 'ASSEMBLED' && d.x >= CONFIG.CONV_2_START_X && d.x <= CONFIG.QC_X).length;

  if (station.state === 'IDLE') {
    // Cherche un drone assemblé prêt au banc de test
    const readyDrone = state.drones.find((d) => d.state === 'ASSEMBLED' && Math.abs(d.x - CONFIG.QC_X) < 4);

    if (readyDrone) {
      station.state = 'SCANNING';
      station.drone = readyDrone;
      station.timer = 0;
      readyDrone.state = 'SCANNING';
      readyDrone.x = CONFIG.QC_X;

      setQcUiState('ANALYSE VISION EN COURS...', '#38bdf8', true);
      audio.playScan();
    }
  } else if (station.state === 'SCANNING') {
    station.timer += dt;
    const progress = Math.min(1, station.timer / state.params.qcTime);

    // Animation du laser et de la grille holographique
    animateQcLaser(progress);

    const pBar = document.getElementById('qc-progress-bar');
    if (pBar) pBar.setAttribute('width', `${(progress * 220).toFixed(0)}`);

    // Fin du cycle de contrôle (Prompt 3 : temps de contrôle 2s)
    if (station.timer >= state.params.qcTime) {
      station.totalTested++;

      // Décision conditionnelle selon probabilité de défaut (Prompt 3 : défaut 20%)
      const isDefect = Math.random() * 100 < state.params.defectRate;
      station.drone.isDefective = isDefect;

      // Voyants de contrôle qualité
      const ledPass = document.getElementById('qc-led-pass');
      const ledFail = document.getElementById('qc-led-fail');
      const diverterArm = document.getElementById('diverter-arm');

      if (isDefect) {
        // NON CONFORME -> BAC DE REJET (Zone rouge)
        station.drone.state = 'INSPECTED_FAIL';
        station.failCount++;

        if (ledFail) {
          ledFail.setAttribute('fill', '#f43f5e');
          ledFail.setAttribute('filter', 'url(#glow-red)');
          setTimeout(() => {
            ledFail.setAttribute('fill', '#4c0519');
            ledFail.removeAttribute('filter');
          }, 900);
        }

        // Aiguillage vers le bas
        if (diverterArm) {
          diverterArm.setAttribute('x2', '1285');
          diverterArm.setAttribute('y2', '292');
        }
      } else {
        // CONFORME -> STOCK FINAL (Zone verte)
        station.drone.state = 'INSPECTED_PASS';
        station.passCount++;

        if (ledPass) {
          ledPass.setAttribute('fill', '#10b981');
          ledPass.setAttribute('filter', 'url(#glow-green)');
          setTimeout(() => {
            ledPass.setAttribute('fill', '#064e3b');
            ledPass.removeAttribute('filter');
          }, 900);
        }

        // Aiguillage vers le haut
        if (diverterArm) {
          diverterArm.setAttribute('x2', '1285');
          diverterArm.setAttribute('y2', '258');
        }
      }

      station.drone.render();

      // Mise à jour des compteurs SVG du poste QC (Prompt 3)
      const passSvg = document.getElementById('qc-pass-count-svg');
      const failSvg = document.getElementById('qc-fail-count-svg');
      const rateSvg = document.getElementById('qc-rate-svg');

      const actualRate = ((station.failCount / station.totalTested) * 100).toFixed(1);
      state.stats.actualDefectRate = parseFloat(actualRate);

      if (passSvg) passSvg.textContent = station.passCount;
      if (failSvg) failSvg.textContent = station.failCount;
      if (rateSvg) rateSvg.textContent = `${actualRate}%`;

      // Libération
      station.state = 'IDLE';
      station.drone = null;
      station.timer = 0;

      setQcUiState('EN VEILLE', '#7dd3fc', false);
      resetQcLaser();
    }
  }
}

function setQcUiState(text, color, active) {
  const statusText = document.getElementById('qc-status-text');
  const curtain = document.getElementById('qc-laser-curtain');
  const line = document.getElementById('qc-laser-line');
  const grid = document.getElementById('qc-holo-grid');

  if (statusText) {
    statusText.textContent = text;
    statusText.setAttribute('fill', color);
  }
  if (curtain) curtain.setAttribute('opacity', active ? '0.75' : '0');
  if (line) line.setAttribute('opacity', active ? '1' : '0');
  if (grid) grid.setAttribute('opacity', active ? '0.9' : '0');
}

function animateQcLaser(progress) {
  const line = document.getElementById('qc-laser-line');
  // Balayage vertical de haut en bas sur le drone
  const y = 250 + Math.sin(progress * Math.PI * 3) * 22;
  if (line) {
    line.setAttribute('y1', `${y}`);
    line.setAttribute('y2', `${y}`);
  }
}

function resetQcLaser() {
  const curtain = document.getElementById('qc-laser-curtain');
  const line = document.getElementById('qc-laser-line');
  const grid = document.getElementById('qc-holo-grid');
  const pBar = document.getElementById('qc-progress-bar');
  if (curtain) curtain.setAttribute('opacity', '0');
  if (line) line.setAttribute('opacity', '0');
  if (grid) grid.setAttribute('opacity', '0');
  if (pBar) pBar.setAttribute('width', '0');
}

// ============================================================================
// 9. CAPTEURS INDUSTRIELS & COMPTAGE (Prompt 6)
// ============================================================================

function updateSensors(dt) {
  // Capteur S1 : Présence de kit avant le poste d'assemblage
  const s1Detected = state.drones.some((d) => Math.abs(d.x - CONFIG.SENSOR_S1_X) < 22 && d.state === 'KIT');
  state.sensors.s1Presence = s1Detected;

  const s1LedTop = document.getElementById('s1-led-top');
  const s1LedBot = document.getElementById('s1-led-bot');
  const s1Beam = document.getElementById('s1-beam');
  const s1Dash = document.getElementById('dash-sensor-s1');

  if (s1Detected) {
    if (s1LedTop) s1LedTop.setAttribute('fill', '#38bdf8');
    if (s1LedBot) s1LedBot.setAttribute('fill', '#38bdf8');
    if (s1Beam) {
      s1Beam.setAttribute('stroke', '#38bdf8');
      s1Beam.setAttribute('stroke-width', '3');
    }
    if (s1Dash) {
      s1Dash.className = 'sensor-badge active-blue';
      s1Dash.textContent = 'Kit présent';
    }
  } else {
    if (s1LedTop) s1LedTop.setAttribute('fill', '#06b6d4');
    if (s1LedBot) s1LedBot.setAttribute('fill', '#06b6d4');
    if (s1Beam) {
      s1Beam.setAttribute('stroke', '#06b6d4');
      s1Beam.setAttribute('stroke-width', '2');
    }
    if (s1Dash) {
      s1Dash.className = 'sensor-badge';
      s1Dash.textContent = 'Libre';
    }
  }

  // Capteur S2 : Activité de numérisation QC
  const s2Dash = document.getElementById('dash-sensor-s2');
  if (state.qcStation.state === 'SCANNING') {
    if (s2Dash) {
      s2Dash.className = 'sensor-badge active-green';
      s2Dash.textContent = 'Contrôle en cours';
    }
  } else {
    if (s2Dash) {
      s2Dash.className = 'sensor-badge';
      s2Dash.textContent = 'En attente';
    }
  }

  // Capteur S3 : Cellule de comptage après tri (impulsion à chaque passage)
  const s2Led = document.getElementById('s2-led');
  const s3Dash = document.getElementById('dash-sensor-s3');

  // Détection de drone franchissant la ligne S2
  const dronePassing = state.drones.some((d) => Math.abs(d.x - CONFIG.DIVERTER_X) < 15);
  if (dronePassing && state.sensors.s3PulseTimer <= 0) {
    state.sensors.s3Count++;
    state.sensors.s3PulseTimer = 0.4;
    if (s2Led) {
      s2Led.setAttribute('fill', '#facc15');
      s2Led.setAttribute('filter', 'url(#glow-amber)');
    }
  }

  if (state.sensors.s3PulseTimer > 0) {
    state.sensors.s3PulseTimer -= dt;
    if (s3Dash) {
      s3Dash.className = 'sensor-badge active-amber';
      s3Dash.textContent = `${state.sensors.s3Count} pièces`;
    }
    if (state.sensors.s3PulseTimer <= 0) {
      if (s2Led) {
        s2Led.setAttribute('fill', '#ca8a04');
        s2Led.removeAttribute('filter');
      }
    }
  } else {
    if (s3Dash) {
      s3Dash.className = 'sensor-badge';
      s3Dash.textContent = `${state.sensors.s3Count} pièces`;
    }
  }
}

// ============================================================================
// 10. GOULOT D'ÉTRANGLEMENT & ALERTE QUALITÉ (Prompts 4, 6)
// ============================================================================

function checkBottlenecks() {
  // Un goulot d'étranglement est caractérisé par une accumulation importante dans la file (>= 3)
  const assemblySaturated = state.assemblyStation.queueCount >= 3;
  const qcSaturated = state.qcStation.queueCount >= 3;

  state.assemblyStation.isBottleneck = assemblySaturated;
  state.qcStation.isBottleneck = qcSaturated;

  // Post Assemblage : Badge et Halo
  const assHalo = document.getElementById('assembly-bottleneck-halo');
  const assBadge = document.getElementById('assembly-bottleneck-badge');
  if (assHalo) assHalo.setAttribute('opacity', assemblySaturated ? '1' : '0');
  if (assBadge) assBadge.setAttribute('opacity', assemblySaturated ? '1' : '0');

  // Poste QC : Badge et Halo
  const qcHalo = document.getElementById('qc-bottleneck-halo');
  const qcBadge = document.getElementById('qc-bottleneck-badge');
  if (qcHalo) qcHalo.setAttribute('opacity', qcSaturated ? '1' : '0');
  if (qcBadge) qcBadge.setAttribute('opacity', qcSaturated ? '1' : '0');

  // Barre d'état supérieure
  const barBottleneck = document.getElementById('bottleneck-indicator-bar');
  if (barBottleneck) {
    barBottleneck.style.display = assemblySaturated || qcSaturated ? 'inline' : 'none';
  }

  // Panneau récapitulatif
  const panelBox = document.getElementById('bottleneck-panel-box');
  const panelIcon = document.getElementById('bottleneck-icon');
  const panelDetail = document.getElementById('bottleneck-detail');
  const panelTip = document.getElementById('bottleneck-tip');

  if (assemblySaturated) {
    panelBox.className = 'bottleneck-box';
    panelIcon.textContent = '⚠️';
    panelDetail.textContent = 'Goulot détecté : Poste 01 Assemblage saturé (accumulation de kits).';
    panelTip.textContent = 'Action : Réduire la cadence de kits ou accélérer l\'assemblage.';
  } else if (qcSaturated) {
    panelBox.className = 'bottleneck-box';
    panelIcon.textContent = '⚠️';
    panelDetail.textContent = 'Goulot détecté : Poste 02 Contrôle Qualité saturé.';
    panelTip.textContent = 'Action : Réduire le temps de scan optique.';
  } else {
    panelBox.className = 'bottleneck-box nominal';
    panelIcon.textContent = '✓';
    panelDetail.textContent = 'Ligne équilibrée : Aucun goulot d\'étranglement détecté.';
    panelTip.textContent = 'Flux nominal';
  }
}

let qualityAlertDismissed = false;

function checkQualityAlert() {
  const totalTested = state.qcStation.totalTested;
  if (totalTested < 5 || qualityAlertDismissed) return;

  const rate = (state.qcStation.failCount / totalTested) * 100;
  const alertBar = document.getElementById('quality-alert-bar');
  const rateText = document.getElementById('alert-defect-rate');

  if (rate > 30) {
    if (alertBar) alertBar.classList.add('active');
    if (rateText) rateText.textContent = `${rate.toFixed(1)}%`;
    audio.playAlarm();
  } else {
    if (alertBar) alertBar.classList.remove('active');
  }
}

// ============================================================================
// 11. MODE DÉFI : OBJECTIF 100 CONFORMES EN < 10 MIN (Prompt 5)
// ============================================================================

function updateChallenge(dt) {
  const ch = state.challenge;
  if (!ch.active || ch.completed || ch.mode === 'free') return;

  ch.timeRemaining -= dt;

  if (ch.timeRemaining <= 0) {
    ch.timeRemaining = 0;
    finishChallenge(false);
    return;
  }

  // Condition de victoire
  if (state.stats.passed >= ch.targetCount) {
    finishChallenge(true);
  }
}

function finishChallenge(isVictory) {
  const ch = state.challenge;
  ch.completed = true;
  ch.victory = isVictory;

  const modal = document.getElementById('challenge-modal');
  const card = document.getElementById('challenge-modal-card');
  const iconTrophy = document.getElementById('modal-icon-trophy');
  const iconDefeat = document.getElementById('modal-icon-defeat');
  const title = document.getElementById('modal-title-text');
  const desc = document.getElementById('modal-desc-text');
  const statTime = document.getElementById('modal-stat-time');
  const statPass = document.getElementById('modal-stat-pass');
  const statRate = document.getElementById('modal-stat-rate');

  const elapsedSec = ch.targetSeconds - ch.timeRemaining;
  const m = Math.floor(elapsedSec / 60);
  const s = Math.floor(elapsedSec % 60);
  const timeFormatted = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  if (isVictory) {
    card.className = 'modal-card';
    iconTrophy.style.display = 'block';
    iconDefeat.style.display = 'none';
    title.textContent = 'Défi Réussi avec Brio !';
    desc.textContent = `Félicitations ! Vous avez atteint l'objectif de ${ch.targetCount} drones conformes en seulement ${timeFormatted}. La ligne industrielle est parfaitement optimisée !`;
    audio.playVictory();
  } else {
    card.className = 'modal-card defeat';
    iconTrophy.style.display = 'none';
    iconDefeat.style.display = 'block';
    title.textContent = 'Temps Écoulé !';
    desc.textContent = `Le chronomètre est arrivé à zéro avant d'atteindre ${ch.targetCount} drones conformes (${state.stats.passed}/${ch.targetCount}). Optimisez vos vitesses et réduisez le taux de défaut pour retenter votre chance !`;
    audio.playFail();
  }

  statTime.textContent = timeFormatted;
  statPass.textContent = state.stats.passed;
  statRate.textContent = `${state.stats.actualDefectRate.toFixed(1)}%`;

  modal.classList.add('open');
}

function resetChallenge(modeKey) {
  const ch = state.challenge;
  ch.mode = modeKey || ch.mode;
  ch.completed = false;
  ch.victory = false;

  if (ch.mode === '100') {
    ch.targetCount = 100;
    ch.targetSeconds = 600;
    ch.timeRemaining = 600;
  } else if (ch.mode === '50') {
    ch.targetCount = 50;
    ch.targetSeconds = 300;
    ch.timeRemaining = 300;
  } else if (ch.mode === '20') {
    ch.targetCount = 20;
    ch.targetSeconds = 120;
    ch.timeRemaining = 120;
  } else {
    ch.mode = 'free';
    ch.targetCount = 100;
    ch.targetSeconds = 99999;
    ch.timeRemaining = 99999;
  }

  // Mise à jour de l'en-tête de défi
  const targetCountEl = document.getElementById('challenge-target-count');
  const targetMaxEl = document.getElementById('challenge-target-max');
  const targetTimeEl = document.getElementById('challenge-target-time');
  const modeLabel = document.getElementById('challenge-mode-label');

  if (targetCountEl) targetCountEl.textContent = ch.targetCount;
  if (targetMaxEl) targetMaxEl.textContent = ch.targetCount;
  if (targetTimeEl) {
    const tm = Math.floor(ch.targetSeconds / 60);
    const ts = Math.floor(ch.targetSeconds % 60);
    targetTimeEl.textContent = ch.mode === 'free' ? 'Illimité' : `${tm}:${String(ts).padStart(2, '0')}`;
  }
  if (modeLabel) {
    modeLabel.textContent = ch.mode === 'free' ? 'Mode Libre' : `Défi ${ch.targetCount} Drones`;
  }

  document.getElementById('challenge-modal').classList.remove('open');
}

// ============================================================================
// 12. AFFICHAGE DES DRONES DANS LE STOCK & REJETS
// ============================================================================

function updateStockDisplay(containerId, count, color) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const maxVisible = 24;
  const numIcons = Math.min(count, maxVisible);
  let html = '';

  const isPass = containerId.includes('pass');
  const baseY = isPass ? 135 : 390;

  for (let i = 0; i < numIcons; i++) {
    const col = i % 8;
    const row = Math.floor(i / 8);
    const x = 1390 + col * 20;
    const y = baseY + row * 24;

    html += `
      <g transform="translate(${x}, ${y}) scale(0.35)">
        <ellipse cx="0" cy="0" rx="14" ry="10" fill="#0f172a" stroke="${color}" stroke-width="2" />
        <line x1="-15" y1="-15" x2="15" y2="15" stroke="${color}" stroke-width="3" />
        <line x1="15" y1="-15" x2="-15" y2="15" stroke="${color}" stroke-width="3" />
        <circle cx="0" cy="0" r="4" fill="${color}" />
      </g>
    `;
  }

  container.innerHTML = html;
}

function triggerStockPulse(targetId, glowColor) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.textContent = targetId.includes('pass') ? state.stats.passed : state.stats.failed;
  el.style.transform = 'scale(1.25)';
  el.style.transition = 'transform 0.15s ease';
  setTimeout(() => {
    el.style.transform = 'scale(1)';
  }, 160);
}

// ============================================================================
// 13. ANIMATION DES ROULEAUX DU CONVOYEUR EN SVG
// ============================================================================

function setupConveyorRollers() {
  const g1 = document.getElementById('rollers-conv-1');
  const g2 = document.getElementById('rollers-conv-2');

  if (g1) {
    let html1 = '';
    for (let x = 180; x <= 470; x += 28) {
      html1 += `<circle class="roller-c" cx="${x}" cy="276" r="10" fill="#1e293b" stroke="#475569" stroke-width="1.5" />
                <line class="roller-spoke" x1="${x - 7}" y1="276" x2="${x + 7}" y2="276" stroke="#94a3b8" stroke-width="2" />`;
    }
    g1.innerHTML = html1;
  }

  if (g2) {
    let html2 = '';
    for (let x = 750; x <= 950; x += 28) {
      html2 += `<circle class="roller-c" cx="${x}" cy="276" r="10" fill="#1e293b" stroke="#475569" stroke-width="1.5" />
                <line class="roller-spoke" x1="${x - 7}" y1="276" x2="${x + 7}" y2="276" stroke="#94a3b8" stroke-width="2" />`;
    }
    g2.innerHTML = html2;
  }
}

function animateConveyorRollers(timestamp) {
  const angle = (timestamp * (state.params.conveyorSpeed / 100)) % 360;
  const spokes = document.querySelectorAll('.roller-spoke');
  spokes.forEach((spoke) => {
    const cx = spoke.previousElementSibling ? spoke.previousElementSibling.getAttribute('cx') : 0;
    spoke.setAttribute('transform', `rotate(${angle}, ${cx}, 276)`);
  });
}

// ============================================================================
// 14. MISE À JOUR DU TABLEAU DE BORD (DASHBOARD & KPI)
// ============================================================================

function updateUi() {
  // KPIs principaux
  document.getElementById('kpi-total').textContent = state.stats.totalInjected;
  document.getElementById('kpi-assembled').textContent = state.stats.assembled;
  document.getElementById('kpi-pass').textContent = state.stats.passed;
  document.getElementById('kpi-fail').textContent = state.stats.failed;

  // Taux de conformité & rejet
  const tested = state.qcStation.totalTested;
  const passRate = tested > 0 ? ((state.stats.passed / tested) * 100).toFixed(1) : '100.0';
  const failRate = tested > 0 ? ((state.stats.failed / tested) * 100).toFixed(1) : '0.0';

  document.getElementById('kpi-pass-rate').textContent = `${passRate}%`;
  document.getElementById('kpi-fail-rate').textContent = `${failRate}%`;

  // Cadence instantanée ppm (pièces par minute)
  const now = state.totalElapsed;
  const recent = state.stats.recentDepartures.filter((t) => now - t <= 60);
  const ppm = recent.length.toFixed(1);
  document.getElementById('kpi-ppm').textContent = ppm;
  document.getElementById('bar-flow-rate').textContent = `${ppm} drone/min`;

  // Rendement synthétique (OEE)
  const yieldVal = tested > 0 ? Math.max(0, 100 - parseFloat(failRate)).toFixed(1) : '100.0';
  document.getElementById('kpi-yield').textContent = `${yieldVal}%`;
  const kpiOeeEl = document.getElementById('kpi-oee');
  if (kpiOeeEl) kpiOeeEl.textContent = `${yieldVal}%`;

  // Temps écoulé
  const m = Math.floor(state.totalElapsed / 60);
  const s = Math.floor(state.totalElapsed % 60);
  document.getElementById('kpi-elapsed').textContent = `Temps écoulé : ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  // Mode Défi UI
  const ch = state.challenge;
  if (ch.mode !== 'free') {
    const chMin = Math.floor(ch.timeRemaining / 60);
    const chSec = Math.floor(ch.timeRemaining % 60);
    const chTenth = Math.floor((ch.timeRemaining % 1) * 10);
    document.getElementById('challenge-timer-val').textContent = `${String(chMin).padStart(2, '0')}:${String(chSec).padStart(2, '0')}.${chTenth}`;

    const progressPct = Math.min(100, (state.stats.passed / ch.targetCount) * 100);
    document.getElementById('challenge-progress-fill').style.width = `${progressPct}%`;
    document.getElementById('challenge-progress-num').textContent = state.stats.passed;
    document.getElementById('challenge-percent').textContent = `${progressPct.toFixed(0)}%`;
  } else {
    document.getElementById('challenge-timer-val').textContent = '--:--';
    document.getElementById('challenge-progress-fill').style.width = '100%';
    document.getElementById('challenge-progress-num').textContent = state.stats.passed;
    document.getElementById('challenge-percent').textContent = 'LIBRE';
  }
}

// ============================================================================
// 15. INTERACTION TOOLTIP / INSPECTEUR DE DRONE
// ============================================================================

function showDroneTooltip(drone, event) {
  const tooltip = document.getElementById('drone-inspector-tooltip');
  if (!tooltip) return;

  const serialEl = document.getElementById('insp-serial');
  const typeEl = document.getElementById('insp-type');
  const timeEl = document.getElementById('insp-time');
  const qcEl = document.getElementById('insp-qc');

  serialEl.textContent = `DRONE #${drone.id} (${drone.serial})`;

  let typeText = 'Kit non assemblé';
  if (drone.state === 'ASSEMBLING') typeText = 'En cours d\'assemblage robotisé';
  else if (drone.state === 'ASSEMBLED') typeText = 'Quadricoptère X4 assemblé';
  else if (drone.state === 'SCANNING') typeText = 'En cours de scan vision 3D';
  else if (drone.state === 'INSPECTED_PASS') typeText = 'Conforme certifié prêt expédition';
  else if (drone.state === 'INSPECTED_FAIL') typeText = 'Non conforme (rejet qualité)';
  typeEl.textContent = `Statut : ${typeText}`;

  const age = (state.totalElapsed - drone.entryTime).toFixed(1);
  timeEl.textContent = `Temps sur convoyeur : ${age}s`;

  let qcText = 'En attente de scan';
  if (drone.state === 'INSPECTED_PASS') qcText = 'Contrôle : 100% CONFORME';
  else if (drone.state === 'INSPECTED_FAIL') qcText = 'Contrôle : ANOMALIE DÉTECTÉE';
  qcEl.textContent = qcText;
  qcEl.style.color = drone.state === 'INSPECTED_PASS' ? '#34d399' : (drone.state === 'INSPECTED_FAIL' ? '#f43f5e' : '#38bdf8');

  tooltip.style.display = 'block';
}

function hideDroneTooltip() {
  const tooltip = document.getElementById('drone-inspector-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

// ============================================================================
// 16. GESTION DES COMMANDES & ÉVÉNEMENTS UTILISATEUR
// ============================================================================

function initEventListeners() {
  // Start / Stop / Pause
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnPause = document.getElementById('btn-pause');
  const btnManualInject = document.getElementById('btn-manual-inject');
  const btnReset = document.getElementById('btn-reset');
  const statusDot = document.getElementById('sim-status-dot');
  const statusText = document.getElementById('sim-status-text');

  btnStart.addEventListener('click', () => {
    state.isRunning = true;
    state.isPaused = false;
    statusDot.className = 'status-dot';
    statusText.textContent = 'En production';
    audio.beep(520, 0.1);
  });

  btnStop.addEventListener('click', () => {
    state.isRunning = false;
    state.isPaused = false;
    statusDot.className = 'status-dot stopped';
    statusText.textContent = 'À l\'arrêt';
    audio.beep(260, 0.15);
  });

  btnPause.addEventListener('click', () => {
    state.isPaused = !state.isPaused;
    if (state.isPaused) {
      statusDot.className = 'status-dot paused';
      statusText.textContent = 'En pause';
      btnPause.classList.add('active');
    } else {
      statusDot.className = 'status-dot';
      statusText.textContent = 'En production';
      btnPause.classList.remove('active');
    }
  });

  btnManualInject.addEventListener('click', () => {
    requestManualInjection();
  });

  btnReset.addEventListener('click', () => {
    fullReset();
  });

  // Vitesse de simulation
  document.querySelectorAll('.speed-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('active'));
      e.target.classList.add('active');
      state.simSpeed = parseFloat(e.target.getAttribute('data-speed'));
      publishMqttTelemetry();
    });
  });

  // Sliders dynamiques (Prompt 4)
  const sliderSpeed = document.getElementById('slider-speed');
  const sliderSpawn = document.getElementById('slider-spawn');
  const sliderAssembly = document.getElementById('slider-assembly');
  const sliderQc = document.getElementById('slider-qc');
  const sliderDefect = document.getElementById('slider-defect');

  sliderSpeed.addEventListener('input', (e) => {
    state.params.conveyorSpeed = parseFloat(e.target.value);
    document.getElementById('val-speed').textContent = `${e.target.value} px/s`;
    publishMqttTelemetry();
  });

  sliderSpawn.addEventListener('input', (e) => {
    state.params.spawnInterval = parseFloat(e.target.value);
    document.getElementById('val-spawn').textContent = `${parseFloat(e.target.value).toFixed(1)} s`;
    publishMqttTelemetry();
  });

  sliderAssembly.addEventListener('input', (e) => {
    state.params.assemblyTime = parseFloat(e.target.value);
    document.getElementById('val-assembly').textContent = `${parseFloat(e.target.value).toFixed(1)} s`;
    publishMqttTelemetry();
  });

  sliderQc.addEventListener('input', (e) => {
    state.params.qcTime = parseFloat(e.target.value);
    document.getElementById('val-qc').textContent = `${parseFloat(e.target.value).toFixed(1)} s`;
    publishMqttTelemetry();
  });

  sliderDefect.addEventListener('input', (e) => {
    state.params.defectRate = parseFloat(e.target.value);
    document.getElementById('val-defect').textContent = `${e.target.value} %`;
    publishMqttTelemetry();
  });

  // Bouton Réinitialiser paramètres
  document.getElementById('btn-reset-params').addEventListener('click', () => {
    sliderSpeed.value = '80';
    sliderSpawn.value = '5.0';
    sliderAssembly.value = '3.0';
    sliderQc.value = '2.0';
    sliderDefect.value = '20';

    sliderSpeed.dispatchEvent(new Event('input'));
    sliderSpawn.dispatchEvent(new Event('input'));
    sliderAssembly.dispatchEvent(new Event('input'));
    sliderQc.dispatchEvent(new Event('input'));
    sliderDefect.dispatchEvent(new Event('input'));
  });

  // Mode Défi
  const challengeSelect = document.getElementById('challenge-select');
  challengeSelect.addEventListener('change', (e) => {
    resetChallenge(e.target.value);
    fullReset();
  });

  document.getElementById('btn-start-challenge').addEventListener('click', () => {
    resetChallenge(challengeSelect.value);
    fullReset();
  });

  document.getElementById('btn-modal-retry').addEventListener('click', () => {
    resetChallenge(challengeSelect.value);
    fullReset();
  });

  document.getElementById('btn-modal-close').addEventListener('click', () => {
    document.getElementById('challenge-modal').classList.remove('open');
  });

  // Acquitter Alerte Qualité (Prompt 6)
  document.getElementById('btn-dismiss-alert').addEventListener('click', () => {
    qualityAlertDismissed = true;
    document.getElementById('quality-alert-bar').classList.remove('active');
  });

  // Son ON/OFF
  const btnSound = document.getElementById('btn-sound-toggle');
  const soundIcon = document.getElementById('sound-icon');
  btnSound.addEventListener('click', () => {
    audio.enabled = !audio.enabled;
    soundIcon.textContent = audio.enabled ? '🔊 Son ACTIF' : '🔇 Son COUPÉ';
    btnSound.classList.toggle('active', audio.enabled);
  });
}

function fullReset() {
  // Supprime tous les drones
  state.drones.forEach((d) => d.destroy());
  state.drones = [];

  state.spawnTimer = 0;
  state.totalElapsed = 0;
  state.nextDroneId = 101;
  state.pendingInjectCount = 0;

  state.assemblyStation.state = 'IDLE';
  state.assemblyStation.drone = null;
  state.assemblyStation.timer = 0;
  state.assemblyStation.totalDone = 0;
  state.assemblyStation.queueCount = 0;

  state.qcStation.state = 'IDLE';
  state.qcStation.drone = null;
  state.qcStation.timer = 0;
  state.qcStation.totalTested = 0;
  state.qcStation.passCount = 0;
  state.qcStation.failCount = 0;
  state.qcStation.queueCount = 0;

  state.sensors.s1Presence = false;
  state.sensors.s2Scan = false;
  state.sensors.s3Count = 0;
  state.sensors.s3PulseTimer = 0;

  state.stats.totalInjected = 0;
  state.stats.assembled = 0;
  state.stats.passed = 0;
  state.stats.failed = 0;
  state.stats.actualDefectRate = 0;
  state.stats.recentDepartures = [];

  state.storedPass = 0;
  state.storedFail = 0;
  qualityAlertDismissed = false;

  // Réinitialisation de l'affichage SVG
  document.getElementById('stock-pass-count-big').textContent = '0';
  document.getElementById('stock-fail-count-big').textContent = '0';
  document.getElementById('stock-pass-items-display').innerHTML = '';
  document.getElementById('stock-fail-items-display').innerHTML = '';
  document.getElementById('qc-pass-count-svg').textContent = '0';
  document.getElementById('qc-fail-count-svg').textContent = '0';
  document.getElementById('qc-rate-svg').textContent = '0.0%';
  document.getElementById('assembly-done-count').textContent = '0';
  document.getElementById('assembly-queue-count').textContent = '0';

  resetRobotArm();
  resetQcLaser();
  setAssemblyUiState('EN ATTENTE', '#94a3b8', false);
  setQcUiState('EN VEILLE', '#7dd3fc', false);

  updateUi();
}

// ============================================================================
// 17. PASSERELLE MQTT & INTÉGRATION NODE-RED
// ============================================================================

function initMqttGateway() {
  const btnOpenMqtt = document.getElementById('btn-open-mqtt');
  const btnCloseMqtt = document.getElementById('btn-close-mqtt-modal');
  const mqttModal = document.getElementById('mqtt-modal');
  const btnConnect = document.getElementById('btn-mqtt-connect');
  const btnDisconnect = document.getElementById('btn-mqtt-disconnect');
  const btnClearLog = document.getElementById('btn-clear-mqtt-log');
  const btnCopyFlow = document.getElementById('btn-copy-flow-json');
  const btnGuideCopyFlow = document.getElementById('btn-guide-copy-flow');
  const btnOpenGuide = document.getElementById('btn-guide-nodered');
  const btnCloseGuide = document.getElementById('btn-close-guide-modal');
  const guideModal = document.getElementById('guide-modal');

  // Affichage du modal MQTT
  if (btnOpenMqtt && mqttModal) {
    btnOpenMqtt.addEventListener('click', () => {
      mqttModal.classList.add('open');
      renderNodeRedFlowJson();
    });
  }
  if (btnCloseMqtt && mqttModal) {
    btnCloseMqtt.addEventListener('click', () => mqttModal.classList.remove('open'));
  }

  // Affichage du modal Guide Node-RED
  if (btnOpenGuide && guideModal) {
    btnOpenGuide.addEventListener('click', () => guideModal.classList.add('open'));
  }
  if (btnCloseGuide && guideModal) {
    btnCloseGuide.addEventListener('click', () => guideModal.classList.remove('open'));
  }

  // Onglets dans le modal MQTT
  document.querySelectorAll('.mqtt-tab-btn').forEach((tabBtn) => {
    tabBtn.addEventListener('click', (e) => {
      document.querySelectorAll('.mqtt-tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.mqtt-tab-content').forEach((c) => (c.style.display = 'none'));
      e.target.classList.add('active');
      const targetId = `tab-${e.target.getAttribute('data-tab')}`;
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.style.display = 'block';
    });
  });

  // Presets de serveurs MQTT
  document.querySelectorAll('.preset-broker').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const url = e.target.getAttribute('data-url');
      const input = document.getElementById('mqtt-broker-url');
      if (input) {
        input.value = url;
        state.mqtt.brokerUrl = url;
        renderNodeRedFlowJson();
      }
    });
  });

  // Bouton Connexion / Déconnexion
  if (btnConnect) {
    btnConnect.addEventListener('click', () => connectMqtt());
  }
  if (btnDisconnect) {
    btnDisconnect.addEventListener('click', () => disconnectMqtt());
  }

  // Nettoyer journal
  if (btnClearLog) {
    btnClearLog.addEventListener('click', () => {
      const stream = document.getElementById('mqtt-packet-stream');
      if (stream) stream.innerHTML = '';
    });
  }

  // Copier le Flow JSON Node-RED
  const handleCopyFlow = (btnEl) => {
    const jsonStr = generateNodeRedFlowJson();
    navigator.clipboard.writeText(jsonStr).then(() => {
      const oldText = btnEl.textContent;
      btnEl.textContent = '✓ Flow Copié dans le Presse-Papier !';
      btnEl.style.background = '#10b981';
      btnEl.style.color = '#000';
      setTimeout(() => {
        btnEl.textContent = oldText;
        btnEl.removeAttribute('style');
      }, 2500);
    }).catch(() => {
      alert('Impossible d\'accéder au presse-papier. Sélectionnez le texte ci-dessous et faites Ctrl+C.');
    });
  };

  if (btnCopyFlow) {
    btnCopyFlow.addEventListener('click', () => handleCopyFlow(btnCopyFlow));
  }
  if (btnGuideCopyFlow) {
    btnGuideCopyFlow.addEventListener('click', () => handleCopyFlow(btnGuideCopyFlow));
  }

  // Rendu initial du code JSON
  renderNodeRedFlowJson();
}

function updateMqttUiBadge(statusText, statusClass) {
  const badgeHeader = document.getElementById('btn-open-mqtt');
  const dotHeader = document.getElementById('mqtt-dot');
  const labelHeader = document.getElementById('mqtt-status-label');
  const badgeModal = document.getElementById('mqtt-modal-status-badge');
  const btnConnect = document.getElementById('btn-mqtt-connect');
  const btnDisconnect = document.getElementById('btn-mqtt-disconnect');

  if (badgeHeader) badgeHeader.className = `mqtt-badge-indicator ${statusClass}`;
  if (badgeModal) badgeModal.className = `mqtt-badge-indicator ${statusClass}`;
  if (labelHeader) labelHeader.textContent = statusText;
  if (badgeModal) badgeModal.textContent = statusText.toUpperCase();

  if (dotHeader) {
    dotHeader.textContent = '●';
    dotHeader.style.color = statusClass === 'connected' ? '#10b981' : (statusClass === 'connecting' ? '#f59e0b' : '#f43f5e');
  }

  if (btnConnect && btnDisconnect) {
    if (statusClass === 'connected') {
      btnConnect.style.display = 'none';
      btnDisconnect.style.display = 'inline-flex';
    } else {
      btnConnect.style.display = 'inline-flex';
      btnDisconnect.style.display = 'none';
    }
  }
}

function logMqttPacket(direction, topic, payload) {
  const stream = document.getElementById('mqtt-packet-stream');
  if (!stream) return;

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

  const line = document.createElement('div');
  line.className = 'mqtt-packet-line';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'mqtt-packet-time';
  timeSpan.textContent = timeStr;

  const dirSpan = document.createElement('span');
  dirSpan.className = `mqtt-packet-dir ${direction.toLowerCase()}`;
  dirSpan.textContent = direction.toUpperCase();

  const topicSpan = document.createElement('span');
  topicSpan.className = 'mqtt-packet-topic';
  topicSpan.textContent = topic;

  const payloadSpan = document.createElement('span');
  payloadSpan.className = 'mqtt-packet-payload';
  const displayPayload = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
  payloadSpan.textContent = displayPayload.length > 100 ? displayPayload.substring(0, 100) + '...' : displayPayload;

  line.appendChild(timeSpan);
  line.appendChild(dirSpan);
  line.appendChild(topicSpan);
  line.appendChild(payloadSpan);

  stream.insertBefore(line, stream.firstChild);

  // Limite à 50 entrées dans le journal
  while (stream.children.length > 50) {
    stream.removeChild(stream.lastChild);
  }
}

function connectMqtt() {
  const urlInput = document.getElementById('mqtt-broker-url');
  const prefixInput = document.getElementById('mqtt-topic-prefix');
  const clientInput = document.getElementById('mqtt-client-id');
  const rateInput = document.getElementById('mqtt-publish-rate');

  state.mqtt.brokerUrl = urlInput ? urlInput.value.trim() : 'ws://localhost:9001';
  state.mqtt.topicPrefix = prefixInput ? prefixInput.value.trim().replace(/\/$/, '') : 'factory/dronesim';
  state.mqtt.clientId = clientInput ? clientInput.value.trim() : `dronesim_${Math.random().toString(16).substring(2, 8)}`;
  state.mqtt.publishRateMs = rateInput ? parseInt(rateInput.value, 10) : 1000;

  disconnectMqtt();

  updateMqttUiBadge('Connexion...', 'connecting');
  state.mqtt.connecting = true;

  // Détection de sécurité navigateur (Mixed Content)
  if (window.location.protocol === 'https:' && state.mqtt.brokerUrl.startsWith('ws://')) {
    logMqttPacket('AVERTISSEMENT', 'sécurité-navigateur', 'Cette page est en HTTPS. Le navigateur bloque ws://localhost (Mixed Content). Lancez l\'app sur http://localhost:3000 ou utilisez wss:// (SSL).');
  }

  try {
    const client = mqtt.connect(state.mqtt.brokerUrl, {
      clientId: state.mqtt.clientId,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 8000,
    });

    state.mqtt.client = client;

    client.on('connect', () => {
      state.mqtt.connected = true;
      state.mqtt.connecting = false;
      updateMqttUiBadge('MQTT: Connecté', 'connected');
      logMqttPacket('SYS', 'mqtt/status', `Connecté au broker : ${state.mqtt.brokerUrl}`);

      // Souscription aux commandes en provenance de Node-RED
      const cmdTopic = `${state.mqtt.topicPrefix}/cmd/#`;
      client.subscribe(cmdTopic, (err) => {
        if (!err) {
          logMqttPacket('SUB', cmdTopic, 'Écoute des commandes Node-RED active');
        }
      });

      // Lancement du cycle d'émission périodique
      if (state.mqtt.publishTimer) clearInterval(state.mqtt.publishTimer);
      state.mqtt.publishTimer = setInterval(() => {
        publishMqttTelemetry();
      }, state.mqtt.publishRateMs);

      // Première publication immédiate
      publishMqttTelemetry();
    });

    client.on('message', (topic, message) => {
      const msgStr = message.toString();
      state.mqtt.rxCount++;
      const rxEl = document.getElementById('mqtt-rx-count');
      if (rxEl) rxEl.textContent = state.mqtt.rxCount;

      logMqttPacket('RX', topic, msgStr);
      handleMqttCommand(topic, msgStr);
    });

    client.on('error', (err) => {
      logMqttPacket('ERR', 'mqtt/error', err.message || 'Erreur réseau MQTT');
      updateMqttUiBadge('Erreur MQTT', 'disconnected');
    });

    client.on('close', () => {
      if (state.mqtt.connected) {
        logMqttPacket('SYS', 'mqtt/status', 'Connexion fermée');
        state.mqtt.connected = false;
        updateMqttUiBadge('MQTT Déconnecté', 'disconnected');
      }
    });

    client.on('offline', () => {
      updateMqttUiBadge('MQTT Hors Ligne', 'connecting');
    });
  } catch (err) {
    logMqttPacket('ERR', 'mqtt/exception', err.message);
    updateMqttUiBadge('Erreur Init', 'disconnected');
  }
}

function disconnectMqtt() {
  if (state.mqtt.publishTimer) {
    clearInterval(state.mqtt.publishTimer);
    state.mqtt.publishTimer = null;
  }

  if (state.mqtt.client) {
    try {
      state.mqtt.client.end(true);
    } catch (_) {}
    state.mqtt.client = null;
  }

  state.mqtt.connected = false;
  state.mqtt.connecting = false;
  updateMqttUiBadge('MQTT Déconnecté', 'disconnected');
}

function publishMqttTelemetry() {
  if (!state.mqtt.client || !state.mqtt.connected) return;

  const prefix = state.mqtt.topicPrefix;
  const now = state.totalElapsed;
  const recent = state.stats.recentDepartures.filter((t) => now - t <= 60);
  const ppm = parseFloat(recent.length.toFixed(1));
  const tested = state.qcStation.totalTested;
  const passRate = tested > 0 ? parseFloat(((state.stats.passed / tested) * 100).toFixed(1)) : 100.0;
  const failRate = parseFloat(state.stats.actualDefectRate.toFixed(1));
  const statusStr = state.isRunning ? (state.isPaused ? 'PAUSED' : 'RUNNING') : 'STOPPED';

  const telemetryPayload = {
    timestamp: Date.now(),
    simTimeSec: Math.floor(state.totalElapsed),
    status: statusStr,
    totalInjected: state.stats.totalInjected,
    assembled: state.stats.assembled,
    passed: state.stats.passed,
    failed: state.stats.failed,
    passRate: passRate,
    defectRate: failRate,
    ppm: ppm,
    oeeYield: Math.max(0, 100 - failRate),
    assemblyQueue: state.assemblyStation.queueCount,
    qcQueue: state.qcStation.queueCount,
    bottleneck: state.assemblyStation.isBottleneck || state.qcStation.isBottleneck,
    qualityAlert: tested >= 5 && failRate > 30,
    sensors: {
      s1_presence: state.sensors.s1Presence ? 1 : 0,
      s2_scanning: state.qcStation.state === 'SCANNING' ? 1 : 0,
      s3_counter: state.sensors.s3Count,
    },
    params: {
      speed: state.params.conveyorSpeed,
      spawnInterval: state.params.spawnInterval,
      assemblyTime: state.params.assemblyTime,
      qcTime: state.params.qcTime,
      defectTarget: state.params.defectRate,
    },
  };

  // 1. Publication globale JSON complète pour Node-RED Function / Dashboard
  safePublish(`${prefix}/telemetry`, JSON.stringify(telemetryPayload));

  // 2. Publications discrètes pour liaison directe sans parser en Node-RED (Gauges, Charts, Textes)
  safePublish(`${prefix}/stats/total`, String(state.stats.totalInjected));
  safePublish(`${prefix}/stats/assembled`, String(state.stats.assembled));
  safePublish(`${prefix}/stats/passed`, String(state.stats.passed));
  safePublish(`${prefix}/stats/failed`, String(state.stats.failed));
  safePublish(`${prefix}/stats/defect_rate`, String(failRate));
  safePublish(`${prefix}/stats/pass_rate`, String(passRate));
  safePublish(`${prefix}/stats/ppm`, String(ppm));
  const oeeVal = tested > 0 ? parseFloat(Math.max(0, 100 - failRate).toFixed(1)) : 100.0;
  safePublish(`${prefix}/stats/oee`, String(oeeVal));
  safePublish(`${prefix}/stats/status`, statusStr);
  safePublish(`${prefix}/stats/bottleneck`, String(telemetryPayload.bottleneck));
  safePublish(`${prefix}/stats/alarm`, String(telemetryPayload.qualityAlert));

  // Paramètres initiaux et en temps réel pour synchroniser les sliders Node-RED
  safePublish(`${prefix}/params/speed`, String(state.params.conveyorSpeed), true);
  safePublish(`${prefix}/params/assembly_time`, String(state.params.assemblyTime), true);
  safePublish(`${prefix}/params/qc_time`, String(state.params.qcTime), true);
  safePublish(`${prefix}/params/sim_speed`, String(state.simSpeed), true);

  // Capteurs unitaires
  safePublish(`${prefix}/sensors/s1`, String(telemetryPayload.sensors.s1_presence));
  safePublish(`${prefix}/sensors/s2`, String(telemetryPayload.sensors.s2_scanning));
  safePublish(`${prefix}/sensors/s3`, String(telemetryPayload.sensors.s3_counter));

  state.mqtt.txCount += 19;
  const txEl = document.getElementById('mqtt-tx-count');
  if (txEl) txEl.textContent = state.mqtt.txCount;

  logMqttPacket('TX', `${prefix}/telemetry`, `Passé:${state.stats.passed} Rejets:${state.stats.failed} Défaut:${failRate}% PPM:${ppm} OEE:${oeeVal}%`);
}

function safePublish(topic, payload, retain = false) {
  if (state.mqtt.client && state.mqtt.connected) {
    state.mqtt.client.publish(topic, payload, { qos: 0, retain: retain });
  }
}

function publishMqttEvent(eventType, data) {
  if (!state.mqtt.client || !state.mqtt.connected) return;
  const topic = `${state.mqtt.topicPrefix}/events/${eventType}`;
  safePublish(topic, JSON.stringify(data));
  logMqttPacket('TX_EVT', topic, data);
}

function handleMqttCommand(topic, message) {
  const parts = topic.split('/');
  const cmd = parts[parts.length - 1].toLowerCase();
  const rawVal = message.trim();

  switch (cmd) {
    case 'start':
      state.isRunning = true;
      state.isPaused = false;
      document.getElementById('sim-status-dot').className = 'status-dot';
      document.getElementById('sim-status-text').textContent = 'En production';
      audio.beep(520, 0.1);
      break;

    case 'stop':
      state.isRunning = false;
      state.isPaused = false;
      document.getElementById('sim-status-dot').className = 'status-dot stopped';
      document.getElementById('sim-status-text').textContent = 'À l\'arrêt';
      audio.beep(260, 0.15);
      break;

    case 'pause':
      state.isPaused = !state.isPaused;
      document.getElementById('sim-status-dot').className = state.isPaused ? 'status-dot paused' : 'status-dot';
      document.getElementById('sim-status-text').textContent = state.isPaused ? 'En pause' : 'En production';
      break;

    case 'inject':
      requestManualInjection();
      break;

    case 'reset':
      fullReset();
      break;

    case 'speed':
    case 'set_speed': {
      const val = parseFloat(rawVal);
      if (!isNaN(val) && val >= 30 && val <= 220) {
        state.params.conveyorSpeed = val;
        const slider = document.getElementById('slider-speed');
        if (slider) slider.value = val;
        document.getElementById('val-speed').textContent = `${val} px/s`;
      }
      break;
    }

    case 'defect_rate':
    case 'set_defect_rate': {
      const val = parseFloat(rawVal);
      if (!isNaN(val) && val >= 0 && val <= 60) {
        state.params.defectRate = val;
        const slider = document.getElementById('slider-defect');
        if (slider) slider.value = val;
        document.getElementById('val-defect').textContent = `${val} %`;
      }
      break;
    }

    case 'spawn_interval':
    case 'set_spawn_rate': {
      const val = parseFloat(rawVal);
      if (!isNaN(val) && val >= 1.0 && val <= 10.0) {
        state.params.spawnInterval = val;
        const slider = document.getElementById('slider-spawn');
        if (slider) slider.value = val;
        document.getElementById('val-spawn').textContent = `${val.toFixed(1)} s`;
      }
      break;
    }

    case 'assembly_time':
    case 'set_assembly_time': {
      const val = parseFloat(rawVal);
      if (!isNaN(val) && val >= 1.0 && val <= 8.0) {
        state.params.assemblyTime = val;
        const slider = document.getElementById('slider-assembly');
        if (slider) slider.value = val;
        document.getElementById('val-assembly').textContent = `${val.toFixed(1)} s`;
      }
      break;
    }

    case 'qc_time':
    case 'set_qc_time': {
      const val = parseFloat(rawVal);
      if (!isNaN(val) && val >= 0.5 && val <= 6.0) {
        state.params.qcTime = val;
        const slider = document.getElementById('slider-qc');
        if (slider) slider.value = val;
        document.getElementById('val-qc').textContent = `${val.toFixed(1)} s`;
      }
      break;
    }

    case 'sim_speed':
    case 'set_sim_speed': {
      const val = parseFloat(rawVal);
      if (val === 1 || val === 2 || val === 5) {
        state.simSpeed = val;
        document.querySelectorAll('.speed-btn').forEach((btn) => {
          btn.classList.toggle('active', parseFloat(btn.getAttribute('data-speed')) === val);
        });
      }
      break;
    }
  }

  // Publication immédiate du nouvel état en retour
  setTimeout(() => publishMqttTelemetry(), 50);
}

// ============================================================================
// 18. GÉNÉRATEUR DE FLOW NODE-RED (Dashboard JSON officiel)
// ============================================================================

function generateNodeRedFlowJson() {
  const prefix = (state.mqtt.topicPrefix || 'factory/dronesim').replace(/\/$/, '');

  // Configuration de l'hôte MQTT pour le serveur Node-RED (TCP port 1883 en local)
  let brokerHost = '127.0.0.1';
  let brokerPort = '1883';

  const flow = [
    // Onglet principal dans l'espace de travail Node-RED
    {
      id: 'flow_dronesim',
      type: 'tab',
      label: 'Ligne Usine Drones',
      disabled: false,
      info: 'Supervision industrielle SCADA DroneSim avec dashboard et MQTT',
    },

    // Configuration UI Tab Dashboard
    {
      id: 'tab_dronesim',
      type: 'ui_tab',
      name: 'Usine Drone-X4',
      icon: 'dashboard',
      order: 1,
    },
    // Configuration UI Groups Dashboard
    {
      id: 'grp_cmds',
      type: 'ui_group',
      name: 'Commandes Ligne',
      tab: 'tab_dronesim',
      order: 1,
      disp: true,
      width: '6',
      collapse: false,
    },
    {
      id: 'grp_prod',
      type: 'ui_group',
      name: 'Indicateurs Production',
      tab: 'tab_dronesim',
      order: 2,
      disp: true,
      width: '6',
      collapse: false,
    },
    {
      id: 'grp_qc',
      type: 'ui_group',
      name: 'Qualité, OEE & Cadence',
      tab: 'tab_dronesim',
      order: 3,
      disp: true,
      width: '6',
      collapse: false,
    },
    {
      id: 'grp_sensors',
      type: 'ui_group',
      name: 'Capteurs & Diagnostic',
      tab: 'tab_dronesim',
      order: 4,
      disp: true,
      width: '6',
      collapse: false,
    },
    // Configuration MQTT Broker Node
    {
      id: 'mqtt_broker_config',
      type: 'mqtt-broker',
      name: `Broker ${brokerHost}`,
      broker: brokerHost,
      port: brokerPort,
      clientid: 'nodered_dronesim_client',
      usetls: false,
      compatmode: false,
      keepalive: '60',
      cleansession: true,
    },

    // ========================================================================
    // ZONE 1 : COMMANDES LIGNE & SIMULATION (X: 120 -> 270 -> 440)
    // ========================================================================
    // Bouton DÉMARRER
    {
      id: 'btn_nr_start',
      type: 'ui_button',
      z: 'flow_dronesim',
      name: 'Démarrer Ligne',
      group: 'grp_cmds',
      order: 1,
      width: '3',
      height: '1',
      passthru: false,
      label: 'DÉMARRER',
      tooltip: 'Lancer le convoyeur et la production',
      color: '#ffffff',
      bgcolor: '#10b981',
      payload: '',
      payloadType: 'date',
      topic: `${prefix}/cmd/start`,
      x: 120,
      y: 80,
      wires: [['mqtt_out_start']],
    },
    {
      id: 'mqtt_out_start',
      type: 'mqtt out',
      z: 'flow_dronesim',
      name: 'MQTT Start',
      topic: `${prefix}/cmd/start`,
      qos: '0',
      retain: 'false',
      broker: 'mqtt_broker_config',
      x: 440,
      y: 80,
      wires: [],
    },

    // Bouton ARRÊTER
    {
      id: 'btn_nr_stop',
      type: 'ui_button',
      z: 'flow_dronesim',
      name: 'Arrêter Ligne',
      group: 'grp_cmds',
      order: 2,
      width: '3',
      height: '1',
      passthru: false,
      label: 'ARRÊTER',
      tooltip: 'Arrêt immédiat de la ligne',
      color: '#ffffff',
      bgcolor: '#f43f5e',
      payload: '',
      payloadType: 'date',
      topic: `${prefix}/cmd/stop`,
      x: 120,
      y: 140,
      wires: [['mqtt_out_stop']],
    },
    {
      id: 'mqtt_out_stop',
      type: 'mqtt out',
      z: 'flow_dronesim',
      name: 'MQTT Stop',
      topic: `${prefix}/cmd/stop`,
      qos: '0',
      retain: 'false',
      broker: 'mqtt_broker_config',
      x: 440,
      y: 140,
      wires: [],
    },

    // Bouton INJECTER KIT (Support multi-clic avec horodatage unique)
    {
      id: 'btn_nr_inject',
      type: 'ui_button',
      z: 'flow_dronesim',
      name: 'Injecter Kit',
      group: 'grp_cmds',
      order: 3,
      width: '3',
      height: '1',
      passthru: false,
      label: '+ KIT MANUEL',
      color: '#ffffff',
      bgcolor: '#06b6d4',
      payload: 'inject',
      payloadType: 'str',
      topic: `${prefix}/cmd/inject`,
      x: 120,
      y: 200,
      wires: [['fn_inject_ts']],
    },
    {
      id: 'fn_inject_ts',
      type: 'function',
      z: 'flow_dronesim',
      name: 'Horodatage Unique',
      func: "msg.payload = String(Date.now());\nreturn msg;",
      outputs: 1,
      x: 270,
      y: 200,
      wires: [['mqtt_out_inject']],
    },
    {
      id: 'mqtt_out_inject',
      type: 'mqtt out',
      z: 'flow_dronesim',
      name: 'MQTT Inject',
      topic: `${prefix}/cmd/inject`,
      qos: '0',
      retain: 'false',
      broker: 'mqtt_broker_config',
      x: 440,
      y: 200,
      wires: [],
    },

    // Bouton RÉINITIALISER
    {
      id: 'btn_nr_reset',
      type: 'ui_button',
      z: 'flow_dronesim',
      name: 'Reset Ligne',
      group: 'grp_cmds',
      order: 4,
      width: '3',
      height: '1',
      passthru: false,
      label: 'RÉINITIALISER',
      color: '#ffffff',
      bgcolor: '#475569',
      payload: '',
      payloadType: 'date',
      topic: `${prefix}/cmd/reset`,
      x: 120,
      y: 260,
      wires: [['mqtt_out_reset']],
    },
    {
      id: 'mqtt_out_reset',
      type: 'mqtt out',
      z: 'flow_dronesim',
      name: 'MQTT Reset',
      topic: `${prefix}/cmd/reset`,
      qos: '0',
      retain: 'false',
      broker: 'mqtt_broker_config',
      x: 440,
      y: 260,
      wires: [],
    },

    // Vitesse de Simulation : Boutons 1x, 2x, 5x
    {
      id: 'btn_nr_speed_1x',
      type: 'ui_button',
      z: 'flow_dronesim',
      name: 'Vitesse 1x',
      group: 'grp_cmds',
      order: 5,
      width: '2',
      height: '1',
      passthru: false,
      label: '1x',
      color: '#ffffff',
      bgcolor: '#334155',
      payload: '1',
      payloadType: 'num',
      topic: `${prefix}/cmd/sim_speed`,
      x: 120,
      y: 320,
      wires: [['mqtt_out_sim_speed']],
    },
    {
      id: 'btn_nr_speed_2x',
      type: 'ui_button',
      z: 'flow_dronesim',
      name: 'Vitesse 2x',
      group: 'grp_cmds',
      order: 6,
      width: '2',
      height: '1',
      passthru: false,
      label: '2x',
      color: '#ffffff',
      bgcolor: '#0284c7',
      payload: '2',
      payloadType: 'num',
      topic: `${prefix}/cmd/sim_speed`,
      x: 120,
      y: 360,
      wires: [['mqtt_out_sim_speed']],
    },
    {
      id: 'btn_nr_speed_5x',
      type: 'ui_button',
      z: 'flow_dronesim',
      name: 'Vitesse 5x',
      group: 'grp_cmds',
      order: 7,
      width: '2',
      height: '1',
      passthru: false,
      label: '5x',
      color: '#ffffff',
      bgcolor: '#7c3aed',
      payload: '5',
      payloadType: 'num',
      topic: `${prefix}/cmd/sim_speed`,
      x: 120,
      y: 400,
      wires: [['mqtt_out_sim_speed']],
    },
    {
      id: 'mqtt_out_sim_speed',
      type: 'mqtt out',
      z: 'flow_dronesim',
      name: 'MQTT Sim Speed',
      topic: `${prefix}/cmd/sim_speed`,
      qos: '0',
      retain: 'false',
      broker: 'mqtt_broker_config',
      x: 440,
      y: 360,
      wires: [],
    },

    // ========================================================================
    // ZONE 2 : SLIDERS DE RÉGLAGE DYNAMIQUE (X: 120 -> 280 -> 450)
    // Synchronisation bidirectionnelle : prend les valeurs initiales du site
    // ========================================================================
    // 1. Slider Vitesse Convoyeur (initialisé à 80 px/s depuis le site)
    {
      id: 'mqtt_in_param_speed',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'Param Vitesse',
      topic: `${prefix}/params/speed`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 120,
      y: 480,
      wires: [['slider_nr_speed']],
    },
    {
      id: 'slider_nr_speed',
      type: 'ui_slider',
      z: 'flow_dronesim',
      name: 'Vitesse Convoyeur',
      label: 'Vitesse Convoyeur (px/s)',
      group: 'grp_cmds',
      order: 8,
      width: '6',
      height: '1',
      passthru: false,
      outs: 'all',
      topic: `${prefix}/cmd/set_speed`,
      min: 30,
      max: 220,
      step: 5,
      x: 280,
      y: 480,
      wires: [['mqtt_out_speed']],
    },
    {
      id: 'mqtt_out_speed',
      type: 'mqtt out',
      z: 'flow_dronesim',
      name: 'MQTT Set Speed',
      topic: `${prefix}/cmd/set_speed`,
      qos: '0',
      retain: 'false',
      broker: 'mqtt_broker_config',
      x: 450,
      y: 480,
      wires: [],
    },

    // 2. Slider Délai Assemblage (initialisé à 3.0 s depuis le site)
    {
      id: 'mqtt_in_param_assembly',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'Param Assemblage',
      topic: `${prefix}/params/assembly_time`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 120,
      y: 550,
      wires: [['slider_nr_assembly']],
    },
    {
      id: 'slider_nr_assembly',
      type: 'ui_slider',
      z: 'flow_dronesim',
      name: 'Délai Assemblage',
      label: 'Délai Assemblage (s)',
      group: 'grp_cmds',
      order: 9,
      width: '6',
      height: '1',
      passthru: false,
      outs: 'all',
      topic: `${prefix}/cmd/set_assembly_time`,
      min: 1.0,
      max: 8.0,
      step: 0.5,
      x: 280,
      y: 550,
      wires: [['mqtt_out_assembly']],
    },
    {
      id: 'mqtt_out_assembly',
      type: 'mqtt out',
      z: 'flow_dronesim',
      name: 'MQTT Set Assembly',
      topic: `${prefix}/cmd/set_assembly_time`,
      qos: '0',
      retain: 'false',
      broker: 'mqtt_broker_config',
      x: 450,
      y: 550,
      wires: [],
    },

    // 3. Slider Délai Contrôle QC (initialisé à 2.0 s depuis le site)
    {
      id: 'mqtt_in_param_qc',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'Param Contrôle QC',
      topic: `${prefix}/params/qc_time`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 120,
      y: 620,
      wires: [['slider_nr_qc']],
    },
    {
      id: 'slider_nr_qc',
      type: 'ui_slider',
      z: 'flow_dronesim',
      name: 'Délai Scan QC',
      label: 'Délai Contrôle QC (s)',
      group: 'grp_cmds',
      order: 10,
      width: '6',
      height: '1',
      passthru: false,
      outs: 'all',
      topic: `${prefix}/cmd/set_qc_time`,
      min: 0.5,
      max: 6.0,
      step: 0.5,
      x: 280,
      y: 620,
      wires: [['mqtt_out_qc']],
    },
    {
      id: 'mqtt_out_qc',
      type: 'mqtt out',
      z: 'flow_dronesim',
      name: 'MQTT Set QC',
      topic: `${prefix}/cmd/set_qc_time`,
      qos: '0',
      retain: 'false',
      broker: 'mqtt_broker_config',
      x: 450,
      y: 620,
      wires: [],
    },

    // ========================================================================
    // ZONE 3 : INDICATEURS PRODUCTION (Colonnes X: 640 -> 880)
    // Affichage des compteurs numériques (unités et quantités) via ui_text
    // ========================================================================
    // Total Kits
    {
      id: 'mqtt_in_total',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In Total',
      topic: `${prefix}/stats/total`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 640,
      y: 80,
      wires: [['text_nr_total']],
    },
    {
      id: 'text_nr_total',
      type: 'ui_text',
      z: 'flow_dronesim',
      group: 'grp_prod',
      order: 1,
      width: '3',
      height: '1',
      name: 'Total Kits',
      label: 'Total Kits : ',
      format: '{{msg.payload}}',
      layout: 'row-spread',
      x: 880,
      y: 80,
      wires: [],
    },

    // Total Assemblés
    {
      id: 'mqtt_in_assembled',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In Assembled',
      topic: `${prefix}/stats/assembled`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 640,
      y: 140,
      wires: [['text_nr_assembled']],
    },
    {
      id: 'text_nr_assembled',
      type: 'ui_text',
      z: 'flow_dronesim',
      group: 'grp_prod',
      order: 2,
      width: '3',
      height: '1',
      name: 'Total Assemblés',
      label: 'Drones Assemblés : ',
      format: '{{msg.payload}}',
      layout: 'row-spread',
      x: 880,
      y: 140,
      wires: [],
    },

    // Drones Conformes (Stock)
    {
      id: 'mqtt_in_pass',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In Pass',
      topic: `${prefix}/stats/passed`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 640,
      y: 200,
      wires: [['text_nr_pass']],
    },
    {
      id: 'text_nr_pass',
      type: 'ui_text',
      z: 'flow_dronesim',
      name: 'Stock Conformes',
      group: 'grp_prod',
      order: 3,
      width: '3',
      height: '1',
      label: 'Conformes (Stock) : ',
      format: '{{msg.payload}}',
      layout: 'row-spread',
      x: 880,
      y: 200,
      wires: [],
    },

    // Drones Rejetés (Bac de Rejet)
    {
      id: 'mqtt_in_fail',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In Fail',
      topic: `${prefix}/stats/failed`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 640,
      y: 260,
      wires: [['text_nr_fail']],
    },
    {
      id: 'text_nr_fail',
      type: 'ui_text',
      z: 'flow_dronesim',
      name: 'Rejets Qualité',
      group: 'grp_prod',
      order: 4,
      width: '3',
      height: '1',
      label: 'Rejets (Défauts) : ',
      format: '{{msg.payload}}',
      layout: 'row-spread',
      x: 880,
      y: 260,
      wires: [],
    },

    // ========================================================================
    // ZONE 4 : QUALITÉ, RENDEMENT OEE & CADENCE (Colonnes X: 1100 -> 1320 -> 1540)
    // ========================================================================
    // Jauge Rendement OEE (Overall Equipment Effectiveness / TRS)
    {
      id: 'mqtt_in_oee',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In OEE',
      topic: `${prefix}/stats/oee`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 1100,
      y: 80,
      wires: [['gauge_nr_oee']],
    },
    {
      id: 'gauge_nr_oee',
      type: 'ui_gauge',
      z: 'flow_dronesim',
      name: 'Rendement OEE',
      group: 'grp_qc',
      order: 1,
      width: '3',
      height: '3',
      gtype: 'gage',
      title: 'Rendement OEE (TRS)',
      label: '%',
      format: '{{value}}%',
      min: 0,
      max: 100,
      colors: ['#f43f5e', '#f59e0b', '#10b981'],
      seg1: '60',
      seg2: '85',
      x: 1320,
      y: 80,
      wires: [],
    },

    // Jauge Taux de Défaut & Graphique Historique
    {
      id: 'mqtt_in_defect_rate',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In Defect Rate',
      topic: `${prefix}/stats/defect_rate`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 1100,
      y: 160,
      wires: [['gauge_nr_defect', 'fn_chart_defect']],
    },
    {
      id: 'gauge_nr_defect',
      type: 'ui_gauge',
      z: 'flow_dronesim',
      name: 'Taux Défaut Gauge',
      group: 'grp_qc',
      order: 2,
      width: '3',
      height: '3',
      gtype: 'gage',
      title: 'Taux de Défaut',
      label: '%',
      format: '{{value}}%',
      min: 0,
      max: 60,
      colors: ['#10b981', '#f59e0b', '#f43f5e'],
      seg1: '20',
      seg2: '30',
      x: 1320,
      y: 140,
      wires: [],
    },
    {
      id: 'fn_chart_defect',
      type: 'function',
      z: 'flow_dronesim',
      name: 'Format Nombre pour Graphique',
      func: "var val = parseFloat(msg.payload);\nif (!isNaN(val)) {\n    msg.payload = val;\n    msg.topic = 'Taux de Défaut (%)';\n    return msg;\n}\nreturn null;",
      outputs: 1,
      x: 1320,
      y: 190,
      wires: [['chart_nr_defect']],
    },
    {
      id: 'chart_nr_defect',
      type: 'ui_chart',
      z: 'flow_dronesim',
      name: 'Graphique Qualité',
      group: 'grp_qc',
      order: 4,
      width: '6',
      height: '4',
      label: 'Historique Taux de Défaut (%)',
      chartType: 'line',
      legend: 'false',
      xformat: 'HH:mm:ss',
      interpolate: 'linear',
      nodata: 'En attente de mesures...',
      dot: false,
      ymin: '0',
      ymax: '60',
      removeOlder: '10',
      removeOlderPoints: '300',
      removeOlderUnit: '60',
      x: 1540,
      y: 190,
      wires: [[]],
    },

    // Cadence Instantanée PPM (Nombre / Taux)
    {
      id: 'mqtt_in_ppm',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In PPM',
      topic: `${prefix}/stats/ppm`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 1100,
      y: 270,
      wires: [['text_nr_ppm']],
    },
    {
      id: 'text_nr_ppm',
      type: 'ui_text',
      z: 'flow_dronesim',
      name: 'Cadence PPM',
      group: 'grp_qc',
      order: 3,
      width: '6',
      height: '1',
      label: 'Cadence instantanée : ',
      format: '{{msg.payload}} drones/min',
      layout: 'row-spread',
      x: 1320,
      y: 270,
      wires: [],
    },

    // ========================================================================
    // ZONE 5 : CAPTEURS & DIAGNOSTIC (Colonnes X: 640 -> 880 -> 1100, Y: 380 -> 660)
    // ========================================================================
    // Capteur S1
    {
      id: 'mqtt_in_s1',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In S1',
      topic: `${prefix}/sensors/s1`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 640,
      y: 380,
      wires: [['fn_s1']],
    },
    {
      id: 'fn_s1',
      type: 'function',
      z: 'flow_dronesim',
      name: 'Format S1',
      func: "msg.payload = (msg.payload === '1' || msg.payload === 1) ? 'Kit présent' : 'Libre';\nreturn msg;",
      outputs: 1,
      x: 880,
      y: 380,
      wires: [['text_nr_s1']],
    },
    {
      id: 'text_nr_s1',
      type: 'ui_text',
      z: 'flow_dronesim',
      group: 'grp_sensors',
      order: 1,
      width: '3',
      height: '1',
      name: 'S1 Présence',
      label: 'Capteur S1 (Kit) : ',
      format: '{{msg.payload}}',
      x: 1100,
      y: 380,
      wires: [],
    },

    // Capteur S2 Scan
    {
      id: 'mqtt_in_s2',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In S2',
      topic: `${prefix}/sensors/s2`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 640,
      y: 450,
      wires: [['fn_s2']],
    },
    {
      id: 'fn_s2',
      type: 'function',
      z: 'flow_dronesim',
      name: 'Format S2',
      func: "msg.payload = (msg.payload === '1' || msg.payload === 1) ? 'Contrôle en cours' : 'En attente';\nreturn msg;",
      outputs: 1,
      x: 880,
      y: 450,
      wires: [['text_nr_s2']],
    },
    {
      id: 'text_nr_s2',
      type: 'ui_text',
      z: 'flow_dronesim',
      group: 'grp_sensors',
      order: 2,
      width: '3',
      height: '1',
      name: 'S2 Scan',
      label: 'Capteur S2 (QC) : ',
      format: '{{msg.payload}}',
      x: 1100,
      y: 450,
      wires: [],
    },

    // Compteur S3 (Drones triés)
    {
      id: 'mqtt_in_s3',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In S3',
      topic: `${prefix}/sensors/s3`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 640,
      y: 520,
      wires: [['fn_s3']],
    },
    {
      id: 'fn_s3',
      type: 'function',
      z: 'flow_dronesim',
      name: 'Format S3',
      func: "msg.payload = String(msg.payload) + ' pièces';\nreturn msg;",
      outputs: 1,
      x: 880,
      y: 520,
      wires: [['text_nr_s3']],
    },
    {
      id: 'text_nr_s3',
      type: 'ui_text',
      z: 'flow_dronesim',
      group: 'grp_sensors',
      order: 3,
      width: '3',
      height: '1',
      name: 'S3 Compteur',
      label: 'Compteur Tri (S3) : ',
      format: '{{msg.payload}}',
      x: 1100,
      y: 520,
      wires: [],
    },

    // Statut Machine & Ligne
    {
      id: 'mqtt_in_status',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In Status',
      topic: `${prefix}/stats/status`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 640,
      y: 590,
      wires: [['fn_status']],
    },
    {
      id: 'fn_status',
      type: 'function',
      z: 'flow_dronesim',
      name: 'Format Statut',
      func: "if (msg.payload === 'RUNNING') {\n    msg.payload = 'En production';\n} else if (msg.payload === 'PAUSED') {\n    msg.payload = 'En pause';\n} else {\n    msg.payload = 'À l\\'arrêt';\n}\nreturn msg;",
      outputs: 1,
      x: 880,
      y: 590,
      wires: [['text_nr_status']],
    },
    {
      id: 'text_nr_status',
      type: 'ui_text',
      z: 'flow_dronesim',
      group: 'grp_sensors',
      order: 4,
      width: '3',
      height: '1',
      name: 'Statut Usine',
      label: 'Statut Ligne : ',
      format: '{{msg.payload}}',
      x: 1100,
      y: 590,
      wires: [],
    },

    // Diagnostic Goulot d'Étranglement
    {
      id: 'mqtt_in_bottleneck',
      type: 'mqtt in',
      z: 'flow_dronesim',
      name: 'In Bottleneck',
      topic: `${prefix}/stats/bottleneck`,
      qos: '0',
      datatype: 'utf8',
      broker: 'mqtt_broker_config',
      x: 640,
      y: 660,
      wires: [['fn_bottleneck']],
    },
    {
      id: 'fn_bottleneck',
      type: 'function',
      z: 'flow_dronesim',
      name: 'Format Goulot',
      func: "msg.payload = (msg.payload === 'true' || msg.payload === true) ? 'Goulot détecté' : 'Flux normal';\nreturn msg;",
      outputs: 1,
      x: 880,
      y: 660,
      wires: [['text_nr_bottleneck']],
    },
    {
      id: 'text_nr_bottleneck',
      type: 'ui_text',
      z: 'flow_dronesim',
      group: 'grp_sensors',
      order: 5,
      width: '6',
      height: '1',
      name: 'Diagnostic Goulot',
      label: 'Équilibrage : ',
      format: '{{msg.payload}}',
      x: 1100,
      y: 660,
      wires: [],
    },
  ];

  return JSON.stringify(flow, null, 2);
}

function renderNodeRedFlowJson() {
  const previewEl = document.getElementById('flow-json-preview');
  if (previewEl) {
    previewEl.textContent = generateNodeRedFlowJson();
  }
}


// ============================================================================
// 19. INITIALISATION DE L'APPLICATION
// ============================================================================

function bootApp() {
  setupConveyorRollers();
  initEventListeners();
  initMqttGateway();
  resetChallenge('100');
  requestAnimationFrame(simulationLoop);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}
