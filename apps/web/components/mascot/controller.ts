// Presentation only. No answers or game decisions enter this controller.
export const CHARACTER_STATES: Readonly<Record<string, {priority:number;duration?:number}>> = Object.freeze({
  IDLE: { priority: 0 }, THINKING: { priority: 1 }, NERVOUS: { priority: 1 },
  SPEAKING: { priority: 4 }, EXCITED: { priority: 3, duration: 1500 },
  SURPRISED: { priority: 3, duration: 1100 }, HAPPY: { priority: 2, duration: 1600 },
  SAD: { priority: 2 }, CELEBRATING: { priority: 3, duration: 2400 },
  EVENT_YES: { priority: 5, duration: 1600 }, EVENT_NO: { priority: 5, duration: 1400 },
  ROUND_START: { priority: 3, duration: 1200 }, ROUND_REVEAL: { priority: 4, duration: 850 },
  GREETING: { priority: 2, duration: 1900 }, CURIOUS: { priority: 1, duration: 2200 },
  WINK: { priority: 1, duration: 1200 }, STRETCH: { priority: 1, duration: 2200 },
  LOCKED_IN: { priority: 1, duration: 1400 }, COPYING: { priority: 1 },
  EXIT: { priority: 6, duration: 550 },
});

const aliases: Record<string,string> = { idle: "IDLE", thinking: "THINKING", speaking: "SPEAKING", event: "EVENT_YES",
  success: "CELEBRATING", setback: "SAD", "no-event": "EVENT_NO", appearing: "ROUND_START", transition: "IDLE", goodbye: "EXIT" };
export function characterState(mode: string) {
  return aliases[mode] ?? (CHARACTER_STATES[mode] ? mode : "IDLE");
}
export function seededRandom(seed = 7139) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

const rest = () => ({ x: 0, y: 0, rx: 0.03, ry: 0.05, rz: -0.025, scale: 1, stretch: 1,
  eyeY: 1, eyeX: 1, eyeTilt: 0, wink: 0, gazeX: 0, gazeY: 0, mouth: 0, opacity: 1 });
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (n: number) => { n = clamp(n); return n * n * (3 - 2 * n); };

