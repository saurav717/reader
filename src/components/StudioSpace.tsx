// ===========================================================================
//  The Studio's room: a space (studioSpace.ts) drawn in real 3-D.
//
//  A unit cube with a grid for a floor, lit from above, and in it whatever
//  the scene placed: surfaces, points, paths, panels, boxes, arrows, labels,
//  graphs. Each is rebuilt from `thingsAt` whenever the walk moves, so a
//  keyed thing moves, grows or changes with it. The camera orbits with a
//  drag, zooms with the wheel and pans with a right drag or a shift drag;
//  the scene can say where it starts, and 0 puts it back. The renderer is
//  three.js, loaded with the Studio and not before.
// ===========================================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { StudioSpec } from '../lib/studio';
import { thingsAt } from '../lib/studioSpace';
import type { Placed, Tone, V3 } from '../lib/studioSpace';
import { drawFrame, paletteOf } from './StudioFrame';

const toColor = (c: [number, number, number]) => new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);

/** The page's colours as three.js colours, plus the two the room itself needs. */
function colours(element: Element) {
  const palette = paletteOf(element);
  const style = getComputedStyle(element);
  const hex = (name: string, fallback: string) => {
    const v = style.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  };
  const tones: Record<Tone, THREE.Color> = {
    accent: toColor(palette.accent),
    mark: toColor(palette.mark),
    ink: toColor(palette.ink),
    muted: new THREE.Color(hex('--muted', '#6f6c63')),
    blue: new THREE.Color(hex('--viz-3', '#2d64a0')),
    pink: new THREE.Color(hex('--ul-pink', '#c9566c')),
  };
  return { palette, tones, paper: toColor(palette.paper), soft: toColor(palette.soft), border: new THREE.Color(hex('--border', '#e2ddce')), ink: toColor(palette.ink) };
}
type Colours = ReturnType<typeof colours>;

/** Words as a sprite that always faces the camera. */
function sprite(text: string, colour: THREE.Color, size: number, background?: THREE.Color): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const scale = 4;
  const font = 28 * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${font}px "IBM Plex Mono", ui-monospace, monospace`;
  const width = Math.ceil(ctx.measureText(text).width) + font;
  canvas.width = width;
  canvas.height = font * 1.6;
  ctx.font = `${font}px "IBM Plex Mono", ui-monospace, monospace`;
  ctx.textBaseline = 'middle';
  if (background) {
    ctx.fillStyle = `#${background.getHexString()}`;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.roundRect(0, 0, width, canvas.height, canvas.height / 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = `#${colour.getHexString()}`;
  ctx.fillText(text, font / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const s = new THREE.Sprite(material);
  s.scale.set((size * width) / canvas.height, size, 1);
  s.renderOrder = 10;
  return s;
}

const v = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);

