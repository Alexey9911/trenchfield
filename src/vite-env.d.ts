/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  state: string;
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
  };
  player: {
    position: { x: number; y: number; z: number };
    health: number;
    alive: boolean;
  };
  bots: { alive: number; total: number };
  match: { timeLeft: number; running: boolean };
  audio: { loaded: number; missing: string[] };
  imports: Array<{ name: string; triangles: number; materials: number; loaded: boolean }>;
  chunks: number;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
}