export function createCharacterController(seed = 7139) {
  const random = seededRandom(seed);
  let requested: string | undefined; let state = "IDLE", entered = 0, nextBlink = 1700 + random() * 2400;
  let last: number | undefined; let reaction: {name:string;at:number} | null = null; let blinkAt = -10000, nextGlance = 0, gazeX = 0, gazeY = 0;
  let nextIdle = 5000 + random() * 5000;
  const current = rest();
  return {
    // Optional future presentation signals obey priorities; authoritative mode changes always win.
    react(mode: string, now: number) {
      const name = characterState(mode);
      if (CHARACTER_STATES[name].priority < CHARACTER_STATES[state].priority) return false;
      reaction = { name, at: now }; return true;
    },
    sample({ mode = "idle", enteredAt, wordMs = 145, still = false }: PoseOptions, now: number) {
      const desired = characterState(mode);
      if (requested !== desired) { requested = desired; state = desired; entered = enteredAt ?? now; reaction = null; }
      if (reaction) { state = reaction.name; entered = reaction.at; reaction = null; }
      let age = Math.max(0, now - entered) / 1000;
      const duration = CHARACTER_STATES[state].duration;
      if (duration && age * 1000 >= duration && state !== "EXIT") { state = "IDLE"; entered = now; age = 0; }
      if (!still && state === "IDLE" && requested === "IDLE" && now >= nextIdle) {
        const variations = ["CURIOUS", "WINK", "STRETCH"];
        state = variations[Math.floor(random() * variations.length)];
        entered = now;
        age = 0;
        nextIdle = now + 9000 + random() * 9000;
      }
      const dt = Math.min(0.05, Math.max(0, (now - (last ?? now)) / 1000));
      const first = last == null;
      last = now;
      if (now >= nextGlance) {
        gazeX = (random() - 0.5) * 0.045; gazeY = (random() - 0.5) * 0.022;
        nextGlance = now + 1800 + random() * 3600;
      }
      if (now >= nextBlink) { blinkAt = now; nextBlink = now + 2600 + random() * 4400; }
      const blinkAge = now - blinkAt;
      const blink = blinkAge < 170 ? 1 - 0.95 * Math.sin(blinkAge / 170 * Math.PI) ** 2 : 1;
      const p = rest();
      const t = now / 1000;
      p.y = 0.045 * Math.sin(t * 1.71) + 0.016 * Math.sin(t * 0.73);
      p.rx += 0.025 * Math.cos(t * 1.31); p.ry += 0.065 * Math.sin(t * 0.61);
      p.rz += 0.025 * Math.sin(t * 0.97); p.stretch = 1 + 0.009 * Math.sin(t * 1.9);
      p.gazeX = gazeX; p.gazeY = gazeY;
      const jump = Math.sin(clamp((age - 0.13) / 0.75) * Math.PI);
      const anticipation = Math.sin(clamp(age / 0.16) * Math.PI);
      const settle = Math.sin(age * 11) * Math.exp(-3 * age);
      if (["EXCITED", "EVENT_YES", "HAPPY", "CELEBRATING", "ROUND_START"].includes(state)) {
        p.y += 0.22 * jump - 0.05 * anticipation;
        p.stretch += 0.05 * jump - 0.07 * anticipation;
        p.ry += (state === "CELEBRATING" ? 0.65 : 0.3) * jump;
        p.rz += 0.12 * settle; p.eyeY = 0.72; p.eyeTilt = 0.12; p.mouth = 0.25;
        if (state === "EVENT_YES" || state === "ROUND_START") p.scale = 0.78 + 0.22 * smooth(age / 0.4);
        if (state === "CELEBRATING") { p.y += 0.08 * Math.sin(age * 9) * Math.exp(-age); p.eyeY = 0.62; }
      }
      if (state === "THINKING") {
        const consider = smooth((Math.sin(t * 0.9) + 1) / 2);
        p.ry += 0.12 * consider; p.rz -= 0.1 * consider; p.gazeX += 0.018 * consider;
        p.gazeY += 0.016; p.eyeY = 0.92;
      }
      if (state === "CURIOUS") {
        const look = Math.sin(clamp(age / 2.2) * Math.PI);
        p.rz += 0.16 * look;
        p.ry -= 0.18 * look;
        p.gazeX -= 0.035 * look;
        p.gazeY += 0.014 * look;
        p.eyeY = 1.08;
      }
      if (state === "WINK") {
        p.wink = Math.sin(clamp((age - 0.2) / 0.65) * Math.PI) ** 2;
        p.rz += 0.09 * Math.sin(clamp(age / 1.2) * Math.PI);
        p.mouth = 0.15;
      }
      if (state === "STRETCH") {
        const stretch = Math.sin(clamp(age / 2.2) * Math.PI);
        p.stretch += 0.10 * stretch;
        p.y += 0.07 * stretch;
        p.rz -= 0.08 * stretch;
        p.eyeY = 0.83;
      }
      if (state === "GREETING") {
        const wave = Math.sin(clamp(age / 1.9) * Math.PI);
        p.y += 0.12 * wave;
        p.rz += 0.19 * Math.sin(age * 8) * wave;
        p.eyeY = 0.8;
        p.mouth = 0.22;
      }
      if (state === "LOCKED_IN") {
        const nod = Math.sin(clamp(age / 1.1) * Math.PI);
        p.rx += 0.16 * nod;
        p.y -= 0.035 * nod;
        p.eyeY = 0.87;
      }
      if (state === "COPYING") {
        const glance = Math.sin(t * 1.15);
        p.ry += 0.13 * glance;
        p.rz += 0.07 * glance;
        p.gazeX += 0.035 * glance;
        p.eyeY = 0.9;
      }
      if (state === "NERVOUS" || state === "ROUND_REVEAL") {
        p.y *= 0.4; p.x = 0.008 * Math.sin(t * 13); p.eyeY = 1.08; p.gazeX *= 1.4;
      }
      if (state === "SPEAKING") {
        const pulse = Math.sin((age * 1000 % wordMs) / wordMs * Math.PI) ** 2;
        const accent = 0.55 + 0.45 * Math.sin(Math.floor(age * 1000 / wordMs) * 2.399) ** 2;
        p.mouth = 0.22 + 0.7 * pulse * accent; p.y += 0.017 * pulse * accent;
        p.rz += 0.025 * Math.sin(age * 3.1); p.eyeY = 0.94; p.gazeX *= 0.35;
      }
      if (state === "SURPRISED") {
        const recoil = Math.sin(clamp(age / 0.7) * Math.PI);
        p.rx -= 0.13 * recoil; p.scale -= 0.055 * recoil; p.rz += 0.08 * settle;
        p.eyeY = 1.27; p.eyeX = 1.09; p.mouth = 0.8;
      }
      if (state === "SAD" || state === "EVENT_NO") {
        p.y -= 0.075; p.rx += 0.09; p.eyeY = 0.65; p.eyeTilt = -0.13; p.gazeY = -0.014;
        if (state === "EVENT_NO") { p.ry += 0.22 * Math.sin(age * 11) * Math.exp(-2.8 * age); p.rz += 0.08 * settle; }
      }
      if (state === "EXIT") { const leave = smooth(age / 0.55); p.scale = 1 - 0.65 * leave; p.y += 0.26 * leave; p.opacity = 1 - leave; }
      if (still) {
        // Keep static emotional cues, without drift, blinking, squash or movement.
        Object.assign(p, { x: 0, y: 0, rx: 0.03, ry: 0.05, rz: -0.025, scale: 1, stretch: 1, wink: 0, gazeX: 0, gazeY: 0 });
        p.mouth = state === "SPEAKING" ? 0.25 : p.mouth;
      } else p.eyeY *= blink;
      const blend = first || still ? 1 : 1 - Math.exp(-dt * 13);
      for (const key of (Object.keys(p) as (keyof typeof p)[])) current[key] += (p[key] - current[key]) * blend;
      return { ...current, state };
    },
  };
}


export type PoseOptions = {mode?:string;enteredAt?:number;wordMs?:number;still?:boolean};
export type Pose = ReturnType<ReturnType<typeof createCharacterController>["sample"]>;