/** The things of one moment, as objects: disposed and rebuilt when the moment changes. */
function build(placed: Placed[], c: Colours, canvases: Map<string, HTMLCanvasElement>): THREE.Group {
  const group = new THREE.Group();
  const label = (text: string | undefined, at: THREE.Vector3, lift: number, tone: THREE.Color = c.ink) => {
    if (!text) return;
    const s = sprite(text, tone, 0.055);
    s.position.copy(at).add(new THREE.Vector3(0, lift, 0));
    group.add(s);
  };
  for (const thing of placed) {
    switch (thing.kind) {
      case 'surface': {
        const rows = thing.heights.length;
        const cols = thing.heights[0].length;
        const geometry = new THREE.PlaneGeometry(thing.size[0], thing.size[2], cols - 1, rows - 1);
        geometry.rotateX(-Math.PI / 2);
        const pos = geometry.attributes.position as THREE.BufferAttribute;
        // The plane's vertices run row by row from the far edge; the grid's rows run from the top of the picture, which is the far edge too.
        for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) pos.setY(r * cols + col, thing.heights[r][col] * thing.size[1]);
        geometry.computeVertexNormals();
        const tone = c.tones[thing.tone];
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: tone.clone().lerp(c.paper, 0.72), side: THREE.DoubleSide, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.92 }));
        const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial({ color: tone, transparent: true, opacity: 0.28 }));
        const at = v(thing.at).add(new THREE.Vector3(thing.size[0] / 2, 0, thing.size[2] / 2));
        mesh.position.copy(at);
        wire.position.copy(at);
        group.add(mesh, wire);
        label(thing.label, v(thing.at).add(new THREE.Vector3(thing.size[0], thing.size[1] * 0.5, thing.size[2])), 0.04, tone);
        break;
      }
      case 'point': {
        const tone = c.tones[thing.tone];
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(thing.size, 24, 16), new THREE.MeshStandardMaterial({ color: tone, roughness: 0.5 }));
        mesh.position.copy(v(thing.at));
        group.add(mesh);
        label(thing.label, mesh.position, thing.size + 0.05, tone);
        break;
      }
      case 'path': {
        if (thing.points.length < 2) break;
        const tone = c.tones[thing.tone];
        const curve = new THREE.CatmullRomCurve3(thing.points.map(v), false, 'catmullrom', 0);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, thing.points.length * 6), 0.006, 6, false), new THREE.MeshStandardMaterial({ color: tone, roughness: 0.6 }));
        group.add(tube);
        for (const p of thing.points.slice(0, -1)) {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshStandardMaterial({ color: tone, transparent: true, opacity: 0.7 }));
          dot.position.copy(v(p));
          group.add(dot);
        }
        label(thing.label, v(thing.points[thing.points.length - 1]), 0.05, tone);
        break;
      }
      case 'panel': {
        let canvas = canvases.get(thing.id);
        if (!canvas) {
          canvas = document.createElement('canvas');
          canvas.width = canvas.height = 192;
          canvases.set(thing.id, canvas);
        }
        drawFrame(canvas, thing.frame, c.palette, thing.show.kind === 'noise' ? 'ink' : 'accent', 192);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.NearestFilter;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(thing.size[0], thing.size[1]), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
        if (thing.face === 'x') mesh.rotation.y = Math.PI / 2;
        if (thing.face === 'y') mesh.rotation.x = -Math.PI / 2;
        mesh.position.copy(v(thing.at));
        group.add(mesh);
        const frame = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: c.ink, transparent: true, opacity: 0.35 }));
        frame.rotation.copy(mesh.rotation);
        frame.position.copy(mesh.position);
        group.add(frame);
        label(thing.label, mesh.position, thing.size[1] / 2 + 0.04);
        break;
      }
      case 'box': {
        const tone = c.tones[thing.tone];
        const h = Math.max(0.005, thing.size[1] * thing.value);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(thing.size[0], h, thing.size[2]), new THREE.MeshStandardMaterial({ color: tone.clone().lerp(c.paper, 0.35), roughness: 0.8 }));
        mesh.position.set(thing.at[0], thing.at[1] + h / 2, thing.at[2]);
        group.add(mesh);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: tone, transparent: true, opacity: 0.6 }));
        edges.position.copy(mesh.position);
        group.add(edges);
        label(thing.label, mesh.position, h / 2 + 0.04, tone);
        break;
      }
      case 'arrow': {
        const tone = c.tones[thing.tone];
        const from = v(thing.from);
        const to = v(thing.to);
        const dir = to.clone().sub(from);
        const length = dir.length();
        if (length < 1e-4) break;
        const arrow = new THREE.ArrowHelper(dir.normalize(), from, length, tone.getHex(), Math.min(0.06, length * 0.35), Math.min(0.03, length * 0.2));
        group.add(arrow);
        label(thing.label, from.clone().add(to).multiplyScalar(0.5), 0.035, tone);
        break;
      }
      case 'text': {
        if (!thing.text) break;
        const s = sprite(thing.text, c.tones[thing.tone], thing.size * 1.2);
        s.position.copy(v(thing.at));
        group.add(s);
        break;
      }
      case 'graph': {
        const tone = c.tones[thing.tone];
        for (const [a, b] of thing.edges) {
          const geometry = new THREE.BufferGeometry().setFromPoints([v(thing.nodes[a]), v(thing.nodes[b])]);
          group.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: c.ink, transparent: true, opacity: 0.3 })));
        }
        thing.nodes.forEach((node, i) => {
          const active = i === thing.active;
          const mesh = new THREE.Mesh(new THREE.SphereGeometry(active ? 0.03 : 0.022, 20, 14), new THREE.MeshStandardMaterial({ color: c.paper.clone().lerp(tone, 0.15 + 0.85 * (thing.values[i] ?? 0.5)), roughness: 0.5 }));
          mesh.position.copy(v(node));
          group.add(mesh);
          if (active) {
            const ring = new THREE.Mesh(new THREE.SphereGeometry(0.038, 20, 14), new THREE.MeshBasicMaterial({ color: c.tones.mark, wireframe: true, transparent: true, opacity: 0.8 }));
            ring.position.copy(v(node));
            group.add(ring);
          }
        });
        break;
      }
    }
  }
  return group;
}

