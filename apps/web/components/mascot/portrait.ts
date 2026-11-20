// All small avatars share one portrait captured from the actual Three.js model.
// They need neither animation loops nor additional WebGL contexts.
let portrait: string | null = null;
const listeners = new Set<() => void>();
export const getMascotPortrait = () => portrait;
export const getServerPortrait = () => null;
export const subscribePortrait = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function publishMascotPortrait(image: string) {
  if (portrait) return;
  portrait = image;
  listeners.forEach((listener) => listener());
}
