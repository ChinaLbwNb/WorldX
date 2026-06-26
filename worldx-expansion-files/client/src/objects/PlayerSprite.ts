import Phaser from "phaser";
import {
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH,
  type CharacterDisplayMetrics,
} from "../config/game-config";

const WALK_SPEED_BODY_HEIGHT_RATIO = 1.3;

export class PlayerSprite extends Phaser.GameObjects.Container {
  isMoving = false;

  private shadow!: Phaser.GameObjects.Ellipse;
  private bodyCircle: Phaser.GameObjects.Arc | null = null;
  private bodyContainer!: Phaser.GameObjects.Container;
  private glowRing!: Phaser.GameObjects.Graphics;
  private glowTween: Phaser.Tweens.Tween | null = null;
  private moveTween: Phaser.Tweens.Tween | null = null;
  private idleTween: Phaser.Tweens.Tween | null = null;
  private walkTween: Phaser.Tweens.Tween | null = null;
  private labelRoot: HTMLDivElement | null = null;
  private nameEl: HTMLDivElement | null = null;
  private overlayZoom = 1;
  private displayMetrics: CharacterDisplayMetrics;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    config: {
      displayMetrics: CharacterDisplayMetrics;
    }
  ) {
    super(scene, x, y);
    this.displayMetrics = config.displayMetrics;
    this.createVisuals();
    this.setInteractive({
      hitArea: new Phaser.Geom.Circle(0, 0, this.displayMetrics.circleRadius * 1.2),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
      useHandCursor: true,
    });
    scene.add.existing(this);
  }

  private createVisuals(): void {
    const radius = this.displayMetrics.circleRadius;

    // Shadow
    this.shadow = this.scene.add.ellipse(
      0,
      radius * 0.65,
      radius * 1.3,
      radius * 0.55,
      0x000000,
      0.4,
    );

    // Glow ring (pulsating)
    this.glowRing = this.scene.add.graphics();
    this.drawGlowRing(1);
    this.glowTween = this.scene.tweens.add({
      targets: { scale: 1 },
      scale: 1.35,
      duration: 1400,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
      onUpdate: (tween) => {
        const s = (tween.targets[0] as { scale: number }).scale;
        this.glowRing.setScale(s);
        this.glowRing.setAlpha(1.4 - s);
      },
    });

    // Body circle (player color)
    const strokeWidth = this.displayMetrics.circleStrokeWidth;
    this.bodyCircle = this.scene.add
      .circle(0, 0, radius, 0x00b894)
      .setStrokeStyle(strokeWidth, 0xffffff, 1);

    const highlight = this.scene.add.arc(
      -radius * 0.25,
      -radius * 0.25,
      radius * 0.4,
      0,
      360,
      false,
      0xffffff,
      0.4,
    );

    this.bodyContainer = this.scene.add.container(0, 0, [this.bodyCircle, highlight]);

    // Idle bounce
    this.idleTween = this.scene.tweens.add({
      targets: this.bodyContainer,
      scaleY: 0.94,
      scaleX: 1.06,
      y: 3,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    this.createDomLabel();

    this.add([
      this.shadow,
      this.glowRing,
      this.bodyContainer,
    ]);

    this.syncOverlayZoom(this.scene.cameras.main.zoom);
  }

  private drawGlowRing(scale: number): void {
    const radius = this.displayMetrics.circleRadius * 1.6;
    this.glowRing.clear();
    this.glowRing.lineStyle(3, 0x00b894, 0.6);
    this.glowRing.strokeCircle(0, 0, radius);
    this.glowRing.setScale(scale);
  }

  private createDomLabel(): void {
    const overlayRoot =
      document.getElementById("label-root") ?? document.getElementById("ui-root");
    if (!overlayRoot) return;

    const root = document.createElement("div");
    root.className = "player-label";
    root.style.position = "absolute";
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.alignItems = "center";
    root.style.gap = "2px";
    root.style.pointerEvents = "none";
    root.style.userSelect = "none";
    root.style.zIndex = "12";
    root.style.transform = "translate(-50%, -100%)";

    const name = document.createElement("div");
    name.className = "player-label__name";
    name.textContent = "你";
    name.style.fontWeight = "700";
    name.style.color = "#a3f7bf";
    name.style.textShadow = "0 1px 3px rgba(0,0,0,0.8)";
    name.style.whiteSpace = "nowrap";

    const badge = document.createElement("div");
    badge.textContent = "玩家";
    badge.style.fontSize = "10px";
    badge.style.color = "#00b894";
    badge.style.background = "rgba(0,0,0,0.6)";
    badge.style.padding = "1px 6px";
    badge.style.borderRadius = "999px";
    badge.style.border = "1px solid rgba(0,184,148,0.5)";
    badge.style.whiteSpace = "nowrap";

    root.append(name, badge);
    overlayRoot.appendChild(root);

    this.labelRoot = root;
    this.nameEl = name;
    this.updateDomLabelStyle();
    this.updateDomLabelPosition();
  }

  /**
   * Move the player to a target position with a smooth tween animation.
   */
  moveToPosition(targetX: number, targetY: number, onComplete?: () => void): void {
    if (this.isMoving) this.stopMoving();

    const dist = Phaser.Math.Distance.Between(this.x, this.y, targetX, targetY);
    if (dist < 1) {
      onComplete?.();
      return;
    }

    this.isMoving = true;
    this.startWalkingAnimation();

    const speed = this.getWalkSpeed();
    const duration = Math.max(100, (dist / speed) * 1000);

    this.moveTween = this.scene.tweens.add({
      targets: this,
      x: targetX,
      y: targetY,
      duration,
      ease: "Sine.easeInOut",
      onUpdate: () => {
        this.updateDomLabelPosition();
      },
      onComplete: () => {
        this.isMoving = false;
        this.moveTween = null;
        this.stopWalkingAnimation();
        onComplete?.();
      },
    });
  }

  stopMoving(): void {
    if (this.moveTween) {
      this.moveTween.stop();
      this.moveTween = null;
    }
    this.isMoving = false;
    this.stopWalkingAnimation();
  }

  getSortFootY(): number {
    return this.y + this.displayMetrics.circleRadius * 0.65;
  }

  private getWalkSpeed(): number {
    return Math.max(60, this.displayMetrics.circleRadius * 2 * WALK_SPEED_BODY_HEIGHT_RATIO);
  }

  private startWalkingAnimation(): void {
    if (this.walkTween) return;
    this.idleTween?.pause();
    this.walkTween = this.scene.tweens.add({
      targets: this.bodyContainer,
      y: 6,
      scaleX: 1.12,
      scaleY: 0.88,
      duration: 140,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private stopWalkingAnimation(): void {
    if (this.walkTween) {
      this.walkTween.stop();
      this.walkTween = null;
    }
    this.bodyContainer.setY(0);
    this.bodyContainer.setScale(1, 1);
    this.idleTween?.resume();
  }

  syncOverlayZoom(cameraZoom: number): void {
    const safeZoom = Math.max(cameraZoom, 0.01);
    if (Math.abs(this.overlayZoom - safeZoom) >= 0.001) {
      this.overlayZoom = safeZoom;
    }
    this.updateDomLabelStyle();
    this.updateDomLabelPosition();
  }

  private updateDomLabelStyle(): void {
    if (!this.labelRoot || !this.nameEl) return;

    const zoom = Math.max(this.overlayZoom, 0.01);
    const nameSize = Phaser.Math.Clamp(this.displayMetrics.labelNameWorldSize * zoom, 10, 22);

    this.nameEl.style.fontSize = `${nameSize}px`;
  }

  private updateDomLabelPosition(): void {
    if (!this.labelRoot) return;

    const camera = this.scene.cameras.main;
    const worldView = camera.worldView;
    const screenX = (this.x - worldView.x) * camera.zoom + camera.x;
    const screenY = (this.y - worldView.y) * camera.zoom + camera.y;

    const visible =
      this.active &&
      this.visible &&
      screenX >= -120 &&
      screenX <= camera.width + 120 &&
      screenY >= -120 &&
      screenY <= camera.height + 120;

    this.labelRoot.style.display = visible ? "flex" : "none";
    if (!visible) return;

    const headOffset = this.displayMetrics.circleRadius * 1.1;
    const headScreenY = screenY - headOffset * camera.zoom;
    this.labelRoot.style.left = `${Math.round(screenX)}px`;
    this.labelRoot.style.top = `${Math.round(headScreenY)}px`;
  }

  override destroy(fromScene?: boolean): void {
    this.glowTween?.stop();
    this.glowTween = null;
    this.moveTween?.stop();
    this.moveTween = null;
    this.idleTween?.stop();
    this.idleTween = null;
    this.walkTween?.stop();
    this.walkTween = null;
    this.labelRoot?.remove();
    this.labelRoot = null;
    this.nameEl = null;
    super.destroy(fromScene);
  }
}