function dispose(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      const map = (m as THREE.MeshBasicMaterial).map;
      if (map) map.dispose();
      m.dispose();
    }
  });
}

/** The camera where the scene says it starts: turned `yaw` degrees around the room, `pitch` degrees above the floor, at a distance set by `zoom`. */
function placeCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, spec: StudioSpec) {
  const yaw = ((spec.space?.camera?.yaw ?? 30) * Math.PI) / 180;
  const pitch = ((spec.space?.camera?.pitch ?? 26) * Math.PI) / 180;
  const distance = 2.6 / (spec.space?.camera?.zoom ?? 1);
  controls.target.set(0.5, 0.38, 0.5);
  camera.position.set(0.5 + distance * Math.cos(pitch) * Math.sin(yaw), 0.38 + distance * Math.sin(pitch), 0.5 + distance * Math.cos(pitch) * Math.cos(yaw));
  controls.update();
}

export function StudioSpaceView({ spec, p, seed }: { spec: StudioSpec; p: number; seed: number }) {
  const host = useRef<HTMLDivElement>(null);
  const world = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; room: THREE.Group | null; canvases: Map<string, HTMLCanvasElement>; colours: Colours; draw: () => void } | null>(null);

  // The room itself: made once, sized to its host, torn down with it.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const c = colours(element);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 0.4;
    controls.maxDistance = 6;
    controls.maxPolarAngle = Math.PI * 0.49;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1.5, 3, 2);
    scene.add(sun);
    const floor = new THREE.GridHelper(1, 10, c.border, c.border);
    floor.position.set(0.5, 0, 0.5);
    (floor.material as THREE.Material).transparent = true;
    (floor.material as THREE.Material).opacity = 0.7;
    scene.add(floor);
    const axes = spec.space?.axes;
    const axisLabel = (text: string | undefined, x: number, y: number, z: number) => {
      if (!text) return;
      const s = sprite(text, c.tones.muted, 0.05);
      s.position.set(x, y, z);
      scene.add(s);
    };
    axisLabel(axes?.x, 1.06, 0.02, 0.5);
    axisLabel(axes?.y, 0, 1.06, 0);
    axisLabel(axes?.z, 0.5, 0.02, 1.06);
    let pending = 0;
    const draw = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        controls.update();
        renderer.render(scene, camera);
      });
    };
    const fit = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      draw();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    placeCamera(camera, controls, spec);
    controls.addEventListener('change', draw);
    // Damping settles over a few frames after a drag: keep drawing while it does.
    let settling = 0;
    const onStart = () => {
      cancelAnimationFrame(settling);
      const tick = () => {
        draw();
        settling = requestAnimationFrame(tick);
      };
      settling = requestAnimationFrame(tick);
    };
    const onEnd = () => window.setTimeout(() => cancelAnimationFrame(settling), 800);
    controls.addEventListener('start', onStart);
    controls.addEventListener('end', onEnd);
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.key === '0') {
        placeCamera(camera, controls, spec);
        draw();
      }
    };
    window.addEventListener('keydown', onKey);
    world.current = { renderer, scene, camera, controls, room: null, canvases: new Map(), colours: c, draw };
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(settling);
      cancelAnimationFrame(pending);
      observer.disconnect();
      controls.dispose();
      if (world.current?.room) dispose(world.current.room);
      renderer.dispose();
      renderer.domElement.remove();
      world.current = null;
    };
  }, [spec]);

  // The things, at this moment of the walk.
  useEffect(() => {
    const w = world.current;
    if (!w || !spec.space) return;
    if (w.room) {
      w.scene.remove(w.room);
      dispose(w.room);
    }
    w.room = build(thingsAt(spec.space, spec.slots, p, seed), w.colours, w.canvases);
    w.scene.add(w.room);
    w.draw();
  }, [spec, p, seed]);

  return <div ref={host} className="studio-space" role="img" aria-label={`${spec.state}, in a 3-D space`} />;
}
