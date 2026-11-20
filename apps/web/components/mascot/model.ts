import type { Material, Scene } from "three";
import type { Pose } from "./controller";
import {
  BufferGeometry, Color, DataTexture, DoubleSide, Float32BufferAttribute, Group,
  InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter, Mesh,
  MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, RedFormat,
  RepeatWrapping, SphereGeometry, Vector3,
} from "three";
import { seededRandom } from "./controller";

export const FULL_FUR_COUNT = 5000;
export const LOW_FUR_COUNT = 1800;

export function pebbleGeometry() {
  const shape = new SphereGeometry(1, 64, 48);
  const points = shape.attributes.position;
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i), y = points.getY(i), z = points.getZ(i);
    const wave = 1 + 0.026 * Math.sin(3.8 * x + 2.4 * y) * Math.cos(2.8 * z - y);
    points.setXYZ(i, 1.1 * x * wave * (1 - 0.085 * y),
      0.75 * y * wave - 0.065 * x + 0.025 * x * x,
      0.63 * z * wave * (1 + 0.075 * x));
  }
  shape.computeVertexNormals();
  return shape;
}

export function nearEye(x: number, y: number, z: number) {
  return z > 0.45 && [-0.26, 0.26].some((eye) => ((x - eye) / 0.172) ** 2 + ((y + 0.04) / 0.196) ** 2 < 1);
}

// Area-weighted triangle sampling keeps the flattened underside/sides as dense as the crown.
// Reject only the two eye sockets, then continue until all 5,000 roots are populated.
export function sampleCoat(body: BufferGeometry, count = FULL_FUR_COUNT) {
  const random = seededRandom(90517);
  const positions = body.attributes.position, normals = body.attributes.normal, indices = body.index!;
  const areas = [], a = new Vector3(), b = new Vector3(), c = new Vector3(), ab = new Vector3(), ac = new Vector3();
  let total = 0;
  for (let i = 0; i < indices.count; i += 3) {
    a.fromBufferAttribute(positions, indices.getX(i)); b.fromBufferAttribute(positions, indices.getX(i + 1)); c.fromBufferAttribute(positions, indices.getX(i + 2));
    total += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
    areas.push(total);
  }
  const roots = [], directions = [], lengths = [], bends = [], shades = [], tangents = [];
  while (lengths.length < count) {
    const pick = random() * total;
    let low = 0, high = areas.length - 1;
    while (low < high) { const mid = (low + high) >>> 1; if (areas[mid] < pick) low = mid + 1; else high = mid; }
    const triangle = low * 3;
    const u = Math.sqrt(random()), v = random();
    const weights = [1 - u, u * (1 - v), u * v];
    const root = new Vector3(), normal = new Vector3();
    for (let k = 0; k < 3; k++) {
      const index = indices.getX(triangle + k);
      root.addScaledVector(a.fromBufferAttribute(positions, index), weights[k]);
      normal.addScaledVector(b.fromBufferAttribute(normals, index), weights[k]);
    }
    if (nearEye(root.x, root.y, root.z)) continue;
    normal.normalize();
    const tangent = new Vector3(0, 1, 0);
    if (Math.abs(normal.y) > 0.95) tangent.set(1, 0, 0);
    tangent.cross(normal).normalize().applyAxisAngle(normal, random() * Math.PI * 2);
    roots.push(...root.toArray()); directions.push(...normal.toArray()); tangents.push(...tangent.toArray());
    lengths.push(0.035 + random() * 0.033);
    bends.push((random() - 0.5) * 0.026);
    const shade = 0.82 + random() * 0.18;
    shades.push(shade * 0.985, shade * 0.992, shade);
  }
  return { roots, directions, lengths, bends, shades, tangents };
}

