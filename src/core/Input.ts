/** Converts raw DOM input into game intents. Pointer-lock mouse look. */
export interface InputIntents {
  forward: number;
  strafe: number;
  sprint: boolean;
  jump: boolean;
  crouch: boolean;
  fire: boolean;
  ads: boolean;
  reload: boolean;
  grenade: boolean;
  smoke: boolean;
  flash: boolean;
  weaponSlot: 1 | 2 | 3 | null;
  scoreboard: boolean;
}

export class Input {
  private keys = new Set<string>();
  yawDelta = 0;
  pitchDelta = 0;
  private fireHeld = false;
  private adsHeld = false;
  private reloadPressed = false;
  private grenadePressed = false;
  private smokePressed = false;
  private flashPressed = false;
  private slotPressed: 1 | 2 | 3 | null = null;
  private locked = false;
  sensitivity = 1.0;
  onPause: () => void = () => {};
  onLockChange: (locked: boolean) => void = () => {};
  /** Test hook: when true, look can be driven without pointer lock. */
  testMode = false;

  // --- touch state (mobile), set by TouchControls; merged into intents ---
  touchMode = false;
  touchMoveX = 0; // strafe -1..1
  touchMoveY = 0; // forward -1..1
  touchFire = false;
  touchAds = false;
  private touchJumpPressed = false;
  private touchReloadPressed = false;
  private touchGrenadePressed = false;
  private touchSlotPressed: 1 | 2 | 3 | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('blur', this.releaseAll);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isLocked(): boolean {
    return this.locked || this.testMode || this.touchMode;
  }

  requestLock(): void {
    if (this.testMode || this.touchMode) {
      this.onLockChange(true);
      return;
    }
    this.canvas.requestPointerLock();
  }

  // touch button hooks
  pressTouchJump(): void { this.touchJumpPressed = true; }
  pressTouchReload(): void { this.touchReloadPressed = true; }
  pressTouchGrenade(): void { this.touchGrenadePressed = true; }
  pressTouchSlot(slot: 1 | 2 | 3): void { this.touchSlotPressed = slot; }
  addTouchLook(dx: number, dy: number): void {
    this.yawDelta -= dx * 0.006;
    this.pitchDelta -= dy * 0.006;
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  consume(): InputIntents {
    const kbForward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const kbStrafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const intents: InputIntents = {
      forward: kbForward !== 0 ? kbForward : this.touchMoveY,
      strafe: kbStrafe !== 0 ? kbStrafe : this.touchMoveX,
      sprint:
        this.keys.has('ShiftLeft') ||
        this.keys.has('ShiftRight') ||
        this.touchMoveY > 0.85,
      jump: this.keys.has('Space') || this.touchJumpPressed,
      crouch: this.keys.has('KeyC') || this.keys.has('ControlLeft'),
      fire: this.fireHeld || this.touchFire,
      ads: this.adsHeld || this.touchAds,
      reload: this.reloadPressed || this.touchReloadPressed,
      grenade: this.grenadePressed || this.touchGrenadePressed,
      smoke: this.smokePressed,
      flash: this.flashPressed,
      weaponSlot: this.slotPressed ?? this.touchSlotPressed,
      scoreboard: this.keys.has('Tab'),
    };
    this.reloadPressed = false;
    this.grenadePressed = false;
    this.smokePressed = false;
    this.flashPressed = false;
    this.slotPressed = null;
    this.touchJumpPressed = false;
    this.touchReloadPressed = false;
    this.touchGrenadePressed = false;
    this.touchSlotPressed = null;
    return intents;
  }

  consumeLook(): { yaw: number; pitch: number } {
    const out = { yaw: this.yawDelta * this.sensitivity, pitch: this.pitchDelta * this.sensitivity };
    this.yawDelta = 0;
    this.pitchDelta = 0;
    return out;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Tab') e.preventDefault();
    this.keys.add(e.code);
    if (e.code === 'KeyR') this.reloadPressed = true;
    if (e.code === 'KeyG') this.grenadePressed = true;
    if (e.code === 'KeyF') this.smokePressed = true;
    if (e.code === 'KeyX') this.flashPressed = true;
    if (e.code === 'Digit1') this.slotPressed = 1;
    if (e.code === 'Digit2') this.slotPressed = 2;
    if (e.code === 'Digit3') this.slotPressed = 3;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isLocked) return;
    this.yawDelta -= e.movementX * 0.0022;
    this.pitchDelta -= e.movementY * 0.0022;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.isLocked) return;
    if (e.button === 0) this.fireHeld = true;
    if (e.button === 2) this.adsHeld = true;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.fireHeld = false;
    if (e.button === 2) this.adsHeld = false;
  };

  private onPointerLockChange = (): void => {
    const wasLocked = this.locked;
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) {
      this.releaseAll();
      if (wasLocked) this.onPause();
    }
    this.onLockChange(this.locked);
  };

  private releaseAll = (): void => {
    this.keys.clear();
    this.fireHeld = false;
    this.adsHeld = false;
  };

  dispose(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('blur', this.releaseAll);
  }
}
