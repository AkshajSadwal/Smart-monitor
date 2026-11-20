"use client";

import { useEffect, useRef, useState } from "react";
import { AmbientLight, DirectionalLight, NeutralToneMapping, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { createCharacterController } from "./controller";
import { applyCharacterPose, createMascot, FULL_FUR_COUNT, LOW_FUR_COUNT } from "./model";
import { getMascotPortrait, publishMascotPortrait } from "./portrait";
type SceneProps = {fallback: React.ReactNode; visible:boolean; still:boolean; mode:string; enteredAt?:number; wordMs?:number; cue?:number};
export default function RobotScene({ fallback, visible, still, mode, enteredAt, wordMs, cue }: SceneProps) {
  const surface = useRef<HTMLDivElement>(null);
  const controls = useRef<{refresh:() => void} | null>(null);
  const settings = useRef({ visible, still, mode, enteredAt, wordMs, cue });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (failed) return;
    const target = surface.current; if (!target) return;
    const canvas = document.createElement("canvas");
    target.append(canvas);
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    } catch {
      // A static mascot remains available when WebGL is disabled.
      canvas.remove();
      const fallbackFrame = requestAnimationFrame(() => setFailed(true));
      return () => cancelAnimationFrame(fallbackFrame);
    }

    const scene = new Scene();
    const camera = new PerspectiveCamera(35, 1, 0.1, 25);
    camera.position.z = 5;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;
    scene.add(new AmbientLight("#f3f6ff", 1.3));
    for (const [color, intensity, x, y, z] of [
      ["#ffffff", 2.6, -3, 5, 4], ["#e4ebff", 0.8, 3, -1, 3], ["#ffffff", 2.5, 2, 3, -4],
    ] as const) {
      const light = new DirectionalLight(color, intensity);
      light.position.set(x, y, z);
      scene.add(light);
    }
    const mascot = createMascot(scene);
    if (!getMascotPortrait()) {
      camera.aspect = 1.25; camera.updateProjectionMatrix();
      renderer.setSize(180, 144, false);
      applyCharacterPose(mascot, createCharacterController().sample({ still: true }, 0), 0, true);
      renderer.render(scene, camera);
      try { publishMascotPortrait(canvas.toDataURL("image/png")); } catch { /* CSS portrait remains available. */ }
    }
    const controller = createCharacterController();
    let lastCue = settings.current.cue;
    let lowDetail = (navigator.hardwareConcurrency || 8) <= 4 || ((navigator as Navigator & {deviceMemory?:number}).deviceMemory || 8) <= 2;
    let lastDraw = 0, slowFrames = 0, samples = 0;
    const setDetail = () => {
      mascot.fur.geometry.instanceCount = lowDetail ? LOW_FUR_COUNT : FULL_FUR_COUNT;
      canvas.dataset.furStrands = String(mascot.fur.geometry.instanceCount);
    };
    setDetail();
    let frame = 0;
    let canDraw = false;
    const draw = (now: number) => {
      frame = 0;
      const config = settings.current;
      if (!canDraw || !config.visible || document.hidden) return;
      if (config.cue !== lastCue) {
        const joined = typeof config.cue === "number" && typeof lastCue === "number" && config.cue > lastCue;
        controller.react(joined ? "GREETING" : "CURIOUS", now);
        lastCue = config.cue;
      }
      const pose = controller.sample(config, now);
      applyCharacterPose(mascot, pose, now, config.still);
      canvas.style.opacity = String(pose.opacity);
      canvas.dataset.characterState = pose.state;
      // Assess sustained frame pressure once; never oscillate between quality levels.
      if (!lowDetail && lastDraw && now - lastDraw < 150 && samples < 120) {
        samples++; if (now - lastDraw > 28) slowFrames++;
        if (samples === 120 && slowFrames > 85) { lowDetail = true; setDetail(); renderer.setPixelRatio(1); }
      }
      lastDraw = now;
      renderer.render(scene, camera);
      if (!config.still) frame = requestAnimationFrame(draw);
    };
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = target;
      canDraw = width > 0 && height > 0;
      if (!canDraw) return;
      camera.aspect = width / height;
      camera.position.z = Math.max(5, 4.65 / camera.aspect);
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, lowDetail ? 1 : 1.75));
      renderer.setSize(width, height, false);
      refresh();
    };
    const resize = new ResizeObserver(measure);
    const loseContext = () => setFailed(true);
    resize.observe(target);
    canvas.addEventListener("webglcontextlost", loseContext);
    document.addEventListener("visibilitychange", refresh);
    controls.current = { refresh };
    measure();

    return () => {
      controls.current = null;
      cancelAnimationFrame(frame);
      resize.disconnect();
      canvas.removeEventListener("webglcontextlost", loseContext);
      document.removeEventListener("visibilitychange", refresh);
      const geometries = new Set<import("three").BufferGeometry>();
      const materials = new Set<import("three").Material>();
      scene.traverse((node) => { const item = node as import("three").Mesh;
        if (item.geometry) geometries.add(item.geometry);
        if (item.material) (Array.isArray(item.material) ? item.material : [item.material]).forEach(material => materials.add(material));
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      mascot.coat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, [failed]);

  useEffect(() => {
    settings.current = { visible, still, mode, enteredAt, wordMs, cue };
    controls.current?.refresh();
  }, [visible, still, mode, enteredAt, wordMs, cue]);

  return failed ? fallback : <div ref={surface} className="robot-surface" />;
}