function furGeometry(coat: ReturnType<typeof sampleCoat>) {
  // Two crossed, tapered, three-segment ribbons per strand. One instanced draw call.
  const vertices = [], indices = [];
  for (let ribbon = 0; ribbon < 2; ribbon++) {
    for (let row = 0; row <= 3; row++) {
      const t = row / 3, width = 0.0031 * (1 - 0.94 * t);
      for (const side of [-1, 1]) vertices.push(ribbon ? 0 : side * width, t, ribbon ? side * width : 0);
    }
    for (let row = 0; row < 3; row++) {
      const n = ribbon * 8 + row * 2;
      indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
    }
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  for (const [key, values, size] of [
    ["strandRoot", coat.roots, 3], ["strandNormal", coat.directions, 3], ["strandTangent", coat.tangents, 3],
    ["strandLength", coat.lengths, 1], ["strandBend", coat.bends, 1], ["color", coat.shades, 3],
  ] as const) geometry.setAttribute(key, new InstancedBufferAttribute(new Float32Array(values), size));
  geometry.instanceCount = FULL_FUR_COUNT;
  return geometry;
}

function velvetTexture() {
  const random = seededRandom(127), data = new Uint8Array(128 * 128);
  for (let i = 0; i < data.length; i++) data[i] = 100 + random() * 60;
  const texture = new DataTexture(data, 128, 128, RedFormat);
  texture.wrapS = texture.wrapT = RepeatWrapping; texture.repeat.set(3, 2);
  texture.magFilter = texture.minFilter = LinearFilter; texture.needsUpdate = true;
  return texture;
}

export function createMascot(scene: Scene) {
  const group = new Group(); scene.add(group);
  const coat = velvetTexture(), geometry = pebbleGeometry();
  const body = new Mesh(geometry, new MeshPhysicalMaterial({
    color: "#ffffff", roughness: 1, metalness: 0, bumpMap: coat, bumpScale: 0.016,
    sheen: 0.8, sheenRoughness: 1, sheenColor: new Color("#f4f7ff"),
  }));
  group.add(body);
  const sway = { value: 0 };
  const furMaterial = new MeshStandardMaterial({ color: "#ffffff", roughness: 1, side: DoubleSide, vertexColors: true });
  furMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.coatTime = sway;
    shader.vertexShader = `attribute vec3 strandRoot, strandNormal, strandTangent;
      attribute float strandLength, strandBend; uniform float coatTime;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <beginnormal_vertex>",
      "vec3 objectNormal = normalize(strandNormal + strandTangent * 0.16);");
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `
      vec3 bitangent = cross(strandNormal, strandTangent);
      float curve = strandBend + 0.002 * sin(coatTime * 1.8 + strandRoot.y * 7.0 + strandRoot.x * 4.0);
      vec3 transformed = strandRoot + strandNormal * (position.y * strandLength - 0.002)
        + strandTangent * (position.x + curve * position.y * position.y)
        + bitangent * position.z;
    `);
  };
  const fur = new Mesh(furGeometry(sampleCoat(geometry)), furMaterial);
  fur.frustumCulled = false; group.add(fur);
  const shape = new SphereGeometry(1, 24, 18);
  const ink = new MeshPhysicalMaterial({ color: "#171525", roughness: 0.2, clearcoat: 0.75, clearcoatRoughness: 0.18 });
  const socket = new MeshStandardMaterial({ color: "#bcc0ce", roughness: 1 });
  const glint = new MeshBasicMaterial({ color: "#ffffff" });
  const face = new Group(); group.add(face);
  const eyes = [];
  const detail = (parent: Group, material: Material, position: [number,number,number], scale: [number,number,number]) => {
    const mesh = new Mesh(shape, material); mesh.position.set(...position); mesh.scale.set(...scale); parent.add(mesh); return mesh;
  };
  for (const x of [-0.26, 0.26]) {
    const eye = new Group(); eye.position.set(x, -0.04, x > 0 ? 0.638 : 0.615); face.add(eye);
    detail(eye, socket, [0, 0, -0.024], [0.12, 0.147, 0.035]);
    detail(eye, ink, [0, 0, 0], [0.103, 0.129, 0.049]);
    detail(eye, glint, [-0.024, 0.039, 0.043], [0.018, 0.023, 0.007]);
    detail(eye, glint, [0.024, -0.033, 0.046], [0.007, 0.009, 0.004]);
    eyes.push(eye);
  }
  const mouth = detail(face, ink, [0, -0.275, 0.672], [0.041, 0.018, 0.019]);
  return { group, face, eyes, mouth, coat, fur, sway };
}

export function applyCharacterPose(robot: ReturnType<typeof createMascot>, pose: Pose, now: number, still: boolean) {
  const { group, eyes, face, mouth } = robot;
  group.position.set(pose.x, pose.y, 0); group.rotation.set(pose.rx, pose.ry, pose.rz);
  group.scale.set(1.17 * pose.scale / Math.sqrt(pose.stretch), 1.17 * pose.scale * pose.stretch, 1.17 * pose.scale);
  face.position.set(pose.gazeX, pose.gazeY, 0);
  eyes.forEach((eye, index) => {
    eye.scale.set(pose.eyeX, pose.eyeY * (index === 0 ? 1 - 0.9 * pose.wink : 1), 1);
    eye.rotation.z = (index ? -1 : 1) * pose.eyeTilt;
  });
  mouth.visible = pose.mouth > 0.05; mouth.scale.y = 0.008 + pose.mouth * 0.032;
  robot.sway.value = still ? 0 : now / 1000;
}
