# DroneSim SVG — Drone Assembly & Quality-Control Line

An interactive industrial simulation of a quadcopter drone factory, built with **vanilla JavaScript and native SVG** (no UI framework). Kits are injected onto a conveyor, assembled by a robotic station, inspected by an optical QC station, then sorted into a *conforming stock* or a *reject bin*. The simulation can be connected to **MQTT / Node-RED** to behave like a digital twin of a real production line.

> The UI is in French.

## Features

- **Production line**: source → conveyor 1 → robotic assembly station → conveyor 2 → optical QC station → diverter → pass stock / reject bin.
- **Live adjustable parameters**: conveyor speed, kit injection interval, assembly time, QC scan time, defect rate (0–60 %), simulation speed (1×, 2×, 5×).
- **Controls**: start, stop, pause, manual kit injection, full reset.
- **Sensors**: S1 (kit presence), S2 (QC scan activity), S3 (parts counter after sorting).
- **Bottleneck detection** on the assembly and QC stations (queue ≥ 3) and a **quality alarm** when the defect rate exceeds 30 %.
- **Challenge mode**: reach 100 / 50 / 20 conforming drones before the timer ends (10 / 5 / 2 min), or play in free mode.
- **KPIs dashboard**: injected, assembled, passed, failed, pass/fail rate, throughput (drones/min), yield.
- **Drone inspector**: hover a drone to see its serial number, status, time on conveyor and QC result.
- **Synthesized sound effects** via the Web Audio API (no audio files).
- **MQTT gateway** with a packet monitor (Tx/Rx) and a built-in **Node-RED flow generator** (copy-paste JSON).

## Tech stack

| Purpose | Tool |
|---|---|
| Bundler / dev server | [Vite](https://vite.dev) |
| Rendering | Native SVG + vanilla JS (ES modules) |
| Messaging | [mqtt.js](https://github.com/mqttjs/MQTT.js) over WebSockets |
| Broker (optional) | Eclipse Mosquitto |
| Automation (optional) | Node-RED |

## Project structure

```
.
├── index.html        # Page layout + the whole SVG factory scene and modals
├── src/
│   ├── main.js       # Simulation engine, UI logic, MQTT gateway, Node-RED flow generator
│   └── style.css     # Styles (dark industrial theme)
├── mosquitto.conf    # Mosquitto config: TCP 1883 + WebSocket 9001
├── vite.config.ts    # Vite config
├── tsconfig.json     # Editor / TypeScript settings
└── package.json
```

## Getting started

**Prerequisites:** Node.js 18+ (or [Bun](https://bun.sh)).

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

Other scripts:

```bash
npm run build     # production build in dist/
npm run preview   # preview the production build
```

## MQTT / Node-RED integration (optional)

The simulation runs fine without any broker. To enable the digital-twin mode:

1. **Start Mosquitto** with the provided config (exposes TCP `1883` for Node-RED and WebSocket `9001` for the browser):
   ```bash
   mosquitto -c mosquitto.conf
   ```
2. In the app, click the **MQTT** badge in the header and press **Connect** (defaults: `ws://localhost:9001`, prefix `factory/dronesim`).
3. Open the **Node-RED guide**, copy the generated flow JSON and import it into Node-RED (*Menu → Import*).

> `allow_anonymous true` is used for local development only. Do not expose this broker publicly.

### Topics

All topics are prefixed by the configurable base `factory/dronesim`.

**Published by the simulation**

| Topic | Content |
|---|---|
| `telemetry` | Full JSON snapshot |
| `stats/total`, `assembled`, `passed`, `failed` | Counters |
| `stats/defect_rate`, `pass_rate`, `ppm`, `oee` | Quality and throughput KPIs |
| `stats/status`, `bottleneck`, `alarm` | Line state and alerts |
| `params/speed`, `assembly_time`, `qc_time`, `sim_speed` | Current parameters (retained) |
| `sensors/s1`, `s2`, `s3` | Sensor states |

**Commands received** (`<prefix>/cmd/<command>`)

| Command | Effect |
|---|---|
| `start`, `stop`, `pause` | Run state |
| `inject` | Inject a kit |
| `reset` | Reset the simulation |
| `set_speed`, `set_spawn_rate`, `set_assembly_time`, `set_qc_time`, `set_defect_rate`, `set_sim_speed` | Change a parameter (numeric payload) |

## How it works

- `requestAnimationFrame` loop with a clamped time step, scaled by the simulation speed.
- Each drone is an SVG `<g>` whose appearance depends on its state: `KIT → ASSEMBLING → ASSEMBLED → SCANNING → INSPECTED_PASS / INSPECTED_FAIL`.
- Stations are small state machines (`IDLE` / `PROCESSING` or `SCANNING`) with queue accumulation in front of them.
- The QC verdict is random, drawn from the configured defect rate.

